import type {
  TranslationFailure,
  TranslationRequest,
  TranslationResult,
} from "../../contracts/src/translation.js";

export interface TranslationProviderCapabilities {
  readonly translation: true;
  readonly languageDetection: boolean;
  readonly dictionary: boolean;
  readonly pronunciation: boolean;
  readonly examples: boolean;
  readonly supportedSourceLanguages?: readonly string[];
  readonly supportedTargetLanguages?: readonly string[];
  readonly maxTextLength: number;
}

/** Minimal cancellation shape, intentionally independent of DOM AbortSignal. */
export interface CancellationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface TranslationProviderContext {
  readonly signal: CancellationSignal;
  readonly now: () => Date;
}

export interface TranslationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: TranslationProviderCapabilities;

  /**
   * Implementations must never mutate the request and must reject cancellation with a
   * TranslationProviderError whose failure.code is "cancelled".
   */
  translate(request: TranslationRequest, context: TranslationProviderContext): Promise<TranslationResult>;
}

export class TranslationProviderError extends Error {
  readonly failure: TranslationFailure;

  constructor(failure: TranslationFailure) {
    super(failure.message);
    this.name = "TranslationProviderError";
    this.failure = failure;
  }
}

export function isProviderCompatible(
  provider: TranslationProvider,
  request: TranslationRequest,
): boolean {
  const { capabilities } = provider;
  if (request.text.length > capabilities.maxTextLength) return false;
  if (
    request.sourceLanguage &&
    request.sourceLanguage !== "auto" &&
    capabilities.supportedSourceLanguages &&
    !capabilities.supportedSourceLanguages.includes(request.sourceLanguage)
  ) return false;
  return !capabilities.supportedTargetLanguages || capabilities.supportedTargetLanguages.includes(request.targetLanguage);
}
