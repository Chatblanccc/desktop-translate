import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_TRANSLATION_TARGET_LANGUAGES,
  isPhase4TranslationTargetLanguage,
  MAX_TRANSLATION_AUXILIARY_TEXT_LENGTH,
  MAX_TRANSLATION_FAILURE_MESSAGE_LENGTH,
  MAX_TRANSLATION_TEXT_LENGTH,
  isLanguageCode,
  isTranslationFailure,
  isTranslationRequest,
  isTranslationResult,
  isTranslationTimestamp,
} from "../../packages/contracts/src/translation.ts";
import { selectionFixture, translationFixture } from "./fixtures.ts";

const request = {
  requestId: translationFixture.requestId,
  selectionId: selectionFixture.selectionId,
  text: selectionFixture.text,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
};

const failure = {
  requestId: translationFixture.requestId,
  selectionId: selectionFixture.selectionId,
  code: "rate-limited",
  message: "Provider rate limit reached",
  providerId: "fixture",
  retryable: true,
  retryAfterMs: 1_000,
} as const;

test("translation request accepts bounded Unicode and strict language identifiers", () => {
  assert.equal(isTranslationRequest(request), true);
  assert.equal(isTranslationRequest({ ...request, text: "A😀B", sourceLanguage: "en-US" }), true);
  for (const language of ["en", "yue", "zh-CN", "sr-Latn-RS"]) {
    assert.equal(isLanguageCode(language), true, language);
  }
  for (const language of ["auto", "EN", "english", "zh_中文", "", null]) {
    assert.equal(isLanguageCode(language), false, String(language));
  }
  assert.deepEqual(PHASE4_TRANSLATION_TARGET_LANGUAGES, ["zh-CN", "en", "ja", "ko"]);
  for (const language of PHASE4_TRANSLATION_TARGET_LANGUAGES) {
    assert.equal(isPhase4TranslationTargetLanguage(language), true, language);
  }
  for (const language of ["eo", "auto", "en-US", null]) {
    assert.equal(isPhase4TranslationTargetLanguage(language), false, String(language));
  }
});

test("translation request rejects unknown fields, malformed identifiers, and unsafe text", () => {
  for (const invalid of [
    { ...request, unexpected: true },
    { ...request, requestId: "bad request" },
    { ...request, selectionId: "selection:1" },
    { ...request, text: "" },
    { ...request, text: "bad\0text" },
    { ...request, text: "bad\ud800text" },
    { ...request, text: "x".repeat(MAX_TRANSLATION_TEXT_LENGTH + 1) },
    { ...request, sourceLanguage: "english" },
    { ...request, targetLanguage: "auto" },
  ]) assert.equal(isTranslationRequest(invalid), false);
});

test("translation result validates nested capability data and canonical timestamps", () => {
  const rich = {
    ...translationFixture,
    pronunciations: [{ dialect: "US", phonetic: "ɑːrk", audioUrl: "https://audio.example/pronounce" }],
    examples: [{ source: "software architecture", target: "软件架构" }],
  };
  assert.equal(isTranslationResult(translationFixture), true);
  assert.equal(isTranslationResult(rich), true);
  assert.equal(isTranslationTimestamp("2024-02-29T23:59:59Z"), true);
  assert.equal(isTranslationTimestamp("2026-07-16T08:00:00.123Z"), true);
  for (const invalid of [
    "2023-02-29T08:00:00Z",
    "2026-02-30T08:00:00Z",
    "2026-07-16T24:00:00Z",
    "2026-07-16T08:00:00+08:00",
    "2026-07-16",
  ]) assert.equal(isTranslationTimestamp(invalid), false, invalid);
});

test("translation result rejects unknown, oversized, malformed, and unsafe nested values", () => {
  for (const invalid of [
    { ...translationFixture, rawProviderResponse: {} },
    { ...translationFixture, translatedText: "" },
    { ...translationFixture, translatedText: "bad\udc00" },
    { ...translationFixture, detectedSourceLanguage: "auto" },
    { ...translationFixture, receivedAt: "2026-02-30T08:00:00Z" },
    { ...translationFixture, fromCache: "false" },
    { ...translationFixture, attribution: { ...translationFixture.attribution, secret: "no" } },
    { ...translationFixture, attribution: { providerId: "Fixture", providerDisplayName: "Fixture" } },
    { ...translationFixture, pronunciations: [{ audioUrl: "http://audio.example/file" }] },
    { ...translationFixture, pronunciations: [{ audioUrl: "https://user:pass@audio.example/file" }] },
    { ...translationFixture, pronunciations: [{}] },
    { ...translationFixture, dictionary: [{ definitions: [] }] },
    {
      ...translationFixture,
      dictionary: [{ definitions: ["x".repeat(MAX_TRANSLATION_AUXILIARY_TEXT_LENGTH + 1)] }],
    },
    { ...translationFixture, examples: [{ source: "valid", target: "bad\0text" }] },
  ]) assert.equal(isTranslationResult(invalid), false);
});

test("translation failure is sanitized and rejects Main-only causes at the boundary", () => {
  assert.equal(isTranslationFailure(failure), true);
  assert.equal(isTranslationFailure({ ...failure, retryAfterMs: undefined }), true);
  for (const invalid of [
    { ...failure, cause: new Error("provider body") },
    { ...failure, rawResponse: "secret" },
    { ...failure, code: "timeout" },
    { ...failure, message: "" },
    { ...failure, message: "x".repeat(MAX_TRANSLATION_FAILURE_MESSAGE_LENGTH + 1) },
    { ...failure, retryable: false, retryAfterMs: 1_000 },
    { ...failure, retryAfterMs: -1 },
    { ...failure, providerId: "Fixture Provider" },
  ]) assert.equal(isTranslationFailure(invalid), false);
});
