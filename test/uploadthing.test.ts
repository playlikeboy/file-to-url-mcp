import { describe, expect, test } from "vitest";
import { UploadThingClient, UploadThingError, buildMultipartEnvelope, parseUploadThingToken } from "../src/uploadthing";
import { API_KEY, APP_ID, TOKEN, createFakeUploadThing, streamOf, textBytes } from "./helpers";

function createClient() {
  const fake = createFakeUploadThing();
  return { fake, client: new UploadThingClient({ apiKey: API_KEY, appId: APP_ID }, fake.fetch) };
}

describe("parseUploadThingToken", () => {
  test("decodes the dashboard token", () => {
    expect(parseUploadThingToken(TOKEN)).toEqual({ apiKey: API_KEY, appId: APP_ID });
  });

  test("tolerates surrounding quotes and whitespace", () => {
    expect(parseUploadThingToken(` '${TOKEN}' `).appId).toBe(APP_ID);
  });

  test("throws when the secret is missing", () => {
    expect(() => parseUploadThingToken(undefined)).toThrow(/not set/);
  });

  test.each(["not-base64!", btoa("not json"), btoa(JSON.stringify({ apiKey: "only" }))])("throws on malformed token %j", (token) => {
    expect(() => parseUploadThingToken(token)).toThrow(/malformed/);
  });
});

describe("buildMultipartEnvelope", () => {
  test("wraps a single file part", () => {
    const envelope = buildMultipartEnvelope("a.txt", "text/plain", "BOUND");
    const decoder = new TextDecoder();
    expect(decoder.decode(envelope.prefix)).toBe(
      '--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n',
    );
    expect(decoder.decode(envelope.suffix)).toBe("\r\n--BOUND--\r\n");
  });

  test("neutralises quotes and line breaks in the filename and type", () => {
    const envelope = buildMultipartEnvelope('a"\r\nX: y.txt', "text/plain\r\nX: y", "B");
    const header = new TextDecoder().decode(envelope.prefix);
    expect(header).toContain('filename="a___X: y.txt"');
    expect(header.split("\r\n")).toHaveLength(5);
  });
});

describe("UploadThingClient.upload", () => {
  test("uploads in-memory bytes and returns the key and CDN url", async () => {
    const { fake, client } = createClient();

    const result = await client.upload({ name: "note.txt", size: 5, type: "text/plain", body: textBytes("hello") });

    expect(result).toEqual({ key: "key0001XYZ", url: `https://${APP_ID}.ufs.sh/f/key0001XYZ` });
    const stored = fake.files.get("key0001XYZ");
    expect(new TextDecoder().decode(stored?.bytes)).toBe("hello");
    expect(stored?.name).toBe("note.txt");
    expect(stored?.type).toBe("text/plain");
  });

  test("sends the api key and file details when requesting the presigned url", async () => {
    const { fake, client } = createClient();

    await client.upload({ name: "a.bin", size: 3, type: "application/octet-stream", body: new Uint8Array([1, 2, 3]) });

    const prepare = fake.calls[0];
    expect(prepare.url).toBe("https://api.uploadthing.com/v7/prepareUpload");
    expect(prepare.headers["x-uploadthing-api-key"]).toBe(API_KEY);
    expect(prepare.json).toMatchObject({ fileName: "a.bin", fileSize: 3, acl: "public-read" });
  });

  test.each([
    ["page.html", "text/html", "attachment"],
    ["logo.svg", "image/svg+xml", "attachment"],
    ["photo.png", "image/png", "inline"],
    ["clip.mp4", "video/mp4", "inline"],
  ])("stores %s (%s) so the CDN serves it as %s", async (name, type, disposition) => {
    const { fake, client } = createClient();

    await client.upload({ name, size: 1, type, body: textBytes("a") });

    expect(fake.calls[0].json).toMatchObject({ contentDisposition: disposition });
  });

  test("reports storage's own rejection of a streamed upload, not a stalled stream", async () => {
    const { fake, client } = createClient();
    fake.failNext("ingest.uploadthing.com", 413);

    const upload = client.upload({ name: "s.txt", size: 9, type: "text/plain", body: streamOf(textBytes("chunk-one")) });

    await expect(upload).rejects.toThrow(/rejected the upload \(413\)/);
  });

  test("streams a body of the declared size without buffering", async () => {
    const { fake, client } = createClient();
    const body = streamOf(textBytes("chunk-one "), textBytes("chunk-two"));

    const result = await client.upload({ name: "s.txt", size: 19, type: "text/plain", body });

    expect(new TextDecoder().decode(fake.files.get(result.key)?.bytes)).toBe("chunk-one chunk-two");
  });

  test("fails when the stream is shorter than declared", async () => {
    const { client } = createClient();

    const upload = client.upload({ name: "s.txt", size: 100, type: "text/plain", body: streamOf(textBytes("short")) });

    await expect(upload).rejects.toThrow(UploadThingError);
  });

  test("falls back to a constructed url when the ingest reply has none", async () => {
    const fake = createFakeUploadThing();
    const client = new UploadThingClient({ apiKey: API_KEY, appId: APP_ID }, async (input, init) =>
      input.includes("ingest") ? new Response("{}", { status: 200 }) : fake.fetch(input, init),
    );

    const result = await client.upload({ name: "a.txt", size: 1, type: "text/plain", body: textBytes("a") });

    expect(result.url).toBe(`https://${APP_ID}.ufs.sh/f/${result.key}`);
  });

  test("reports a rejected presign request", async () => {
    const { fake, client } = createClient();
    fake.failNext("prepareUpload", 401);

    const upload = client.upload({ name: "a.txt", size: 1, type: "text/plain", body: textBytes("a") });

    await expect(upload).rejects.toThrow(/prepareUpload failed \(401\)/);
  });

  test("reports a rejected file PUT", async () => {
    const { fake, client } = createClient();
    fake.failNext("ingest.uploadthing.com", 400);

    const upload = client.upload({ name: "a.txt", size: 1, type: "text/plain", body: textBytes("a") });

    await expect(upload).rejects.toThrow(/rejected the upload \(400\)/);
  });
});

describe("UploadThingClient management calls", () => {
  test("deletes keys in batches of 100 and sums the result", async () => {
    const { fake, client } = createClient();
    const keys = Array.from({ length: 250 }, (_, index) => `k${index}`);
    for (const key of keys) fake.files.set(key, { bytes: new Uint8Array(1), name: key, type: "text/plain" });

    const deleted = await client.deleteFiles(keys);

    expect(deleted).toBe(250);
    expect(fake.calls.map((call) => (call.json as { fileKeys: string[] }).fileKeys.length)).toEqual([100, 100, 50]);
    expect(fake.files.size).toBe(0);
  });

  test("makes no request when there is nothing to delete", async () => {
    const { fake, client } = createClient();

    expect(await client.deleteFiles([])).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  test("renames a file", async () => {
    const { fake, client } = createClient();
    const { key } = await client.upload({ name: "old.txt", size: 1, type: "text/plain", body: textBytes("a") });

    await client.renameFile(key, "new.txt");

    expect(fake.files.get(key)?.name).toBe("new.txt");
  });

  test("returns usage totals", async () => {
    const { client } = createClient();
    await client.upload({ name: "a.txt", size: 4, type: "text/plain", body: textBytes("abcd") });

    expect(await client.getUsage()).toEqual({ totalBytes: 4, filesUploaded: 1, limitBytes: 2147483648 });
  });

  test("surfaces API failures as UploadThingError with a 502 status", async () => {
    const { fake, client } = createClient();
    fake.failNext("getUsageInfo", 500);

    await expect(client.getUsage()).rejects.toMatchObject({ name: "UploadThingError", status: 502 });
  });
});
