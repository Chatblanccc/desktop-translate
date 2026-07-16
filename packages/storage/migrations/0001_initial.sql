PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS translation_history (
  id TEXT PRIMARY KEY,
  selection_id TEXT NOT NULL,
  source_text TEXT NOT NULL CHECK (length(source_text) BETWEEN 1 AND 32768),
  translated_text TEXT NOT NULL,
  source_language TEXT,
  target_language TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('uia', 'uia-point-approx', 'ocr')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_translation_history_created_at
  ON translation_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_translation_history_source_text
  ON translation_history(source_text);

CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  history_id TEXT REFERENCES translation_history(id) ON DELETE SET NULL,
  source_text TEXT NOT NULL CHECK (length(source_text) BETWEEN 1 AND 32768),
  translated_text TEXT NOT NULL,
  source_language TEXT,
  target_language TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_normalized_pair
  ON favorites(lower(trim(source_text)), target_language, lower(trim(translated_text)));

CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key TEXT PRIMARY KEY,
  source_text TEXT NOT NULL CHECK (length(source_text) BETWEEN 1 AND 32768),
  source_language TEXT,
  target_language TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_translation_cache_expires_at
  ON translation_cache(expires_at);

CREATE TABLE IF NOT EXISTS app_exclusions (
  id TEXT PRIMARY KEY,
  process_name TEXT NOT NULL COLLATE NOCASE,
  window_class TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_exclusions_process_window
  ON app_exclusions(process_name, COALESCE(window_class, ''));

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  encrypted_value BLOB NOT NULL,
  encryption_scheme TEXT NOT NULL CHECK (encryption_scheme IN ('electron-safe-storage-v1')),
  updated_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
VALUES (1, 'initial', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
