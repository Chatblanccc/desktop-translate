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

export type TranslationFailureCode =
  | "cancelled"
  | "invalid-request"
  | "credentials-missing"
  | "authentication-failed"
  | "quota-exceeded"
  | "rate-limited"
  | "network-unavailable"
  | "provider-unavailable"
  | "unsupported-language"
  | "malformed-response"
  | "unknown";

export interface TranslationFailure {
  readonly requestId: string;
  readonly selectionId: string;
  readonly code: TranslationFailureCode;
  readonly message: string;
  readonly providerId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}
