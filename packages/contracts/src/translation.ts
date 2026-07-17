export const MAX_TRANSLATION_REQUEST_ID_LENGTH = 128;
export const MAX_TRANSLATION_TEXT_LENGTH = 32_768;
export const MAX_TRANSLATION_AUXILIARY_TEXT_LENGTH = 4_096;
export const MAX_TRANSLATION_FAILURE_MESSAGE_LENGTH = 512;
export const MAX_TRANSLATION_PROVIDER_ID_LENGTH = 64;
export const MAX_TRANSLATION_PROVIDER_DISPLAY_NAME_LENGTH = 128;
export const MAX_TRANSLATION_AUDIO_URL_LENGTH = 2_048;
export const MAX_TRANSLATION_PRONUNCIATIONS = 16;
export const MAX_TRANSLATION_DICTIONARY_SENSES = 64;
export const MAX_TRANSLATION_DEFINITIONS_PER_SENSE = 32;
export const MAX_TRANSLATION_EXAMPLES = 64;
export const MAX_TRANSLATION_RETRY_AFTER_MS = 86_400_000;

/** Phase 4 Provider and languages intentionally exposed by the desktop Settings UI. */
export const PHASE4_TRANSLATION_PROVIDER_ID = "baidu" as const;
export const PHASE4_TRANSLATION_TARGET_LANGUAGES = ["zh-CN", "en", "ja", "ko"] as const;
export type Phase4TranslationTargetLanguage =
  (typeof PHASE4_TRANSLATION_TARGET_LANGUAGES)[number];
export const PHASE4_TRANSLATION_SOURCE_LANGUAGES = [
  "auto",
  ...PHASE4_TRANSLATION_TARGET_LANGUAGES,
] as const;
export type Phase4TranslationSourceLanguage =
  (typeof PHASE4_TRANSLATION_SOURCE_LANGUAGES)[number];

export type LanguageCode = string;

export interface TranslationRequest {
  readonly requestId: string;
  readonly selectionId: string;
  readonly text: string;
  readonly sourceLanguage?: LanguageCode | "auto";
  readonly targetLanguage: LanguageCode;
}

export interface Pronunciation {
  readonly dialect?: string;
  readonly phonetic?: string;
  readonly audioUrl?: string;
}

export interface DictionarySense {
  readonly partOfSpeech?: string;
  readonly definitions: readonly string[];
}

export interface TranslationExample {
  readonly source: string;
  readonly target: string;
}

export interface TranslationAttribution {
  readonly providerId: string;
  readonly providerDisplayName: string;
}

export interface TranslationResult {
  readonly requestId: string;
  readonly selectionId: string;
  readonly originalText: string;
  readonly translatedText: string;
  readonly detectedSourceLanguage?: LanguageCode;
  readonly targetLanguage: LanguageCode;
  readonly pronunciations?: readonly Pronunciation[];
  readonly dictionary?: readonly DictionarySense[];
  readonly examples?: readonly TranslationExample[];
  readonly attribution: TranslationAttribution;
  readonly receivedAt: string;
  readonly fromCache: boolean;
}

export const TRANSLATION_FAILURE_CODES = [
  "cancelled",
  "invalid-request",
  "credentials-missing",
  "authentication-failed",
  "quota-exceeded",
  "rate-limited",
  "network-unavailable",
  "provider-unavailable",
  "unsupported-language",
  "malformed-response",
  "unknown",
] as const;
export type TranslationFailureCode = (typeof TRANSLATION_FAILURE_CODES)[number];

/**
 * Sanitized application failure. Provider causes and raw response bodies are intentionally
 * absent from this cross-package contract and must remain private to Electron Main.
 */
export interface TranslationFailure {
  readonly requestId: string;
  readonly selectionId: string;
  readonly code: TranslationFailureCode;
  readonly message: string;
  readonly providerId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function hasValidTranslationUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    hasValidTranslationUtf16(value)
  );
}

export function isTranslationRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_TRANSLATION_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function isTranslationSelectionId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && value !== "auto" && LANGUAGE_CODE_PATTERN.test(value);
}

export function isPhase4TranslationTargetLanguage(
  value: unknown,
): value is Phase4TranslationTargetLanguage {
  return PHASE4_TRANSLATION_TARGET_LANGUAGES.includes(
    value as Phase4TranslationTargetLanguage,
  );
}

export function isPhase4TranslationSourceLanguage(
  value: unknown,
): value is Phase4TranslationSourceLanguage {
  return PHASE4_TRANSLATION_SOURCE_LANGUAGES.includes(
    value as Phase4TranslationSourceLanguage,
  );
}

export function isTranslationProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TRANSLATION_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

export function isPhase4TranslationProviderId(
  value: unknown,
): value is typeof PHASE4_TRANSLATION_PROVIDER_ID {
  return value === PHASE4_TRANSLATION_PROVIDER_ID;
}

export function isTranslationFailureCode(value: unknown): value is TranslationFailureCode {
  return (
    typeof value === "string" &&
    TRANSLATION_FAILURE_CODES.includes(value as TranslationFailureCode)
  );
}

export function isTranslationRetryAfterMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TRANSLATION_RETRY_AFTER_MS
  );
}

export function isTranslationTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined || second === undefined ||
    hour > 23 || minute > 59 || second > 59
  ) return false;
  const instant = new Date(value);
  return (
    Number.isFinite(instant.getTime()) &&
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() + 1 === month &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_TRANSLATION_AUDIO_URL_LENGTH ||
    !hasValidTranslationUtf16(value)
  ) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isPronunciation(value: unknown): value is Pronunciation {
  if (!isRecord(value) || !hasOnlyKeys(value, ["dialect", "phonetic", "audioUrl"])) return false;
  if (value.dialect !== undefined && !isBoundedText(value.dialect, 1, 128)) return false;
  if (value.phonetic !== undefined && !isBoundedText(value.phonetic, 1, 256)) return false;
  if (value.audioUrl !== undefined && !isHttpsUrl(value.audioUrl)) return false;
  return value.dialect !== undefined || value.phonetic !== undefined || value.audioUrl !== undefined;
}

function isDictionarySense(value: unknown): value is DictionarySense {
  if (!isRecord(value) || !hasOnlyKeys(value, ["partOfSpeech", "definitions"])) return false;
  if (value.partOfSpeech !== undefined && !isBoundedText(value.partOfSpeech, 1, 128)) return false;
  return (
    Array.isArray(value.definitions) &&
    value.definitions.length >= 1 &&
    value.definitions.length <= MAX_TRANSLATION_DEFINITIONS_PER_SENSE &&
    value.definitions.every((definition) =>
      isBoundedText(definition, 1, MAX_TRANSLATION_AUXILIARY_TEXT_LENGTH)
    )
  );
}

function isTranslationExample(value: unknown): value is TranslationExample {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["source", "target"]) &&
    isBoundedText(value.source, 1, MAX_TRANSLATION_AUXILIARY_TEXT_LENGTH) &&
    isBoundedText(value.target, 1, MAX_TRANSLATION_AUXILIARY_TEXT_LENGTH)
  );
}

export function isTranslationAttribution(value: unknown): value is TranslationAttribution {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["providerId", "providerDisplayName"]) &&
    isTranslationProviderId(value.providerId) &&
    isBoundedText(
      value.providerDisplayName,
      1,
      MAX_TRANSLATION_PROVIDER_DISPLAY_NAME_LENGTH,
    )
  );
}

export function isTranslationRequest(value: unknown): value is TranslationRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["requestId", "selectionId", "text", "sourceLanguage", "targetLanguage"])
  ) return false;
  return (
    isTranslationRequestId(value.requestId) &&
    isTranslationSelectionId(value.selectionId) &&
    isBoundedText(value.text, 1, MAX_TRANSLATION_TEXT_LENGTH) &&
    (value.sourceLanguage === undefined || value.sourceLanguage === "auto" || isLanguageCode(value.sourceLanguage)) &&
    isLanguageCode(value.targetLanguage)
  );
}

export function isTranslationResult(value: unknown): value is TranslationResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requestId",
      "selectionId",
      "originalText",
      "translatedText",
      "detectedSourceLanguage",
      "targetLanguage",
      "pronunciations",
      "dictionary",
      "examples",
      "attribution",
      "receivedAt",
      "fromCache",
    ])
  ) return false;
  if (
    !isTranslationRequestId(value.requestId) ||
    !isTranslationSelectionId(value.selectionId) ||
    !isBoundedText(value.originalText, 1, MAX_TRANSLATION_TEXT_LENGTH) ||
    !isBoundedText(value.translatedText, 1, MAX_TRANSLATION_TEXT_LENGTH) ||
    (value.detectedSourceLanguage !== undefined && !isLanguageCode(value.detectedSourceLanguage)) ||
    !isLanguageCode(value.targetLanguage) ||
    !isTranslationAttribution(value.attribution) ||
    !isTranslationTimestamp(value.receivedAt) ||
    typeof value.fromCache !== "boolean"
  ) return false;
  if (
    value.pronunciations !== undefined &&
    (!Array.isArray(value.pronunciations) ||
      value.pronunciations.length > MAX_TRANSLATION_PRONUNCIATIONS ||
      !value.pronunciations.every(isPronunciation))
  ) return false;
  if (
    value.dictionary !== undefined &&
    (!Array.isArray(value.dictionary) ||
      value.dictionary.length > MAX_TRANSLATION_DICTIONARY_SENSES ||
      !value.dictionary.every(isDictionarySense))
  ) return false;
  if (
    value.examples !== undefined &&
    (!Array.isArray(value.examples) ||
      value.examples.length > MAX_TRANSLATION_EXAMPLES ||
      !value.examples.every(isTranslationExample))
  ) return false;
  return true;
}

export function isTranslationFailure(value: unknown): value is TranslationFailure {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requestId",
      "selectionId",
      "code",
      "message",
      "providerId",
      "retryable",
      "retryAfterMs",
    ])
  ) return false;
  return (
    isTranslationRequestId(value.requestId) &&
    isTranslationSelectionId(value.selectionId) &&
    isTranslationFailureCode(value.code) &&
    isBoundedText(value.message, 1, MAX_TRANSLATION_FAILURE_MESSAGE_LENGTH) &&
    (value.providerId === undefined || isTranslationProviderId(value.providerId)) &&
    typeof value.retryable === "boolean" &&
    (
      value.retryAfterMs === undefined ||
      (value.retryable && isTranslationRetryAfterMs(value.retryAfterMs))
    )
  );
}
