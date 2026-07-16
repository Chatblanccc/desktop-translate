import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../../packages/storage/migrations/0001_initial.sql", import.meta.url);

test("initial migration defines all Phase 1 stores and privacy-safe secret storage", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "schema_migrations",
    "settings",
    "translation_history",
    "favorites",
    "translation_cache",
    "app_exclusions",
    "secrets",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /encrypted_value BLOB NOT NULL/);
  assert.doesNotMatch(sql, /screenshot|image_blob|raw_pixels/i);
  assert.match(sql, /INSERT OR IGNORE INTO schema_migrations/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(sql);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      "schema_migrations",
      "settings",
      "translation_history",
      "favorites",
      "translation_cache",
      "app_exclusions",
      "secrets",
    ]) assert.ok(tables.includes(table), `migration did not create ${table}`);
    assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 1").get().count,
      1,
    );
    const insertExclusion = database.prepare(
      "INSERT INTO app_exclusions(id, process_name, window_class, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
    );
    insertExclusion.run("one", "chrome.exe", "2026-07-16T08:00:00Z", "2026-07-16T08:00:00Z");
    assert.throws(
      () => insertExclusion.run("two", "CHROME.EXE", "2026-07-16T08:00:01Z", "2026-07-16T08:00:01Z"),
      /UNIQUE constraint failed/,
    );
  } finally {
    database.close();
  }
});
