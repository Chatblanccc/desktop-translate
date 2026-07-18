import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  transition,
  type ApplicationState,
} from "../../packages/application/src/selection-state-machine.ts";
import type { TranslationFailure } from "../../packages/contracts/src/translation.ts";
import { selectionFixture, translationFixture } from "./fixtures.ts";

function listeningState(translationEnabled = true): ApplicationState {
  let state = transition(createInitialState(true, translationEnabled), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  return state;
}

function translatingState(): ApplicationState {
  return transition(listeningState(), {
    type: "selection.received",
    selection: selectionFixture,
    requestId: translationFixture.requestId,
  }).state;
}

function providerFailure(): TranslationFailure {
  return {
    requestId: translationFixture.requestId,
    selectionId: selectionFixture.selectionId,
    code: "provider-unavailable",
    message: "Translation is temporarily unavailable",
    providerId: "fixture",
    retryable: true,
  };
}

test("ready Host starts listening and delegates translation work to the session reducer", () => {
  const ready = transition(createInitialState(true, true), { type: "native.ready" });
  assert.equal(ready.state.mode, "starting");
  assert.deepEqual(ready.effects, [{ type: "native.start" }]);

  const listening = transition(ready.state, { type: "native.started" });
  const selected = transition(listening.state, {
    type: "selection.received",
    selection: selectionFixture,
    requestId: translationFixture.requestId,
  });
  assert.equal(selected.state.activeSelection?.stage, "translating");
  assert.deepEqual(selected.effects.map((effect) => effect.type), [
    "card.present",
    "translation.request",
  ]);
});

test("translation opt-out preserves the Phase 3 source-only path", () => {
  let state = listeningState(false);
  const selected = transition(state, {
    type: "selection.received",
    selection: selectionFixture,
    requestId: "ignored:1",
  });
  assert.equal(selected.state.activeSelection?.stage, "source-only");
  assert.equal(selected.effects[0]?.type, "card.present");
  const card = selected.effects[0]?.type === "card.present" ? selected.effects[0].card : undefined;
  assert.equal(card?.kind, "source-only");
  assert.equal(card && "requestId" in card, false);

  state = transition(selected.state, { type: "translation.enable" }).state;
  assert.equal(state.translationEnabled, true);
  const translating = transition(state, {
    type: "selection.received",
    selection: selectionFixture,
    requestId: translationFixture.requestId,
  });
  const disabled = transition(translating.state, { type: "translation.disable" });
  assert.equal(disabled.state.translationEnabled, false);
  assert.equal(disabled.state.activeSelection?.stage, "source-only");
  assert.deepEqual(disabled.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.present",
  ]);
});

test("new selection, pause, disconnect, display change, and shutdown cancel in-flight translation", () => {
  const active = translatingState();
  const nextSelection = {
    ...selectionFixture,
    selectionId: "123e4567-e89b-42d3-a456-426614174001",
  };
  const replaced = transition(active, {
    type: "selection.received",
    selection: nextSelection,
    requestId: "translate:2",
  });
  assert.deepEqual(replaced.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.dismiss",
    "card.present",
    "translation.request",
  ]);

  for (const event of [
    { type: "selection.dismissed" } as const,
    { type: "display.changed" } as const,
  ]) {
    const result = transition(active, event);
    assert.equal(result.state.activeSelection, undefined);
    assert.deepEqual(result.effects.map((effect) => effect.type), [
      "translation.cancel",
      "card.dismiss",
    ]);
  }

  const paused = transition(active, { type: "listening.disable" });
  assert.equal(paused.state.mode, "stopping");
  assert.deepEqual(paused.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.dismiss",
    "native.stop",
  ]);

  const disconnected = transition(active, { type: "native.disconnected" });
  assert.equal(disconnected.state.mode, "booting");
  assert.deepEqual(disconnected.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.dismiss",
    "native.reconnect",
  ]);

  const shutdown = transition(active, { type: "app.shutdown" });
  assert.equal(shutdown.state.mode, "shutting-down");
  assert.deepEqual(shutdown.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.dismiss",
    "native.shutdown",
  ]);
});

test("stale provider completion is ignored and matching success is presented", () => {
  const active = translatingState();
  const stale = transition(active, {
    type: "translation.succeeded",
    result: { ...translationFixture, requestId: "translate:stale" },
  });
  assert.equal(stale.state.activeSelection, active.activeSelection);
  assert.deepEqual(stale.effects, []);

  const matched = transition(active, {
    type: "translation.succeeded",
    result: translationFixture,
  });
  assert.equal(matched.state.activeSelection?.stage, "translated");
  const card = matched.effects[0]?.type === "card.present" ? matched.effects[0].card : undefined;
  assert.equal(card?.kind, "translated");
});

test("provider failure and retry never change the Native lifecycle", () => {
  const active = translatingState();
  const failed = transition(active, {
    type: "translation.failed",
    failure: providerFailure(),
  });
  assert.equal(failed.state.mode, "listening");
  assert.equal(failed.state.nativeReady, true);
  assert.equal(failed.state.listeningRequested, true);
  assert.equal(failed.state.activeSelection?.stage, "failed");

  const retried = transition(failed.state, {
    type: "translation.retry-requested",
    requestId: "translate:2",
  });
  assert.equal(retried.state.mode, "listening");
  assert.equal(retried.state.activeSelection?.stage, "translating");
  assert.deepEqual(retried.effects.map((effect) => effect.type), [
    "card.present",
    "translation.request",
  ]);
});

test("recoverable Host errors retain translation while fatal errors cancel it", () => {
  const active = translatingState();
  const recoverable = transition(active, {
    type: "native.error",
    error: {
      code: "uia_timeout",
      message: "safe",
      scope: "uia",
      recoverable: true,
      selectionId: selectionFixture.selectionId,
    },
  });
  assert.equal(recoverable.state.activeSelection, active.activeSelection);
  assert.deepEqual(recoverable.effects, []);

  const fatal = transition(active, {
    type: "native.error",
    error: { code: "pipe_error", message: "safe", scope: "host", recoverable: false },
  });
  assert.equal(fatal.state.mode, "faulted");
  assert.equal(fatal.state.activeSelection, undefined);
  assert.deepEqual(fatal.effects.map((effect) => effect.type), [
    "translation.cancel",
    "card.dismiss",
  ]);
});

test("idle and stop lifecycle branches remain deterministic", () => {
  const idle = transition(createInitialState(false, false), { type: "native.ready" });
  assert.equal(idle.state.mode, "idle");
  assert.deepEqual(idle.effects, []);
  assert.equal(transition(idle.state, { type: "native.started" }).state, idle.state);

  const enabling = transition(idle.state, { type: "listening.enable" });
  assert.equal(enabling.state.mode, "starting");
  assert.deepEqual(enabling.effects, [{ type: "native.start" }]);

  const stopBeforeStarted: ApplicationState = {
    ...enabling.state,
    listeningRequested: false,
  };
  const stopping = transition(stopBeforeStarted, { type: "native.started" });
  assert.equal(stopping.state.mode, "stopping");
  assert.deepEqual(stopping.effects, [{ type: "native.stop" }]);
  const stopped = transition(stopping.state, { type: "native.stopped" });
  assert.equal(stopped.state.mode, "idle");

  const shutdown = transition(idle.state, { type: "app.shutdown" });
  assert.equal(
    transition(shutdown.state, { type: "listening.enable" }).state,
    shutdown.state,
  );
});
