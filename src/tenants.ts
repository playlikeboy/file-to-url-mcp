/**
 * A tenant is one UploadThing API key. Callers may bring their own UPLOADTHING_TOKEN; the vault keeps
 * each tenant's credentials (encrypted) so expired files can be deleted later, and issues short-lived
 * upload tickets so a token never has to be handed back to the model.
 *
 * Tenants are identified by a hash of the secret API key, never by the app id: app ids are public
 * (they appear in every CDN link), so anything keyed on them could be claimed by a forged token.
 */

import type { Sealer } from "./crypto";
import type { TenantKeyStore } from "./store";
import type { UploadThingConfig } from "./uploadthing";
import { UserError } from "./util";

export const UPLOAD_TICKET_TTL_SECONDS = 3600;
const TICKET_CONTEXT = "upload-ticket";
const credentialsContext = (tenantId: string): string => `credentials:${tenantId}`;
const TENANT_ID_HEX_LENGTH = 32;

export interface Tenant {
  /** Stable, non-reversible id derived from the API key. */
  readonly id: string;
  readonly credentials: UploadThingConfig;
}

interface TicketPayload {
  readonly tenantId: string;
  readonly expiresAt: number;
}

export async function tenantFor(credentials: UploadThingConfig): Promise<Tenant> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`file2url-tenant:${credentials.apiKey}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: hex.slice(0, TENANT_ID_HEX_LENGTH), credentials };
}

export interface VaultDeps {
  readonly keys: TenantKeyStore;
  /** Null when TOKEN_ENCRYPTION_KEY is not configured: only the default account can be used then. */
  readonly sealer: Sealer | null;
  /** The server's own account, used when a caller brings no token. */
  readonly fallback: Tenant | null;
  readonly now?: () => number;
}

export class TenantVault {
  private readonly keys: TenantKeyStore;
  private readonly sealer: Sealer | null;
  private readonly fallback: Tenant | null;
  private readonly now: () => number;

  constructor(deps: VaultDeps) {
    this.keys = deps.keys;
    this.sealer = deps.sealer;
    this.fallback = deps.fallback;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get defaultTenant(): Tenant | null {
    return this.fallback;
  }

  isDefault(tenantId: string): boolean {
    return this.fallback?.id === tenantId;
  }

  /** Stores a caller's credentials (encrypted) so the cron can clean up their expired files. */
  async remember(tenant: Tenant): Promise<void> {
    if (this.isDefault(tenant.id)) return;
    const sealer = this.requireSealer();
    const known = await this.credentials(tenant.id);
    if (known && known.apiKey === tenant.credentials.apiKey && known.appId === tenant.credentials.appId) return;
    const sealed = await sealer.seal(JSON.stringify(tenant.credentials), credentialsContext(tenant.id));
    await this.keys.save(tenant.id, sealed, this.now());
  }

  /** Credentials for a tenant, or null if this server has never been given them. */
  async credentials(tenantId: string): Promise<UploadThingConfig | null> {
    if (this.fallback && this.isDefault(tenantId)) return this.fallback.credentials;
    if (!this.sealer) return null;
    const sealed = await this.keys.find(tenantId);
    const opened = sealed ? await this.sealer.open(sealed, credentialsContext(tenantId)) : null;
    if (!opened) return null;
    const parsed = JSON.parse(opened) as Partial<UploadThingConfig>;
    return typeof parsed.apiKey === "string" && typeof parsed.appId === "string"
      ? { apiKey: parsed.apiKey, appId: parsed.appId }
      : null;
  }

  /** A ticket that lets its holder upload into `tenant`'s account for one hour. Null for the default account. */
  async issueTicket(tenant: Tenant): Promise<string | null> {
    if (this.isDefault(tenant.id)) return null;
    await this.remember(tenant);
    const payload: TicketPayload = { tenantId: tenant.id, expiresAt: this.now() + UPLOAD_TICKET_TTL_SECONDS };
    return this.requireSealer().seal(JSON.stringify(payload), TICKET_CONTEXT);
  }

  async redeemTicket(ticket: string): Promise<Tenant> {
    const opened = this.sealer ? await this.sealer.open(ticket, TICKET_CONTEXT) : null;
    const payload = opened ? (JSON.parse(opened) as Partial<TicketPayload>) : null;
    if (!payload || typeof payload.tenantId !== "string" || !(Number(payload.expiresAt) > this.now())) {
      throw new UserError("The upload ticket is invalid or has expired. Call create_upload_url again.", 401);
    }
    const credentials = await this.credentials(payload.tenantId);
    if (!credentials) throw new UserError("The upload ticket no longer matches a known account.", 401);
    return { id: payload.tenantId, credentials };
  }

  private requireSealer(): Sealer {
    if (!this.sealer) {
      throw new UserError("This server is not set up for bring-your-own tokens (TOKEN_ENCRYPTION_KEY is missing).", 503);
    }
    return this.sealer;
  }
}
