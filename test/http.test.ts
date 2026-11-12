import { describe, expect, test, vi } from "vitest";
import { errorResponse, handleDirectUpload, handleDownload } from "../src/http";
import { UploadThingError } from "../src/uploadthing";
import { UserError } from "../src/util";
import { BASE_URL, NOW, createTestContext, textBytes } from "./helpers";

type Context = ReturnType<typeof createTestContext>;

async function seed(context: Context, name = "hello.txt", extra: Record<string, unknown> = {}) {
  const bytes = textBytes("hello world");
  return context.service.upload({ name, size: bytes.byteLength, body: bytes, source: "text", ...extra });
}

function download(context: Context, id: string, init: RequestInit = {}, query = "") {
  return handleDownload(new Request(`${BASE_URL}/${id}${query}`, init), id, context.service, context.uploadThing.fetch);
}

describe("handleDownload", () => {
  test("serves the file inline with safe headers", async () => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello world");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe("11");
    expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="hello\.txt"/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test.each(["?download=1", "?dl=1", "?download"])("forces a download with %s", async (query) => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id, {}, query);

    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("download=0 keeps the file inline", async () => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id, {}, "?download=0");

    expect(response.headers.get("content-disposition")).toMatch(/^inline/);
  });

  test.each(["page.html", "drawing.svg", "feed.xml", "script.js"])("always serves %s as an attachment", async (name) => {
    const context = createTestContext();
    const view = await seed(context, name);

    const response = await download(context, view.id);

    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("does not forward upstream caching headers", async () => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id);

    expect(response.headers.get("cache-control")).not.toContain("max-age");
  });

  test("passes Range requests through as 206", async () => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id, { headers: { range: "bytes=6-10" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await response.text()).toBe("world");
  });

  test("answers HEAD with headers and no body", async () => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("11");
    expect(await response.text()).toBe("");
  });

  test("counts whole-file GETs but not HEADs or mid-file ranges", async () => {
    const context = createTestContext();
    const view = await seed(context);

    await download(context, view.id);
    await download(context, view.id, { headers: { range: "bytes=0-" } });
    await download(context, view.id, { method: "HEAD" });
    await download(context, view.id, { headers: { range: "bytes=5-9" } });

    expect((await context.service.get(view.id)).download_count).toBe(2);
  });

  test("stops serving after max_downloads and answers 410", async () => {
    const context = createTestContext();
    const view = await seed(context, "once.txt", { maxDownloads: 1 });

    const first = await download(context, view.id);
    const second = await download(context, view.id);
    const head = await download(context, view.id, { method: "HEAD" });

    expect([first.status, second.status, head.status]).toEqual([200, 410, 410]);
  });

  test("answers 410 for an expired link and 404 for an unknown one", async () => {
    const context = createTestContext();
    const view = await seed(context, "soon.txt", { expiresIn: "10m" });
    context.clock.now = NOW + 601;

    const expired = await download(context, view.id);
    const unknown = await download(context, "zzzzzzz");

    expect(expired.status).toBe(410);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ success: false, error: "File not found." });
  });

  test("a download-limited file ignores Range, is served whole, and every GET counts", async () => {
    const context = createTestContext();
    const view = await seed(context, "twice.txt", { maxDownloads: 2 });

    const first = await download(context, view.id, { headers: { range: "bytes=1-" } });
    const second = await download(context, view.id, { headers: { range: "bytes=-3" } });
    const third = await download(context, view.id, { headers: { range: "bytes=5-" } });

    expect(first.status).toBe(200);
    expect(await first.text()).toBe("hello world");
    expect([second.status, third.status]).toEqual([200, 410]);
  });

  test("answers 502 when the storage provider errors", async () => {
    const context = createTestContext();
    const view = await seed(context);
    context.uploadThing.failNext("ufs.sh", 500);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await download(context, view.id);

    expect(response.status).toBe(502);
  });

  test("answers 404 when storage no longer has the file", async () => {
    const context = createTestContext();
    const view = await seed(context);
    context.uploadThing.files.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await download(context, view.id);

    expect(response.status).toBe(404);
  });

  test("rejects methods other than GET and HEAD", async () => {
    const context = createTestContext();
    const view = await seed(context);

    const response = await download(context, view.id, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("handleDirectUpload", () => {
  function put(context: Context, path: string, body: BodyInit | null, headers: Record<string, string> = {}, method = "PUT") {
    const init = { method, body, headers, duplex: "half" } as RequestInit;
    return handleDirectUpload(new Request(`${BASE_URL}${path}`, init), context.service);
  }

  test("stores a raw body named by the path", async () => {
    const context = createTestContext();

    const response = await put(context, "/upload/my%20clip.mp4?expires_in=1h&max_downloads=3", textBytes("video-bytes"), {
      "content-length": "11",
    });
    const payload = (await response.json()) as { success: boolean; data: Record<string, unknown> };

    expect(response.status).toBe(201);
    expect(payload.success).toBe(true);
    expect(payload.data).toMatchObject({ filename: "my clip.mp4", content_type: "video/mp4", size_bytes: 11, max_downloads: 3, expires_in: "1h" });
    expect(new TextDecoder().decode([...context.uploadThing.files.values()][0].bytes)).toBe("video-bytes");
  });

  test("accepts the filename as a query parameter and POST as the method", async () => {
    const context = createTestContext();

    const response = await put(context, "/upload?filename=data.csv", textBytes("a,b"), { "content-length": "3" }, "POST");

    expect(((await response.json()) as { data: { filename: string } }).data.filename).toBe("data.csv");
  });

  test("buffers a body that has no content-length", async () => {
    const context = createTestContext();
    const stream = new Blob([textBytes("streamed")]).stream();

    const response = await put(context, "/upload/s.txt", stream);

    expect(((await response.json()) as { data: { size_bytes: number } }).data.size_bytes).toBe(8);
  });

  test("uses an explicit content type but ignores curl's generic ones", async () => {
    const context = createTestContext();

    const explicit = await put(context, "/upload/a.bin", textBytes("x"), { "content-length": "1", "content-type": "image/webp" });
    const generic = await put(context, "/upload/b.png", textBytes("x"), { "content-length": "1", "content-type": "application/octet-stream" });

    expect(((await explicit.json()) as { data: { content_type: string } }).data.content_type).toBe("image/webp");
    expect(((await generic.json()) as { data: { content_type: string } }).data.content_type).toBe("image/png");
  });

  /** Serialises a form the way curl -F would, including the Content-Length header. */
  async function multipartRequest(form: FormData): Promise<Request> {
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    const headers = { "content-type": encoded.headers.get("content-type") ?? "", "content-length": String(body.byteLength) };
    return new Request(`${BASE_URL}/upload`, { method: "POST", body, headers });
  }

  test("accepts a multipart form with a file field and form options", async () => {
    const context = createTestContext();
    const form = new FormData();
    form.append("file", new Blob(["a,b\n1,2\n"], { type: "text/csv" }), "sheet.csv");
    form.append("expires_in", "5m");

    const response = await handleDirectUpload(await multipartRequest(form), context.service);
    const payload = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(201);
    expect(payload.data).toMatchObject({ filename: "sheet.csv", content_type: "text/csv", expires_in: "5m" });
  });

  test("rejects a multipart form without a file", async () => {
    const context = createTestContext();
    const form = new FormData();
    form.append("note", "no file here");

    const response = await handleDirectUpload(await multipartRequest(form), context.service);

    expect(response.status).toBe(400);
  });

  test("refuses a multipart body larger than the in-memory cap and points to raw upload", async () => {
    const context = createTestContext({ maxBufferedBytes: 64 });
    const form = new FormData();
    form.append("file", new Blob(["x".repeat(500)]), "big.bin");

    const response = await handleDirectUpload(await multipartRequest(form), context.service);

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toContain("curl -T");
    expect(context.uploadThing.calls).toHaveLength(0);
  });

  test("refuses a multipart body with no declared length", async () => {
    const context = createTestContext();
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.bin");

    const response = await handleDirectUpload(new Request(`${BASE_URL}/upload`, { method: "POST", body: form }), context.service);

    expect(response.status).toBe(413);
  });

  test.each([
    ["a missing filename", "/upload", /Missing filename/],
    ["a bad max_downloads", "/upload/a.txt?max_downloads=lots", /whole number/],
    ["a bad expiry", "/upload/a.txt?expires_in=soon", /Invalid expires_in/],
  ])("rejects %s with a 400", async (_label, path, message) => {
    const context = createTestContext();

    const response = await put(context, path, textBytes("x"), { "content-length": "1" });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
  });

  test("rejects an empty body", async () => {
    const context = createTestContext();

    const response = await put(context, "/upload/a.txt", null);

    expect(response.status).toBe(400);
  });

  test("rejects a file over the size limit with 413", async () => {
    const context = createTestContext({ maxFileBytes: 4 });

    const response = await put(context, "/upload/a.txt", textBytes("too big"), { "content-length": "7" });

    expect(response.status).toBe(413);
  });

  test("rejects GET", async () => {
    const context = createTestContext();

    const response = await handleDirectUpload(new Request(`${BASE_URL}/upload/a.txt`), context.service);

    expect(response.status).toBe(405);
  });
});

describe("errorResponse", () => {
  test("shows user errors as-is", async () => {
    const response = errorResponse(new UserError("Bad input.", 422));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: "Bad input." });
  });

  test("hides storage and internal error details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const storage = errorResponse(new UploadThingError("secret upstream detail", 502));
    const internal = errorResponse(new Error("stack detail"));

    expect(storage.status).toBe(502);
    expect(JSON.stringify(await storage.json())).not.toContain("secret");
    expect(internal.status).toBe(500);
    expect(await internal.json()).toEqual({ success: false, error: "Internal error." });
    expect(log).toHaveBeenCalledTimes(2);
  });
});
