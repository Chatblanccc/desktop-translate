import type { SelectionSource } from "../../contracts/src/native-ipc.js";
import type { TranslationResult } from "../../contracts/src/translation.js";

export interface HistoryRecord {
  readonly id: string;
  readonly selectionId: string;
  readonly sourceText: string;
  readonly translatedText: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly providerId: string;
  readonly sourceKind: SelectionSource;
  readonly confidence: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface FavoriteRecord {
  readonly id: string;
  readonly historyId?: string;
  readonly sourceText: string;
  readonly translatedText: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HistoryQuery {
  readonly before?: string;
  readonly text?: string;
  readonly limit: number;
}

export interface HistoryRepository {
  add(record: HistoryRecord): Promise<void>;
  list(query: HistoryQuery): Promise<readonly HistoryRecord[]>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
  pruneBefore(timestamp: string): Promise<number>;
}

export interface FavoritesRepository {
  add(record: FavoriteRecord): Promise<void>;
  update(id: string, patch: Pick<FavoriteRecord, "note" | "updatedAt">): Promise<boolean>;
  list(): Promise<readonly FavoriteRecord[]>;
  delete(id: string): Promise<boolean>;
}

export interface SettingsRepository {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, updatedAt: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface TranslationCacheRepository {
  get(cacheKey: string, now: string): Promise<TranslationResult | undefined>;
  put(cacheKey: string, result: TranslationResult, expiresAt: string): Promise<void>;
  prune(now: string): Promise<number>;
}

/** Values are already encrypted by Electron Main before crossing this boundary. */
export interface SecretsRepository {
  getEncrypted(key: string): Promise<Uint8Array | undefined>;
  setEncrypted(key: string, value: Uint8Array, updatedAt: string): Promise<void>;
  replaceEncryptedIfCurrent(
    key: string,
    expectedValue: Uint8Array,
    replacementValue: Uint8Array,
    updatedAt: string
  ): Promise<boolean>;
  delete(key: string): Promise<boolean>;
}
