import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  transition,
} from "../../packages/application/src/selection-state-machine.ts";
import { selectionFixture } from "./fixtures.ts";

test("ready host auto-starts and a selection presents source text without translation", () => {
  let result = transition(createInitialState(), { type: "native.ready" });
  assert.equal(result.state.mode, "starting");
  assert.deepEqual(result.effects, [{ type: "native.start" }]);

  result = transition(result.state, { type: "native.started" });
  assert.equal(result.state.mode, "listening");

  result = transition(result.state, { type: "selection.received", selection: selectionFixture });
  assert.deepEqual(result.state.activeSelection, { stage: "presented", selection: selectionFixture });
  assert.deepEqual(result.effects, [{ type: "card.present-source", selection: selectionFixture }]);
  assert.equal(result.effects.some((effect) => effect.type.startsWith("translation.")), false);
});

test("new selection dismisses the old card before presenting the latest result", () => {
  let state = transition(createInitialState(), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  state = transition(state, { type: "selection.received", selection: selectionFixture }).state;
  const next = { ...selectionFixture, selectionId: "123e4567-e89b-42d3-a456-426614174001" };
  const result = transition(state, { type: "selection.received", selection: next });
  assert.deepEqual(result.effects, [
    { type: "card.dismiss" },
    { type: "card.present-source", selection: next },
  ]);
  assert.equal(result.state.activeSelection?.selection.selectionId, next.selectionId);
});

test("disable, disconnect, and shutdown dismiss active source cards", () => {
  let state = transition(createInitialState(), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  state = transition(state, { type: "selection.received", selection: selectionFixture }).state;

  let result = transition(state, { type: "listening.disable" });
  assert.deepEqual(result.effects, [{ type: "card.dismiss" }, { type: "native.stop" }]);
  assert.equal(result.state.activeSelection, undefined);

  state = transition(createInitialState(), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  state = transition(state, { type: "selection.received", selection: selectionFixture }).state;
  result = transition(state, { type: "native.disconnected" });
  assert.deepEqual(result.effects, [{ type: "card.dismiss" }, { type: "native.reconnect" }]);

  state = transition(createInitialState(), { type: "native.ready" }).state;
  state = transition(state, { type: "native.started" }).state;
  state = transition(state, { type: "selection.received", selection: selectionFixture }).state;
  result = transition(state, { type: "app.shutdown" });
  assert.deepEqual(result.effects, [{ type: "card.dismiss" }, { type: "native.shutdown" }]);
  assert.equal(result.state.mode, "shutting-down");
});
