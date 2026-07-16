import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  transition,
} from "../../packages/application/src/selection-state-machine.ts";
import { selectionFixture, translationFixture } from "./fixtures.ts";

test("ready host auto-starts and a selection requests translation", () => {
  let result = transition(createInitialState(true), { type: "native.ready" });
  assert.equal(result.state.mode, "starting");
  assert.deepEqual(result.effects, [{ type: "native.start" }]);

  result = transition(result.state, { type: "native.started" });
  assert.equal(result.state.mode, "listening");

  result = transition(result.state, {
    type: "selection.received",
    selection: selectionFixture,
    requestId: "translate:1",
  });
  assert.equal(result.state.activeSelection?.stage, "translating");
  assert.equal(result.effects[0]?.type, "translation.request");
});

test("new selection cancels the old request and stale completion is ignored", () => {
  let state = transition(createInitialState(true), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  state = transition(state, {
    type: "selection.received",
    selection: selectionFixture,
    requestId: "translate:1",
  }).state;

  const nextSelection = { ...selectionFixture, selectionId: "22222222-2222-4222-8222-222222222222", text: "system" };
  const next = transition(state, {
    type: "selection.received",
    selection: nextSelection,
    requestId: "translate:2",
  });
  assert.deepEqual(next.effects.map((effect) => effect.type), ["translation.cancel", "card.dismiss", "translation.request"]);

  const stale = transition(next.state, { type: "translation.succeeded", result: translationFixture });
  assert.equal(stale.state, next.state);
  assert.deepEqual(stale.effects, []);
});

test("matching completion presents and shutdown cancels outstanding work", () => {
  let state = transition(createInitialState(true), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  state = transition(state, {
    type: "selection.received",
    selection: selectionFixture,
    requestId: translationFixture.requestId,
  }).state;

  const presented = transition(state, { type: "translation.succeeded", result: translationFixture });
  assert.equal(presented.state.activeSelection?.stage, "presented");
  assert.equal(presented.effects[0]?.type, "card.present");

  const shutdown = transition(presented.state, { type: "app.shutdown" });
  assert.equal(shutdown.state.mode, "shutting-down");
  assert.deepEqual(shutdown.effects.map((effect) => effect.type), ["card.dismiss", "native.shutdown"]);
});
