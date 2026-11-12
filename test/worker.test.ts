/** Integration tests: real Worker entry + real MCP transport, with D1 and UploadThing faked. */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { API_KEY, BASE_URL, TOKEN, createFakeUploadThing, createTestD1, sourceResponse, type FakeUploadThing } from "./helpers";

const BOB_KEY = "sk_test_bob";
const BOB_TOKEN = btoa(JSON.stringify({ apiKey: BOB_KEY, appId: "bobapp", regions: ["sea1"] }));
const AS_BOB = { headers: { authorization: `Bearer ${BOB_TOKEN}` } };

interface Caller {
  readonly headers?: Record<string, string>;
  readonly query?: string;
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface ToolOutcome {
  readonly isError: boolean;
  readonly data: any;
  readonly text: string;
}

let env: Env;
let uploadThing: FakeUploadThing;
let rpcId = 0;

beforeEach(() => {
  uploadThing = createFakeUploadThing();
  env = { DB: createTestD1(), UPLOADTHING_TOKEN: TOKEN, TOKEN_ENCRYPTION_KEY: "test-encryption-secret", DEFAULT_EXPIRY: "1d", MAX_FILE_MB: "1" };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://files.example/")) {
      return sourceResponse(url, "remote file body", { headers: { "content-type": "text/plain", "content-length": "16" } });
    }
    return uploadThing.fetch(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${BASE_URL}${path}`, init), env);
}

async function rpc(method: string, params: unknown = {}, caller: Caller = {}): Promise<any> {
  rpcId += 1;
  const response = await request(`/mcp${caller.query ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...caller.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  return response.json();
}

async function callTool(name: string, args: Record<string, unknown> = {}, caller: Caller = {}): Promise<ToolOutcome> {
  const reply = await rpc("tools/call", { name, arguments: args }, caller);
  const text: string = reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
  const isError = Boolean(reply.result?.isError) || !reply.result;
  try {
    return { isError, data: JSON.parse(text), text };
  } catch {
    return { isError, data: null, text };
  }
}

describe("MCP protocol", () => {
  test("initialize identifies the server and gives usage instructions", async () => {
    const reply = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });

    expect(reply.result.serverInfo).toEqual({ name: "file2url", version: "1.0.0" });
    expect(reply.result.instructions).toContain("delete_files");
  });

  test("lists every tool with a schema", async () => {
    const reply = await rpc("tools/list");

    const names = reply.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      "upload_from_url",
      "upload_text",
      "upload_base64",
      "create_upload_url",
      "get_file",
      "list_files",
      "delete_files",
      "update_file",
      "get_usage",
    ]);
    expect(reply.result.tools.every((tool: { inputSchema: { type: string } }) => tool.inputSchema.type === "object")).toBe(true);
  });

  test("answers GET /mcp with 405 because the server is stateless", async () => {
    const response = await request("/mcp");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("adds CORS headers to MCP replies and answers preflight", async () => {
    const post = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const preflight = await request("/mcp", { method: "OPTIONS" });

    expect(post.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.status).toBe(204);
  });

  test("rejects arguments that fail schema validation", async () => {
    const outcome = await callTool("delete_files", { files: [] });

    expect(outcome.isError).toBe(true);
  });
});

describe("upload tools", () => {
  test("upload_text returns a link that serves the text", async () => {
    const outcome = await callTool("upload_text", { content: "# hi", filename: "note.md", expires_in: "10m" });

    expect(outcome.isError).toBe(false);
    expect(outcome.data).toMatchObject({ filename: "note.md", content_type: "text/markdown", expires_in: "10m" });
    const served = await request(new URL(outcome.data.url).pathname);
    expect(await served.text()).toBe("# hi");
  });

  test("upload_base64 accepts a data URL and keeps the bytes intact", async () => {
    const outcome = await callTool("upload_base64", { data: `data:image/png;base64,${PNG_BASE64}`, filename: "pixel", max_downloads: 1 });

    expect(outcome.data).toMatchObject({ content_type: "image/png", max_downloads: 1 });
    const served = await request(`/${outcome.data.id}`);
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(PNG_BASE64);
  });

  test("upload_base64 reports invalid data as a tool error", async () => {
    const outcome = await callTool("upload_base64", { data: "!!!not base64!!!", filename: "x.bin" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not valid base64");
  });

  test("upload_from_url copies a remote file", async () => {
    const outcome = await callTool("upload_from_url", { url: "https://files.example/docs/readme.txt", expires_in: "1w" });

    expect(outcome.data).toMatchObject({ filename: "readme.txt", size_bytes: 16, expires_in: "7d" });
  });

  test("upload_from_url refuses private addresses", async () => {
    const outcome = await callTool("upload_from_url", { url: "http://127.0.0.1/secret" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("private or loopback");
  });

  test("inline uploads over the configured size are refused", async () => {
    const outcome = await callTool("upload_text", { content: "x".repeat(1024 * 1024 + 1), filename: "big.txt" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/limit/);
  });

  test("create_upload_url returns a command that the upload endpoint accepts", async () => {
    const outcome = await callTool("create_upload_url", { filename: "big video.mp4", expires_in: "1h", max_downloads: 2 });

    expect(outcome.data.upload_url).toBe(`${BASE_URL}/upload/big%20video.mp4?expires_in=1h&max_downloads=2`);
    expect(outcome.data.curl).toContain(outcome.data.upload_url);
    const uploaded = await request(new URL(outcome.data.upload_url).pathname + new URL(outcome.data.upload_url).search, {
      method: "PUT",
      body: "fake video",
      headers: { "content-length": "10" },
    });
    expect(((await uploaded.json()) as { data: Record<string, unknown> }).data).toMatchObject({ filename: "big video.mp4", max_downloads: 2 });
  });

  test("create_upload_url omits the query string when no options are given", async () => {
    const outcome = await callTool("create_upload_url", { filename: "a.png" });

    expect(outcome.data.upload_url).toBe(`${BASE_URL}/upload/a.png`);
  });

  test("a storage outage is reported without leaking upstream detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    uploadThing.failNext("prepareUpload", 500);

    const outcome = await callTool("upload_text", { content: "x", filename: "a.txt" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).not.toContain("simulated failure");
  });
});

describe("management tools", () => {
  test("get_file, update_file, list_files and delete_files work together", async () => {
    const created = await callTool("upload_text", { content: "v1", filename: "a.txt" });

    const fetched = await callTool("get_file", { file: created.data.url });
    const updated = await callTool("update_file", { file: created.data.id, expires_in: "never", filename: "b.txt", max_downloads: 9 });
    const listed = await callTool("list_files", { limit: 5 });
    const deleted = await callTool("delete_files", { files: [created.data.url, "zzzzzzz"] });
    const afterDelete = await callTool("get_file", { file: created.data.id });

    expect(fetched.data.id).toBe(created.data.id);
    expect(updated.data).toMatchObject({ filename: "b.txt", expires_at: null, max_downloads: 9 });
    expect(listed.data).toMatchObject({ count: 1, limit: 5, offset: 0, has_more: false });
    expect(deleted.data).toEqual({ deleted: [{ id: created.data.id, filename: "b.txt" }], not_found: ["zzzzzzz"] });
    expect(afterDelete.isError).toBe(true);
    expect(uploadThing.files.size).toBe(0);
  });

  test("update_file with nothing to change is an error", async () => {
    const created = await callTool("upload_text", { content: "v1", filename: "a.txt" });

    const outcome = await callTool("update_file", { file: created.data.id });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Nothing to update");
  });

  test("get_usage reports storage totals and limits", async () => {
    await callTool("upload_text", { content: "12345", filename: "a.txt" });

    const outcome = await callTool("get_usage");

    expect(outcome.data).toMatchObject({ tracked_files: 1, storage_used: "5 B", default_expiry: "1d", max_file_size: "1.00 MB" });
  });
});

describe("HTTP routes", () => {
  test("GET / describes the server and its MCP endpoint", async () => {
    const response = await request("/");

    expect(await response.json()).toMatchObject({ name: "file2url", mcp_endpoint: `${BASE_URL}/mcp`, transport: "streamable-http" });
  });

  test("PUBLIC_BASE_URL overrides the request origin in links", async () => {
    env = { ...env, PUBLIC_BASE_URL: "https://dl.example.com/" };

    const response = await request("/");

    expect(((await response.json()) as { mcp_endpoint: string }).mcp_endpoint).toBe("https://dl.example.com/mcp");
  });

  test("short links work with and without the extension", async () => {
    const created = await callTool("upload_text", { content: "body", filename: "a.txt" });

    const withExtension = await request(`/${created.data.id}.txt`);
    const withoutExtension = await request(`/${created.data.id}`);

    expect([withExtension.status, withoutExtension.status]).toEqual([200, 200]);
  });

  test.each(["/nope", "/toolongidentifier", "/abc/def"])("answers 404 for %s", async (path) => {
    expect((await request(path)).status).toBe(404);
  });

  test("favicon requests are answered without a database lookup", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");

    const response = await request("/favicon.ico");

    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  test("an MCP request body over 12 MB is refused before it is parsed", async () => {
    const outcome = await callTool("upload_base64", { data: "A".repeat(13 * 1024 * 1024), filename: "big.bin" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Payload Too Large");
    expect(uploadThing.calls).toHaveLength(0);
  });

  test("a malformed server-side token produces a 500 without detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    env = { ...env, UPLOADTHING_TOKEN: "garbage-not-a-token" };

    const response = await request("/");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: "Internal error." });
  });
});

describe("bring your own UploadThing token", () => {
  function apiKeysUsed(pathFragment: string): string[] {
    return uploadThing.calls.filter((call) => call.url.includes(pathFragment)).map((call) => call.headers["x-uploadthing-api-key"]);
  }

  test.each([
    ["an Authorization bearer header", { headers: { authorization: `Bearer ${BOB_TOKEN}` } }],
    ["an x-api-key header", { headers: { "x-api-key": BOB_TOKEN } }],
    ["an x-uploadthing-token header", { headers: { "x-uploadthing-token": BOB_TOKEN } }],
    ["a ?token= URL parameter", { query: `?token=${encodeURIComponent(BOB_TOKEN)}` }],
    ["a ?api_key= URL parameter", { query: `?api_key=${encodeURIComponent(BOB_TOKEN)}` }],
  ])("uploads into the caller's own account when given %s", async (_label, caller) => {
    const outcome = await callTool("upload_text", { content: "mine", filename: "mine.txt" }, caller);

    expect(outcome.isError).toBe(false);
    expect(apiKeysUsed("prepareUpload")).toEqual([BOB_KEY]);
  });

  test("uses the shared default account when no token is given", async () => {
    await callTool("upload_text", { content: "shared", filename: "shared.txt" });

    expect(apiKeysUsed("prepareUpload")).toEqual([API_KEY]);
  });

  test("accounts cannot list, read or delete each other's files", async () => {
    const shared = await callTool("upload_text", { content: "shared", filename: "shared.txt" });
    const bobs = await callTool("upload_text", { content: "bob", filename: "bob.txt" }, AS_BOB);

    const bobList = await callTool("list_files", {}, AS_BOB);
    const sharedList = await callTool("list_files");
    const peek = await callTool("get_file", { file: shared.data.id }, AS_BOB);
    const steal = await callTool("delete_files", { files: [shared.data.url, shared.data.direct_url] }, AS_BOB);
    const reverse = await callTool("delete_files", { files: [bobs.data.id] });

    expect(bobList.data.files.map((file: { id: string }) => file.id)).toEqual([bobs.data.id]);
    expect(sharedList.data.files.map((file: { id: string }) => file.id)).toEqual([shared.data.id]);
    expect(peek.isError).toBe(true);
    expect(steal.data.deleted).toEqual([]);
    expect(reverse.data.deleted).toEqual([]);
    expect(uploadThing.files.size).toBe(2);
  });

  test("a file's short link needs no token, whoever uploaded it", async () => {
    const bobs = await callTool("upload_text", { content: "bob's file", filename: "bob.txt" }, AS_BOB);

    const served = await request(`/${bobs.data.id}`);

    expect(await served.text()).toBe("bob's file");
  });

  test("get_usage reports only the caller's own files", async () => {
    await callTool("upload_text", { content: "shared-file", filename: "shared.txt" });
    await callTool("upload_text", { content: "bob", filename: "bob.txt" }, AS_BOB);

    const usage = await callTool("get_usage", {}, AS_BOB);

    expect(usage.data).toMatchObject({ tracked_files: 1, tracked_size: "3 B" });
  });

  test("create_upload_url hands out a ticket, not the token, and the ticket uploads into the caller's account", async () => {
    const outcome = await callTool("create_upload_url", { filename: "clip.mp4" }, AS_BOB);
    const uploadUrl = new URL(outcome.data.upload_url);

    const uploaded = await request(uploadUrl.pathname + uploadUrl.search, { method: "PUT", body: "video", headers: { "content-length": "5" } });
    const listed = await callTool("list_files", {}, AS_BOB);

    expect(outcome.text).not.toContain(BOB_TOKEN);
    expect(outcome.text).not.toContain(BOB_KEY);
    expect(uploadUrl.searchParams.get("ticket")).toBeTruthy();
    expect(outcome.data.valid_for).toBe("1 hour");
    expect(uploaded.status).toBe(201);
    expect(apiKeysUsed("prepareUpload")).toEqual([BOB_KEY]);
    expect(listed.data.count).toBe(1);
  });

  test("create_upload_url needs no ticket for the default account", async () => {
    const outcome = await callTool("create_upload_url", { filename: "clip.mp4" });

    expect(outcome.data.upload_url).not.toContain("ticket=");
    expect(outcome.data.valid_for).toBe("no time limit");
  });

  test("a forged upload ticket is refused", async () => {
    const response = await request("/upload/a.txt?ticket=forged", { method: "PUT", body: "x", headers: { "content-length": "1" } });

    expect(response.status).toBe(401);
    expect(uploadThing.calls).toHaveLength(0);
  });

  test("the direct upload endpoint accepts a bearer token", async () => {
    const response = await request("/upload/a.txt", {
      method: "PUT",
      body: "x",
      headers: { "content-length": "1", authorization: `Bearer ${BOB_TOKEN}` },
    });

    expect(response.status).toBe(201);
    expect(apiKeysUsed("prepareUpload")).toEqual([BOB_KEY]);
  });

  test.each(["not-a-token", btoa("{}"), "sk_live_rawsecretkey"])("a malformed token %j is refused with a helpful 401", async (token) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toContain("not a valid UPLOADTHING_TOKEN");
  });

  test("a token UploadThing rejects is reported as a bad token", async () => {
    uploadThing.failNext("prepareUpload", 401);

    const outcome = await callTool("upload_text", { content: "x", filename: "a.txt" }, AS_BOB);

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("UploadThing rejected the API key");
  });

  test("with no default account, a token is required", async () => {
    env = { ...env, UPLOADTHING_TOKEN: undefined };

    const anonymous = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const withToken = await callTool("upload_text", { content: "x", filename: "a.txt" }, AS_BOB);
    const info = (await (await request("/")).json()) as { auth: string };

    expect(anonymous.status).toBe(401);
    expect(withToken.isError).toBe(false);
    expect(info.auth).toMatch(/^Required/);
  });

  test("without TOKEN_ENCRYPTION_KEY, own tokens are refused with a clear reason", async () => {
    env = { ...env, TOKEN_ENCRYPTION_KEY: undefined };

    const outcome = await callTool("upload_text", { content: "x", filename: "a.txt" }, AS_BOB);

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("TOKEN_ENCRYPTION_KEY");
    expect(uploadThing.files.size).toBe(0);
  });

  test("the cron deletes a caller's expired file with that caller's stored key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bobs = await callTool("upload_text", { content: "once", filename: "once.txt", max_downloads: 1 }, AS_BOB);
    await request(`/${bobs.data.id}`);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) } as unknown as ExecutionContext;

    await worker.scheduled({} as ScheduledController, env, ctx);
    await Promise.all(pending);

    expect(apiKeysUsed("deleteFiles")).toEqual([BOB_KEY]);
    expect(uploadThing.files.size).toBe(0);
  });
});

describe("scheduled cleanup", () => {
  function runScheduled(): Promise<unknown> {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) } as unknown as ExecutionContext;
    return worker.scheduled({} as ScheduledController, env, ctx).then(() => Promise.all(pending));
  }

  test("deletes files whose download limit is used up", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const burned = await callTool("upload_text", { content: "once", filename: "once.txt", max_downloads: 1 });
    const kept = await callTool("upload_text", { content: "keep", filename: "keep.txt" });
    await request(`/${burned.data.id}`);

    await runScheduled();

    expect(uploadThing.files.size).toBe(1);
    expect((await request(`/${burned.data.id}`)).status).toBe(404);
    expect((await request(`/${kept.data.id}`)).status).toBe(200);
  });

  test("logs instead of throwing when storage is down", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const burned = await callTool("upload_text", { content: "once", filename: "once.txt", max_downloads: 1 });
    await request(`/${burned.data.id}`);
    uploadThing.failNext("deleteFiles", 500);

    await expect(runScheduled()).resolves.toBeDefined();
    expect(log).toHaveBeenCalledWith("Expired file cleanup failed", expect.anything());
  });
});
