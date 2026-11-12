/** Worker entry: resolves the caller's account, routes MCP / uploads / downloads; cron removes expired files. */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { cleanupExpired } from "./cleanup";
import { Sealer } from "./crypto";
import { CORS_HEADERS, errorResponse, handleDirectUpload, handleDownload, jsonResponse } from "./http";
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from "./mcp";
import { FileService, LinkReader } from "./service";
import { D1FileStore, D1TenantKeyStore } from "./store";
import { TenantVault } from "./tenants";
import { UploadThingClient, parseUploadThingToken, type UploadThingConfig } from "./uploadthing";
import { UserError } from "./util";

export interface Env {
  readonly DB: D1Database;
  /** Optional shared default account, used when a caller brings no token. */
  readonly UPLOADTHING_TOKEN?: string;
  /** Encrypts callers' API keys at rest and signs upload tickets. Required for bring-your-own tokens. */
  readonly TOKEN_ENCRYPTION_KEY?: string;
  readonly DEFAULT_EXPIRY?: string;
  readonly MAX_FILE_MB?: string;
  readonly PUBLIC_BASE_URL?: string;
}

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_MAX_FILE_MB = 512;
/** In-memory payloads are copied a few times on the way to storage; this keeps the peak far below the 128 MB isolate limit. */
const MAX_BUFFERED_BYTES = 16 * BYTES_PER_MB;
/** Largest MCP request body (a base64 upload of roughly 8 MB fits). */
const MCP_MAX_BODY_BYTES = 12 * BYTES_PER_MB;
const DOWNLOAD_ROUTE = /^\/([0-9A-Za-z]{7})(?:\.[A-Za-z0-9]{1,10})?\/?$/;
const TOKEN_HELP =
  "Pass your UPLOADTHING_TOKEN as 'Authorization: Bearer <token>', an 'x-api-key' header, or '?token=<token>' on the URL.";

function buildVault(env: Env): TenantVault {
  return new TenantVault({
    keys: new D1TenantKeyStore(env.DB),
    sealer: env.TOKEN_ENCRYPTION_KEY ? new Sealer(env.TOKEN_ENCRYPTION_KEY) : null,
    fallback: env.UPLOADTHING_TOKEN ? parseUploadThingToken(env.UPLOADTHING_TOKEN) : null,
  });
}

/** The token a caller supplied, from whichever place their client is able to put it. */
export function callerToken(request: Request, url: URL): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const candidates = [
    bearer?.[1],
    request.headers.get("x-api-key"),
    request.headers.get("x-uploadthing-token"),
    url.searchParams.get("token"),
    url.searchParams.get("api_key"),
  ];
  const token = candidates.find((candidate) => candidate && candidate.trim());
  return token ? token.trim() : null;
}

/** Whose UploadThing account this request acts on: an upload ticket, the caller's own token, or the default. */
async function resolveTenant(request: Request, url: URL, vault: TenantVault): Promise<UploadThingConfig> {
  const ticket = url.searchParams.get("ticket");
  if (ticket) return vault.redeemTicket(ticket);
  const token = callerToken(request, url);
  if (token) {
    try {
      return parseUploadThingToken(token);
    } catch {
      throw new UserError(`That is not a valid UPLOADTHING_TOKEN (copy it from the UploadThing dashboard, API Keys tab). ${TOKEN_HELP}`, 401);
    }
  }
  if (vault.defaultTenant) return vault.defaultTenant;
  throw new UserError(`This server has no default account. ${TOKEN_HELP}`, 401);
}

function baseUrlFor(env: Env, origin: string): string {
  return (env.PUBLIC_BASE_URL || origin).replace(/\/+$/, "");
}

function buildService(env: Env, baseUrl: string, tenant: UploadThingConfig, store: D1FileStore, vault: TenantVault): FileService {
  const maxFileMb = Number(env.MAX_FILE_MB) > 0 ? Number(env.MAX_FILE_MB) : DEFAULT_MAX_FILE_MB;
  return new FileService({
    store,
    storage: new UploadThingClient(tenant),
    config: {
      appId: tenant.appId,
      baseUrl,
      defaultExpiry: env.DEFAULT_EXPIRY || "1d",
      maxFileBytes: maxFileMb * BYTES_PER_MB,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
    },
    rememberTenant: () => vault.remember(tenant),
    issueUploadTicket: () => vault.issueTicket(tenant),
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Stateless Streamable HTTP: a fresh server + transport per request, JSON responses (no SSE needed). */
async function handleMcp(request: Request, service: FileService): Promise<Response> {
  const server = createMcpServer(service);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}

function methodNotAllowed(): Response {
  return jsonResponse(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: use POST." }, id: null },
    405,
    { allow: "POST" },
  );
}

function infoResponse(env: Env, baseUrl: string, hasDefaultAccount: boolean): Response {
  return jsonResponse({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: "Turns files into short, temporary, public download links.",
    mcp_endpoint: `${baseUrl}/mcp`,
    transport: "streamable-http",
    auth: hasDefaultAccount
      ? `Optional. ${TOKEN_HELP} Without a token, a shared public account is used.`
      : `Required. ${TOKEN_HELP}`,
    direct_upload: `curl -T ./file.png "${baseUrl}/upload/file.png?expires_in=1d" -H "Authorization: Bearer <UPLOADTHING_TOKEN>"`,
    default_expiry: env.DEFAULT_EXPIRY || "1d",
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(request.url);
  // "favicon" happens to be seven characters, so it would otherwise be looked up as a file id.
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });

  const store = new D1FileStore(env.DB);
  const download = DOWNLOAD_ROUTE.exec(url.pathname);
  if (download) return handleDownload(request, download[1], new LinkReader(store));

  const baseUrl = baseUrlFor(env, url.origin);
  const vault = buildVault(env);
  if (url.pathname === "/") return infoResponse(env, baseUrl, vault.defaultTenant !== null);

  const isMcp = url.pathname === "/mcp" || url.pathname === "/mcp/";
  const isUpload = url.pathname === "/upload" || url.pathname.startsWith("/upload/");
  if (!isMcp && !isUpload) return jsonResponse({ success: false, error: "Not found." }, 404);
  if (isMcp && request.method !== "POST") return methodNotAllowed();

  const tenant = await resolveTenant(request, url, vault);
  const service = buildService(env, baseUrl, tenant, store, vault);
  return isMcp ? handleMcp(request, service) : handleDirectUpload(request, service);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const vault = buildVault(env);
    const cleanup = cleanupExpired({
      store: new D1FileStore(env.DB),
      storageFor: async (appId) => {
        const tenant = await vault.credentials(appId);
        return tenant ? new UploadThingClient(tenant) : null;
      },
      now: () => Math.floor(Date.now() / 1000),
    });
    ctx.waitUntil(
      cleanup.then(
        (removed) => {
          if (removed > 0) console.warn(`Expired file cleanup removed ${removed} file(s).`);
        },
        (error: unknown) => console.error("Expired file cleanup failed", error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
