/** File metadata repository. The D1 implementation is the only place that knows SQL. */

export type FileSource = "url" | "text" | "base64" | "direct";

export interface FileRecord {
  readonly id: string;
  /** Account that owns the file (a hash of its API key, see tenants.ts). */
  readonly tenantId: string;
  readonly fileKey: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly directUrl: string;
  readonly source: FileSource;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
}

export interface FilePatch {
  readonly name?: string;
  readonly expiresAt?: number | null;
  readonly maxDownloads?: number | null;
}

export interface ListOptions {
  readonly tenantId: string;
  readonly limit: number;
  readonly offset: number;
  /** Unix seconds; files already expired or out of downloads are excluded. */
  readonly now: number;
}

export interface StoreStats {
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface FileStore {
  insert(record: FileRecord): Promise<void>;
  findById(id: string): Promise<FileRecord | null>;
  findByKey(fileKey: string): Promise<FileRecord | null>;
  list(options: ListOptions): Promise<readonly FileRecord[]>;
  update(id: string, patch: FilePatch): Promise<FileRecord | null>;
  /** Atomically counts one download; returns null if the file is missing, expired or exhausted. */
  claimDownload(id: string, now: number): Promise<FileRecord | null>;
  /** Files past their expiry time or download limit. */
  findDead(now: number, limit: number): Promise<readonly FileRecord[]>;
  deleteMany(ids: readonly string[]): Promise<void>;
  stats(tenantId: string): Promise<StoreStats>;
}

interface FileRow {
  id: string;
  tenant_id: string;
  file_key: string;
  name: string;
  size: number;
  content_type: string;
  direct_url: string;
  source: string;
  created_at: number;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
}

function toRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fileKey: row.file_key,
    name: row.name,
    size: row.size,
    contentType: row.content_type,
    directUrl: row.direct_url,
    source: row.source as FileSource,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
  };
}

const PATCH_COLUMNS: Readonly<Record<keyof FilePatch, string>> = {
  name: "name",
  expiresAt: "expires_at",
  maxDownloads: "max_downloads",
};

/** D1 allows at most 100 bound parameters per statement. */
const DELETE_CHUNK_SIZE = 100;

export class D1FileStore implements FileStore {
  constructor(private readonly db: D1Database) {}

  async insert(record: FileRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO files (id, tenant_id, file_key, name, size, content_type, direct_url, source, created_at, expires_at, max_downloads, download_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id, record.tenantId, record.fileKey, record.name, record.size, record.contentType, record.directUrl,
        record.source, record.createdAt, record.expiresAt, record.maxDownloads, record.downloadCount,
      )
      .run();
  }

  async findById(id: string): Promise<FileRecord | null> {
    const row = await this.db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
    return row ? toRecord(row) : null;
  }

  async findByKey(fileKey: string): Promise<FileRecord | null> {
    const row = await this.db.prepare("SELECT * FROM files WHERE file_key = ?").bind(fileKey).first<FileRow>();
    return row ? toRecord(row) : null;
  }

  async list(options: ListOptions): Promise<readonly FileRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM files
         WHERE tenant_id = ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_downloads IS NULL OR download_count < max_downloads)
         ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .bind(options.tenantId, options.now, options.limit, options.offset)
      .all<FileRow>();
    return result.results.map(toRecord);
  }

  async update(id: string, patch: FilePatch): Promise<FileRecord | null> {
    const keys = (Object.keys(patch) as (keyof FilePatch)[]).filter((key) => patch[key] !== undefined);
    if (keys.length === 0) return this.findById(id);
    const assignments = keys.map((key) => `${PATCH_COLUMNS[key]} = ?`).join(", ");
    const values = keys.map((key) => patch[key] ?? null);
    const row = await this.db
      .prepare(`UPDATE files SET ${assignments} WHERE id = ? RETURNING *`)
      .bind(...values, id)
      .first<FileRow>();
    return row ? toRecord(row) : null;
  }

  async claimDownload(id: string, now: number): Promise<FileRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE files SET download_count = download_count + 1
         WHERE id = ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_downloads IS NULL OR download_count < max_downloads)
         RETURNING *`,
      )
      .bind(id, now)
      .first<FileRow>();
    return row ? toRecord(row) : null;
  }

  async findDead(now: number, limit: number): Promise<readonly FileRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM files
         WHERE (expires_at IS NOT NULL AND expires_at <= ?)
            OR (max_downloads IS NOT NULL AND download_count >= max_downloads)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(now, limit)
      .all<FileRow>();
    return result.results.map(toRecord);
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += DELETE_CHUNK_SIZE) {
      const chunk = ids.slice(start, start + DELETE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      await this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).bind(...chunk).run();
    }
  }

  async stats(tenantId: string): Promise<StoreStats> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_bytes FROM files WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ file_count: number; total_bytes: number }>();
    return { fileCount: row?.file_count ?? 0, totalBytes: row?.total_bytes ?? 0 };
  }
}

/** Encrypted UploadThing credentials, one row per tenant, so the cron can delete that tenant's expired files. */
export interface TenantKeyStore {
  save(tenantId: string, sealedCredentials: string, now: number): Promise<void>;
  find(tenantId: string): Promise<string | null>;
}

export class D1TenantKeyStore implements TenantKeyStore {
  constructor(private readonly db: D1Database) {}

  async save(tenantId: string, sealedCredentials: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tenants (tenant_id, credentials_enc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET credentials_enc = excluded.credentials_enc, updated_at = excluded.updated_at`,
      )
      .bind(tenantId, sealedCredentials, now)
      .run();
  }

  async find(tenantId: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT credentials_enc FROM tenants WHERE tenant_id = ?").bind(tenantId).first<{ credentials_enc: string }>();
    return row?.credentials_enc ?? null;
  }
}
