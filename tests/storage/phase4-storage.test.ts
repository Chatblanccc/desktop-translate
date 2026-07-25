import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  PHASE4_SETTING_KEYS,
  SqlitePhase3SettingsRepository,
  SqlitePhase4SettingsRepository,
  SqliteSecretsRepository,
  runStorageMigrations,
} from "../../packages/storage/src/sqlite-storage.ts";

function appliedMigrations(database: DatabaseSync): readonly Readonly<{
  version: number;
  name: string;
}>[] {
  const rows = database.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as unknown as readonly Readonly<{ version: number | bigint; name: string }>[];
  return rows.map((row) => ({ version: Number(row.version), name: row.name }));
}

test("an existing Phase 3 database upgrades to Phase 4 with translation disabled by default", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database, { now: () => "2026-07-16T08:00:00.000Z" });
    const phase3 = new SqlitePhase3SettingsRepository(database, {
      now: () => "2026-07-16T08:30:00.000Z",
    });
    await phase3.setBallVisible(false);
    await phase3.setEdgeSnap(false);
    await phase3.setTheme("dark");
    await phase3.setSelectionEnabled(false);
    await phase3.setOcrActivation("alt-drag");

    const upgraded = await new SqlitePhase4SettingsRepository(database).load();
    assert.deepEqual(upgraded, {
      ball: { visible: false, edgeSnap: false },
      theme: "dark",
      selection: { enabled: false, ocrActivation: "alt-drag" },
      translation: {
        enabled: false,
        providerId: "baidu",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        consentVersion: 0,
      },
    });
    assert.deepEqual(appliedMigrations(database), [{ version: 1, name: "initial" }]);
  } finally {
    database.close();
  }
});

test("Phase 4 settings and secrets remain invisible to the Phase 3 repository without a migration", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database, { now: () => "2026-07-16T08:00:00.000Z" });
    const phase3 = new SqlitePhase3SettingsRepository(database, {
      now: () => "2026-07-16T08:30:00.000Z",
    });
    await phase3.setBallVisible(false);
    await phase3.setTheme("light");
    await phase3.setSelectionEnabled(false);
    await phase3.setOcrActivation("fallback");
    const phase3Before = await phase3.load();

    const phase4 = new SqlitePhase4SettingsRepository(database, {
      now: () => "2026-07-16T09:00:00.000Z",
    });
    await phase4.setTranslationEnabled(true);
    await phase4.setTranslationProviderId("baidu");
    await phase4.setTranslationSourceLanguage("en");
    await phase4.setTranslationTargetLanguage("ja");
    await phase4.setTranslationConsentVersion(1);
    await new SqliteSecretsRepository(database).setEncrypted(
      "translation.baidu.credentials",
      new Uint8Array([4, 3, 2, 1]),
      "2026-07-16T09:00:00.000Z",
    );

    assert.deepEqual(await new SqlitePhase3SettingsRepository(database).load(), phase3Before);
    assert.deepEqual(appliedMigrations(database), [{ version: 1, name: "initial" }]);
    assert.deepEqual(runStorageMigrations(database), []);
  } finally {
    database.close();
  }
});

test("Phase 4 translation settings default safely and persist alongside Phase 3 settings", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database);
    const repository = new SqlitePhase4SettingsRepository(database, {
      now: () => "2026-07-16T12:00:00.000Z",
    });

    assert.deepEqual(await repository.load(), {
      ball: { visible: true, edgeSnap: true },
      theme: "system",
      selection: { enabled: true, ocrActivation: "fallback" },
      translation: {
        enabled: false,
        providerId: "baidu",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        consentVersion: 0,
      },
    });

    await repository.setBallVisible(false);
    await repository.setEdgeSnap(false);
    await repository.setBallAnchor({
      mode: "free",
      displayId: "primary",
      horizontalRatio: 0.45,
      verticalRatio: 0.55,
    });
    await repository.setSelectionEnabled(false);
    await repository.setTranslationEnabled(true);
    await repository.setTranslationProviderId("baidu");
    await repository.setTranslationSourceLanguage("en");
    await repository.setTranslationTargetLanguage("ja");
    await repository.setTranslationConsentVersion(1);

    assert.deepEqual(await new SqlitePhase4SettingsRepository(database).load(), {
      ball: {
        visible: false,
        edgeSnap: false,
        anchor: {
          mode: "free",
          displayId: "primary",
          horizontalRatio: 0.45,
          verticalRatio: 0.55,
        },
      },
      theme: "system",
      selection: { enabled: false, ocrActivation: "fallback" },
      translation: {
        enabled: true,
        providerId: "baidu",
        sourceLanguage: "en",
        targetLanguage: "ja",
        consentVersion: 1,
      },
    });

    await repository.resetTranslationConsent();
    assert.equal((await repository.load()).translation.consentVersion, 0);
  } finally {
    database.close();
  }
});

test("invalid Phase 4 values fail closed without exposing persisted values", async () => {
  const database = new DatabaseSync(":memory:");
  const invalidKeys: string[] = [];
  try {
    runStorageMigrations(database);
    const insert = database.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, '2026-07-16T12:00:00.000Z')",
    );
    insert.run(PHASE4_SETTING_KEYS.translationEnabled, JSON.stringify("yes"));
    insert.run(PHASE4_SETTING_KEYS.translationProviderId, JSON.stringify("../unsafe"));
    insert.run(PHASE4_SETTING_KEYS.translationSourceLanguage, JSON.stringify("*"));
    insert.run(PHASE4_SETTING_KEYS.translationTargetLanguage, JSON.stringify("auto"));
    insert.run(PHASE4_SETTING_KEYS.translationConsentVersion, JSON.stringify(-1));

    const repository = new SqlitePhase4SettingsRepository(database, {
      onInvalidSetting: (key) => invalidKeys.push(key),
    });
    assert.deepEqual((await repository.load()).translation, {
      enabled: false,
      providerId: "baidu",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      consentVersion: 0,
    });
    assert.deepEqual(invalidKeys.sort(), [
      PHASE4_SETTING_KEYS.translationConsentVersion,
      PHASE4_SETTING_KEYS.translationEnabled,
      PHASE4_SETTING_KEYS.translationProviderId,
      PHASE4_SETTING_KEYS.translationSourceLanguage,
      PHASE4_SETTING_KEYS.translationTargetLanguage,
    ].sort());

    await assert.rejects(repository.setTranslationEnabled("yes" as unknown as boolean), /boolean/);
    await assert.rejects(repository.setTranslationProviderId("../unsafe"), /provider/);
    await assert.rejects(repository.setTranslationProviderId("fixture"), /provider/);
    await assert.rejects(repository.setTranslationSourceLanguage("*"), /source language/);
    await assert.rejects(repository.setTranslationSourceLanguage("eo"), /source language/);
    await assert.rejects(repository.setTranslationTargetLanguage("auto"), /target language/);
    await assert.rejects(repository.setTranslationTargetLanguage("eo"), /target language/);
    await assert.rejects(repository.setTranslationConsentVersion(-1), /consent/);
  } finally {
    database.close();
  }
});

test("encrypted secrets use the existing safeStorage scheme and never return shared buffers", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    runStorageMigrations(database);
    const repository = new SqliteSecretsRepository(database);
    const encrypted = new Uint8Array([1, 2, 3, 4]);
    await repository.setEncrypted("translation.baidu.credentials", encrypted, "2026-07-16T12:00:00.000Z");
    encrypted[0] = 99;

    const first = await repository.getEncrypted("translation.baidu.credentials");
    assert.deepEqual(first, new Uint8Array([1, 2, 3, 4]));
    if (first !== undefined) first[1] = 99;
    assert.deepEqual(
      await repository.getEncrypted("translation.baidu.credentials"),
      new Uint8Array([1, 2, 3, 4]),
    );

    assert.equal(await repository.replaceEncryptedIfCurrent(
      "translation.baidu.credentials",
      new Uint8Array([9, 9, 9, 9]),
      new Uint8Array([5, 6, 7, 8]),
      "2026-07-16T12:01:00.000Z",
    ), false);
    assert.deepEqual(
      await repository.getEncrypted("translation.baidu.credentials"),
      new Uint8Array([1, 2, 3, 4]),
    );
    assert.equal(await repository.replaceEncryptedIfCurrent(
      "translation.baidu.credentials",
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      "2026-07-16T12:02:00.000Z",
    ), true);
    assert.deepEqual(
      await repository.getEncrypted("translation.baidu.credentials"),
      new Uint8Array([5, 6, 7, 8]),
    );

    const row = database.prepare(
      "SELECT encryption_scheme AS scheme, length(encrypted_value) AS size FROM secrets WHERE key = ?",
    ).get("translation.baidu.credentials") as unknown as { scheme: string; size: number };
    assert.equal(row.scheme, "electron-safe-storage-v1");
    assert.equal(row.size, 4);
    assert.equal(await repository.delete("translation.baidu.credentials"), true);
    assert.equal(await repository.delete("translation.baidu.credentials"), false);
    assert.equal(await repository.getEncrypted("translation.baidu.credentials"), undefined);

    await assert.rejects(
      repository.setEncrypted("empty", new Uint8Array(), "2026-07-16T12:00:00.000Z"),
      /Encrypted secret/,
    );
    await assert.rejects(
      repository.setEncrypted("bad\0key", new Uint8Array([1]), "2026-07-16T12:00:00.000Z"),
      /key/,
    );

    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(
      "INSERT INTO secrets(key, encrypted_value, encryption_scheme, updated_at) VALUES (?, ?, ?, ?)",
    ).run("wrong-scheme", new Uint8Array([1]), "plaintext", "2026-07-16T12:00:00.000Z");
    await assert.rejects(repository.getEncrypted("wrong-scheme"), /encrypted secret/);
    database.exec("PRAGMA ignore_check_constraints = OFF");

    database.prepare(
      "INSERT INTO secrets(key, encrypted_value, encryption_scheme, updated_at) VALUES (?, ?, ?, ?)",
    ).run(
      "wrong-value",
      new Uint8Array(),
      "electron-safe-storage-v1",
      "2026-07-16T12:00:00.000Z",
    );
    await assert.rejects(repository.getEncrypted("wrong-value"), /encrypted secret/);
  } finally {
    database.close();
  }
});
