/** MCP tool definitions. Each tool is a thin adapter over FileService. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOKEN_REJECTED_MESSAGE } from "./http";
import type { FileService } from "./service";
import { UploadThingError } from "./uploadthing";
import { UserError, decodeBase64, formatBytes, sanitizeFilename, splitDataUrl } from "./util";

export const SERVER_NAME = "file2url";
export const SERVER_VERSION = "1.0.0";

/** Cloudflare caps request bodies at 100 MB on Free/Pro plans; this is what /upload can accept. */
const DIRECT_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const BASE64_BYTES_PER_CHAR = 0.75;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_DELETE_BATCH = 50;

const FILE_REF_HELP = "The file's short link, its id, its direct_url, or its storage key.";

function uploadOptionShape(defaultExpiry: string) {
  return {
    expires_in: z
      .string()
      .optional()
      .describe(
        `How long until the file is auto-deleted. Examples: "10m", "1h", "1d", "1w", "30d", or "never". Default: "${defaultExpiry}".`,
      ),
    max_downloads: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Stop serving the short link after this many downloads (e.g. 1 = burn after reading). Omit or 0 for unlimited."),
  };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Only UserError text is shown to callers; storage and internal failures are logged, not echoed. */
function fail(error: unknown): CallToolResult {
  if (error instanceof UserError) return { isError: true, content: [{ type: "text", text: `Error: ${error.message}` }] };
  if (error instanceof UploadThingError && error.isAuthFailure) {
    return { isError: true, content: [{ type: "text", text: `Error: ${TOKEN_REJECTED_MESSAGE}` }] };
  }
  console.error("Tool failed", error);
  const message =
    error instanceof UploadThingError
      ? "The storage provider rejected the request. Try again shortly."
      : "Internal error while handling the request.";
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

async function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    return fail(error);
  }
}

function assertBuffered(byteLength: number, service: FileService): void {
  const cap = service.limits.maxBufferedBytes;
  if (byteLength > cap) {
    throw new UserError(`Inline content is limited to ${formatBytes(cap)}. Use create_upload_url or upload_from_url for larger files.`, 413);
  }
}

function registerUploadTools(server: McpServer, service: FileService): void {
  const options = uploadOptionShape(service.limits.defaultExpiry);
  const baseUrl = service.limits.baseUrl;

  server.registerTool(
    "upload_from_url",
    {
      title: "Upload file from URL",
      description:
        "Fetch any file (image, video, audio, PDF, archive, ...) from a public URL, store it, and return a short temporary public link. " +
        "Best for files that already live somewhere online. Large files are streamed, so videos work.",
      inputSchema: {
        url: z.string().describe("Public http(s) URL of the file to copy."),
        filename: z.string().optional().describe("Filename to give the stored file. Defaults to the name from the URL."),
        content_type: z.string().optional().describe('Override the MIME type, e.g. "video/mp4".'),
        headers: z.record(z.string(), z.string()).optional().describe("Extra request headers for the source URL (e.g. Authorization)."),
        ...options,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      run(() =>
        service.uploadFromUrl({
          url: args.url,
          filename: args.filename,
          contentType: args.content_type,
          headers: args.headers,
          expiresIn: args.expires_in,
          maxDownloads: args.max_downloads,
        }),
      ),
  );

  server.registerTool(
    "upload_text",
    {
      title: "Upload text as a file",
      description:
        "Save text content (markdown, JSON, CSV, HTML, code, logs, ...) as a file and return a short temporary public link.",
      inputSchema: {
        content: z.string().min(1).describe("The text content of the file."),
        filename: z.string().describe('Filename including extension, e.g. "report.md" or "data.csv".'),
        content_type: z.string().optional().describe("Override the MIME type. Defaults to one guessed from the extension."),
        ...options,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      run(() => {
        const bytes = new TextEncoder().encode(args.content);
        assertBuffered(bytes.byteLength, service);
        return service.upload({
          name: args.filename,
          type: args.content_type,
          size: bytes.byteLength,
          body: bytes,
          source: "text",
          expiresIn: args.expires_in,
          maxDownloads: args.max_downloads,
        });
      }),
  );

  server.registerTool(
    "upload_base64",
    {
      title: "Upload base64 file",
      description:
        "Upload a small binary file passed as base64 (or a data: URL) and return a short temporary public link. " +
        "For anything larger than a few MB, prefer create_upload_url (local files) or upload_from_url (online files).",
      inputSchema: {
        data: z.string().min(1).describe('Base64-encoded file bytes. A "data:<mime>;base64," prefix is accepted.'),
        filename: z.string().describe('Filename including extension, e.g. "chart.png".'),
        content_type: z.string().optional().describe("Override the MIME type. Defaults to one guessed from the data URL or extension."),
        ...options,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      run(() => {
        const { mime, payload } = splitDataUrl(args.data);
        // Checked before decoding: decoding first would let an oversized string exhaust Worker memory.
        assertBuffered(Math.floor(payload.length * BASE64_BYTES_PER_CHAR), service);
        const bytes = decodeBase64(payload);
        return service.upload({
          name: args.filename,
          type: args.content_type ?? mime,
          size: bytes.byteLength,
          body: bytes,
          source: "base64",
          expiresIn: args.expires_in,
          maxDownloads: args.max_downloads,
        });
      }),
  );

  server.registerTool(
    "create_upload_url",
    {
      title: "Get a direct upload URL for a local file",
      description:
        "Returns a ready-to-run upload command for a file on the local disk or sandbox (any type, up to 100 MB). " +
        "Run the returned curl command with a shell tool; its JSON response contains the short public link. " +
        "Use this for local images, videos and other binaries instead of base64.",
      inputSchema: {
        filename: z.string().describe('Name the file should have once uploaded, e.g. "demo.mp4".'),
        ...options,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const query = new URLSearchParams();
        if (args.expires_in) query.set("expires_in", args.expires_in);
        if (args.max_downloads) query.set("max_downloads", String(args.max_downloads));
        // The ticket stands in for the caller's token, which is never handed back to the model.
        const ticket = await service.uploadTicket();
        if (ticket) query.set("ticket", ticket);
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        const uploadUrl = `${baseUrl}/upload/${encodeURIComponent(sanitizeFilename(args.filename))}${suffix}`;
        return {
          upload_url: uploadUrl,
          method: "PUT",
          max_size: formatBytes(DIRECT_UPLOAD_LIMIT_BYTES),
          curl: `curl -sS -T "<path-to-local-file>" "${uploadUrl}"`,
          powershell: `Invoke-RestMethod -Method Put -InFile "<path-to-local-file>" -Uri "${uploadUrl}"`,
          valid_for: ticket ? "1 hour" : "no time limit",
          response: "JSON { success, data: { url, download_url, direct_url, expires_at, ... } }",
        };
      }),
  );
}

function registerManagementTools(server: McpServer, service: FileService): void {
  server.registerTool(
    "get_file",
    {
      title: "Get file info",
      description: "Look up a file's links, size, type, expiry and download count.",
      inputSchema: { file: z.string().describe(FILE_REF_HELP) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => service.get(args.file)),
  );

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List currently live files, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`How many to return (default ${DEFAULT_LIST_LIMIT}).`),
        offset: z.number().int().min(0).optional().describe("How many to skip, for pagination."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const limit = args.limit ?? DEFAULT_LIST_LIMIT;
        const offset = args.offset ?? 0;
        const files = await service.list(limit, offset);
        return { files, count: files.length, limit, offset, has_more: files.length === limit };
      }),
  );

  server.registerTool(
    "delete_files",
    {
      title: "Delete files",
      description:
        "Permanently delete one or more files right away (their links stop working). Call this once a temporary file is no longer needed.",
      inputSchema: {
        files: z.array(z.string()).min(1).max(MAX_DELETE_BATCH).describe(`Files to delete. Each item: ${FILE_REF_HELP}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => service.delete(args.files)),
  );

  server.registerTool(
    "update_file",
    {
      title: "Update file expiry, limit or name",
      description: "Change when a file auto-deletes (measured from now), its download limit, or its filename.",
      inputSchema: {
        file: z.string().describe(FILE_REF_HELP),
        expires_in: z.string().optional().describe('New lifetime from now: "1h", "1d", "1w", ... or "never".'),
        max_downloads: z.number().int().min(0).optional().describe("New download limit. 0 removes the limit."),
        filename: z.string().optional().describe("New filename."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(() => {
        if (args.expires_in === undefined && args.max_downloads === undefined && args.filename === undefined) {
          throw new UserError("Nothing to update: pass expires_in, max_downloads or filename.");
        }
        return service.update(args.file, {
          expiresIn: args.expires_in,
          maxDownloads: args.max_downloads,
          filename: args.filename,
        });
      }),
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get storage usage",
      description: "Show how much storage is used, the storage limit, and the server's upload limits and default expiry.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(() => service.usage()),
  );
}

export function createMcpServer(service: FileService): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Turns files into short, temporary, public download links. " +
        "Use upload_from_url for files already online, upload_text for text you generate, upload_base64 for small binaries, " +
        "and create_upload_url for local files (run the returned curl command). " +
        `Files auto-delete after ${service.limits.defaultExpiry} unless expires_in says otherwise; call delete_files when a file is no longer needed.`,
    },
  );
  registerUploadTools(server, service);
  registerManagementTools(server, service);
  return server;
}
