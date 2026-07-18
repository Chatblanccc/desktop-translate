import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import {
  isBallAnchor,
  isOcrActivation,
  isThemeMode,
  type BallAnchor,
  type OcrActivation,
  type ThemeMode,
} from "../../contracts/src/ui-shell.js";
import {
  isPhase4TranslationProviderId,
  isPhase4TranslationSourceLanguage,
  isPhase4TranslationTargetLanguage,
} from "../../contracts/src/translation.js";
import type { SecretsRepository, SettingsRepository } from "./repositories.js";

export interface StorageMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface RunStorageMigrationsOptions {
  readonly migrationsDirectory?: string;
  readonly migrations?: readonly StorageMigration[];
  readonly now?: () => string;
}

export const DEFAULT_STORAGE_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/u;

function validateMigration(migration: StorageMigration): void {
  if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
    throw new TypeError("Storage migration version must be a positive safe integer");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(migration.name)) {
    throw new TypeError(`Storage migration ${migration.version} has an invalid name`);
  }
  if (migration.sql.trim().length === 0) {
    throw new TypeError(`Storage migration ${migration.version} is empty`);
  }
}

function validateMigrationSet(migrations: readonly StorageMigration[]): void {
  if (migrations.length === 0) throw new TypeError("No storage migrations were found");
  const versions = new Set<number>();
  for (const [index, migration] of migrations.entries()) {
    validateMigration(migration);
    if (versions.has(migration.version)) {
      throw new TypeError(`Duplicate storage migration version: ${migration.version}`);
    }
    if (migration.version !== index + 1) {
      throw new TypeError(`Storage migrations must be contiguous from version 1; found ${migration.version}`);
    }
    versions.add(migration.version);
  }
}

export function loadStorageMigrations(
  directory = DEFAULT_STORAGE_MIGRATIONS_DIRECTORY,
): readonly StorageMigration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = MIGRATION_FILE_PATTERN.exec(entry.name);
      if (!match) throw new TypeError(`Invalid storage migration filename: ${entry.name}`);
      return {
        version: Number(match[1]),
        name: match[2]!,
        sql: readFileSync(join(directory, entry.name), "utf8"),
      } satisfies StorageMigration;
    })
    .sort((left, right) => left.version - right.version);

  validateMigrationSet(migrations);
  return migrations;
}

interface AppliedMigrationRow {
  readonly version: number | bigint;
  readonly name: string;
}

/** Applies pending migrations transactionally. The caller owns the DatabaseSync lifecycle. */
export function runStorageMigrations(
  database: DatabaseSync,
  options: RunStorageMigrationsOptions = {},
): readonly number[] {
  if (options.migrations !== undefined && options.migrationsDirectory !== undefined) {
    throw new TypeError("Specify migrations or migrationsDirectory, not both");
  }
  const migrations = options.migrations === undefined
    ? loadStorageMigrations(options.migrationsDirectory)
    : [...options.migrations].sort((left, right) => left.version - right.version);

  validateMigrationSet(migrations);

  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const appliedRows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as unknown as readonly AppliedMigrationRow[];
  const applied = new Map(appliedRows.map((row) => [Number(row.version), row.name]));

  for (const [version, name] of applied) {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (!migration) throw new Error(`Database contains unknown storage migration ${version}`);
    if (migration.name !== name) throw new Error(`Storage migration ${version} name mismatch`);
  }

  const insertApplied = database.prepare(
    "INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
  );
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insertApplied.run(migration.version, migration.name, (options.now ?? (() => new Date().toISOString()))());
      database.exec("COMMIT");
      newlyApplied.push(migration.version);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error.
      }
      throw error;
    }
  }
  return newlyApplied;
}

interface SettingRow {
  readonly valueJson: string;
}

function assertSettingKey(key: string): void {
  if (key.length < 1 || key.length > 256 || key.includes("\0")) {
    throw new TypeError("Setting key must contain 1 to 256 non-NUL characters");
  }
}

function assertUpdatedAt(updatedAt: string): void {
  if (updatedAt.length < 1 || updatedAt.length > 64 || !Number.isFinite(Date.parse(updatedAt))) {
    throw new TypeError("updatedAt must be an ISO-compatible timestamp");
  }
}

export class SqliteSettingsRepository implements SettingsRepository {
  readonly #select: StatementSync;
  readonly #upsert: StatementSync;
  readonly #delete: StatementSync;

  constructor(database: DatabaseSync) {
    this.#select = database.prepare("SELECT value_json AS valueJson FROM settings WHERE key = ?");
    this.#upsert = database.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    this.#delete = database.prepare("DELETE FROM settings WHERE key = ?");
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertSettingKey(key);
    const row = this.#select.get(key) as unknown as SettingRow | undefined;
    if (!row || typeof row.valueJson !== "string") return undefined;
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, updatedAt: string): Promise<void> {
    assertSettingKey(key);
    assertUpdatedAt(updatedAt);
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) throw new TypeError("Setting value must be JSON-serializable");
    this.#upsert.run(key, valueJson, updatedAt);
  }

  async delete(key: string): Promise<boolean> {
    assertSettingKey(key);
    const result = this.#delete.run(key);
    return Number(result.changes) > 0;
  }
}

interface SecretRow {
  readonly encryptedValue: unknown;
  readonly encryptionScheme: unknown;
}

const SAFE_STORAGE_ENCRYPTION_SCHEME = "electron-safe-storage-v1";
const MAX_ENCRYPTED_SECRET_BYTES = 1024 * 1024;

export class SqliteSecretsRepository implements SecretsRepository {
  readonly #select: StatementSync;
  readonly #upsert: StatementSync;
  readonly #replaceIfCurrent: StatementSync;
  readonly #delete: StatementSync;

  constructor(database: DatabaseSync) {
    this.#select = database.prepare(
      `SELECT encrypted_value AS encryptedValue, encryption_scheme AS encryptionScheme
       FROM secrets WHERE key = ?`,
    );
    this.#upsert = database.prepare(`
      INSERT INTO secrets(key, encrypted_value, encryption_scheme, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        encryption_scheme = excluded.encryption_scheme,
        updated_at = excluded.updated_at
    `);
    this.#replaceIfCurrent = database.prepare(`
      UPDATE secrets
      SET encrypted_value = ?, encryption_scheme = ?, updated_at = ?
      WHERE key = ? AND encryption_scheme = ? AND encrypted_value = ?
    `);
    this.#delete = database.prepare("DELETE FROM secrets WHERE key = ?");
  }

  async getEncrypted(key: string): Promise<Uint8Array | undefined> {
    assertSettingKey(key);
    const row = this.#select.get(key) as unknown as
      | SecretRow
      | undefined;
    if (row === undefined) return undefined;
    if (
      row.encryptionScheme !== SAFE_STORAGE_ENCRYPTION_SCHEME ||
      !(row.encryptedValue instanceof Uint8Array) ||
      row.encryptedValue.byteLength < 1 ||
      row.encryptedValue.byteLength > MAX_ENCRYPTED_SECRET_BYTES
    ) {
      throw new TypeError("Stored encrypted secret is invalid");
    }
    return new Uint8Array(row.encryptedValue);
  }

  async setEncrypted(key: string, value: Uint8Array, updatedAt: string): Promise<void> {
    assertSettingKey(key);
    assertUpdatedAt(updatedAt);
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength < 1 ||
      value.byteLength > MAX_ENCRYPTED_SECRET_BYTES
    ) {
      throw new TypeError("Encrypted secret must contain 1 byte to 1 MiB");
    }
    // node:sqlite copies this blob synchronously; clone first so callers never share repository state.
    this.#upsert.run(
      key,
      new Uint8Array(value),
      SAFE_STORAGE_ENCRYPTION_SCHEME,
      updatedAt,
    );
  }

  async replaceEncryptedIfCurrent(
    key: string,
    expectedValue: Uint8Array,
    replacementValue: Uint8Array,
    updatedAt: string
  ): Promise<boolean> {
    assertSettingKey(key);
    assertUpdatedAt(updatedAt);
    for (const value of [expectedValue, replacementValue]) {
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength < 1 ||
        value.byteLength > MAX_ENCRYPTED_SECRET_BYTES
      ) {
        throw new TypeError("Encrypted secret must contain 1 byte to 1 MiB");
      }
    }
    const result = this.#replaceIfCurrent.run(
      new Uint8Array(replacementValue),
      SAFE_STORAGE_ENCRYPTION_SCHEME,
      updatedAt,
      key,
      SAFE_STORAGE_ENCRYPTION_SCHEME,
      new Uint8Array(expectedValue),
    );
    return Number(result.changes) > 0;
  }

  async delete(key: string): Promise<boolean> {
    assertSettingKey(key);
    return Number(this.#delete.run(key).changes) > 0;
  }
}

export const PHASE2_SETTING_KEYS = Object.freeze({
  ballVisible: "ui.ball.visible",
  ballEdgeSnap: "ui.ball.edgeSnap",
  ballAnchor: "ui.ball.anchor",
  theme: "ui.theme",
} as const);

export type Phase2SettingKey = (typeof PHASE2_SETTING_KEYS)[keyof typeof PHASE2_SETTING_KEYS];

export interface Phase2UiSettings {
  readonly ball: {
    readonly visible: boolean;
    readonly edgeSnap: boolean;
    readonly anchor?: BallAnchor;
  };
  readonly theme: ThemeMode;
}

export const DEFAULT_PHASE2_UI_SETTINGS: Phase2UiSettings = Object.freeze({
  ball: Object.freeze({
    visible: true,
    edgeSnap: true,
  }),
  theme: "system",
});

export interface SqlitePhase2SettingsRepositoryOptions {
  readonly now?: () => string;
  /** Receives only the invalid key; persisted values never cross this diagnostic boundary. */
  readonly onInvalidSetting?: (key: Phase2SettingKey) => void;
}

type ReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: unknown };

export class SqlitePhase2SettingsRepository {
  readonly #settings: SqliteSettingsRepository;
  readonly #select: StatementSync;
  readonly #now: () => string;
  readonly #onInvalidSetting: ((key: Phase2SettingKey) => void) | undefined;

  constructor(database: DatabaseSync, options: SqlitePhase2SettingsRepositoryOptions = {}) {
    this.#settings = new SqliteSettingsRepository(database);
    this.#select = database.prepare("SELECT value_json AS valueJson FROM settings WHERE key = ?");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onInvalidSetting = options.onInvalidSetting;
  }

  async load(): Promise<Phase2UiSettings> {
    const visible = this.#readValidated(PHASE2_SETTING_KEYS.ballVisible, isBoolean, true);
    const edgeSnap = this.#readValidated(PHASE2_SETTING_KEYS.ballEdgeSnap, isBoolean, true);
    const anchor = this.#readValidated(PHASE2_SETTING_KEYS.ballAnchor, isBallAnchor, undefined);
    const theme = this.#readValidated(PHASE2_SETTING_KEYS.theme, isThemeMode, "system");
    return anchor === undefined
      ? { ball: { visible, edgeSnap }, theme }
      : { ball: { visible, edgeSnap, anchor }, theme };
  }

  async setBallVisible(value: boolean): Promise<void> {
    if (typeof value !== "boolean") throw new TypeError("Ball visibility must be a boolean");
    await this.#settings.set(PHASE2_SETTING_KEYS.ballVisible, value, this.#now());
  }

  async setEdgeSnap(value: boolean): Promise<void> {
    if (typeof value !== "boolean") throw new TypeError("Edge snap must be a boolean");
    await this.#settings.set(PHASE2_SETTING_KEYS.ballEdgeSnap, value, this.#now());
  }

  async setTheme(value: ThemeMode): Promise<void> {
    if (!isThemeMode(value)) throw new TypeError("Theme must be system, light, or dark");
    await this.#settings.set(PHASE2_SETTING_KEYS.theme, value, this.#now());
  }

  async setBallAnchor(value: BallAnchor): Promise<void> {
    if (!isBallAnchor(value)) throw new TypeError("Ball anchor is invalid");
    await this.#settings.set(PHASE2_SETTING_KEYS.ballAnchor, value, this.#now());
  }

  async resetBallAnchor(): Promise<void> {
    await this.#settings.delete(PHASE2_SETTING_KEYS.ballAnchor);
  }

  #readSetting(key: Phase2SettingKey): ReadResult {
    const row = this.#select.get(key) as unknown as SettingRow | undefined;
    if (!row) return { kind: "missing" };
    if (typeof row.valueJson !== "string") return { kind: "invalid" };
    try {
      return { kind: "value", value: JSON.parse(row.valueJson) as unknown };
    } catch {
      return { kind: "invalid" };
    }
  }

  #readValidated<T>(
    key: Phase2SettingKey,
    guard: (value: unknown) => value is T,
    fallback: T,
  ): T {
    const result = this.#readSetting(key);
    if (result.kind === "missing") return fallback;
    if (result.kind === "value" && guard(result.value)) return result.value;
    try {
      this.#onInvalidSetting?.(key);
    } catch {
      // Diagnostics must never prevent safe startup defaults.
    }
    return fallback;
  }
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export const PHASE3_SETTING_KEYS = Object.freeze({
  ...PHASE2_SETTING_KEYS,
  selectionEnabled: "selection.enabled",
  ocrActivation: "selection.ocrActivation",
} as const);

export type Phase3SettingKey = (typeof PHASE3_SETTING_KEYS)[keyof typeof PHASE3_SETTING_KEYS];

export interface Phase3UiSettings extends Phase2UiSettings {
  readonly selection: {
    readonly enabled: boolean;
    readonly ocrActivation: OcrActivation;
  };
}

export const DEFAULT_PHASE3_UI_SETTINGS: Phase3UiSettings = Object.freeze({
  ...DEFAULT_PHASE2_UI_SETTINGS,
  selection: Object.freeze({ enabled: true, ocrActivation: "fallback" }),
});

export interface SqlitePhase3SettingsRepositoryOptions {
  readonly now?: () => string;
  /** Receives only the invalid key; persisted values never cross this boundary. */
  readonly onInvalidSetting?: (key: Phase3SettingKey) => void;
}

export class SqlitePhase3SettingsRepository {
  readonly #settings: SqliteSettingsRepository;
  readonly #select: StatementSync;
  readonly #now: () => string;
  readonly #onInvalidSetting: ((key: Phase3SettingKey) => void) | undefined;

  constructor(database: DatabaseSync, options: SqlitePhase3SettingsRepositoryOptions = {}) {
    this.#settings = new SqliteSettingsRepository(database);
    this.#select = database.prepare("SELECT value_json AS valueJson FROM settings WHERE key = ?");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onInvalidSetting = options.onInvalidSetting;
  }

  async load(): Promise<Phase3UiSettings> {
    const visible = this.#readValidated(PHASE3_SETTING_KEYS.ballVisible, isBoolean, true);
    const edgeSnap = this.#readValidated(PHASE3_SETTING_KEYS.ballEdgeSnap, isBoolean, true);
    const anchor = this.#readValidated(PHASE3_SETTING_KEYS.ballAnchor, isBallAnchor, undefined);
    const theme = this.#readValidated(PHASE3_SETTING_KEYS.theme, isThemeMode, "system");
    const enabled = this.#readValidated(PHASE3_SETTING_KEYS.selectionEnabled, isBoolean, true);
    const ocrActivation = this.#readValidated(
      PHASE3_SETTING_KEYS.ocrActivation,
      isOcrActivation,
      "fallback",
    );
    const ball = anchor === undefined
      ? { visible, edgeSnap }
      : { visible, edgeSnap, anchor };
    return { ball, theme, selection: { enabled, ocrActivation } };
  }

  async setBallVisible(value: boolean): Promise<void> {
    if (typeof value !== "boolean") throw new TypeError("Ball visibility must be a boolean");
    await this.#settings.set(PHASE3_SETTING_KEYS.ballVisible, value, this.#now());
  }

  async setEdgeSnap(value: boolean): Promise<void> {
    if (typeof value !== "boolean") throw new TypeError("Edge snap must be a boolean");
    await this.#settings.set(PHASE3_SETTING_KEYS.ballEdgeSnap, value, this.#now());
  }

  async setTheme(value: ThemeMode): Promise<void> {
    if (!isThemeMode(value)) throw new TypeError("Theme must be system, light, or dark");
    await this.#settings.set(PHASE3_SETTING_KEYS.theme, value, this.#now());
  }

  async setBallAnchor(value: BallAnchor): Promise<void> {
    if (!isBallAnchor(value)) throw new TypeError("Ball anchor is invalid");
    await this.#settings.set(PHASE3_SETTING_KEYS.ballAnchor, value, this.#now());
  }

  async resetBallAnchor(): Promise<void> {
    await this.#settings.delete(PHASE3_SETTING_KEYS.ballAnchor);
  }

  async setSelectionEnabled(value: boolean): Promise<void> {
    if (typeof value !== "boolean") throw new TypeError("Selection enabled must be a boolean");
    await this.#settings.set(PHASE3_SETTING_KEYS.selectionEnabled, value, this.#now());
  }

  async setOcrActivation(value: OcrActivation): Promise<void> {
    if (!isOcrActivation(value)) throw new TypeError("OCR activation is invalid");
    await this.#settings.set(PHASE3_SETTING_KEYS.ocrActivation, value, this.#now());
  }

  #readValidated<T>(key: Phase3SettingKey, guard: (value: unknown) => value is T, fallback: T): T {
    const row = this.#select.get(key) as unknown as SettingRow | undefined;
    if (!row) return fallback;
    try {
      const value = JSON.parse(row.valueJson) as unknown;
      if (guard(value)) return value;
    } catch {
      // Invalid values use the safe fallback path below.
    }
    try {
      this.#onInvalidSetting?.(key);
    } catch {
      // Diagnostics must never prevent safe startup defaults.
    }
    return fallback;
  }
}

export const PHASE4_SETTING_KEYS = Object.freeze({
  ...PHASE3_SETTING_KEYS,
  translationEnabled: "translation.enabled",
  translationProviderId: "translation.providerId",
  translationSourceLanguage: "translation.sourceLanguage",
  translationTargetLanguage: "translation.targetLanguage",
  translationConsentVersion: "translation.consentVersion",
} as const);

export type Phase4SettingKey = (typeof PHASE4_SETTING_KEYS)[keyof typeof PHASE4_SETTING_KEYS];

export interface Phase4UiSettings extends Phase3UiSettings {
  readonly translation: {
    readonly enabled: boolean;
    readonly providerId: string;
    readonly sourceLanguage: string | "auto";
    readonly targetLanguage: string;
    /** Zero means the user has not accepted a Phase 4 outbound-text consent notice. */
    readonly consentVersion: number;
  };
}

export const DEFAULT_PHASE4_UI_SETTINGS: Phase4UiSettings = Object.freeze({
  ...DEFAULT_PHASE3_UI_SETTINGS,
  translation: Object.freeze({
    enabled: false,
    providerId: "baidu",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    consentVersion: 0,
  }),
});

export interface SqlitePhase4SettingsRepositoryOptions {
  readonly now?: () => string;
  /** Receives only the invalid key; persisted values never cross this diagnostic boundary. */
  readonly onInvalidSetting?: (key: Phase4SettingKey) => void;
}

export class SqlitePhase4SettingsRepository {
  readonly #phase3: SqlitePhase3SettingsRepository;
  readonly #settings: SqliteSettingsRepository;
  readonly #select: StatementSync;
  readonly #now: () => string;
  readonly #onInvalidSetting: ((key: Phase4SettingKey) => void) | undefined;

  constructor(database: DatabaseSync, options: SqlitePhase4SettingsRepositoryOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onInvalidSetting = options.onInvalidSetting;
    this.#phase3 = new SqlitePhase3SettingsRepository(database, {
      now: this.#now,
      ...(options.onInvalidSetting === undefined
        ? {}
        : { onInvalidSetting: options.onInvalidSetting }),
    });
    this.#settings = new SqliteSettingsRepository(database);
    this.#select = database.prepare("SELECT value_json AS valueJson FROM settings WHERE key = ?");
  }

  async load(): Promise<Phase4UiSettings> {
    const phase3 = await this.#phase3.load();
    return {
      ...phase3,
      translation: {
        enabled: this.#readValidated(
          PHASE4_SETTING_KEYS.translationEnabled,
          isBoolean,
          DEFAULT_PHASE4_UI_SETTINGS.translation.enabled,
        ),
        providerId: this.#readValidated(
          PHASE4_SETTING_KEYS.translationProviderId,
          isProviderId,
          DEFAULT_PHASE4_UI_SETTINGS.translation.providerId,
        ),
        sourceLanguage: this.#readValidated(
          PHASE4_SETTING_KEYS.translationSourceLanguage,
          isPhase4TranslationSourceLanguage,
          DEFAULT_PHASE4_UI_SETTINGS.translation.sourceLanguage,
        ),
        targetLanguage: this.#readValidated(
          PHASE4_SETTING_KEYS.translationTargetLanguage,
          isPhase4TranslationTargetLanguage,
          DEFAULT_PHASE4_UI_SETTINGS.translation.targetLanguage,
        ),
        consentVersion: this.#readValidated(
          PHASE4_SETTING_KEYS.translationConsentVersion,
          isConsentVersion,
          DEFAULT_PHASE4_UI_SETTINGS.translation.consentVersion,
        ),
      },
    };
  }

  async setBallVisible(value: boolean): Promise<void> {
    await this.#phase3.setBallVisible(value);
  }

  async setEdgeSnap(value: boolean): Promise<void> {
    await this.#phase3.setEdgeSnap(value);
  }

  async setTheme(value: ThemeMode): Promise<void> {
    await this.#phase3.setTheme(value);
  }

  async setBallAnchor(value: BallAnchor): Promise<void> {
    await this.#phase3.setBallAnchor(value);
  }

  async resetBallAnchor(): Promise<void> {
    await this.#phase3.resetBallAnchor();
  }

  async setSelectionEnabled(value: boolean): Promise<void> {
    await this.#phase3.setSelectionEnabled(value);
  }

  async setOcrActivation(value: OcrActivation): Promise<void> {
    await this.#phase3.setOcrActivation(value);
  }

  async setTranslationEnabled(value: boolean): Promise<void> {
    if (!isBoolean(value)) throw new TypeError("Translation enabled must be a boolean");
    await this.#settings.set(PHASE4_SETTING_KEYS.translationEnabled, value, this.#now());
  }

  async setTranslationProviderId(value: string): Promise<void> {
    if (!isProviderId(value)) throw new TypeError("Translation provider id is invalid");
    await this.#settings.set(PHASE4_SETTING_KEYS.translationProviderId, value, this.#now());
  }

  async setTranslationSourceLanguage(value: string | "auto"): Promise<void> {
    if (!isPhase4TranslationSourceLanguage(value)) {
      throw new TypeError("Translation source language is invalid");
    }
    await this.#settings.set(PHASE4_SETTING_KEYS.translationSourceLanguage, value, this.#now());
  }

  async setTranslationTargetLanguage(value: string): Promise<void> {
    if (!isPhase4TranslationTargetLanguage(value)) {
      throw new TypeError("Translation target language is invalid");
    }
    await this.#settings.set(PHASE4_SETTING_KEYS.translationTargetLanguage, value, this.#now());
  }

  async setTranslationConsentVersion(value: number): Promise<void> {
    if (!isConsentVersion(value)) throw new TypeError("Translation consent version is invalid");
    await this.#settings.set(PHASE4_SETTING_KEYS.translationConsentVersion, value, this.#now());
  }

  async resetTranslationConsent(): Promise<void> {
    await this.#settings.delete(PHASE4_SETTING_KEYS.translationConsentVersion);
  }

  #readValidated<T>(key: Phase4SettingKey, guard: (value: unknown) => value is T, fallback: T): T {
    const row = this.#select.get(key) as unknown as SettingRow | undefined;
    if (row === undefined) return fallback;
    try {
      const value = JSON.parse(row.valueJson) as unknown;
      if (guard(value)) return value;
    } catch {
      // Invalid values use the safe fallback path below.
    }
    try {
      this.#onInvalidSetting?.(key);
    } catch {
      // Diagnostics must never prevent safe startup defaults.
    }
    return fallback;
  }
}

function isProviderId(value: unknown): value is string {
  return isPhase4TranslationProviderId(value);
}

function isConsentVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}

export class SqliteAppExclusionsRepository {
  readonly #listEnabled: StatementSync;

  constructor(database: DatabaseSync) {
    this.#listEnabled = database.prepare(
      "SELECT process_name AS processName, enabled FROM app_exclusions WHERE enabled = 1 ORDER BY process_name COLLATE NOCASE",
    );
  }

  async listEnabledProcessNames(): Promise<readonly string[]> {
    const rows = this.#listEnabled.all() as unknown as Array<{
      readonly processName: string;
      readonly enabled: number;
    }>;
    return rows
      .filter((row) => row.enabled === 1 && isWindowsProcessBasename(row.processName))
      .map((row) => row.processName);
  }
}

function isWindowsProcessBasename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 260 &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".") &&
    !value.endsWith(" ") &&
    !/[<>:"/\\|?*\u0000-\u001f]/u.test(value)
  );
}
