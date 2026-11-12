import { describe, expect, test, vi } from "vitest";
import { cleanupExpired } from "../src/cleanup";
import { Sealer } from "../src/crypto";
import { D1FileStore, D1TenantKeyStore, type FileRecord } from "../src/store";
import { TenantVault, UPLOAD_TICKET_TTL_SECONDS, tenantFor, type Tenant } from "../src/tenants";
import { UploadThingClient } from "../src/uploadthing";
import { NOW, createFakeUploadThing, createTestD1 } from "./helpers";

const DEFAULT_CREDENTIALS = { appId: "default-app", apiKey: "sk_default" };
const ALICE_CREDENTIALS = { appId: "alice-app", apiKey: "sk_alice" };

async function createVault(options: { sealer?: Sealer | null; withDefault?: boolean } = {}) {
  const keys = new D1TenantKeyStore(createTestD1());
  const clock = { now: NOW };
  const fallback = options.withDefault === false ? null : await tenantFor(DEFAULT_CREDENTIALS);
  const alice = await tenantFor(ALICE_CREDENTIALS);
  const vault = new TenantVault({
    keys,
    sealer: options.sealer === undefined ? new Sealer("test-secret") : options.sealer,
    fallback,
    now: () => clock.now,
  });
  return { vault, keys, clock, alice, fallback: fallback as Tenant };
}

describe("tenantFor", () => {
  test("derives a stable id from the secret key, not from the public app id", async () => {
    const first = await tenantFor({ appId: "app-one", apiKey: "sk_same" });
    const sameKeyOtherApp = await tenantFor({ appId: "app-two", apiKey: "sk_same" });
    const sameAppOtherKey = await tenantFor({ appId: "app-one", apiKey: "sk_different" });

    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    expect(sameKeyOtherApp.id).toBe(first.id);
    expect(sameAppOtherKey.id).not.toBe(first.id);
    expect(first.id).not.toContain("sk_same");
  });
});

describe("Sealer", () => {
  test("round-trips text and never produces the same ciphertext twice", async () => {
    const sealer = new Sealer("secret");

    const first = await sealer.seal("sk_live_abc", "purpose");
    const second = await sealer.seal("sk_live_abc", "purpose");

    expect(first).not.toBe(second);
    expect(first).not.toContain("sk_live");
    expect(await sealer.open(first, "purpose")).toBe("sk_live_abc");
  });

  test("refuses values sealed with another key, tampered values and junk", async () => {
    const sealed = await new Sealer("secret").seal("value", "purpose");
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");

    expect(await new Sealer("other").open(sealed, "purpose")).toBeNull();
    expect(await new Sealer("secret").open(flipped, "purpose")).toBeNull();
    expect(await new Sealer("secret").open("short", "purpose")).toBeNull();
    expect(await new Sealer("secret").open("%%%not base64%%%", "purpose")).toBeNull();
  });

  test("a value sealed for one purpose cannot be opened as another", async () => {
    const sealer = new Sealer("secret");
    const sealed = await sealer.seal("value", "credentials:alice");

    expect(await sealer.open(sealed, "upload-ticket")).toBeNull();
    expect(await sealer.open(sealed, "credentials:bob")).toBeNull();
    expect(await sealer.open(sealed, "credentials:alice")).toBe("value");
  });
});

describe("D1TenantKeyStore", () => {
  test("saves, finds and overwrites a tenant's credentials", async () => {
    const keys = new D1TenantKeyStore(createTestD1());

    await keys.save("tenant", "sealed-1", NOW);
    await keys.save("tenant", "sealed-2", NOW + 1);

    expect(await keys.find("tenant")).toBe("sealed-2");
    expect(await keys.find("unknown")).toBeNull();
  });
});

describe("TenantVault", () => {
  test("stores a caller's credentials encrypted and returns them later", async () => {
    const { vault, keys, alice } = await createVault();

    await vault.remember(alice);

    expect(await keys.find(alice.id)).not.toContain(ALICE_CREDENTIALS.apiKey);
    expect(await vault.credentials(alice.id)).toEqual(ALICE_CREDENTIALS);
  });

  test("never stores the default account and serves it from configuration", async () => {
    const { vault, keys, fallback } = await createVault();

    await vault.remember(fallback);

    expect(await keys.find(fallback.id)).toBeNull();
    expect(await vault.credentials(fallback.id)).toEqual(DEFAULT_CREDENTIALS);
    expect(vault.defaultTenant).toEqual(fallback);
  });

  test("returns null for a tenant it has never seen", async () => {
    const { vault } = await createVault();

    expect(await vault.credentials("stranger")).toBeNull();
  });

  test("returns null when stored credentials cannot be decrypted or are malformed", async () => {
    const sealer = new Sealer("test-secret");
    const { vault, keys } = await createVault({ sealer });
    await keys.save("garbled", "garbage", NOW);
    await keys.save("wrong-shape", await sealer.seal(JSON.stringify({ apiKey: 42 }), "credentials:wrong-shape"), NOW);

    expect(await vault.credentials("garbled")).toBeNull();
    expect(await vault.credentials("wrong-shape")).toBeNull();
  });

  test("issues a ticket that resolves back to the caller's account", async () => {
    const { vault, alice } = await createVault();

    const ticket = await vault.issueTicket(alice);

    expect(ticket).not.toContain(ALICE_CREDENTIALS.apiKey);
    expect(await vault.redeemTicket(ticket as string)).toEqual(alice);
  });

  test("a stored credentials blob cannot be replayed as an upload ticket", async () => {
    const { vault, keys, alice } = await createVault();
    await vault.remember(alice);
    const storedBlob = (await keys.find(alice.id)) as string;

    await expect(vault.redeemTicket(storedBlob)).rejects.toMatchObject({ status: 401 });
  });

  test("does not rewrite credentials that are already on file", async () => {
    const { vault, keys, alice } = await createVault();
    await vault.remember(alice);
    const save = vi.spyOn(keys, "save");

    await vault.remember(alice);

    expect(save).not.toHaveBeenCalled();
  });

  test("issues no ticket for the default account", async () => {
    const { vault, fallback } = await createVault();

    expect(await vault.issueTicket(fallback)).toBeNull();
  });

  test("rejects expired, forged and foreign tickets", async () => {
    const { vault, clock, alice } = await createVault();
    const ticket = (await vault.issueTicket(alice)) as string;
    const foreign = await new Sealer("another-server").seal(JSON.stringify({ tenantId: alice.id, expiresAt: NOW + 999 }), "upload-ticket");
    clock.now = NOW + UPLOAD_TICKET_TTL_SECONDS;

    await expect(vault.redeemTicket(ticket)).rejects.toMatchObject({ status: 401 });
    await expect(vault.redeemTicket("forged")).rejects.toMatchObject({ status: 401 });
    await expect(vault.redeemTicket(foreign)).rejects.toMatchObject({ status: 401 });
  });

  test("rejects a ticket for an account whose credentials are gone", async () => {
    const sealer = new Sealer("test-secret");
    const { vault } = await createVault({ sealer });
    const orphan = await sealer.seal(JSON.stringify({ tenantId: "deleted-tenant", expiresAt: NOW + 60 }), "upload-ticket");

    await expect(vault.redeemTicket(orphan)).rejects.toThrow(/no longer matches/);
  });

  test("without an encryption key, own tokens are refused but the default account still works", async () => {
    const { vault, alice, fallback } = await createVault({ sealer: null });

    await expect(vault.remember(alice)).rejects.toMatchObject({ status: 503 });
    await expect(vault.redeemTicket("anything")).rejects.toMatchObject({ status: 401 });
    expect(await vault.credentials(alice.id)).toBeNull();
    expect(await vault.credentials(fallback.id)).toEqual(DEFAULT_CREDENTIALS);
  });

  test("works with no default account at all", async () => {
    const { vault, alice } = await createVault({ withDefault: false });

    await vault.remember(alice);

    expect(vault.defaultTenant).toBeNull();
    expect(await vault.credentials(alice.id)).toEqual(ALICE_CREDENTIALS);
  });
});

describe("cleanupExpired", () => {
  function expired(id: string, tenantId: string): FileRecord {
    return {
      id,
      tenantId,
      fileKey: `key-${id}`,
      name: `${id}.txt`,
      size: 1,
      contentType: "text/plain",
      directUrl: `https://cdn.test/f/key-${id}`,
      source: "text",
      createdAt: NOW - 100,
      expiresAt: NOW - 1,
      maxDownloads: null,
      downloadCount: 0,
    };
  }

  test("deletes each account's files with that account's own key", async () => {
    const store = new D1FileStore(createTestD1());
    const fake = createFakeUploadThing();
    await store.insert(expired("aaaaaa1", "alice"));
    await store.insert(expired("bbbbbb1", "bob"));

    const removed = await cleanupExpired({
      store,
      storageFor: async (tenantId) => new UploadThingClient({ appId: "any", apiKey: `sk_${tenantId}` }, fake.fetch),
      now: () => NOW,
    });

    expect(removed).toBe(2);
    const keysUsed = fake.calls.map((call) => [call.headers["x-uploadthing-api-key"], (call.json as { fileKeys: string[] }).fileKeys]);
    expect(keysUsed).toEqual(
      expect.arrayContaining([
        ["sk_alice", ["key-aaaaaa1"]],
        ["sk_bob", ["key-bbbbbb1"]],
      ]),
    );
  });

  test("drops records whose account revoked its key, and still cleans everyone else", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new D1FileStore(createTestD1());
    const fake = createFakeUploadThing();
    const earlier = { ...expired("revoked", "mallory"), createdAt: NOW - 500 };
    await store.insert(earlier);
    await store.insert(expired("aaaaaa1", "alice"));
    fake.files.set("key-aaaaaa1", { bytes: new Uint8Array(1), name: "a", type: "text/plain" });
    fake.failNext("deleteFiles", 401);
    const deps = {
      store,
      storageFor: async (tenantId: string) => new UploadThingClient({ appId: "any", apiKey: `sk_${tenantId}` }, fake.fetch),
      now: () => NOW,
    };

    const removed = await cleanupExpired(deps);

    expect(removed).toBe(1);
    expect(await store.findById("revoked")).toBeNull();
    expect(await store.findById("aaaaaa1")).toBeNull();
    expect(fake.files.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the key for account "mallory" was revoked'));
    log.mockRestore();
  });

  test("keeps records for a retry on a temporary storage error, without blocking other accounts", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new D1FileStore(createTestD1());
    const fake = createFakeUploadThing();
    await store.insert({ ...expired("flaky01", "flaky"), createdAt: NOW - 500 });
    await store.insert(expired("aaaaaa1", "alice"));
    fake.failNext("deleteFiles", 503);
    const deps = {
      store,
      storageFor: async (tenantId: string) => new UploadThingClient({ appId: "any", apiKey: `sk_${tenantId}` }, fake.fetch),
      now: () => NOW,
    };

    const firstRun = await cleanupExpired(deps);
    const secondRun = await cleanupExpired(deps);

    expect(firstRun).toBe(1);
    expect(secondRun).toBe(1);
    expect(await store.findById("flaky01")).toBeNull();
    log.mockRestore();
  });

  test("drops records of an unknown account so they cannot block the queue, and cleans the others", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new D1FileStore(createTestD1());
    const fake = createFakeUploadThing();
    await store.insert(expired("aaaaaa1", "alice"));
    await store.insert(expired("ghost01", "ghost"));

    const removed = await cleanupExpired({
      store,
      storageFor: async (tenantId) => (tenantId === "ghost" ? null : new UploadThingClient({ appId: "any", apiKey: "sk" }, fake.fetch)),
      now: () => NOW,
    });

    expect(removed).toBe(1);
    expect(await store.findById("ghost01")).toBeNull();
    expect(await store.findById("aaaaaa1")).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no credentials for account "ghost"'));
    log.mockRestore();
  });

  test("does nothing when no file is due", async () => {
    const store = new D1FileStore(createTestD1());

    expect(await cleanupExpired({ store, storageFor: async () => null, now: () => NOW })).toBe(0);
  });
});
