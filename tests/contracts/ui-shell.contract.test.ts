import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  isBallAnchor,
  isNativeUiStatus,
  isSetBallVisiblePayload,
  isSetEdgeSnapPayload,
  isSetThemePayload,
  isThemeMode,
  isUiShellSettingsWritePayload,
  isUiShellSnapshot,
} from "../../packages/contracts/src/ui-shell.ts";

test("Phase 2 default snapshot is strict, safe, and deeply immutable", () => {
  assert.deepEqual(DEFAULT_UI_SHELL_SNAPSHOT, {
    version: 1,
    ball: { visible: true, edgeSnap: true },
    theme: "system",
    native: { status: "unavailable", degradedCapabilities: [] },
  });
  assert.equal(isUiShellSnapshot(DEFAULT_UI_SHELL_SNAPSHOT), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.ball), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.native), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.native.degradedCapabilities), true);
});

test("theme and native status guards accept only the locked vocabulary", () => {
  for (const theme of ["system", "light", "dark"]) assert.equal(isThemeMode(theme), true);
  for (const status of ["unavailable", "starting", "ready", "degraded", "faulted"]) {
    assert.equal(isNativeUiStatus(status), true);
  }
  for (const invalid of ["auto", "high-contrast", "", null, 1]) assert.equal(isThemeMode(invalid), false);
  for (const invalid of ["stopping", "offline", "", null, 1]) assert.equal(isNativeUiStatus(invalid), false);
});

test("ball anchors support edge ratios and reject unsafe or extra fields", () => {
  assert.equal(isBallAnchor({ displayId: "2528732444", edge: "left", verticalRatio: 0 }), true);
  assert.equal(isBallAnchor({ displayId: "display:primary", edge: "right", verticalRatio: 1 }), true);

  for (const invalid of [
    { displayId: "", edge: "right", verticalRatio: 0.5 },
    { displayId: "display", edge: "top", verticalRatio: 0.5 },
    { displayId: "display", edge: "right", verticalRatio: -0.01 },
    { displayId: "display", edge: "right", verticalRatio: 1.01 },
    { displayId: "display", edge: "right", verticalRatio: Number.NaN },
    { displayId: "display", edge: "right", verticalRatio: Number.POSITIVE_INFINITY },
    { displayId: "display", edge: "right", verticalRatio: 0.5, horizontalRatio: 0.5 },
    { displayId: "display", edge: "right", verticalRatio: 0.5, x: 10 },
  ]) assert.equal(isBallAnchor(invalid), false);
});

test("snapshot guard rejects unknown fields, malformed anchors, and duplicate capabilities", () => {
  const valid = {
    version: 1,
    ball: {
      visible: false,
      edgeSnap: true,
      anchor: { displayId: "primary", edge: "right", verticalRatio: 0.6 },
    },
    theme: "dark",
    native: { status: "degraded", degradedCapabilities: ["ocr"] },
  };
  assert.equal(isUiShellSnapshot(valid), true);
  assert.equal(isUiShellSnapshot({ ...valid, applicationVersion: "0.2.0-phase2" }), false);
  assert.equal(isUiShellSnapshot({ ...valid, ball: { ...valid.ball, verticalRatio: 0.5 } }), false);
  assert.equal(
    isUiShellSnapshot({ ...valid, native: { ...valid.native, degradedCapabilities: ["ocr", "ocr"] } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, native: { ...valid.native, degradedCapabilities: ["OCR"] } }),
    false,
  );
});

test("settings payload guards are exact and role-safe", () => {
  assert.equal(isSetBallVisiblePayload({ value: false }), true);
  assert.equal(isSetEdgeSnapPayload({ value: true }), true);
  assert.equal(isSetThemePayload({ value: "light" }), true);
  assert.equal(isSetBallVisiblePayload({ value: false, unexpected: true }), false);
  assert.equal(isSetEdgeSnapPayload({ value: "true" }), false);
  assert.equal(isSetThemePayload({ value: "sepia" }), false);

  for (const payload of [
    { kind: "setBallVisible", value: false },
    { kind: "setEdgeSnap", value: true },
    { kind: "setTheme", value: "system" },
    { kind: "resetBallPosition" },
  ]) assert.equal(isUiShellSettingsWritePayload(payload), true);

  for (const payload of [
    { kind: "setBallVisible", value: 0 },
    { kind: "setTheme", value: "sepia" },
    { kind: "resetBallPosition", value: true },
    { kind: "setBallAnchor", value: {} },
    undefined,
  ]) assert.equal(isUiShellSettingsWritePayload(payload), false);
});
