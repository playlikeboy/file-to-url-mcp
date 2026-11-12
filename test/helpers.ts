import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cleanupExpired } from "../src/cleanup";
import { FileService, type ServiceConfig } from "../src/service";
import { D1FileStore } from "../src/store";
import { UploadThingClient } from "../src/uploadthing";

export const BASE_URL = "https://f2u.test";
export const APP_ID = "testapp";
export const API_KEY = "sk_test_key";
export const TOKEN = btoa(JSON.stringify({ apiKey: API_KEY, appId: APP_ID, regions: ["sea1"] }));
export const NOW = 1_800_000_000;
export const TENANT_ID = "tenant-under-test";

type SqlValue = string | number | null;

/** Just enough of the D1 API, backed by an in-memory SQLite database running the real migration. */
export function createTestD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const migration of ["0001_init.sql", "0002_tenants.sql", "0003_tenant_ids.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const statement = (sql: string, params: SqlValue[]) => ({
    bind: (...next: SqlValue[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true };
    },
  });
  return { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database;
}

interface StoredFile {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly type: string;
}

export interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly json?: unknown;
}

export interface FakeUploadThing {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly files: Map<string, StoredFile>;
  readonly calls: FakeCall[];
  /** Force the next request whose URL contains `match` to fail with `status`. */
  failNext(match: string, status: number): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function serveFile(file: StoredFile, method: string, rangeHeader: string | undefined): Response {
  const base = { "content-type": file.type, "accept-ranges": "bytes", "cache-control": "public, max-age=86400" };
  const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : file.bytes.byteLength - 1;
    const slice = file.bytes.slice(start, end + 1);
    return new Response(method === "HEAD" ? null : slice, {
      status: 206,
      headers: { ...base, "content-length": String(slice.byteLength), "content-range": `bytes ${start}-${end}/${file.bytes.byteLength}` },
    });
  }
  return new Response(method === "HEAD" ? null : file.bytes, {
    status: 200,
    headers: { ...base, "content-length": String(file.bytes.byteLength) },
  });
}

/** In-memory stand-in for the UploadThing API, its ingest server and its CDN. */
export function createFakeUploadThing(): FakeUploadThing {
  const files = new Map<string, StoredFile>();
  const calls: FakeCall[] = [];
  const failures: { match: string; status: number }[] = [];
  let counter = 0;

  const api = (path: string, body: Record<string, unknown>): Response => {
    if (path === "/v7/prepareUpload") {
      counter += 1;
      const key = `key${String(counter).padStart(4, "0")}XYZ`;
      return json({ key, url: `https://sea1.ingest.uploadthing.com/${key}?signature=fake` });
    }
    if (path === "/v6/deleteFiles") {
      const keys = body.fileKeys as string[];
      const deletedCount = keys.filter((key) => files.delete(key)).length;
      return json({ success: true, deletedCount });
    }
    if (path === "/v6/renameFiles") {
      const [update] = body.updates as { fileKey: string; newName: string }[];
      const existing = files.get(update.fileKey);
      if (existing) files.set(update.fileKey, { ...existing, name: update.newName });
      return json({ success: true, renamedCount: existing ? 1 : 0 });
    }
    if (path === "/v6/getUsageInfo") {
      const totalBytes = [...files.values()].reduce((sum, file) => sum + file.bytes.byteLength, 0);
      return json({ totalBytes, appTotalBytes: totalBytes, filesUploaded: files.size, limitBytes: 2147483648 });
    }
    return json({ error: "unknown endpoint" }, 404);
  };

  const ingest = async (url: URL, init: RequestInit, headers: Record<string, string>): Promise<Response> => {
    const form = await new Response(init.body as BodyInit, { headers }).formData();
    const file = form.get("file") as File;
    const key = url.pathname.slice(1);
    files.set(key, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, type: file.type });
    return json({ ufsUrl: `https://${APP_ID}.ufs.sh/f/${key}`, fileHash: "hash" });
  };

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const isApi = url.hostname === "api.uploadthing.com";
    const body = isApi ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: input, method, headers, json: body });

    const failureIndex = failures.findIndex((failure) => input.includes(failure.match));
    if (failureIndex >= 0) {
      const [failure] = failures.splice(failureIndex, 1);
      return new Response("simulated failure", { status: failure.status });
    }
    if (isApi) return api(url.pathname, body ?? {});
    if (url.hostname.endsWith("ingest.uploadthing.com")) return ingest(url, init, headers);
    if (url.hostname.endsWith(".ufs.sh")) {
      const file = files.get(url.pathname.replace("/f/", ""));
      return file ? serveFile(file, method, headers.range) : new Response("not found", { status: 404 });
    }
    return new Response("unexpected host", { status: 500 });
  };

  return { fetch: fetchImpl, files, calls, failNext: (match, status) => void failures.push({ match, status }) };
}

export interface TestContext {
  readonly service: FileService;
  readonly store: D1FileStore;
  readonly uploadThing: FakeUploadThing;
  readonly clock: { now: number };
  /** Runs the expiry cron against this context's store and storage. */
  readonly cleanup: () => Promise<number>;
}

export function createTestContext(
  overrides: Partial<ServiceConfig> = {},
  sourceFetch?: (input: string, init?: RequestInit) => Promise<Response>,
): TestContext {
  const uploadThing = createFakeUploadThing();
  const store = new D1FileStore(createTestD1());
  const clock = { now: NOW };
  const storage = new UploadThingClient({ apiKey: API_KEY, appId: APP_ID }, uploadThing.fetch);
  const service = new FileService({
    store,
    storage,
    config: { tenantId: TENANT_ID, baseUrl: BASE_URL, defaultExpiry: "1d", maxFileBytes: 1024 * 1024, maxBufferedBytes: 64 * 1024, ...overrides },
    now: () => clock.now,
    fetchImpl: sourceFetch,
  });
  const cleanup = () => cleanupExpired({ store, storageFor: async () => storage, now: () => clock.now });
  return { service, store, uploadThing, clock, cleanup };
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A Response whose `url` is set, as it would be for a real network fetch. */
export function sourceResponse(url: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}
