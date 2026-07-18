import type { SelectionSource } from "./native-ipc.js";
import {
  MAX_TRANSLATION_TEXT_LENGTH,
  hasValidTranslationUtf16,
  isLanguageCode,
  isTranslationAttribution,
  isTranslationFailureCode,
  isTranslationRequestId,
  isTranslationRetryAfterMs,
  isTranslationSelectionId,
  type LanguageCode,
  type TranslationAttribution,
  type TranslationFailureCode,
} from "./translation.js";

export const MAX_SELECTION_CARD_TEXT_LENGTH = MAX_TRANSLATION_TEXT_LENGTH;

export interface SelectionCardBaseViewModel {
  readonly selectionId: string;
  readonly sourceText: string;
  readonly source: SelectionSource;
  readonly confidence: number;
}

export interface SourceOnlySelectionCardViewModel extends SelectionCardBaseViewModel {
  readonly kind: "source-only";
}

export interface TranslatingSelectionCardViewModel extends SelectionCardBaseViewModel {
  readonly kind: "translating";
  readonly requestId: string;
}

export interface TranslatedSelectionCardViewModel extends SelectionCardBaseViewModel {
  readonly kind: "translated";
  readonly requestId: string;
  readonly translatedText: string;
  readonly targetLanguage: LanguageCode;
  readonly detectedSourceLanguage?: LanguageCode;
  readonly attribution: TranslationAttribution;
  readonly fromCache: boolean;
}

export interface FailedSelectionCardViewModel extends SelectionCardBaseViewModel {
  readonly kind: "failed";
  readonly requestId: string;
  readonly code: TranslationFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type SelectionCardViewModel =
  | SourceOnlySelectionCardViewModel
  | TranslatingSelectionCardViewModel
  | TranslatedSelectionCardViewModel
  | FailedSelectionCardViewModel;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasValidBase(value: Record<string, unknown>): boolean {
  return (
    isTranslationSelectionId(value.selectionId) &&
    typeof value.sourceText === "string" &&
    value.sourceText.length >= 1 &&
    value.sourceText.length <= MAX_SELECTION_CARD_TEXT_LENGTH &&
    hasValidTranslationUtf16(value.sourceText) &&
    ["uia", "uia-point-approx", "ocr"].includes(value.source as string) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

const BASE_KEYS = ["kind", "selectionId", "sourceText", "source", "confidence"] as const;

export function isSelectionCardViewModel(value: unknown): value is SelectionCardViewModel {
  if (!isRecord(value) || !hasValidBase(value)) return false;
  switch (value.kind) {
    case "source-only":
      return hasOnlyKeys(value, BASE_KEYS);

    case "translating":
      return (
        hasOnlyKeys(value, [...BASE_KEYS, "requestId"]) &&
        isTranslationRequestId(value.requestId)
      );

    case "translated":
      return (
        hasOnlyKeys(value, [
          ...BASE_KEYS,
          "requestId",
          "translatedText",
          "targetLanguage",
          "detectedSourceLanguage",
          "attribution",
          "fromCache",
        ]) &&
        isTranslationRequestId(value.requestId) &&
        typeof value.translatedText === "string" &&
        value.translatedText.length >= 1 &&
        value.translatedText.length <= MAX_SELECTION_CARD_TEXT_LENGTH &&
        hasValidTranslationUtf16(value.translatedText) &&
        isLanguageCode(value.targetLanguage) &&
        (
          value.detectedSourceLanguage === undefined ||
          isLanguageCode(value.detectedSourceLanguage)
        ) &&
        isTranslationAttribution(value.attribution) &&
        typeof value.fromCache === "boolean"
      );

    case "failed":
      return (
        hasOnlyKeys(value, [
          ...BASE_KEYS,
          "requestId",
          "code",
          "retryable",
          "retryAfterMs",
        ]) &&
        isTranslationRequestId(value.requestId) &&
        isTranslationFailureCode(value.code) &&
        typeof value.retryable === "boolean" &&
        (
          value.retryAfterMs === undefined ||
          (value.retryable && isTranslationRetryAfterMs(value.retryAfterMs))
        )
      );

    default:
      return false;
  }
}
