import { describe, expect, test, vi } from "vitest";
import { FileService, readAllCapped } from "../src/service";
import { UploadThingClient } from "../src/uploadthing";
import { APP_ID, BASE_URL, NOW, createTestContext, sourceResponse, streamOf, textBytes } from "./helpers";

const HELLO = textBytes("hello");

function uploadHello(context: ReturnType<typeof createTestContext>, extra: Record<string, unknown> = {}) {
  return context.service.upload({ name: "hello.txt", size: HELLO.byteLength, body: HELLO, source: "text", ...extra });
}

describe("FileService.upload", () => {
  test("stores the file and returns short, download and direct links", async () => {
    const context = createTestContext();

    const view = await uploadHello(context);

    expect(view.url).toMatch(new RegExp(`^${BASE_URL}/[0-9A-Za-z]{7}\\.txt$`));
    expect(view.download_url).toBe(`${view.url}?download=1`);
    expect(view.direct_url).toBe(`https://${APP_ID}.ufs.sh/f/key0001XYZ`);
    expect(view).toMatchObject({ filename: "hello.txt", content_type: "text/plain", size_bytes: 5, size: "5 B", download_count: 0 });
  });

  test("applies the default expiry when none is given", async () => {
    const context = createTestContext({ defaultExpiry: "1w" });

    const view = await uploadHello(context);

    expect(view.expires_at).toBe(new Date((NOW + 604800) * 1000).toISOString());
    expect(view.expires_in).toBe("7d");
  });

  test("supports files that never expire", async () => {
    const context = createTestContext();

    const view = await uploadHello(context, { expiresIn: "never" });

    expect(view.expires_at).toBeNull();
    expect(view.expires_in).toBe("never");
  });

  test("records a download limit and treats 0 as unlimited", async () => {
    const context = createTestContext();

    const limited = await uploadHello(context, { maxDownloads: 3 });
    const unlimited = await uploadHello(context, { maxDownloads: 0 });

    expect(limited.max_downloads).toBe(3);
    expect(unlimited.max_downloads).toBeNull();
  });

  test("prefers an explicit content type and sanitises the filename", async () => {
    const context = createTestContext();

    const view = await uploadHello(context, { name: "../../evil name.bin", type: "Image/PNG; q=1" });

    expect(view.filename).toBe("evil name.bin");
    expect(view.content_type).toBe("image/png");
  });

  test("omits the extension from the link when the name has none", async () => {
    const context = createTestContext();

    const view = await uploadHello(context, { name: "README" });

    expect(view.url).toMatch(/\/[0-9A-Za-z]{7}$/);
  });

  test.each([
    ["an empty file", { size: 0 }, /empty/],
    ["an oversized file", { size: 2 * 1024 * 1024 }, /limit is 1\.00 MB/],
    ["a bad expiry", { expiresIn: "soon" }, /Invalid expires_in/],
    ["a negative download limit", { maxDownloads: -1 }, /max_downloads/],
  ])("rejects %s before touching storage", async (_label, extra, message) => {
    const context = createTestContext();

    await expect(uploadHello(context, extra)).rejects.toThrow(message);
    expect(context.uploadThing.calls).toHaveLength(0);
  });

  test("removes the stored bytes when metadata cannot be saved", async () => {
    const context = createTestContext();
    vi.spyOn(context.store, "insert").mockRejectedValue(new Error("db down"));

    await expect(uploadHello(context)).rejects.toThrow(/Could not save file metadata: db down/);
    expect(context.uploadThing.files.size).toBe(0);
  });

  test("does not retry or delete the bytes when a failed insert actually committed", async () => {
    const context = createTestContext();
    const realInsert = context.store.insert.bind(context.store);
    const insert = vi.spyOn(context.store, "insert").mockImplementation(async (record) => {
      await realInsert(record);
      throw new Error("network lost after commit");
    });

    const view = await uploadHello(context);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(context.uploadThing.files.size).toBe(1);
    expect((await context.service.get(view.id)).filename).toBe("hello.txt");
  });

  test("retries with a new id when the first insert collides", async () => {
    const context = createTestContext();
    const realInsert = context.store.insert.bind(context.store);
    const insert = vi.spyOn(context.store, "insert").mockRejectedValueOnce(new Error("D1_ERROR: UNIQUE constraint failed: files.id"));
    insert.mockImplementation(realInsert);

    const view = await uploadHello(context);

    expect(insert).toHaveBeenCalledTimes(2);
    expect((await context.service.get(view.id)).id).toBe(view.id);
  });
});

describe("FileService.uploadFromUrl", () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

  test("streams a file with a known length and names it from the URL", async () => {
    const source = vi.fn(async (url: string) =>
      sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png", "content-length": "8" } }),
    );
    const context = createTestContext({}, source);

    const view = await context.service.uploadFromUrl({ url: "https://cdn.example.com/img/cat%20pic.png?v=2" });

    expect(view).toMatchObject({ filename: "cat pic.png", content_type: "image/png", size_bytes: 8 });
    expect([...context.uploadThing.files.values()][0].bytes).toEqual(pngBytes);
    expect(source.mock.calls[0][1]?.redirect).toBe("manual");
  });

  test("buffers a response without a content-length", async () => {
    const context = createTestContext({}, async (url) => sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png" } }));

    const view = await context.service.uploadFromUrl({ url: "https://example.com/a.png" });

    expect(view.size_bytes).toBe(8);
  });

  test("buffers a compressed response instead of trusting its content-length", async () => {
    const context = createTestContext({}, async (url) =>
      sourceResponse(url, streamOf(pngBytes), { headers: { "content-length": "3", "content-encoding": "gzip" } }),
    );

    const view = await context.service.uploadFromUrl({ url: "https://example.com/a.bin" });

    expect(view.size_bytes).toBe(8);
  });

  test("uses the Content-Disposition name and adds an extension from the type", async () => {
    const context = createTestContext({}, async (url) =>
      sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="export"' } }),
    );

    const view = await context.service.uploadFromUrl({ url: "https://example.com/download?id=5" });

    expect(view.filename).toBe("export.png");
  });

  test("ignores a generic source type and goes by the filename", async () => {
    const context = createTestContext({}, async (url) =>
      sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "application/octet-stream", "content-length": "8" } }),
    );

    const view = await context.service.uploadFromUrl({ url: "https://raw.example.com/docs/paper.pdf" });

    expect(view).toMatchObject({ filename: "paper.pdf", content_type: "application/pdf" });
  });

  test("lets the caller override filename, type and request headers", async () => {
    const source = vi.fn(async (url: string) => sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "text/plain" } }));
    const context = createTestContext({}, source);

    const view = await context.service.uploadFromUrl({
      url: "https://example.com/x",
      filename: "clip.mp4",
      contentType: "video/mp4",
      headers: { authorization: "Bearer abc" },
    });

    expect(view).toMatchObject({ filename: "clip.mp4", content_type: "video/mp4" });
    expect(new Headers(source.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer abc");
  });

  test("follows redirects to public hosts", async () => {
    const source = vi.fn(async (url: string) =>
      url.includes("short.example")
        ? sourceResponse(url, null, { status: 302, headers: { location: "https://cdn.example.com/final.png" } })
        : sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png" } }),
    );
    const context = createTestContext({}, source);

    const view = await context.service.uploadFromUrl({ url: "https://short.example/abc" });

    expect(view.filename).toBe("final.png");
    expect(source).toHaveBeenCalledTimes(2);
  });

  test("does not forward caller headers to a different origin after a redirect", async () => {
    const source = vi.fn(async (url: string) =>
      url.includes("api.example")
        ? sourceResponse(url, null, { status: 302, headers: { location: "https://storage.other.example/blob.png" } })
        : sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png" } }),
    );
    const context = createTestContext({}, source);

    await context.service.uploadFromUrl({ url: "https://api.example/asset/1", headers: { authorization: "Bearer secret" } });

    expect(new Headers(source.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer secret");
    expect(new Headers(source.mock.calls[1][1]?.headers).get("authorization")).toBeNull();
  });

  test("keeps caller headers on a same-origin redirect", async () => {
    const source = vi.fn(async (url: string) =>
      url.endsWith("/old")
        ? sourceResponse(url, null, { status: 301, headers: { location: "/new.png" } })
        : sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png" } }),
    );
    const context = createTestContext({}, source);

    await context.service.uploadFromUrl({ url: "https://api.example/old", headers: { authorization: "Bearer secret" } });

    expect(new Headers(source.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer secret");
  });

  test("an empty filename falls back to the name from the source", async () => {
    const context = createTestContext({}, async (url) => sourceResponse(url, streamOf(pngBytes), { headers: { "content-type": "image/png" } }));

    const view = await context.service.uploadFromUrl({ url: "https://example.com/real-name.png", filename: "" });

    expect(view.filename).toBe("real-name.png");
  });

  test("refuses a redirect that points at a private address", async () => {
    const context = createTestContext({}, async (url) =>
      sourceResponse(url, null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    );

    await expect(context.service.uploadFromUrl({ url: "https://evil.example/x" })).rejects.toThrow(/private or loopback/);
  });

  test("gives up after too many redirects", async () => {
    const context = createTestContext({}, async (url) => sourceResponse(url, null, { status: 301, headers: { location: `${url}0` } }));

    await expect(context.service.uploadFromUrl({ url: "https://loop.example/a" })).rejects.toThrow(/too many times/);
  });

  test.each([
    ["an HTTP error", async (url: string) => sourceResponse(url, "nope", { status: 404 }), /HTTP 404/],
    ["an empty body", async (url: string) => sourceResponse(url, null, { status: 200 }), /empty response/],
    ["a network failure", async () => Promise.reject(new Error("connection refused")), /connection refused/],
  ])("reports %s from the source", async (_label, source, message) => {
    const context = createTestContext({}, source);

    await expect(context.service.uploadFromUrl({ url: "https://example.com/a.png" })).rejects.toThrow(message);
  });

  test("rejects private source URLs without fetching", async () => {
    const source = vi.fn();
    const context = createTestContext({}, source);

    await expect(context.service.uploadFromUrl({ url: "http://localhost:3000/a" })).rejects.toThrow(/private or loopback/);
    expect(source).not.toHaveBeenCalled();
  });
});

describe("FileService lookups", () => {
  test("finds a file by id, short link, link without extension, direct url and storage key", async () => {
    const context = createTestContext();
    const view = await uploadHello(context);
    const refs = [view.id, view.url, view.download_url, `${BASE_URL}/${view.id}`, view.direct_url, "key0001XYZ", `  ${view.id}  `];

    const found = await Promise.all(refs.map((ref) => context.service.get(ref)));

    expect(found.map((file) => file.id)).toEqual(refs.map(() => view.id));
  });

  test.each(["zzzzzzz", "", "https://f2u.test/", "http://[bad"])("reports %j as not found", async (ref) => {
    const context = createTestContext();

    await expect(context.service.get(ref)).rejects.toMatchObject({ status: 404 });
  });

  test("another account cannot see, update or delete the file, by any reference", async () => {
    const context = createTestContext();
    const view = await uploadHello(context);
    const outsider = new FileService({
      store: context.store,
      storage: new UploadThingClient({ apiKey: "sk_other", appId: "other-app" }, context.uploadThing.fetch),
      config: { ...context.service.limits, appId: "other-app" },
      now: () => context.clock.now,
    });

    for (const ref of [view.id, view.url, view.direct_url, "key0001XYZ"]) {
      await expect(outsider.get(ref)).rejects.toMatchObject({ status: 404 });
    }
    await expect(outsider.update(view.id, { expiresIn: "never" })).rejects.toMatchObject({ status: 404 });
    expect(await outsider.delete([view.id])).toEqual({ deleted: [], not_found: [view.id] });
    expect(await outsider.list(10, 0)).toEqual([]);
    expect((await context.service.get(view.id)).id).toBe(view.id);
  });

  test("records the account before uploading and exposes its upload ticket", async () => {
    const base = createTestContext();
    const rememberTenant = vi.fn(async () => undefined);
    const service = new FileService({
      store: base.store,
      storage: new UploadThingClient({ apiKey: "sk", appId: APP_ID }, base.uploadThing.fetch),
      config: base.service.limits,
      rememberTenant,
      issueUploadTicket: async () => "ticket-123",
    });

    await service.upload({ name: "a.txt", size: HELLO.byteLength, body: HELLO, source: "text" });

    expect(rememberTenant).toHaveBeenCalledTimes(1);
    expect(await service.uploadTicket()).toBe("ticket-123");
    expect(await base.service.uploadTicket()).toBeNull();
  });

  test("reports an expired file as gone", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { expiresIn: "10m" });
    context.clock.now = NOW + 601;

    await expect(context.service.get(view.id)).rejects.toMatchObject({ status: 410 });
  });

  test("lists live files newest first", async () => {
    const context = createTestContext();
    const first = await uploadHello(context);
    context.clock.now = NOW + 10;
    const second = await uploadHello(context);

    const listed = await context.service.list(10, 0);

    expect(listed.map((file) => file.id)).toEqual([second.id, first.id]);
  });
});

describe("FileService.delete", () => {
  test("removes files from storage and the database and reports misses", async () => {
    const context = createTestContext();
    const first = await uploadHello(context);
    const second = await uploadHello(context);

    const result = await context.service.delete([first.url, second.id, "zzzzzzz"]);

    expect(result.deleted.map((file) => file.id)).toEqual([first.id, second.id]);
    expect(result.not_found).toEqual(["zzzzzzz"]);
    expect(context.uploadThing.files.size).toBe(0);
    expect(await context.service.list(10, 0)).toEqual([]);
  });

  test("deletes a file once even when referenced twice", async () => {
    const context = createTestContext();
    const view = await uploadHello(context);

    const result = await context.service.delete([view.id, view.url]);

    expect(result.deleted).toHaveLength(1);
  });

  test("makes no storage call when nothing matches", async () => {
    const context = createTestContext();

    const result = await context.service.delete(["zzzzzzz"]);

    expect(result).toEqual({ deleted: [], not_found: ["zzzzzzz"] });
    expect(context.uploadThing.calls).toHaveLength(0);
  });

  test("can delete a file that has already expired", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { expiresIn: "10m" });
    context.clock.now = NOW + 3600;

    expect((await context.service.delete([view.id])).deleted).toHaveLength(1);
  });
});

describe("FileService.update", () => {
  test("extends the expiry measured from now", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { expiresIn: "10m" });
    context.clock.now = NOW + 300;

    const updated = await context.service.update(view.id, { expiresIn: "1d" });

    expect(updated.expires_at).toBe(new Date((NOW + 300 + 86400) * 1000).toISOString());
  });

  test("can remove the expiry and the download limit", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { maxDownloads: 2 });

    const updated = await context.service.update(view.id, { expiresIn: "never", maxDownloads: 0 });

    expect(updated).toMatchObject({ expires_at: null, max_downloads: null });
  });

  test("renames the file in storage and in the link", async () => {
    const context = createTestContext();
    const view = await uploadHello(context);

    const updated = await context.service.update(view.id, { filename: "report.pdf" });

    expect(updated.filename).toBe("report.pdf");
    expect(updated.url.endsWith(".pdf")).toBe(true);
    expect(context.uploadThing.files.get("key0001XYZ")?.name).toBe("report.pdf");
  });

  test("an empty expires_in leaves the expiry unchanged instead of making the file permanent", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { expiresIn: "10m" });

    const updated = await context.service.update(view.id, { expiresIn: "", maxDownloads: 4 });

    expect(updated.expires_at).toBe(view.expires_at);
  });

  test("leaves untouched fields alone", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { maxDownloads: 5 });

    const updated = await context.service.update(view.id, { expiresIn: "1w" });

    expect(updated).toMatchObject({ filename: "hello.txt", max_downloads: 5 });
  });

  test("fails for a missing file", async () => {
    const context = createTestContext();

    await expect(context.service.update("zzzzzzz", { expiresIn: "1d" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("FileService downloads and cleanup", () => {
  test("claimDownload counts downloads until the limit, then peek reports the file dead", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { maxDownloads: 1 });

    const first = await context.service.claimDownload(view.id);
    const second = await context.service.claimDownload(view.id);

    expect(first?.downloadCount).toBe(1);
    expect(second).toBeNull();
    expect(await context.service.peek(view.id)).toBeNull();
    expect(await context.service.exists(view.id)).toBe(true);
  });

  test("peek returns a live file without counting a download", async () => {
    const context = createTestContext();
    const view = await uploadHello(context);

    await context.service.peek(view.id);

    expect((await context.service.get(view.id)).download_count).toBe(0);
  });

  test("cleanup deletes expired and exhausted files and keeps the rest", async () => {
    const context = createTestContext();
    const expiring = await uploadHello(context, { expiresIn: "10m" });
    const burned = await uploadHello(context, { maxDownloads: 1 });
    const keeper = await uploadHello(context, { expiresIn: "never" });
    await context.service.claimDownload(burned.id);
    context.clock.now = NOW + 601;

    const removed = await context.cleanup();

    expect(removed).toBe(2);
    expect(context.uploadThing.files.size).toBe(1);
    expect(await context.service.exists(expiring.id)).toBe(false);
    expect(await context.service.exists(keeper.id)).toBe(true);
  });

  test("cleanup works through more files than one batch holds", async () => {
    const context = createTestContext();
    for (let index = 0; index < 105; index += 1) await uploadHello(context, { expiresIn: "10m" });
    context.clock.now = NOW + 601;

    expect(await context.cleanup()).toBe(105);
    expect(context.uploadThing.files.size).toBe(0);
  });

  test("cleanup keeps the database rows when storage deletion fails, so it can retry", async () => {
    const context = createTestContext();
    const view = await uploadHello(context, { expiresIn: "10m" });
    context.clock.now = NOW + 601;
    context.uploadThing.failNext("deleteFiles", 500);

    await expect(context.cleanup()).rejects.toThrow(/deleteFiles failed/);
    expect(await context.service.exists(view.id)).toBe(true);
    expect(await context.cleanup()).toBe(1);
  });

  test("usage combines database and storage totals", async () => {
    const context = createTestContext();
    await uploadHello(context);

    expect(await context.service.usage()).toMatchObject({
      tracked_files: 1,
      tracked_size: "5 B",
      storage_used: "5 B",
      storage_limit: "2.00 GB",
      storage_files: 1,
      default_expiry: "1d",
      max_file_size: "1.00 MB",
    });
  });
});

describe("readAllCapped", () => {
  test("concatenates chunks", async () => {
    const bytes = await readAllCapped(streamOf(textBytes("ab"), textBytes("cd")), 10);

    expect(new TextDecoder().decode(bytes)).toBe("abcd");
  });

  test("fails once the cap is exceeded", async () => {
    await expect(readAllCapped(streamOf(textBytes("abcdef"), textBytes("ghijkl")), 8)).rejects.toMatchObject({ status: 413 });
  });
});
