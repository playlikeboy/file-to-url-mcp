/** Minimal UploadThing REST client (no SDK) so uploads can be streamed through the Worker. */

import { isInlineSafe } from "./util";

const API_BASE = "https://api.uploadthing.com";
const DELETE_BATCH_SIZE = 100;

export interface UploadThingConfig {
  readonly apiKey: string;
  readonly appId: string;
}

export interface UploadInput {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  /** In-memory bytes, or a stream that yields exactly `size` bytes. */
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
}

export interface UploadedFile {
  readonly key: string;
  readonly url: string;
}

export interface UsageInfo {
  readonly totalBytes: number;
  readonly filesUploaded: number;
  readonly limitBytes: number;
}

export interface StorageProvider {
  upload(input: UploadInput): Promise<UploadedFile>;
  deleteFiles(keys: readonly string[]): Promise<number>;
  renameFile(key: string, newName: string): Promise<void>;
  getUsage(): Promise<UsageInfo>;
}

export class UploadThingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** HTTP status UploadThing itself answered with (0 if the request never completed). */
    readonly upstreamStatus = 0,
  ) {
    super(message);
    this.name = "UploadThingError";
  }

  /** UploadThing refused the API key: the caller's token is wrong, revoked, or for another app. */
  get isAuthFailure(): boolean {
    return this.upstreamStatus === 401 || this.upstreamStatus === 403;
  }
}

/** UPLOADTHING_TOKEN is base64(JSON{apiKey, appId, regions}). */
export function parseUploadThingToken(token: string | undefined): UploadThingConfig {
  if (!token) throw new Error("UPLOADTHING_TOKEN secret is not set.");
  try {
    const cleaned = token.trim().replace(/^['"]|['"]$/g, "");
    const parsed = JSON.parse(atob(cleaned)) as Partial<UploadThingConfig>;
    if (typeof parsed.apiKey !== "string" || typeof parsed.appId !== "string") throw new Error("missing fields");
    // Both values end up in a request header / hostname, so they must be plain tokens.
    if (!/^[\x21-\x7e]+$/.test(parsed.apiKey) || !/^[a-z0-9]+$/i.test(parsed.appId)) throw new Error("unexpected characters");
    return { apiKey: parsed.apiKey, appId: parsed.appId };
  } catch {
    throw new Error("UPLOADTHING_TOKEN is malformed (expected the base64 token from the UploadThing dashboard).");
  }
}

export interface MultipartEnvelope {
  readonly boundary: string;
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
}

/** Bytes that wrap a single "file" part, so the payload itself can be streamed in between. */
export function buildMultipartEnvelope(name: string, type: string, boundary: string): MultipartEnvelope {
  const encoder = new TextEncoder();
  const safeName = name.replace(/["\\\r\n]/g, "_");
  const safeType = type.replace(/[\r\n]/g, "");
  return {
    boundary,
    prefix: encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${safeType}\r\n\r\n`,
    ),
    suffix: encoder.encode(`\r\n--${boundary}--\r\n`),
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UploadThingClient implements StorageProvider {
  constructor(
    private readonly config: UploadThingConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async upload(input: UploadInput): Promise<UploadedFile> {
    const presigned = await this.api<{ key: string; url: string }>("/v7/prepareUpload", {
      fileName: input.name,
      fileSize: input.size,
      fileType: input.type,
      // Also applies to the direct CDN link, so HTML/SVG uploads cannot be rendered from there either.
      contentDisposition: isInlineSafe(input.type) ? "inline" : "attachment",
      acl: "public-read",
    });
    const envelope = buildMultipartEnvelope(input.name, input.type, `----file2url${crypto.randomUUID().replace(/-/g, "")}`);
    const response = await this.putFile(presigned.url, envelope, input);
    if (!response.ok) {
      throw new UploadThingError(`UploadThing rejected the upload (${response.status}): ${await safeText(response)}`, 502);
    }
    const result = (await response.json().catch(() => ({}))) as { ufsUrl?: string };
    return { key: presigned.key, url: result.ufsUrl ?? `https://${this.config.appId}.ufs.sh/f/${presigned.key}` };
  }

  async deleteFiles(keys: readonly string[]): Promise<number> {
    let deleted = 0;
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      const result = await this.api<{ deletedCount: number }>("/v6/deleteFiles", { fileKeys: batch });
      deleted += result.deletedCount ?? 0;
    }
    return deleted;
  }

  async renameFile(key: string, newName: string): Promise<void> {
    await this.api("/v6/renameFiles", { updates: [{ fileKey: key, newName }] });
  }

  async getUsage(): Promise<UsageInfo> {
    const usage = await this.api<UsageInfo>("/v6/getUsageInfo", {});
    return { totalBytes: usage.totalBytes, filesUploaded: usage.filesUploaded, limitBytes: usage.limitBytes };
  }

  private putFile(url: string, envelope: MultipartEnvelope, input: UploadInput): Promise<Response> {
    const headers = { "content-type": `multipart/form-data; boundary=${envelope.boundary}` };
    if (input.body instanceof Uint8Array) {
      const body = new Blob([envelope.prefix, input.body, envelope.suffix]);
      return this.fetchImpl(url, { method: "PUT", headers, body });
    }
    return this.putStream(url, headers, envelope, input.body, input.size);
  }

  /** Streams prefix + file + suffix with a known total length (no buffering in Worker memory). */
  private async putStream(
    url: string,
    headers: Record<string, string>,
    envelope: MultipartEnvelope,
    source: ReadableStream<Uint8Array>,
    size: number,
  ): Promise<Response> {
    const total = envelope.prefix.byteLength + size + envelope.suffix.byteLength;
    const { readable, writable } = new FixedLengthStream(total);
    const pump = (async () => {
      const head = writable.getWriter();
      await head.write(envelope.prefix);
      head.releaseLock();
      await source.pipeTo(writable, { preventClose: true });
      const tail = writable.getWriter();
      await tail.write(envelope.suffix);
      await tail.close();
    })();
    // The pump's outcome is checked below; this only stops an early return leaving an unhandled rejection.
    pump.catch(() => undefined);
    try {
      const response = await this.fetchImpl(url, { method: "PUT", headers, body: readable });
      // Storage can reject before the body is fully sent: report its reply, not the stalled pump.
      if (response.ok) await pump;
      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UploadThingError(`Streaming the file to storage failed: ${detail}`, 502);
    }
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploadthing-api-key": this.config.apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new UploadThingError(`UploadThing API ${path} failed (${response.status}): ${await safeText(response)}`, 502, response.status);
    }
    return (await response.json()) as T;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
