import assert from "node:assert/strict";
import test from "node:test";

import { isSelectionCardViewModel } from "../../packages/contracts/src/selection-card.ts";
import { selectionFixture, translationFixture } from "./fixtures.ts";

const base = {
  selectionId: selectionFixture.selectionId,
  sourceText: selectionFixture.text,
  source: selectionFixture.source,
  confidence: selectionFixture.confidence,
};

const sourceOnly = { kind: "source-only", ...base } as const;
const translating = {
  kind: "translating",
  ...base,
  requestId: translationFixture.requestId,
} as const;
const translated = {
  kind: "translated",
  ...base,
  requestId: translationFixture.requestId,
  translatedText: translationFixture.translatedText,
  targetLanguage: translationFixture.targetLanguage,
  detectedSourceLanguage: translationFixture.detectedSourceLanguage,
  attribution: translationFixture.attribution,
  fromCache: false,
} as const;
const failed = {
  kind: "failed",
  ...base,
  requestId: translationFixture.requestId,
  code: "rate-limited",
  retryable: true,
  retryAfterMs: 1_000,
} as const;

test("selection card accepts all four strict Phase 4 states", () => {
  for (const card of [sourceOnly, translating, translated, failed]) {
    assert.equal(isSelectionCardViewModel(card), true, card.kind);
  }
});

test("source-only card cannot carry a translation request or result", () => {
  assert.equal(isSelectionCardViewModel({ ...sourceOnly, requestId: "translate:1" }), false);
  assert.equal(isSelectionCardViewModel({ ...sourceOnly, translatedText: "架构" }), false);
  assert.equal(isSelectionCardViewModel({ ...sourceOnly, text: sourceOnly.sourceText }), false);
});

test("translation card states require bounded IDs, text, languages, and attribution", () => {
  for (const [index, card] of [
    { ...translating, requestId: "bad request" },
    { ...translated, translatedText: "" },
    { ...translated, translatedText: "bad\ud800" },
    { ...translated, targetLanguage: "auto" },
    { ...translated, detectedSourceLanguage: "english" },
    { ...translated, attribution: { ...translated.attribution, secret: "no" } },
    { ...translated, fromCache: 0 },
  ].entries()) assert.equal(isSelectionCardViewModel(card), false, `invalid translated card ${index}`);
});

test("failed card exposes only stable retry metadata and never error messages or causes", () => {
  assert.equal(isSelectionCardViewModel({ ...failed, message: "raw provider body" }), false);
  assert.equal(isSelectionCardViewModel({ ...failed, cause: new Error("secret") }), false);
  assert.equal(isSelectionCardViewModel({ ...failed, providerId: "fixture" }), false);
  assert.equal(isSelectionCardViewModel({ ...failed, code: "provider-timeout" }), false);
  assert.equal(isSelectionCardViewModel({ ...failed, retryable: false, retryAfterMs: 1_000 }), false);
});

test("every card state rejects malformed common selection data and unknown fields", () => {
  for (const card of [
    { ...sourceOnly, selectionId: "selection:1" },
    { ...translating, sourceText: "bad\0text" },
    { ...translated, source: "clipboard" },
    { ...failed, confidence: Number.NaN },
    { ...failed, unexpected: true },
  ]) assert.equal(isSelectionCardViewModel(card), false);
});
