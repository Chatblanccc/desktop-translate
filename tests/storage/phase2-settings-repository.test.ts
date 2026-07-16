import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  PHASE2_SETTING_KEYS,
  SqlitePhase2SettingsRepository,
  SqliteSettingsRepository,
  runStorageMigrations,
} from "../../packages/storage/src/sqlite-storage.ts";

test("migration runner applies 0001 once and enables foreign keys", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(runStorageMigrations(database), [1]);
    assert.deepEqual(runStorageMigrations(database), []);
    assert.equal(database.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.equal(
      database.prepare("SELECT name FROM schema_migrations WHERE version = 1").get()!.name,
      "initial",
    );
    assert.ok(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get(),
    );
  } finally {
    database.close();
  }
});

test("migration runner rolls a failing migration back without losing prior versions", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = [
    { version: 1, name: "one", sql: "CREATE TABLE one(id INTEGER PRIMARY KEY) STRICT;" },
    {
      version: 2,
      name: "two",
      sql: "CREATE TABLE should_rollback(id INTEGER PRIMARY KEY) STRICT; INSERT INTO missing_table VALUES (1);",
    },
  ] as const;
  try {
    assert.throws(() => runStorageMigrations(database, { migrations }), /missing_table|no such table/i);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'one'").get());
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(),
      undefined,
    );
    assert.deepEqual(
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version),
      [1],
    );
  } finally {
    database.close();
  }
});

test("migration runner rejects incomplete or ambiguous manifests", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.throws(() => runStorageMigrations(database, { migrations: [] }), /No storage migrations/);
    assert.throws(
      () => runStorageMigrations(database, {
        migrations: [{ version: 2, name: "two", sql: "SELECT 1;" }],
      }),
      /contiguous/,
    );
    assert.throws(
      () => runStorageMigrations(database, {
        migrations: [
          { version: 1, name: "one", sql: "SELECT 1;" },
          { version: 1, name: "again", sql: "SELECT 1;" },
        ],
      }),
      /Duplicate|contiguous/,
    );
  } finally {
    database.close();
  }
});

test("Phase 2 settings persist across database reopen and anchor reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-translate-storage-"));
  const databasePath = join(directory, "settings.sqlite3");
  try {
    let database = new DatabaseSync(databasePath);
    runStorageMigrations(database);
    let repository = new SqlitePhase2SettingsRepository(database, {
      now: () => "2026-07-16T08:00:00.000Z",
    });
    assert.deepEqual(await repository.load(), {
      ball: { visible: true, edgeSnap: true },
      theme: "system",
    });
    await repository.setBallVisible(false);
    await repository.setEdgeSnap(false);
    await repository.setTheme("dark");
    await repository.setBallAnchor({ displayId: "primary", edge: "left", verticalRatio: 0 });
    database.close();

    database = new DatabaseSync(databasePath);
    assert.deepEqual(runStorageMigrations(database), []);
    repository = new SqlitePhase2SettingsRepository(database);
    assert.deepEqual(await repository.load(), {
      ball: {
        visible: false,
        edgeSnap: false,
        anchor: { displayId: "primary", edge: "left", verticalRatio: 0 },
      },
      theme: "dark",
    });
    await repository.resetBallAnchor();
    assert.deepEqual(await repository.load(), {
      ball: { visible: false, edgeSnap: false },
      theme: "dark",
    });
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing and damaged Phase 2 values safely fall back without exposing values", async () => {
  const database = new DatabaseSync(":memory:");
  const invalidKeys: string[] = [];
  try {
    runStorageMigrations(database);
    const insert = database.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, '2026-07-16T08:00:00.000Z')",
    );
    insert.run(PHASE2_SETTING_KEYS.ballVisible, JSON.stringify("yes"));
    insert.run(PHASE2_SETTING_KEYS.ballEdgeSnap, JSON.stringify(null));
    insert.run(
      PHASE2_SETTING_KEYS.ballAnchor,
      JSON.stringify({ displayId: "primary", edge: "right", verticalRatio: 1.01 }),
    );
    insert.run(PHASE2_SETTING_KEYS.theme, JSON.stringify("sepia"));

    const repository = new SqlitePhase2SettingsRepository(database, {
      onInvalidSetting: (key) => invalidKeys.push(key),
    });
    assert.deepEqual(await repository.load(), {
      ball: { visible: true, edgeSnap: true },
      theme: "system",
    });
    assert.deepEqual(invalidKeys.sort(), Object.values(PHASE2_SETTING_KEYS).sort());
  } finally {
    database.close();
  }
});

test("repository survives syntactically corrupt JSON and validates writes at runtime", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)",
    ).run(PHASE2_SETTING_KEYS.theme, "{", "2026-07-16T08:00:00.000Z");
    database.exec("PRAGMA ignore_check_constraints = OFF");

    const invalidKeys: string[] = [];
    const repository = new SqlitePhase2SettingsRepository(database, {
      onInvalidSetting: (key) => invalidKeys.push(key),
    });
    assert.equal((await repository.load()).theme, "system");
    assert.deepEqual(invalidKeys, [PHASE2_SETTING_KEYS.theme]);

    await assert.rejects(repository.setTheme("sepia" as "dark"), /Theme/);
    await assert.rejects(repository.setBallVisible("yes" as unknown as boolean), /visibility/);
    await assert.rejects(
      repository.setBallAnchor({ displayId: "primary", edge: "right", verticalRatio: -0.1 }),
      /anchor/i,
    );
  } finally {
    database.close();
  }
});

test("generic SQLite settings repository upserts, parses, and deletes JSON", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database);
    const repository = new SqliteSettingsRepository(database);
    assert.equal(await repository.get("example"), undefined);
    await repository.set("example", { enabled: true }, "2026-07-16T08:00:00.000Z");
    assert.deepEqual(await repository.get("example"), { enabled: true });
    await repository.set("example", [1, 2, 3], "2026-07-16T08:01:00.000Z");
    assert.deepEqual(await repository.get("example"), [1, 2, 3]);
    assert.equal(await repository.delete("example"), true);
    assert.equal(await repository.delete("example"), false);
  } finally {
    database.close();
  }
});
