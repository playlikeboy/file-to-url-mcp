-- One row per uploaded file. Timestamps are unix seconds.
CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,            -- short id used in the public link
  file_key       TEXT NOT NULL UNIQUE,        -- UploadThing file key
  name           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  content_type   TEXT NOT NULL,
  direct_url     TEXT NOT NULL,               -- UploadThing CDN url
  source         TEXT NOT NULL,               -- url | text | base64 | direct
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,                     -- NULL = never expires
  max_downloads  INTEGER,                     -- NULL = unlimited
  download_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files (created_at);
