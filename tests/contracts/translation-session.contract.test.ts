import assert from "node:assert/strict";
import test from "node:test";

import {
  transitionTranslationSession,
  type TranslationSessionState,
} from "../../packages/application/src/translation-session.ts";
import type { TranslationFailure } from "../../packages/contracts/src/translation.ts";
import { selectionFixture, translationFixture } from "./fixtures.ts";

const nextSelection = {
  ...selectionFixture,
  selectionId: "123e4567-e89b-42d3-a456-426614174001",
  text: "system",
};

function translating(): TranslationSessionState {
  return transitionTranslationSession(undefined, {
    type: "selection.received",
    selection: selectionFixture,
    translationEnabled: true,
    requestId: translationFixture.requestId,
  }).state;
}

function failure(overrides: Partial<TranslationFailure> = {}): TranslationFailure {
  return {
    requestId: translationFixture.requestId,
    selectionId: selectionFixture.selectionId,
    code: "provider-unavailable",
    message: "Translation is temporarily unavailable",
    providerId: "fixture",
    retryable: true,
    ...overrides,
  };
}

test("disabled translation presents source-only without a request identifier", () => {
  const result = transitionTranslationSession(undefined, {
    type: "selection.received",
    selection: selectionFixture,
    translationEnabled: false,
    requestId: "ignored:1",
  });
  assert.equal(result.state?.stage, "source-only");
  assert.deepEqual(result.effects, [{
    type: "card.present",
    card: {
      kind: "source-only",
      selectionId: selectionFixture.selectionId,
      sourceText: selectionFixture.text,
      source: selectionFixture.source,
      confidence: selectionFixture.confidence,
    },
  }]);
  assert.equal("requestId" in (result.effects[0] as { card: object }).card, false);
});

test("enabled translation presents loading before requesting and a newer selection cancels latest-wins", () => {
  const first = transitionTranslationSession(undefined, {
    type: "selection.received",
    selection: selectionFixture,
    translationEnabled: true,
    requestId: "translate:1",
  });
  assert.equal(first.state?.stage, "translating");
  assert.deepEqual(first.effects.map((effect) => effect.type), ["card.present", "translation.request"]);

  const next = transitionTranslationSession(first.state, {
    type: "selection.received",
    selection: nextSelection,
    translationEnabled: true,
    requestId: "translate:2",
  });
  assert.deepEqual(next.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.dismiss",
    "card.present",
    "translation.request",
  ]);
  assert.equal(next.state?.selection.selectionId, nextSelection.selectionId);
  assert.equal(next.state?.stage === "translating" ? next.state.requestId : undefined, "translate:2");
});

test("success requires both selectionId and requestId and publishes a strict translated card", () => {
  const state = translating();
  const staleRequest = transitionTranslationSession(state, {
    type: "translation.succeeded",
    result: { ...translationFixture, requestId: "translate:stale" },
  });
  assert.equal(staleRequest.state, state);
  assert.deepEqual(staleRequest.effects, []);

  const staleSelection = transitionTranslationSession(state, {
    type: "translation.succeeded",
    result: { ...translationFixture, selectionId: nextSelection.selectionId },
  });
  assert.equal(staleSelection.state, state);

  const matched = transitionTranslationSession(state, {
    type: "translation.succeeded",
    result: translationFixture,
  });
  assert.equal(matched.state?.stage, "translated");
  assert.deepEqual(matched.effects, [{
    type: "card.present",
    card: {
      kind: "translated",
      selectionId: selectionFixture.selectionId,
      sourceText: selectionFixture.text,
      source: selectionFixture.source,
      confidence: selectionFixture.confidence,
      requestId: translationFixture.requestId,
      translatedText: translationFixture.translatedText,
      targetLanguage: translationFixture.targetLanguage,
      detectedSourceLanguage: translationFixture.detectedSourceLanguage,
      attribution: translationFixture.attribution,
      fromCache: false,
    },
  }]);
});

test("provider failure does not leak its message into the card and retry uses a fresh request", () => {
  const failed = transitionTranslationSession(translating(), {
    type: "translation.failed",
    failure: failure({ retryAfterMs: 2_000 }),
  });
  assert.equal(failed.state?.stage, "failed");
  assert.deepEqual(failed.effects, [{
    type: "card.present",
    card: {
      kind: "failed",
      selectionId: selectionFixture.selectionId,
      sourceText: selectionFixture.text,
      source: selectionFixture.source,
      confidence: selectionFixture.confidence,
      requestId: translationFixture.requestId,
      code: "provider-unavailable",
      retryable: true,
      retryAfterMs: 2_000,
    },
  }]);
  const card = failed.effects[0]?.type === "card.present" ? failed.effects[0].card : undefined;
  assert.equal(card && "message" in card, false);
  assert.equal(card && "cause" in card, false);

  const sameId = transitionTranslationSession(failed.state, {
    type: "translation.retry-requested",
    requestId: translationFixture.requestId,
  });
  assert.equal(sameId.state, failed.state);
  assert.deepEqual(sameId.effects, []);

  const retried = transitionTranslationSession(failed.state, {
    type: "translation.retry-requested",
    requestId: "translate:2",
  });
  assert.equal(retried.state?.stage, "translating");
  assert.deepEqual(retried.effects.map((effect) => effect.type), ["card.present", "translation.request"]);
});

test("cancel preserves source-only while dismiss aborts and clears the session", () => {
  const state = translating();
  const cancelled = transitionTranslationSession(state, { type: "session.cancel" });
  assert.equal(cancelled.state?.stage, "source-only");
  assert.deepEqual(cancelled.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.present",
  ]);

  const dismissed = transitionTranslationSession(state, { type: "session.dismiss" });
  assert.equal(dismissed.state, undefined);
  assert.deepEqual(dismissed.effects, [
    { type: "translation.cancel", requestId: translationFixture.requestId },
    { type: "card.dismiss" },
  ]);
});

test("matching provider cancellation falls back silently to the source card", () => {
  const result = transitionTranslationSession(translating(), {
    type: "translation.failed",
    failure: failure({ code: "cancelled", retryable: false }),
  });
  assert.equal(result.state?.stage, "source-only");
  assert.equal(result.effects[0]?.type, "card.present");
});
