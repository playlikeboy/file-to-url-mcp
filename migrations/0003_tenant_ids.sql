-- Tenants are now identified by a hash of their secret API key instead of the (public) app id,
-- so a forged token naming someone else's app id can no longer reach their files.
DROP INDEX IF EXISTS idx_files_app_created;
ALTER TABLE files RENAME COLUMN app_id TO tenant_id;
CREATE INDEX IF NOT EXISTS idx_files_tenant_created ON files (tenant_id, created_at);

DROP TABLE IF EXISTS tenants;
CREATE TABLE tenants (
  tenant_id       TEXT PRIMARY KEY,   -- hash of the API key
  credentials_enc TEXT NOT NULL,      -- AES-GCM sealed { apiKey, appId }
  updated_at      INTEGER NOT NULL
);
