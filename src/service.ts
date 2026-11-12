/** Orchestrates uploads, lookups, deletion and expiry on top of the store and the storage provider. */

import type { FileRecord, FileSource, FileStore } from "./store";
import type { StorageProvider } from "./uploadthing";
import {
  DEFAULT_CONTENT_TYPE,
  ID_PATTERN,
  UserError,
  assertPublicHttpUrl,
  bareMimeType,
  extensionForType,
  filenameFromContentDisposition,
  filenameFromUrl,
  formatBytes,
  formatDuration,
  generateId,
  guessContentType,
  parseExpiry,
  sanitizeFilename,
} from "./util";

export interface ServiceConfig {
  /** UploadThing app this service acts for; callers only ever see this app's files. */
  readonly appId: string;
  /** Public origin of this Worker, e.g. https://file2url.example.workers.dev */
  readonly baseUrl: string;
  readonly defaultExpiry: string;
  readonly maxFileBytes: number;
  /** Cap for payloads that must be held in memory (unknown length, base64, text). */
  readonly maxBufferedBytes: number;
}

export interface UploadOptions {
  readonly expiresIn?: string | number | null;
  readonly maxDownloads?: number | null;
}

export interface UploadRequest extends UploadOptions {
  readonly name: string;
  readonly type?: string | null;
  readonly size: number;
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
  readonly source: FileSource;
}

export interface UrlUploadRequest extends UploadOptions {
  readonly url: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface UpdateRequest extends UploadOptions {
  readonly filename?: string;
}

export interface FileView {
  readonly id: string;
  readonly url: string;
  readonly download_url: string;
  readonly direct_url: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly size: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly expires_in: string;
  readonly max_downloads: number | null;
  readonly download_count: number;
}

export interface DeleteResult {
  readonly deleted: readonly { id: string; filename: string }[];
  readonly not_found: readonly string[];
}

export interface ServiceDeps {
  readonly store: FileStore;
  readonly storage: StorageProvider;
  readonly config: ServiceConfig;
  readonly now?: () => number;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called before each upload so the tenant's credentials are on file for later cleanup. */
  readonly rememberTenant?: () => Promise<void>;
  /** Issues a ticket for the direct-upload endpoint, or null when none is needed. */
  readonly issueUploadTicket?: () => Promise<string | null>;
}

const MAX_ID_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;

const systemClock = (): number => Math.floor(Date.now() / 1000);

/** The public, read-only side of a short link. Needs no account: any link works for anyone who has it. */
export class LinkReader {
  constructor(
    protected readonly store: FileStore,
    protected readonly now: () => number = systemClock,
  ) {}

  /** Counts a download and returns the record, or null if the link is dead. */
  claimDownload(id: string): Promise<FileRecord | null> {
    return this.store.claimDownload(id, this.now());
  }

  /** Returns the record only if it exists and has not expired / run out of downloads. */
  async peek(id: string): Promise<FileRecord | null> {
    const record = await this.store.findById(id);
    return record && this.isAlive(record) ? record : null;
  }

  exists(id: string): Promise<boolean> {
    return this.store.findById(id).then((record) => record !== null);
  }

  protected isAlive(record: FileRecord): boolean {
    const notExpired = record.expiresAt === null || record.expiresAt > this.now();
    const hasDownloadsLeft = record.maxDownloads === null || record.downloadCount < record.maxDownloads;
    return notExpired && hasDownloadsLeft;
  }
}

export class FileService extends LinkReader {
  private readonly storage: StorageProvider;
  private readonly config: ServiceConfig;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly rememberTenant: () => Promise<void>;
  private readonly issueUploadTicket: () => Promise<string | null>;

  constructor(deps: ServiceDeps) {
    super(deps.store, deps.now);
    this.storage = deps.storage;
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.rememberTenant = deps.rememberTenant ?? (async () => undefined);
    this.issueUploadTicket = deps.issueUploadTicket ?? (async () => null);
  }

  /** Ticket to append to a direct-upload URL so it lands in this account (null for the default account). */
  uploadTicket(): Promise<string | null> {
    return this.issueUploadTicket();
  }

  get limits(): ServiceConfig {
    return this.config;
  }

  async upload(request: UploadRequest): Promise<FileView> {
    const expirySeconds = parseExpiry(request.expiresIn, this.config.defaultExpiry);
    const maxDownloads = normalizeMaxDownloads(request.maxDownloads);
    this.assertSize(request.size);
    const name = sanitizeFilename(request.name);
    const contentType = bareMimeType(request.type) ?? guessContentType(name);

    await this.rememberTenant();
    const uploaded = await this.storage.upload({ name, size: request.size, type: contentType, body: request.body });
    const createdAt = this.now();
    const record = await this.persist({
      appId: this.config.appId,
      fileKey: uploaded.key,
      name,
      size: request.size,
      contentType,
      directUrl: uploaded.url,
      source: request.source,
      createdAt,
      expiresAt: expirySeconds === null ? null : createdAt + expirySeconds,
      maxDownloads,
      downloadCount: 0,
    });
    return this.toView(record);
  }

  async uploadFromUrl(request: UrlUploadRequest): Promise<FileView> {
    const response = await this.fetchSource(request.url, request.headers ?? {});
    const sourceType = bareMimeType(response.headers.get("content-type"));
    // A generic type from the source says nothing about the file; let the filename decide instead.
    const contentType = bareMimeType(request.contentType) ?? (sourceType === DEFAULT_CONTENT_TYPE ? null : sourceType);
    const name = pickFilename(request.filename, response, contentType);
    const options = { expiresIn: request.expiresIn, maxDownloads: request.maxDownloads };
    if (!response.body) throw new UserError("The source URL returned an empty response.");

    const declared = Number(response.headers.get("content-length"));
    const isStreamable = Number.isInteger(declared) && declared > 0 && !response.headers.get("content-encoding");
    if (isStreamable) {
      return this.upload({ ...options, name, type: contentType, size: declared, body: response.body, source: "url" });
    }
    const bytes = await readAllCapped(response.body, this.config.maxBufferedBytes);
    return this.upload({ ...options, name, type: contentType, size: bytes.byteLength, body: bytes, source: "url" });
  }

  async get(ref: string): Promise<FileView> {
    return this.toView(await this.requireAlive(ref));
  }

  async list(limit: number, offset: number): Promise<readonly FileView[]> {
    const records = await this.store.list({ appId: this.config.appId, limit, offset, now: this.now() });
    return records.map((record) => this.toView(record));
  }

  async delete(refs: readonly string[]): Promise<DeleteResult> {
    const resolved = await Promise.all(refs.map(async (ref) => ({ ref, record: await this.resolve(ref) })));
    const found = dedupeById(resolved.flatMap((entry) => (entry.record ? [entry.record] : [])));
    if (found.length > 0) {
      await this.storage.deleteFiles(found.map((record) => record.fileKey));
      await this.store.deleteMany(found.map((record) => record.id));
    }
    return {
      deleted: found.map((record) => ({ id: record.id, filename: record.name })),
      not_found: resolved.filter((entry) => !entry.record).map((entry) => entry.ref),
    };
  }

  async update(ref: string, request: UpdateRequest): Promise<FileView> {
    const record = await this.requireAlive(ref);
    const name = request.filename === undefined ? undefined : sanitizeFilename(request.filename);
    const hasExpiry = request.expiresIn !== undefined && request.expiresIn !== null && request.expiresIn !== "";
    const expirySeconds = hasExpiry ? parseExpiry(request.expiresIn, "never") : undefined;
    const patch = {
      name,
      expiresAt: expirySeconds === undefined ? undefined : expirySeconds === null ? null : this.now() + expirySeconds,
      maxDownloads: request.maxDownloads === undefined ? undefined : normalizeMaxDownloads(request.maxDownloads),
    };
    if (name !== undefined && name !== record.name) {
      await this.storage.renameFile(record.fileKey, name);
    }
    const updated = await this.store.update(record.id, patch);
    if (!updated) throw new UserError(`File "${ref}" not found.`, 404);
    return this.toView(updated);
  }

  async usage(): Promise<Record<string, unknown>> {
    const [stats, usage] = await Promise.all([this.store.stats(this.config.appId), this.storage.getUsage()]);
    return {
      tracked_files: stats.fileCount,
      tracked_size: formatBytes(stats.totalBytes),
      storage_used: formatBytes(usage.totalBytes),
      storage_limit: formatBytes(usage.limitBytes),
      storage_used_percent: usage.limitBytes > 0 ? Number(((usage.totalBytes / usage.limitBytes) * 100).toFixed(2)) : null,
      storage_files: usage.filesUploaded,
      default_expiry: this.config.defaultExpiry,
      max_file_size: formatBytes(this.config.maxFileBytes),
    };
  }

  toView(record: FileRecord): FileView {
    const extension = record.name.includes(".") ? record.name.split(".").pop()!.toLowerCase() : "";
    const suffix = /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : "";
    const url = `${this.config.baseUrl}/${record.id}${suffix}`;
    return {
      id: record.id,
      url,
      download_url: `${url}?download=1`,
      direct_url: record.directUrl,
      filename: record.name,
      content_type: record.contentType,
      size_bytes: record.size,
      size: formatBytes(record.size),
      created_at: toIso(record.createdAt),
      expires_at: record.expiresAt === null ? null : toIso(record.expiresAt),
      expires_in: record.expiresAt === null ? "never" : formatDuration(record.expiresAt - this.now()),
      max_downloads: record.maxDownloads,
      download_count: record.downloadCount,
    };
  }

  private async requireAlive(ref: string): Promise<FileRecord> {
    const record = await this.resolve(ref);
    if (!record) throw new UserError(`File "${ref}" not found (it may have expired or been deleted).`, 404);
    if (!this.isAlive(record)) throw new UserError(`File "${ref}" has expired.`, 410);
    return record;
  }

  /** Accepts a short id, a short link, an UploadThing URL or a file key. Only this account's files resolve. */
  private async resolve(ref: string): Promise<FileRecord | null> {
    const candidate = extractReference(ref.trim());
    if (!candidate) return null;
    const byId = ID_PATTERN.test(candidate) ? await this.store.findById(candidate) : null;
    const record = byId ?? (await this.store.findByKey(candidate));
    return record && record.appId === this.config.appId ? record : null;
  }

  private assertSize(size: number): void {
    if (!Number.isInteger(size) || size <= 0) throw new UserError("The file is empty.");
    if (size > this.config.maxFileBytes) {
      throw new UserError(
        `File is ${formatBytes(size)}; the limit is ${formatBytes(this.config.maxFileBytes)}.`,
        413,
      );
    }
  }

  /** Inserts with a fresh short id, retrying only on the (unlikely) id collision. */
  private async persist(fields: Omit<FileRecord, "id">): Promise<FileRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const record: FileRecord = { ...fields, id: generateId() };
      try {
        await this.store.insert(record);
        return record;
      } catch (error) {
        lastError = error;
        if (!isIdCollision(error)) break;
      }
    }
    // An insert can report failure after it committed: never delete bytes that a saved row points at.
    const saved = await this.store.findByKey(fields.fileKey).catch((error: unknown) => {
      console.error("Could not verify whether metadata was saved", fields.fileKey, error);
      return null;
    });
    if (saved) return saved;
    await this.storage.deleteFiles([fields.fileKey]).catch((error: unknown) => {
      console.error("Failed to remove orphaned upload", fields.fileKey, error);
    });
    throw new Error(`Could not save file metadata: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /** Fetches a user-supplied URL, re-validating every redirect hop against private hosts. */
  private async fetchSource(input: string, headers: Readonly<Record<string, string>>): Promise<Response> {
    const start = assertPublicHttpUrl(input);
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Caller-supplied headers (often credentials) only go to the origin they were meant for.
      const response = await this.fetchOnce(url, url.origin === start.origin ? headers : {});
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = assertPublicHttpUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new UserError(`Could not fetch the source URL (HTTP ${response.status}).`, 422);
      }
      return response;
    }
    throw new UserError("The source URL redirected too many times.", 422);
  }

  private async fetchOnce(url: URL, headers: Readonly<Record<string, string>>): Promise<Response> {
    // The timeout covers connecting and receiving headers only; a long body transfer must not be cut off.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url.toString(), {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (compatible; file2url/1.0)", ...headers, "accept-encoding": "identity" },
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UserError(`Could not fetch the source URL: ${detail}`, 422);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isIdCollision(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: files\.id/i.test(error.message);
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** 0 / null / undefined mean "unlimited". */
function normalizeMaxDownloads(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value === 0) return null;
  if (!Number.isInteger(value) || value < 0) throw new UserError("max_downloads must be a positive whole number.");
  return value;
}

function dedupeById(records: readonly FileRecord[]): readonly FileRecord[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

/** Reduces a link / key / id to the bare id or file key. */
function extractReference(ref: string): string | null {
  if (!ref) return null;
  if (!/^https?:\/\//i.test(ref)) return ref.replace(/\.[A-Za-z0-9]{1,10}$/, "");
  try {
    const segments = new URL(ref).pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    // UploadThing: /f/<key> or /a/<appId>/<key>; ours: /<id>[.ext]
    const last = segments[0] === "f" || segments[0] === "a" ? segments[segments.length - 1] : segments[0];
    return last.replace(/\.[A-Za-z0-9]{1,10}$/, "");
  } catch {
    return null;
  }
}

function pickFilename(requested: string | undefined, response: Response, contentType: string | null): string {
  const fromHeader = filenameFromContentDisposition(response.headers.get("content-disposition"));
  const fromUrl = response.url ? filenameFromUrl(new URL(response.url)) : null;
  const name = sanitizeFilename(requested || fromHeader || fromUrl, "download");
  if (name.includes(".")) return name;
  const extension = contentType ? extensionForType(contentType) : null;
  return extension ? `${name}.${extension}` : name;
}

/** Reads a stream fully into memory, failing once it exceeds `cap` bytes. */
export async function readAllCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new UserError(
        `The file has no declared size and exceeds the ${formatBytes(cap)} limit for such uploads.`,
        413,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
