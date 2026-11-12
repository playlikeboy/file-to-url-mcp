/** Plain HTTP routes: short-link downloads and direct (curl) uploads. */

import type { FileService, LinkReader, UploadOptions } from "./service";
import { readAllCapped } from "./service";
import { UploadThingError } from "./uploadthing";
import { UserError, contentDisposition, formatBytes, isInlineSafe, sanitizeFilename } from "./util";

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "mcp-session-id, content-disposition, content-length, content-range",
  "access-control-max-age": "86400",
};

const PASSTHROUGH_HEADERS: readonly string[] = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];

export const TOKEN_REJECTED_MESSAGE = "UploadThing rejected the API key. Check the UPLOADTHING_TOKEN you connected with.";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

/** Maps any thrown value onto the { success, error } envelope without leaking internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof UserError) return jsonResponse({ success: false, error: error.message }, error.status);
  if (error instanceof UploadThingError && error.isAuthFailure) {
    return jsonResponse({ success: false, error: TOKEN_REJECTED_MESSAGE }, 401);
  }
  if (error instanceof UploadThingError) {
    console.error("Storage error", error);
    return jsonResponse({ success: false, error: "The storage provider rejected the request. Try again shortly." }, error.status);
  }
  console.error("Unhandled error", error);
  return jsonResponse({ success: false, error: "Internal error." }, 500);
}

/** A GET for the whole file or its first chunk (later Range requests are video seeks, not new downloads). */
function startsAtBeginning(request: Request): boolean {
  const range = request.headers.get("range");
  return !range || /^bytes=0-/.test(range.trim());
}

function wantsAttachment(url: URL, contentType: string): boolean {
  const flag = url.searchParams.get("download") ?? url.searchParams.get("dl");
  return !isInlineSafe(contentType) || (flag !== null && flag !== "0" && flag !== "false");
}

async function deadLinkResponse(id: string, service: LinkReader): Promise<Response> {
  return (await service.exists(id))
    ? jsonResponse({ success: false, error: "This link has expired." }, 410)
    : jsonResponse({ success: false, error: "File not found." }, 404);
}

function upstreamFailure(id: string, status: number): Response {
  console.error("Upstream fetch failed", id, status);
  if (status === 404) return jsonResponse({ success: false, error: "The file is no longer available." }, 404);
  if (status === 416) return jsonResponse({ success: false, error: "Requested range not satisfiable." }, 416);
  return jsonResponse({ success: false, error: "The storage provider is unavailable. Try again shortly." }, 502);
}

export async function handleDownload(
  request: Request,
  id: string,
  service: LinkReader,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ success: false, error: "Method not allowed." }, 405, { allow: "GET, HEAD" });
  }
  const found = await service.peek(id);
  if (!found) return deadLinkResponse(id, service);

  // Download-limited files are always served whole and every GET counts, so Range tricks cannot dodge the limit.
  const isLimited = found.maxDownloads !== null;
  const shouldCount = request.method === "GET" && (isLimited || startsAtBeginning(request));
  const record = shouldCount ? await service.claimDownload(id) : found;
  if (!record) return deadLinkResponse(id, service);

  const range = isLimited ? null : request.headers.get("range");
  const upstream = await fetchImpl(record.directUrl, { method: request.method, headers: range ? { range } : {} });
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    return upstreamFailure(record.id, upstream.status);
  }

  // Re-wrapping the upstream response (instead of building a new one) keeps Content-Length on HEAD replies.
  const response = new Response(upstream.body, upstream);
  for (const name of [...response.headers.keys()]) {
    if (!PASSTHROUGH_HEADERS.includes(name.toLowerCase())) response.headers.delete(name);
  }
  for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
  const disposition = wantsAttachment(new URL(request.url), record.contentType) ? "attachment" : "inline";
  response.headers.set("content-type", record.contentType);
  response.headers.set("content-disposition", contentDisposition(disposition, record.name));
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-robots-tag", "noindex");
  return response;
}

function parseUploadOptions(get: (name: string) => string | null): UploadOptions {
  const rawMax = get("max_downloads");
  if (rawMax !== null && !/^\d+$/.test(rawMax)) throw new UserError("max_downloads must be a whole number.");
  return { expiresIn: get("expires_in") ?? get("expires") ?? undefined, maxDownloads: rawMax === null ? undefined : Number(rawMax) };
}

function filenameFromPath(url: URL): string | null {
  const rest = url.pathname.replace(/^\/upload\/?/, "");
  if (!rest) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

async function uploadMultipart(request: Request, url: URL, service: FileService): Promise<Response> {
  // formData() holds the whole body in memory, so multipart is only for small files.
  const declared = Number(request.headers.get("content-length"));
  const cap = service.limits.maxBufferedBytes;
  if (!Number.isInteger(declared) || declared <= 0 || declared > cap) {
    throw new UserError(
      `Multipart uploads are limited to ${formatBytes(cap)}. For larger files send the raw file instead: curl -T ./file "${service.limits.baseUrl}/upload/<filename>".`,
      413,
    );
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw new UserError('Multipart uploads need a "file" field.');
  const field = (name: string): string | null => {
    const value = form.get(name);
    return typeof value === "string" ? value : url.searchParams.get(name);
  };
  const view = await service.upload({
    ...parseUploadOptions(field),
    name: field("filename") ?? filenameFromPath(url) ?? file.name,
    type: file.type || null,
    size: file.size,
    body: file.stream() as ReadableStream<Uint8Array>,
    source: "direct",
  });
  return jsonResponse({ success: true, data: view }, 201);
}

async function uploadRawBody(request: Request, url: URL, service: FileService): Promise<Response> {
  if (!request.body) throw new UserError("Request body is empty. Send the file as the body, e.g. curl -T ./file <url>.");
  const name = url.searchParams.get("filename") ?? filenameFromPath(url);
  if (!name) throw new UserError("Missing filename. Use PUT /upload/<filename> or add ?filename=<name>.");
  const declared = Number(request.headers.get("content-length"));
  const hasLength = Number.isInteger(declared) && declared > 0;
  const body = hasLength ? request.body : await readAllCapped(request.body, service.limits.maxBufferedBytes);
  const headerType = request.headers.get("content-type");
  const view = await service.upload({
    ...parseUploadOptions((key) => url.searchParams.get(key)),
    name: sanitizeFilename(name),
    // curl sends a generic type for --data-binary; prefer guessing from the filename then.
    type: headerType && !/x-www-form-urlencoded|octet-stream/.test(headerType) ? headerType : null,
    size: hasLength ? declared : (body as Uint8Array).byteLength,
    body: body as Uint8Array | ReadableStream<Uint8Array>,
    source: "direct",
  });
  return jsonResponse({ success: true, data: view }, 201);
}

/** PUT/POST /upload/<filename>?expires_in=1d&max_downloads=3 — raw body or multipart "file" field. */
export async function handleDirectUpload(request: Request, service: FileService): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "POST") {
    return jsonResponse({ success: false, error: "Use PUT or POST to upload." }, 405, { allow: "PUT, POST" });
  }
  try {
    const url = new URL(request.url);
    const isMultipart = (request.headers.get("content-type") ?? "").includes("multipart/form-data");
    return isMultipart ? await uploadMultipart(request, url, service) : await uploadRawBody(request, url, service);
  } catch (error) {
    return errorResponse(error);
  }
}
