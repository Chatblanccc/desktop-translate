import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_START_CONFIG,
  isNativeMessage,
  isSelectionResult,
} from "../../packages/contracts/src/native-ipc.ts";
import { selectionFixture } from "./fixtures.ts";

test("selection/result accepts physical coordinates, string handles and DPI metadata", () => {
  assert.equal(isSelectionResult(selectionFixture), true);
  assert.equal(
    isNativeMessage({
      v: 1,
      kind: "event",
      seq: 0,
      method: "selection/result",
      timestamp: selectionFixture.timestamp,
      payload: selectionFixture,
    }),
    true,
  );
});

test("input/pointer-down accepts only a strict physical-pixel point payload", () => {
  const pointerDown = {
    v: 1,
    kind: "event",
    seq: 1,
    method: "input/pointer-down",
    timestamp: "2026-07-16T08:00:00.000Z",
    payload: {
      point: { x: -12, y: 44 },
      coordinateSpace: "physical-px",
    },
  };

  assert.equal(isNativeMessage(pointerDown), true);
  assert.equal(
    isNativeMessage({ ...pointerDown, payload: { ...pointerDown.payload, coordinateSpace: "dip" } }),
    false,
  );
  assert.equal(
    isNativeMessage({ ...pointerDown, payload: { ...pointerDown.payload, button: "left" } }),
    false,
  );
  assert.equal(isNativeMessage({ ...pointerDown, payload: { coordinateSpace: "physical-px" } }), false);
});

test("invalid or lossy selection values are rejected at the boundary", () => {
  assert.equal(isSelectionResult({ ...selectionFixture, target: { pid: 4242, hwnd: 1 } }), false);
  assert.equal(isSelectionResult({ ...selectionFixture, source: "clipboard" }), false);
  assert.equal(isSelectionResult({ ...selectionFixture, confidence: 1.1 }), false);
  assert.equal(isSelectionResult({ ...selectionFixture, coordinateSpace: "dip" }), false);
  assert.equal(isSelectionResult({ ...selectionFixture, ranges: [{ start: 0, end: 999 }] }), false);
  assert.equal(isSelectionResult({ ...selectionFixture, text: "bad\0text", ranges: [] }), false);
  assert.equal(isSelectionResult({ ...selectionFixture, text: "bad\ud800text", ranges: [] }), false);
  assert.equal(
    isSelectionResult({
      ...selectionFixture,
      ranges: [
        { start: 0, end: 5 },
        { start: 4, end: 12 },
      ],
    }),
    false,
  );
  assert.equal(
    isSelectionResult({ ...selectionFixture, ranges: [{ start: 0, end: 12, text: "wrong" }] }),
    false,
  );
  assert.equal(
    isSelectionResult({
      ...selectionFixture,
      text: "A😀B",
      ranges: [{ start: 1, end: 2 }],
    }),
    false,
  );
});

test("request and response envelopes use id while events use seq", () => {
  const startRequest = {
    v: 1,
    kind: "request",
    id: "start:1",
    method: "start",
    timestamp: "2026-07-16T08:00:00.000Z",
    payload: DEFAULT_START_CONFIG,
  };
  assert.equal(isNativeMessage(startRequest), true);
  assert.equal(isNativeMessage({ ...startRequest, id: undefined, seq: 1 }), false);
});

test("hello requires at least 128 bits encoded as hexadecimal", () => {
  const hello = {
    v: 1,
    kind: "request",
    id: "hello:1",
    method: "hello",
    timestamp: "2026-07-16T08:00:00.000Z",
    payload: {
      desktopVersion: "0.1.0-phase1",
      supportedVersions: [1],
      sessionNonce: "0123456789abcdef0123456789abcdef",
    },
  };
  assert.equal(isNativeMessage(hello), true);
  assert.equal(
    isNativeMessage({ ...hello, payload: { ...hello.payload, sessionNonce: "0123456789abcdef" } }),
    false,
  );
  assert.equal(
    isNativeMessage({ ...hello, payload: { ...hello.payload, sessionNonce: "g".repeat(32) } }),
    false,
  );
  assert.equal(isNativeMessage({ ...hello, timestamp: "2026-07-16T08:00:00" }), false);
  assert.equal(isNativeMessage({ ...hello, timestamp: "2026-02-30T08:00:00Z" }), false);
});

test("hello and ready negotiate pointer-down events as an explicit capability", () => {
  const timestamp = "2026-07-16T08:00:00.000Z";
  const sessionNonce = "0123456789abcdef0123456789abcdef";
  assert.equal(
    isNativeMessage({
      v: 1,
      kind: "request",
      id: "hello:pointer-down",
      method: "hello",
      timestamp,
      payload: {
        desktopVersion: "0.5.0-phase5",
        supportedVersions: [1],
        sessionNonce,
        requestedCapabilities: ["mouse-hook", "pointer-down-events"],
      },
    }),
    true,
  );
  assert.equal(
    isNativeMessage({
      v: 1,
      kind: "response",
      id: "hello:pointer-down",
      method: "ready",
      timestamp,
      payload: {
        selectedVersion: 1,
        hostVersion: "0.5.0-phase5",
        hostPid: "4242",
        sessionNonce,
        capabilities: ["mouse-hook", "pointer-down-events"],
      },
    }),
    true,
  );
});

test("start exclusions are unique Windows process basenames", () => {
  const request = {
    v: 1,
    kind: "request",
    id: "start:exclusions",
    method: "start",
    timestamp: "2026-07-16T08:00:00.000Z",
    payload: { excludedProcessNames: ["chrome.exe", "Visual Studio Code.exe"] },
  };
  assert.equal(isNativeMessage(request), true);
  assert.equal(
    isNativeMessage({ ...request, payload: { excludedProcessNames: ["C:\\Apps\\chrome.exe"] } }),
    false,
  );
  assert.equal(
    isNativeMessage({ ...request, payload: { excludedProcessNames: ["chrome.exe", "CHROME.EXE"] } }),
    false,
  );
  assert.equal(
    isNativeMessage({ ...request, payload: { excludedProcessNames: ["*.exe"] } }),
    false,
  );
});
