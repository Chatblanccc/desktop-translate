import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { isNativeMessage } from "../../packages/contracts/src/native-ipc.ts";

const schemaUrl = new URL("../../protocol/native-ipc.schema.json", import.meta.url);

test("Native IPC JSON Schema exposes the complete v1 method set", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$defs.requestEnvelope.properties.v.const, 1);
  assert.deepEqual(schema.$defs.requestEnvelope.required, ["v", "kind", "id", "method", "timestamp", "payload"]);
  assert.deepEqual(schema.$defs.eventEnvelope.required, ["v", "kind", "seq", "method", "timestamp", "payload"]);

  const methods = [
    "helloRequest",
    "readyResponse",
    "healthRequest",
    "healthResponse",
    "startRequest",
    "startResponse",
    "stopRequest",
    "stopResponse",
    "shutdownRequest",
    "shutdownResponse",
    "pointerDownEvent",
    "selectionResultEvent",
    "hostErrorEvent",
  ];
  for (const definition of methods) assert.ok(schema.$defs[definition], `missing $defs.${definition}`);
});

test("selection/result schema preserves lossless Windows coordinates and identity fields", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const selection = schema.$defs.selectionResult;
  for (const required of [
    "selectionId",
    "source",
    "text",
    "ranges",
    "confidence",
    "physicalRects",
    "releasePoint",
    "monitor",
    "target",
    "coordinateSpace",
    "timestamp",
  ]) assert.ok(selection.required.includes(required), `missing required selection field ${required}`);

  assert.deepEqual(selection.properties.source.enum, ["uia", "uia-point-approx", "ocr"]);
  assert.equal(selection.properties.text.maxLength, 32_768);
  assert.equal(selection.properties.coordinateSpace.const, "physical-px");
  assert.equal(schema.$defs.target.properties.pid.$ref, "#/$defs/decimalString");
  assert.equal(schema.$defs.target.properties.hwnd.$ref, "#/$defs/handleString");
  assert.equal(schema.$defs.monitor.required.includes("dpiX"), true);
  assert.equal(schema.$defs.monitor.required.includes("dpiY"), true);
});

test("start defaults remain deterministic across implementations", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const config = schema.$defs.startConfig.properties;
  assert.equal(config.settleDelayMs.default, 80);
  assert.equal(config.minDragDistancePx.default, 4);
  assert.equal(config.uiaTimeoutMs.default, 350);
  assert.equal(config.ocrTimeoutMs.default, 2_500);
});

test("canonical schema compiles and rejects protocol boundary drift", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
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
      requestedCapabilities: ["mouse-hook", "pointer-down-events", "uia-selection"],
    },
  };
  assert.equal(validate(hello), true, JSON.stringify(validate.errors));
  const timestamp = "2026-07-16T08:00:00.000Z";
  const messages = [
    hello,
    {
      v: 1,
      kind: "response",
      id: "hello:1",
      method: "ready",
      timestamp,
      payload: {
        selectedVersion: 1,
        hostVersion: "0.1.0",
        hostPid: "4242",
        sessionNonce: hello.payload.sessionNonce,
        capabilities: ["mouse-hook", "pointer-down-events", "uia-selection", "desktop-capture"],
      },
    },
    { v: 1, kind: "request", id: "health:1", method: "health", timestamp, payload: {} },
    {
      v: 1,
      kind: "response",
      id: "health:1",
      method: "health",
      timestamp,
      payload: { status: "degraded", listening: false, uptimeMs: 12, degradedCapabilities: ["ocr"] },
    },
    { v: 1, kind: "request", id: "start:1", method: "start", timestamp, payload: {} },
    {
      v: 1,
      kind: "response",
      id: "start:1",
      method: "start",
      timestamp,
      payload: { ok: true, listening: true, effectiveConfig: { settleDelayMs: 80 } },
    },
    { v: 1, kind: "request", id: "stop:1", method: "stop", timestamp, payload: {} },
    {
      v: 1,
      kind: "response",
      id: "stop:1",
      method: "stop",
      timestamp,
      payload: { ok: true, listening: false },
    },
    { v: 1, kind: "request", id: "shutdown:1", method: "shutdown", timestamp, payload: {} },
    {
      v: 1,
      kind: "response",
      id: "shutdown:1",
      method: "shutdown",
      timestamp,
      payload: { ok: true },
    },
    {
      v: 1,
      kind: "event",
      seq: 0,
      method: "input/pointer-down",
      timestamp,
      payload: {
        point: { x: -100, y: 44 },
        coordinateSpace: "physical-px",
      },
    },
    {
      v: 1,
      kind: "event",
      seq: 1,
      method: "selection/result",
      timestamp,
      payload: {
        selectionId: "11111111-1111-4111-8111-111111111111",
        source: "uia",
        text: "architecture",
        ranges: [{ start: 0, end: 12, text: "architecture" }],
        confidence: 1,
        physicalRects: [{ x: -100, y: 20, width: 120, height: 24 }],
        releasePoint: { x: 20, y: 44 },
        monitor: {
          id: "DISPLAY1",
          handle: "0x1234",
          bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
          workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
          dpiX: 144,
          dpiY: 144,
          scaleFactor: 1.5,
        },
        target: { pid: "4242", hwnd: "0x5678", processName: "chrome.exe" },
        coordinateSpace: "physical-px",
        timestamp,
      },
    },
    {
      v: 1,
      kind: "event",
      seq: 2,
      method: "host/error",
      timestamp,
      payload: {
        code: "UIA_NO_SELECTION",
        message: "no selected text",
        scope: "uia",
        recoverable: true,
      },
    },
  ];
  for (const message of messages) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
    assert.equal(isNativeMessage(message), true, `runtime guard rejected ${message.method}`);
  }
  assert.equal(
    validate({ ...hello, payload: { ...hello.payload, sessionNonce: "0123456789abcdef" } }),
    false,
  );
  assert.equal(validate({ ...hello, timestamp: "2026-07-16T08:00:00" }), false);
  assert.equal(validate({ ...hello, unexpected: true }), false);
  const pointerDown = messages.find((message) => message.method === "input/pointer-down");
  assert.equal(validate({ ...pointerDown, payload: { ...pointerDown.payload, coordinateSpace: "dip" } }), false);
  assert.equal(validate({ ...pointerDown, payload: { ...pointerDown.payload, button: "left" } }), false);
  const start = messages.find((message) => message.method === "start" && message.kind === "request");
  assert.equal(validate({ ...start, payload: { excludedProcessNames: ["C:\\Apps\\chrome.exe"] } }), false);
  assert.equal(validate({ ...start, payload: { excludedProcessNames: ["*.exe"] } }), false);
});
