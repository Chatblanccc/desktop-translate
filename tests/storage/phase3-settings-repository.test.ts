import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  PHASE3_SETTING_KEYS,
  SqliteAppExclusionsRepository,
  SqlitePhase3SettingsRepository,
  runStorageMigrations,
} from "../../packages/storage/src/sqlite-storage.ts";

test("Phase 3 selection settings persist and retain Phase 2 shell settings", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database);
    const repository = new SqlitePhase3SettingsRepository(database, {
      now: () => "2026-07-16T08:00:00.000Z",
    });

    assert.deepEqual(await repository.load(), {
      ball: { visible: true, edgeSnap: true },
      theme: "system",
      selection: { enabled: true, ocrActivation: "fallback" },
    });

    await repository.setBallVisible(false);
    await repository.setEdgeSnap(false);
    await repository.setTheme("dark");
    await repository.setSelectionEnabled(false);
    await repository.setOcrActivation("alt-drag");
    await repository.setBallAnchor({
      mode: "free",
      displayId: "secondary",
      horizontalRatio: 0.25,
      verticalRatio: 0.75,
    });

    assert.deepEqual(await new SqlitePhase3SettingsRepository(database).load(), {
      ball: {
        visible: false,
        edgeSnap: false,
        anchor: {
          mode: "free",
          displayId: "secondary",
          horizontalRatio: 0.25,
          verticalRatio: 0.75,
        },
      },
      theme: "dark",
      selection: { enabled: false, ocrActivation: "alt-drag" },
    });
  } finally {
    database.close();
  }
});

test("damaged Phase 3 selection values fall back without exposing persisted values", async () => {
  const database = new DatabaseSync(":memory:");
  const invalidKeys: string[] = [];
  try {
    runStorageMigrations(database);
    const insert = database.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, '2026-07-16T08:00:00.000Z')",
    );
    insert.run(PHASE3_SETTING_KEYS.selectionEnabled, JSON.stringify("yes"));
    insert.run(PHASE3_SETTING_KEYS.ocrActivation, JSON.stringify("always"));

    const repository = new SqlitePhase3SettingsRepository(database, {
      onInvalidSetting: (key) => invalidKeys.push(key),
    });

    assert.deepEqual((await repository.load()).selection, {
      enabled: true,
      ocrActivation: "fallback",
    });
    assert.deepEqual(invalidKeys.sort(), [
      PHASE3_SETTING_KEYS.ocrActivation,
      PHASE3_SETTING_KEYS.selectionEnabled,
    ].sort());

    await assert.rejects(repository.setSelectionEnabled("yes" as unknown as boolean), /boolean/);
    await assert.rejects(repository.setOcrActivation("always" as "fallback"), /activation/);
  } finally {
    database.close();
  }
});

test("enabled app exclusions return only valid Windows process basenames", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database);
    const insert = database.prepare(
      `INSERT INTO app_exclusions(id, process_name, window_class, enabled, created_at, updated_at)
       VALUES (?, ?, NULL, ?, '2026-07-16T08:00:00.000Z', '2026-07-16T08:00:00.000Z')`,
    );
    insert.run("1", "notepad.exe", 1);
    insert.run("2", "Code.exe", 1);
    insert.run("3", "disabled.exe", 0);
    insert.run("4", "C:\\unsafe.exe", 1);
    insert.run("5", "trailing. ", 1);

    const repository = new SqliteAppExclusionsRepository(database);
    assert.deepEqual(await repository.listEnabledProcessNames(), ["Code.exe", "notepad.exe"]);
  } finally {
    database.close();
  }
});
