/**
 * Tenants are UploadThing apps. Callers may bring their own UPLOADTHING_TOKEN; the vault keeps each
 * app's API key (encrypted) so expired files can be deleted later, and issues short-lived upload
 * tickets so a token never has to be handed back to the model.
 */

import type { Sealer } from "./crypto";
import type { TenantKeyStore } from "./store";
import type { UploadThingConfig } from "./uploadthing";
import { UserError } from "./util";

export const UPLOAD_TICKET_TTL_SECONDS = 3600;

interface TicketPayload {
  readonly appId: string;
  readonly expiresAt: number;
}

export interface VaultDeps {
  readonly keys: TenantKeyStore;
  /** Null when TOKEN_ENCRYPTION_KEY is not configured: only the default account can be used then. */
  readonly sealer: Sealer | null;
  /** The server's own account, used when a caller brings no token. */
  readonly fallback: UploadThingConfig | null;
  readonly now?: () => number;
}

export class TenantVault {
  private readonly keys: TenantKeyStore;
  private readonly sealer: Sealer | null;
  private readonly fallback: UploadThingConfig | null;
  private readonly now: () => number;

  constructor(deps: VaultDeps) {
    this.keys = deps.keys;
    this.sealer = deps.sealer;
    this.fallback = deps.fallback;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get defaultTenant(): UploadThingConfig | null {
    return this.fallback;
  }

  isDefault(appId: string): boolean {
    return this.fallback?.appId === appId;
  }

  /** Stores a caller's API key (encrypted) so the cron can clean up their expired files. */
  async remember(tenant: UploadThingConfig): Promise<void> {
    if (this.isDefault(tenant.appId)) return;
    const sealed = await this.requireSealer().seal(tenant.apiKey);
    await this.keys.save(tenant.appId, sealed, this.now());
  }

  /** Credentials for an app, or null if this server has never been given them. */
  async credentials(appId: string): Promise<UploadThingConfig | null> {
    if (this.fallback && this.isDefault(appId)) return this.fallback;
    if (!this.sealer) return null;
    const sealed = await this.keys.find(appId);
    if (!sealed) return null;
    const apiKey = await this.sealer.open(sealed);
    return apiKey ? { appId, apiKey } : null;
  }

  /** A ticket that lets its holder upload into `tenant`'s account for one hour. Null for the default account. */
  async issueTicket(tenant: UploadThingConfig): Promise<string | null> {
    if (this.isDefault(tenant.appId)) return null;
    await this.remember(tenant);
    const payload: TicketPayload = { appId: tenant.appId, expiresAt: this.now() + UPLOAD_TICKET_TTL_SECONDS };
    return this.requireSealer().seal(JSON.stringify(payload));
  }

  async redeemTicket(ticket: string): Promise<UploadThingConfig> {
    const opened = this.sealer ? await this.sealer.open(ticket) : null;
    const payload = opened ? (JSON.parse(opened) as TicketPayload) : null;
    if (!payload || typeof payload.appId !== "string" || !(payload.expiresAt > this.now())) {
      throw new UserError("The upload ticket is invalid or has expired. Call create_upload_url again.", 401);
    }
    const tenant = await this.credentials(payload.appId);
    if (!tenant) throw new UserError("The upload ticket no longer matches a known account.", 401);
    return tenant;
  }

  private requireSealer(): Sealer {
    if (!this.sealer) {
      throw new UserError("This server is not set up for bring-your-own tokens (TOKEN_ENCRYPTION_KEY is missing).", 503);
    }
    return this.sealer;
  }
}
