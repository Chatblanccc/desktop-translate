import { createHash, randomInt } from "node:crypto";

import type {
  TranslationFailure,
  TranslationFailureCode,
  TranslationRequest,
  TranslationResult,
} from "../../contracts/src/translation.js";
import {
  isTranslationRequest,
  isTranslationResult,
} from "../../contracts/src/translation.js";
import {
  TranslationProviderError,
  type CancellationSignal,
  type TranslationProvider,
  type TranslationProviderContext,
} from "./provider.js";

export const BAIDU_TRANSLATION_ENDPOINT =
  "https://fanyi-api.baidu.com/api/trans/vip/translate";
export const BAIDU_MAX_TEXT_BYTES = 6_000;
export const BAIDU_DEFAULT_TIMEOUT_MS = 8_000;
export const BAIDU_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export const BAIDU_PROVIDER_ID = "baidu";
export const BAIDU_PROVIDER_DISPLAY_NAME = "百度翻译";
const BAIDU_ALLOWED_HOST = "fanyi-api.baidu.com";
const BAIDU_ALLOWED_PATH = "/api/trans/vip/translate";

export interface BaiduCredentials {
  readonly appId: string;
  readonly secretKey: string;
}

export type BaiduCredentialsSource =
  | BaiduCredentials
  | (() => BaiduCredentials | undefined | Promise<BaiduCredentials | undefined>);

/**
 * Main-only audit metadata. The symbol keeps the derived boolean out of normal
 * request enumeration and serialization while allowing the validation wrapper
 * to attest that the credential literal is absent from the encoded form.
 */
export const BAIDU_TRANSPORT_AUDIT_METADATA = Symbol("baidu-transport-audit-metadata");

export interface BaiduTransportAuditMetadata {
  readonly secretLiteralPresent: boolean;
}

export interface BaiduTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: CancellationSignal;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly [BAIDU_TRANSPORT_AUDIT_METADATA]?: BaiduTransportAuditMetadata;
}

export interface BaiduTransportResponse {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;
}

export interface BaiduTransport {
  send(request: BaiduTransportRequest): Promise<BaiduTransportResponse>;
}

export type BaiduTransportErrorKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "response-too-large"
  | "malformed-response";

/** Contains classification only. It deliberately never retains a request or response body. */
export class BaiduTransportError extends Error {
  readonly kind: BaiduTransportErrorKind;

  constructor(kind: BaiduTransportErrorKind, message: string) {
    super(message);
    this.name = "BaiduTransportError";
    this.kind = kind;
  }
}

export type BaiduFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchBaiduTransportOptions {
  readonly fetch?: BaiduFetch;
}

/** Security-constrained transport for the single Baidu general-translation endpoint. */
export class FetchBaiduTransport implements BaiduTransport {
  readonly #fetch: BaiduFetch;

  constructor(options: FetchBaiduTransportOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(request: BaiduTransportRequest): Promise<BaiduTransportResponse> {
    assertAllowedEndpoint(request.url);
    assertTransportLimits(request.timeoutMs, request.maxResponseBytes);
    if (request.method !== "POST") {
      throw new BaiduTransportError("network", "Baidu transport requires POST");
    }
    if (request.signal.aborted) {
      throw new BaiduTransportError("cancelled", "Translation request was cancelled");
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);

    try {
      const response = await this.#fetch(request.url, {
        method: "POST",
        headers: { ...request.headers },
        body: request.body,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const body = await readBoundedUtf8Body(response, request.maxResponseBytes);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return retryAfterMs === undefined
        ? { status: response.status, body }
        : { status: response.status, body, retryAfterMs };
    } catch (error) {
      if (request.signal.aborted) {
        throw new BaiduTransportError("cancelled", "Translation request was cancelled");
      }
      if (timedOut) {
        throw new BaiduTransportError("timeout", "Baidu translation request timed out");
      }
      if (error instanceof BaiduTransportError) throw error;
      throw new BaiduTransportError("network", "Baidu translation network request failed");
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface BaiduTranslationProviderOptions {
  readonly credentials?: BaiduCredentialsSource;
  readonly transport?: BaiduTransport;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Generates a numeric salt. Injection keeps signing tests deterministic. */
  readonly createSalt?: () => string;
}

export class BaiduTranslationProvider implements TranslationProvider {
  readonly id = BAIDU_PROVIDER_ID;
  readonly displayName = BAIDU_PROVIDER_DISPLAY_NAME;
  readonly capabilities = Object.freeze({
    translation: true as const,
    languageDetection: true,
    dictionary: false,
    pronunciation: false,
    examples: false,
    supportedSourceLanguages: Object.freeze([...SUPPORTED_LANGUAGE_CODES, "auto"]),
    supportedTargetLanguages: SUPPORTED_LANGUAGE_CODES,
    // The provider contract measures characters; translate() additionally enforces 6,000 UTF-8 bytes.
    maxTextLength: BAIDU_MAX_TEXT_BYTES,
  });

  readonly #credentials: BaiduCredentialsSource | undefined;
  readonly #transport: BaiduTransport;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #createSalt: () => string;

  constructor(options: BaiduTranslationProviderOptions = {}) {
    this.#credentials = options.credentials;
    this.#transport = options.transport ?? new FetchBaiduTransport();
    this.#timeoutMs = options.timeoutMs ?? BAIDU_DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? BAIDU_DEFAULT_MAX_RESPONSE_BYTES;
    this.#createSalt = options.createSalt ?? (() => randomInt(100_000_000, 2_147_483_647).toString());
    assertTransportLimits(this.#timeoutMs, this.#maxResponseBytes);
  }

  async translate(
    request: TranslationRequest,
    context: TranslationProviderContext,
  ): Promise<TranslationResult> {
    if (context.signal.aborted) throw failure(request, "cancelled", false);
    const controller = new AbortController();
    let deadlineReached = false;
    const onExternalAbort = (): void => controller.abort("translation-cancelled");
    context.signal.addEventListener("abort", onExternalAbort, { once: true });

    const timeout = setTimeout(() => {
      deadlineReached = true;
      controller.abort("translation-timeout");
    }, this.#timeoutMs);
    let rejectCancellation!: (reason: TranslationProviderError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onInternalAbort = (): void => {
      rejectCancellation(deadlineReached
        ? failure(request, "network-unavailable", true)
        : failure(request, "cancelled", false));
    };
    controller.signal.addEventListener("abort", onInternalAbort, { once: true });

    // A custom CancellationSignal may have changed before its listener was installed.
    if (context.signal.aborted) onExternalAbort();
    try {
      const work = this.#translateOnce(request, {
        signal: controller.signal,
        now: context.now,
      });
      return await Promise.race([work, cancellation]);
    } catch (error) {
      // Whichever branch observes abort first must produce the same stable result.
      if (deadlineReached) throw failure(request, "network-unavailable", true);
      if (context.signal.aborted) throw failure(request, "cancelled", false);
      throw error;
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onExternalAbort);
      controller.signal.removeEventListener("abort", onInternalAbort);
    }
  }

  async #translateOnce(
    request: TranslationRequest,
    context: TranslationProviderContext,
  ): Promise<TranslationResult> {
    if (context.signal.aborted) throw failure(request, "cancelled", false);
    validateTranslationRequest(request);

    const credentials = await this.#resolveCredentials(request);
    if (context.signal.aborted) throw failure(request, "cancelled", false);

    const salt = this.#createSalt();
    if (!/^\d{1,32}$/u.test(salt)) {
      throw failure(request, "invalid-request", false);
    }
    const sourceLanguage = mapLanguageToBaidu(request.sourceLanguage ?? "auto");
    const targetLanguage = mapLanguageToBaidu(request.targetLanguage);
    if (targetLanguage === "auto") {
      throw failure(request, "unsupported-language", false);
    }
    const sign = createBaiduSignature(credentials, request.text, salt);
    const body = new URLSearchParams([
      ["q", request.text],
      ["from", sourceLanguage],
      ["to", targetLanguage],
      ["appid", credentials.appId],
      ["salt", salt],
      ["sign", sign],
    ]).toString();

    const transportRequest: BaiduTransportRequest = {
      url: BAIDU_TRANSLATION_ENDPOINT,
      method: "POST",
      headers: Object.freeze({
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        accept: "application/json",
      }),
      body,
      signal: context.signal,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maxResponseBytes,
    };
    Object.defineProperty(transportRequest, BAIDU_TRANSPORT_AUDIT_METADATA, {
      value: Object.freeze({
        secretLiteralPresent: [...new URLSearchParams(body).values()].some((value) =>
          value.includes(credentials.secretKey)
        ),
      }),
      enumerable: false,
      configurable: false,
      writable: false,
    });

    let response: BaiduTransportResponse;
    try {
      response = await this.#transport.send(transportRequest);
    } catch (error) {
      throw mapTransportFailure(request, error);
    }

    if (utf8Length(response.body) > this.#maxResponseBytes) {
      throw failure(request, "malformed-response", false);
    }
    if (response.status < 200 || response.status > 299) {
      throw mapHttpFailure(request, response);
    }
    if (context.signal.aborted) throw failure(request, "cancelled", false);

    let parsed: ParsedBaiduResponse;
    try {
      parsed = parseBaiduResponse(response.body);
    } catch (error) {
      throw mapTransportFailure(request, error);
    }
    if (parsed.kind === "failure") {
      throw mapBaiduFailure(request, parsed.errorCode);
    }
    if (
      parsed.to !== targetLanguage ||
      !isSupportedBaiduLanguageCode(parsed.from) ||
      (sourceLanguage !== "auto" && parsed.from !== sourceLanguage)
    ) {
      throw failure(request, "malformed-response", false);
    }
    if (!matchesBaiduSourceEcho(request.text, parsed.translations)) {
      throw failure(request, "malformed-response", false);
    }

    const result: TranslationResult = {
      requestId: request.requestId,
      selectionId: request.selectionId,
      originalText: request.text,
      translatedText: parsed.translations.map((entry) => entry.dst).join("\n"),
      detectedSourceLanguage: mapLanguageFromBaidu(parsed.from),
      targetLanguage: request.targetLanguage,
      attribution: {
        providerId: BAIDU_PROVIDER_ID,
        providerDisplayName: BAIDU_PROVIDER_DISPLAY_NAME,
      },
      receivedAt: context.now().toISOString(),
      fromCache: false,
    };
    if (!isTranslationResult(result)) {
      throw failure(request, "malformed-response", false);
    }
    return result;
  }

  async #resolveCredentials(request: TranslationRequest): Promise<BaiduCredentials> {
    let credentials: BaiduCredentials | undefined;
    try {
      credentials = typeof this.#credentials === "function"
        ? await this.#credentials()
        : this.#credentials;
    } catch {
      throw failure(request, "credentials-missing", false);
    }
    if (!isValidCredentialPart(credentials?.appId) || !isValidCredentialPart(credentials?.secretKey)) {
      throw failure(request, "credentials-missing", false);
    }
    return credentials;
  }
}

export function createBaiduSignature(
  credentials: BaiduCredentials,
  text: string,
  salt: string,
): string {
  return createHash("md5")
    .update(`${credentials.appId}${text}${salt}${credentials.secretKey}`, "utf8")
    .digest("hex");
}

const LANGUAGE_TO_BAIDU = Object.freeze({
  "zh-CN": "zh",
  "zh-Hans": "zh",
  zh: "zh",
  "zh-TW": "cht",
  "zh-Hant": "cht",
  en: "en",
  ja: "jp",
  jp: "jp",
  ko: "kor",
  kor: "kor",
  fr: "fra",
  fra: "fra",
  es: "spa",
  spa: "spa",
  th: "th",
  ar: "ara",
  ara: "ara",
  ru: "ru",
  pt: "pt",
  de: "de",
  it: "it",
  el: "el",
  nl: "nl",
  pl: "pl",
  bg: "bul",
  bul: "bul",
  et: "est",
  est: "est",
  da: "dan",
  dan: "dan",
  fi: "fin",
  fin: "fin",
  cs: "cs",
  ro: "rom",
  rom: "rom",
  sl: "slo",
  slo: "slo",
  sv: "swe",
  swe: "swe",
  hu: "hu",
  vi: "vie",
  vie: "vie",
  yue: "yue",
  lzh: "wyw",
  wyw: "wyw",
  auto: "auto",
} as const);

const SUPPORTED_LANGUAGE_CODES = Object.freeze(Object.keys(LANGUAGE_TO_BAIDU).filter(
  (language) => language !== "auto",
));
const SUPPORTED_BAIDU_LANGUAGE_CODES = new Set(
  Object.values(LANGUAGE_TO_BAIDU).filter((language) => language !== "auto"),
);

function isSupportedBaiduLanguageCode(language: string): boolean {
  return SUPPORTED_BAIDU_LANGUAGE_CODES.has(language as Exclude<
    (typeof LANGUAGE_TO_BAIDU)[keyof typeof LANGUAGE_TO_BAIDU],
    "auto"
  >);
}

function mapLanguageToBaidu(language: string): string {
  const mapped = (LANGUAGE_TO_BAIDU as Readonly<Record<string, string>>)[language];
  if (mapped === undefined) throw new UnsupportedLanguageError();
  return mapped;
}

function mapLanguageFromBaidu(language: string): string {
  const mapped: Readonly<Record<string, string>> = {
    zh: "zh-CN",
    cht: "zh-TW",
    jp: "ja",
    kor: "ko",
    fra: "fr",
    spa: "es",
    ara: "ar",
    bul: "bg",
    est: "et",
    dan: "da",
    fin: "fi",
    rom: "ro",
    slo: "sl",
    swe: "sv",
    vie: "vi",
    wyw: "lzh",
  };
  return mapped[language] ?? language;
}

class UnsupportedLanguageError extends Error {}

function validateTranslationRequest(request: TranslationRequest): void {
  if (!isTranslationRequest(request)) {
    throw failure(request, "invalid-request", false);
  }
  if (
    typeof request.text !== "string" ||
    request.text.trim().length === 0 ||
    request.text.includes("\0") ||
    utf8Length(request.text) > BAIDU_MAX_TEXT_BYTES
  ) {
    throw failure(request, "invalid-request", false);
  }
  try {
    mapLanguageToBaidu(request.sourceLanguage ?? "auto");
    if (mapLanguageToBaidu(request.targetLanguage) === "auto") throw new UnsupportedLanguageError();
  } catch (error) {
    if (error instanceof UnsupportedLanguageError) {
      throw failure(request, "unsupported-language", false);
    }
    throw error;
  }
}

function isValidCredentialPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.length <= 512 &&
    !value.includes("\0")
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertTransportLimits(timeoutMs: number, maxResponseBytes: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("Baidu timeout must be between 1 and 120000 milliseconds");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 1024 * 1024
  ) {
    throw new TypeError("Baidu response limit must be between 1 byte and 1 MiB");
  }
}

function assertAllowedEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BaiduTransportError("network", "Baidu endpoint is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== BAIDU_ALLOWED_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== BAIDU_ALLOWED_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BaiduTransportError("network", "Baidu endpoint is not allowlisted");
  }
}

async function readBoundedUtf8Body(response: Response, limit: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > limit) {
    await response.body?.cancel();
    throw new BaiduTransportError("response-too-large", "Baidu response exceeded the size limit");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new BaiduTransportError("response-too-large", "Baidu response exceeded the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BaiduTransportError) throw error;
    throw new BaiduTransportError("network", "Baidu response stream failed");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BaiduTransportError("malformed-response", "Baidu response was not valid UTF-8");
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), 60_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(timestamp - Date.now(), 0), 60_000);
}

type ParsedBaiduResponse =
  | {
      readonly kind: "success";
      readonly from: string;
      readonly to: string;
      readonly translations: readonly { readonly src: string; readonly dst: string }[];
    }
  | { readonly kind: "failure"; readonly errorCode: string };

function baiduSourceCorrelationKey(value: string): string {
  return value
    .normalize("NFC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function matchesBaiduSourceEcho(
  requestText: string,
  translations: readonly { readonly src: string; readonly dst: string }[],
): boolean {
  const echoedSource = translations.map((entry) => entry.src).join("\n");
  if (
    baiduSourceCorrelationKey(echoedSource) !==
    baiduSourceCorrelationKey(requestText)
  ) {
    return false;
  }
  return translations.every((entry) => {
    const sourceIsBlank = baiduSourceCorrelationKey(entry.src).trim().length === 0;
    const translationIsBlank = baiduSourceCorrelationKey(entry.dst).trim().length === 0;
    return !sourceIsBlank || translationIsBlank;
  });
}

function parseBaiduResponse(body: string): ParsedBaiduResponse {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new BaiduTransportError("malformed-response", "Baidu returned invalid JSON");
  }
  if (!isRecord(value)) {
    throw new BaiduTransportError("malformed-response", "Baidu returned an invalid response object");
  }
  if ("error_code" in value) {
    if (typeof value.error_code !== "string" || !/^\d{5}$/u.test(value.error_code)) {
      throw new BaiduTransportError("malformed-response", "Baidu returned an invalid error code");
    }
    return { kind: "failure", errorCode: value.error_code };
  }
  if (
    typeof value.from !== "string" ||
    value.from.length < 1 ||
    value.from.length > 32 ||
    typeof value.to !== "string" ||
    value.to.length < 1 ||
    value.to.length > 32 ||
    !Array.isArray(value.trans_result) ||
    value.trans_result.length < 1 ||
    value.trans_result.length > 1_000
  ) {
    throw new BaiduTransportError("malformed-response", "Baidu returned an invalid translation response");
  }
  const translations: Array<{ readonly src: string; readonly dst: string }> = [];
  for (const entry of value.trans_result) {
    if (
      !isRecord(entry) ||
      typeof entry.src !== "string" ||
      typeof entry.dst !== "string" ||
      entry.src.length > BAIDU_MAX_TEXT_BYTES ||
      entry.dst.length > BAIDU_DEFAULT_MAX_RESPONSE_BYTES
    ) {
      throw new BaiduTransportError("malformed-response", "Baidu returned an invalid translation item");
    }
    translations.push({ src: entry.src, dst: entry.dst });
  }
  if (translations.every((entry) => entry.dst.length === 0)) {
    throw new BaiduTransportError("malformed-response", "Baidu returned an empty translation");
  }
  return { kind: "success", from: value.from, to: value.to, translations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapTransportFailure(request: TranslationRequest, error: unknown): TranslationProviderError {
  if (error instanceof TranslationProviderError) return error;
  if (error instanceof BaiduTransportError) {
    switch (error.kind) {
      case "cancelled":
        return failure(request, "cancelled", false);
      case "timeout":
      case "network":
        return failure(request, "network-unavailable", true);
      case "response-too-large":
      case "malformed-response":
        return failure(request, "malformed-response", false);
    }
  }
  return failure(request, "network-unavailable", true);
}

function mapHttpFailure(
  request: TranslationRequest,
  response: BaiduTransportResponse,
): TranslationProviderError {
  if (response.status === 401 || response.status === 403) {
    return failure(request, "authentication-failed", false);
  }
  if (response.status === 429) {
    return failure(request, "rate-limited", true, response.retryAfterMs ?? 1_000);
  }
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return failure(request, "invalid-request", false);
  }
  if (response.status === 408 || response.status >= 500) {
    return failure(request, "provider-unavailable", true, response.retryAfterMs);
  }
  return failure(request, "provider-unavailable", false);
}

function mapBaiduFailure(request: TranslationRequest, code: string): TranslationProviderError {
  switch (code) {
    case "52001":
    case "52002":
      return failure(request, "provider-unavailable", true);
    case "52003":
    case "54001":
    case "58000":
    case "90107":
      return failure(request, "authentication-failed", false);
    case "54000":
      return failure(request, "invalid-request", false);
    case "54003":
      return failure(request, "rate-limited", true, 1_000);
    case "54004":
      return failure(request, "quota-exceeded", false);
    case "54005":
      return failure(request, "rate-limited", true, 3_000);
    case "58001":
      return failure(request, "unsupported-language", false);
    case "58002":
      return failure(request, "provider-unavailable", false);
    default:
      return failure(request, "unknown", false);
  }
}

const FAILURE_MESSAGES: Readonly<Record<TranslationFailureCode, string>> = Object.freeze({
  cancelled: "Translation request was cancelled",
  "invalid-request": "Translation request is invalid",
  "credentials-missing": "Baidu translation credentials are not configured",
  "authentication-failed": "Baidu translation authentication failed",
  "quota-exceeded": "Baidu translation quota is exhausted",
  "rate-limited": "Baidu translation rate limit was reached",
  "network-unavailable": "Baidu translation network is unavailable",
  "provider-unavailable": "Baidu translation service is unavailable",
  "unsupported-language": "Baidu does not support this language direction",
  "malformed-response": "Baidu returned an invalid response",
  unknown: "Baidu translation failed",
});

function failure(
  request: TranslationRequest,
  code: TranslationFailureCode,
  retryable: boolean,
  retryAfterMs?: number,
): TranslationProviderError {
  const base: TranslationFailure = {
    requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
    selectionId: typeof request.selectionId === "string" ? request.selectionId : "invalid-selection",
    code,
    message: FAILURE_MESSAGES[code],
    providerId: BAIDU_PROVIDER_ID,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  return new TranslationProviderError(base);
}
