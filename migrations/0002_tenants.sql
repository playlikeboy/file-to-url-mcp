-- Bring-your-own-token support: every file belongs to one UploadThing app (the "tenant").
ALTER TABLE files ADD COLUMN app_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_files_app_created ON files (app_id, created_at);

-- The app's API key, AES-GCM encrypted with TOKEN_ENCRYPTION_KEY, so the cron can delete expired files later.
CREATE TABLE IF NOT EXISTS tenants (
  app_id      TEXT PRIMARY KEY,
  api_key_enc TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
