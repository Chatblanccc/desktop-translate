import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  isBallAnchor,
  isCredentialStatus,
  isNativeUiStatus,
  isOcrActivation,
  isSelectionLifecycle,
  isSetBallVisiblePayload,
  isSetEdgeSnapPayload,
  isSetThemePayload,
  isSetOcrActivationPayload,
  isSetSelectionEnabledPayload,
  isThemeMode,
  isUiShellSettingsWritePayload,
  isUiShellSnapshot,
} from "../../packages/contracts/src/ui-shell.ts";

test("Phase 4 default snapshot is strict, opt-in, safe, and deeply immutable", () => {
  assert.deepEqual(DEFAULT_UI_SHELL_SNAPSHOT, {
    version: 3,
    ball: { visible: true, edgeSnap: true },
    theme: "system",
    native: { status: "unavailable", degradedCapabilities: [] },
    selection: { enabled: true, lifecycle: "starting", ocrActivation: "fallback" },
    translation: {
      enabled: false,
      providerId: "baidu",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      credentialStatus: "missing",
      consentVersion: 0,
    },
  });
  assert.equal(isUiShellSnapshot(DEFAULT_UI_SHELL_SNAPSHOT), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.ball), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.native), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.native.degradedCapabilities), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.selection), true);
  assert.equal(Object.isFrozen(DEFAULT_UI_SHELL_SNAPSHOT.translation), true);
});

test("theme and native status guards accept only the locked vocabulary", () => {
  for (const theme of ["system", "light", "dark"]) assert.equal(isThemeMode(theme), true);
  for (const status of ["unavailable", "starting", "ready", "degraded", "faulted"]) {
    assert.equal(isNativeUiStatus(status), true);
  }
  for (const lifecycle of ["disabled", "starting", "listening", "degraded", "faulted"]) {
    assert.equal(isSelectionLifecycle(lifecycle), true);
  }
  for (const activation of ["fallback", "alt-drag"]) assert.equal(isOcrActivation(activation), true);
  for (const status of ["missing", "configured", "unavailable"]) {
    assert.equal(isCredentialStatus(status), true);
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
    version: 3,
    ball: {
      visible: false,
      edgeSnap: true,
      anchor: { displayId: "primary", edge: "right", verticalRatio: 0.6 },
    },
    theme: "dark",
    native: { status: "degraded", degradedCapabilities: ["ocr"] },
    selection: { enabled: true, lifecycle: "degraded", ocrActivation: "fallback" },
    translation: {
      enabled: true,
      providerId: "baidu",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      credentialStatus: "configured",
      consentVersion: 1,
    },
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
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, apiKey: "secret" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, providerId: "Baidu" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, providerId: "fixture" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, sourceLanguage: "english" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, sourceLanguage: "eo" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, targetLanguage: "auto" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, targetLanguage: "eo" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, credentialStatus: "verified" } }),
    false,
  );
  assert.equal(
    isUiShellSnapshot({ ...valid, translation: { ...valid.translation, consentVersion: -1 } }),
    false,
  );
});

test("settings payload guards are exact and role-safe", () => {
  assert.equal(isSetBallVisiblePayload({ value: false }), true);
  assert.equal(isSetEdgeSnapPayload({ value: true }), true);
  assert.equal(isSetThemePayload({ value: "light" }), true);
  assert.equal(isSetSelectionEnabledPayload({ value: false }), true);
  assert.equal(isSetOcrActivationPayload({ value: "alt-drag" }), true);
  assert.equal(isSetBallVisiblePayload({ value: false, unexpected: true }), false);
  assert.equal(isSetEdgeSnapPayload({ value: "true" }), false);
  assert.equal(isSetThemePayload({ value: "sepia" }), false);

  for (const payload of [
    { kind: "setBallVisible", value: false },
    { kind: "setEdgeSnap", value: true },
    { kind: "setTheme", value: "system" },
    { kind: "setSelectionEnabled", value: false },
    { kind: "setOcrActivation", value: "fallback" },
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
