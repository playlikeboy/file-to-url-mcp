import { beforeEach, describe, expect, test } from "vitest";
import { D1FileStore, type FileRecord } from "../src/store";
import { NOW, createTestD1 } from "./helpers";

function record(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "aaaaaaa",
    appId: "app-a",
    fileKey: "key-a",
    name: "a.txt",
    size: 10,
    contentType: "text/plain",
    directUrl: "https://cdn.test/f/key-a",
    source: "text",
    createdAt: NOW,
    expiresAt: NOW + 3600,
    maxDownloads: null,
    downloadCount: 0,
    ...overrides,
  };
}

describe("D1FileStore", () => {
  let store: D1FileStore;

  beforeEach(() => {
    store = new D1FileStore(createTestD1());
  });

  test("round-trips a record by id and by storage key", async () => {
    const original = record();
    await store.insert(original);

    expect(await store.findById("aaaaaaa")).toEqual(original);
    expect(await store.findByKey("key-a")).toEqual(original);
  });

  test("returns null for unknown ids and keys", async () => {
    expect(await store.findById("missing")).toBeNull();
    expect(await store.findByKey("missing")).toBeNull();
  });

  test("rejects a duplicate id", async () => {
    await store.insert(record());

    await expect(store.insert(record({ fileKey: "other" }))).rejects.toThrow();
  });

  test("lists live files newest first and paginates", async () => {
    await store.insert(record({ id: "old0000", fileKey: "k1", createdAt: NOW - 30 }));
    await store.insert(record({ id: "mid0000", fileKey: "k2", createdAt: NOW - 20 }));
    await store.insert(record({ id: "new0000", fileKey: "k3", createdAt: NOW - 10 }));

    const firstPage = await store.list({ appId: "app-a", limit: 2, offset: 0, now: NOW });
    const secondPage = await store.list({ appId: "app-a", limit: 2, offset: 2, now: NOW });

    expect(firstPage.map((file) => file.id)).toEqual(["new0000", "mid0000"]);
    expect(secondPage.map((file) => file.id)).toEqual(["old0000"]);
  });

  test("list and stats only cover the requested app", async () => {
    await store.insert(record({ id: "mine000", fileKey: "k1", size: 7 }));
    await store.insert(record({ id: "theirs0", fileKey: "k2", appId: "app-b", size: 100 }));

    const listed = await store.list({ appId: "app-a", limit: 10, offset: 0, now: NOW });

    expect(listed.map((file) => file.id)).toEqual(["mine000"]);
    expect(await store.stats("app-a")).toEqual({ fileCount: 1, totalBytes: 7 });
    expect(await store.stats("app-b")).toEqual({ fileCount: 1, totalBytes: 100 });
  });

  test("list hides expired and exhausted files", async () => {
    await store.insert(record({ id: "live000", fileKey: "k1" }));
    await store.insert(record({ id: "forever", fileKey: "k2", expiresAt: null }));
    await store.insert(record({ id: "expired", fileKey: "k3", expiresAt: NOW - 1 }));
    await store.insert(record({ id: "burned0", fileKey: "k4", maxDownloads: 1, downloadCount: 1 }));

    const listed = await store.list({ appId: "app-a", limit: 10, offset: 0, now: NOW });

    expect(listed.map((file) => file.id).sort()).toEqual(["forever", "live000"]);
  });

  test("update changes only the supplied fields", async () => {
    await store.insert(record());

    const updated = await store.update("aaaaaaa", { name: "b.txt", expiresAt: null });

    expect(updated).toMatchObject({ name: "b.txt", expiresAt: null, maxDownloads: null, size: 10 });
  });

  test("update with an empty patch returns the record unchanged", async () => {
    await store.insert(record());

    expect(await store.update("aaaaaaa", {})).toEqual(record());
  });

  test("update returns null for an unknown id", async () => {
    expect(await store.update("missing", { name: "x" })).toBeNull();
  });

  test("claimDownload increments the counter", async () => {
    await store.insert(record());

    const claimed = await store.claimDownload("aaaaaaa", NOW);

    expect(claimed?.downloadCount).toBe(1);
  });

  test("claimDownload refuses once the download limit is reached", async () => {
    await store.insert(record({ maxDownloads: 2 }));

    const results = [
      await store.claimDownload("aaaaaaa", NOW),
      await store.claimDownload("aaaaaaa", NOW),
      await store.claimDownload("aaaaaaa", NOW),
    ];

    expect(results.map((result) => result?.downloadCount ?? null)).toEqual([1, 2, null]);
  });

  test("claimDownload refuses an expired file", async () => {
    await store.insert(record({ expiresAt: NOW }));

    expect(await store.claimDownload("aaaaaaa", NOW)).toBeNull();
  });

  test("findDead returns expired and exhausted files only", async () => {
    await store.insert(record({ id: "live000", fileKey: "k1" }));
    await store.insert(record({ id: "forever", fileKey: "k2", expiresAt: null }));
    await store.insert(record({ id: "expired", fileKey: "k3", expiresAt: NOW }));
    await store.insert(record({ id: "burned0", fileKey: "k4", maxDownloads: 1, downloadCount: 1 }));

    const dead = await store.findDead(NOW, 10);

    expect(dead.map((file) => file.id).sort()).toEqual(["burned0", "expired"]);
  });

  test("findDead honours its limit", async () => {
    await store.insert(record({ id: "expire1", fileKey: "k1", expiresAt: NOW - 5 }));
    await store.insert(record({ id: "expire2", fileKey: "k2", expiresAt: NOW - 5 }));

    expect(await store.findDead(NOW, 1)).toHaveLength(1);
  });

  test("deleteMany removes many rows across chunks", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `id${String(index).padStart(5, "0")}`);
    for (const id of ids) await store.insert(record({ id, fileKey: `key-${id}` }));

    await store.deleteMany(ids.slice(0, 119));

    expect(await store.stats("app-a")).toEqual({ fileCount: 1, totalBytes: 10 });
  });

  test("stats is zero for an empty table", async () => {
    expect(await store.stats("app-a")).toEqual({ fileCount: 0, totalBytes: 0 });
  });
});
