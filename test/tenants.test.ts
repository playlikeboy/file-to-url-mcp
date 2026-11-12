import { describe, expect, test, vi } from "vitest";
import { cleanupExpired } from "../src/cleanup";
import { Sealer } from "../src/crypto";
import { D1FileStore, D1TenantKeyStore, type FileRecord } from "../src/store";
import { TenantVault, UPLOAD_TICKET_TTL_SECONDS } from "../src/tenants";
import { UploadThingClient } from "../src/uploadthing";
import { NOW, createFakeUploadThing, createTestD1 } from "./helpers";

const DEFAULT = { appId: "default-app", apiKey: "sk_default" };
const ALICE = { appId: "alice-app", apiKey: "sk_alice" };

function createVault(options: { sealer?: Sealer | null; fallback?: typeof DEFAULT | null } = {}) {
  const keys = new D1TenantKeyStore(createTestD1());
  const clock = { now: NOW };
  const vault = new TenantVault({
    keys,
    sealer: options.sealer === undefined ? new Sealer("test-secret") : options.sealer,
    fallback: options.fallback === undefined ? DEFAULT : options.fallback,
    now: () => clock.now,
  });
  return { vault, keys, clock };
}

describe("Sealer", () => {
  test("round-trips text and never produces the same ciphertext twice", async () => {
    const sealer = new Sealer("secret");

    const first = await sealer.seal("sk_live_abc");
    const second = await sealer.seal("sk_live_abc");

    expect(first).not.toBe(second);
    expect(first).not.toContain("sk_live");
    expect(await sealer.open(first)).toBe("sk_live_abc");
  });

  test("refuses values sealed with another key, tampered values and junk", async () => {
    const sealed = await new Sealer("secret").seal("value");
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");

    expect(await new Sealer("other").open(sealed)).toBeNull();
    expect(await new Sealer("secret").open(flipped)).toBeNull();
    expect(await new Sealer("secret").open("short")).toBeNull();
    expect(await new Sealer("secret").open("%%%not base64%%%")).toBeNull();
  });
});

describe("D1TenantKeyStore", () => {
  test("saves, finds and overwrites a key", async () => {
    const keys = new D1TenantKeyStore(createTestD1());

    await keys.save("app", "sealed-1", NOW);
    await keys.save("app", "sealed-2", NOW + 1);

    expect(await keys.find("app")).toBe("sealed-2");
    expect(await keys.find("unknown")).toBeNull();
  });
});

describe("TenantVault", () => {
  test("stores a caller's API key encrypted and returns it later", async () => {
    const { vault, keys } = createVault();

    await vault.remember(ALICE);

    expect(await keys.find(ALICE.appId)).not.toContain(ALICE.apiKey);
    expect(await vault.credentials(ALICE.appId)).toEqual(ALICE);
  });

  test("never stores the default account and serves it from configuration", async () => {
    const { vault, keys } = createVault();

    await vault.remember(DEFAULT);

    expect(await keys.find(DEFAULT.appId)).toBeNull();
    expect(await vault.credentials(DEFAULT.appId)).toEqual(DEFAULT);
    expect(vault.defaultTenant).toEqual(DEFAULT);
  });

  test("returns null for an app it has never seen", async () => {
    const { vault } = createVault();

    expect(await vault.credentials("stranger")).toBeNull();
  });

  test("returns null when a stored key can no longer be decrypted", async () => {
    const { vault, keys } = createVault();
    await keys.save(ALICE.appId, "garbage", NOW);

    expect(await vault.credentials(ALICE.appId)).toBeNull();
  });

  test("issues a ticket that resolves back to the caller's account", async () => {
    const { vault } = createVault();

    const ticket = await vault.issueTicket(ALICE);

    expect(ticket).not.toContain(ALICE.apiKey);
    expect(await vault.redeemTicket(ticket as string)).toEqual(ALICE);
  });

  test("issues no ticket for the default account", async () => {
    const { vault } = createVault();

    expect(await vault.issueTicket(DEFAULT)).toBeNull();
  });

  test("rejects expired, forged and foreign tickets", async () => {
    const { vault, clock } = createVault();
    const ticket = (await vault.issueTicket(ALICE)) as string;
    const foreign = await new Sealer("another-server").seal(JSON.stringify({ appId: ALICE.appId, expiresAt: NOW + 999 }));
    clock.now = NOW + UPLOAD_TICKET_TTL_SECONDS;

    await expect(vault.redeemTicket(ticket)).rejects.toMatchObject({ status: 401 });
    await expect(vault.redeemTicket("forged")).rejects.toMatchObject({ status: 401 });
    await expect(vault.redeemTicket(foreign)).rejects.toMatchObject({ status: 401 });
  });

  test("rejects a ticket for an account whose key is gone", async () => {
    const sealer = new Sealer("test-secret");
    const { vault } = createVault({ sealer });
    const orphan = await sealer.seal(JSON.stringify({ appId: "deleted-app", expiresAt: NOW + 60 }));

    await expect(vault.redeemTicket(orphan)).rejects.toThrow(/no longer matches/);
  });

  test("without an encryption key, own tokens are refused but the default account still works", async () => {
    const { vault } = createVault({ sealer: null });

    await expect(vault.remember(ALICE)).rejects.toMatchObject({ status: 503 });
    await expect(vault.redeemTicket("anything")).rejects.toMatchObject({ status: 401 });
    expect(await vault.credentials(ALICE.appId)).toBeNull();
    expect(await vault.credentials(DEFAULT.appId)).toEqual(DEFAULT);
  });

  test("works with no default account at all", async () => {
    const { vault } = createVault({ fallback: null });

    await vault.remember(ALICE);

    expect(vault.defaultTenant).toBeNull();
    expect(await vault.credentials(ALICE.appId)).toEqual(ALICE);
  });
});

describe("cleanupExpired", () => {
  function expired(id: string, appId: string): FileRecord {
    return {
      id,
      appId,
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
    await store.insert(expired("aaaaaa1", "alice-app"));
    await store.insert(expired("bbbbbb1", "bob-app"));

    const removed = await cleanupExpired({
      store,
      storageFor: async (appId) => new UploadThingClient({ appId, apiKey: `sk_${appId}` }, fake.fetch),
      now: () => NOW,
    });

    expect(removed).toBe(2);
    const keysUsed = fake.calls.map((call) => [call.headers["x-uploadthing-api-key"], (call.json as { fileKeys: string[] }).fileKeys]);
    expect(keysUsed).toEqual(
      expect.arrayContaining([
        ["sk_alice-app", ["key-aaaaaa1"]],
        ["sk_bob-app", ["key-bbbbbb1"]],
      ]),
    );
  });

  test("leaves files of an unknown account in place and still cleans the others", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new D1FileStore(createTestD1());
    const fake = createFakeUploadThing();
    await store.insert(expired("aaaaaa1", "alice-app"));
    await store.insert(expired("ghost01", "ghost-app"));

    const removed = await cleanupExpired({
      store,
      storageFor: async (appId) => (appId === "ghost-app" ? null : new UploadThingClient({ appId, apiKey: "sk" }, fake.fetch)),
      now: () => NOW,
    });

    expect(removed).toBe(1);
    expect(await store.findById("ghost01")).not.toBeNull();
    expect(await store.findById("aaaaaa1")).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no credentials for app "ghost-app"'));
    log.mockRestore();
  });

  test("does nothing when no file is due", async () => {
    const store = new D1FileStore(createTestD1());

    expect(await cleanupExpired({ store, storageFor: async () => null, now: () => NOW })).toBe(0);
  });
});
