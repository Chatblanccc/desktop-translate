/** Shared Native IPC v1 types. Keep this file in lockstep with protocol/native-ipc.schema.json. */

export const NATIVE_IPC_VERSION = 1 as const;
export const MAX_SELECTION_TEXT_LENGTH = 32_768 as const;
export const MAX_SELECTION_RANGES = 256 as const;
export const MAX_SELECTION_RECTS = 256 as const;

export type NativeCapability =
  | "mouse-hook"
  | "uia-selection"
  | "uia-point-approximation"
  | "desktop-capture"
  | "ocr";

export interface RequestEnvelope<Method extends string, Payload> {
  readonly v: typeof NATIVE_IPC_VERSION;
  readonly kind: "request";
  readonly id: string;
  readonly method: Method;
  readonly timestamp: string;
  readonly payload: Payload;
}

export interface ResponseEnvelope<Method extends string, Payload> {
  readonly v: typeof NATIVE_IPC_VERSION;
  readonly kind: "response";
  /** A response repeats the id of its request. */
  readonly id: string;
  readonly method: Method;
  readonly timestamp: string;
  readonly payload: Payload;
}

export interface EventEnvelope<Method extends string, Payload> {
  readonly v: typeof NATIVE_IPC_VERSION;
  readonly kind: "event";
  /** Monotonically increasing for one Native Host process lifetime. */
  readonly seq: number;
  readonly method: Method;
  readonly timestamp: string;
  readonly payload: Payload;
}

export type SelectionSource = "uia" | "uia-point-approx" | "ocr";

export interface PhysicalPoint {
  readonly x: number;
  readonly y: number;
}

export interface PhysicalRect extends PhysicalPoint {
  readonly width: number;
  readonly height: number;
}

export interface SelectionTextRange {
  /** UTF-16 code-unit offset into SelectionResult.text, inclusive. */
  readonly start: number;
  /** UTF-16 code-unit offset into SelectionResult.text, exclusive. */
  readonly end: number;
  readonly text?: string;
  readonly physicalRects?: readonly PhysicalRect[];
}

export interface SelectionMonitor {
  readonly id: string;
  /** Decimal or 0x-prefixed unsigned pointer value; never a JSON number. */
  readonly handle: string;
  readonly bounds: PhysicalRect;
  readonly workArea: PhysicalRect;
  readonly dpiX: number;
  readonly dpiY: number;
  readonly scaleFactor: number;
}

export interface SelectionTarget {
  /** Unsigned decimal string; using a string keeps the wire representation lossless. */
  readonly pid: string;
  /** Decimal or 0x-prefixed unsigned pointer value; never a JSON number. */
  readonly hwnd: string;
  readonly processName?: string;
}

export interface SelectionResult {
  /** UUID generated once per completed acquisition attempt. */
  readonly selectionId: string;
  readonly source: SelectionSource;
  readonly text: string;
  readonly ranges: readonly SelectionTextRange[];
  readonly confidence: number;
  readonly physicalRects: readonly PhysicalRect[];
  readonly releasePoint: PhysicalPoint;
  readonly monitor: SelectionMonitor;
  readonly target: SelectionTarget;
  readonly coordinateSpace: "physical-px";
  /** When acquisition completed, encoded as an ISO-8601 UTC timestamp. */
  readonly timestamp: string;
}

export interface StartConfig {
  readonly enableUia?: boolean;
  readonly enableOcrFallback?: boolean;
  readonly ocrActivation?: "fallback" | "alt-drag";
  readonly settleDelayMs?: number;
  readonly minDragDistancePx?: number;
  readonly uiaTimeoutMs?: number;
  readonly ocrTimeoutMs?: number;
  readonly excludedProcessNames?: readonly string[];
}

export const DEFAULT_START_CONFIG = Object.freeze({
  enableUia: true,
  enableOcrFallback: true,
  ocrActivation: "fallback",
  settleDelayMs: 80,
  minDragDistancePx: 4,
  uiaTimeoutMs: 350,
  ocrTimeoutMs: 2_500,
  excludedProcessNames: Object.freeze([] as string[]),
}) satisfies Required<StartConfig>;

export type HelloRequest = RequestEnvelope<
  "hello",
  {
    readonly desktopVersion: string;
    readonly supportedVersions: readonly [1, ...1[]];
    readonly sessionNonce: string;
    readonly requestedCapabilities?: readonly NativeCapability[];
  }
>;

export type ReadyResponse = ResponseEnvelope<
  "ready",
  {
    readonly selectedVersion: 1;
    readonly hostVersion: string;
    readonly hostPid: string;
    readonly sessionNonce: string;
    readonly capabilities: readonly NativeCapability[];
  }
>;

export type HealthRequest = RequestEnvelope<"health", Record<string, never>>;
export type HealthResponse = ResponseEnvelope<
  "health",
  {
    readonly status: "starting" | "ready" | "degraded" | "stopping";
    readonly listening: boolean;
    readonly uptimeMs: number;
    readonly lastEventSeq?: number;
    readonly degradedCapabilities?: readonly NativeCapability[];
  }
>;

export type StartRequest = RequestEnvelope<"start", StartConfig>;
export type StartResponse = ResponseEnvelope<
  "start",
  { readonly ok: true; readonly listening: true; readonly effectiveConfig?: StartConfig }
>;
export type StopRequest = RequestEnvelope<"stop", { readonly reason?: string }>;
export type StopResponse = ResponseEnvelope<"stop", { readonly ok: true; readonly listening: false }>;
export type ShutdownRequest = RequestEnvelope<
  "shutdown",
  { readonly reason?: string; readonly gracePeriodMs?: number }
>;
export type ShutdownResponse = ResponseEnvelope<"shutdown", { readonly ok: true }>;
export type SelectionResultEvent = EventEnvelope<"selection/result", SelectionResult>;

export type HostErrorScope = "protocol" | "hook" | "uia" | "capture" | "ocr" | "host";
export interface HostError {
  readonly code: string;
  readonly message: string;
  readonly scope: HostErrorScope;
  readonly recoverable: boolean;
  readonly relatedRequestId?: string;
  readonly selectionId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}
export type HostErrorEvent = EventEnvelope<"host/error", HostError>;

export type NativeRequest = HelloRequest | HealthRequest | StartRequest | StopRequest | ShutdownRequest;
export type NativeResponse = ReadyResponse | HealthResponse | StartResponse | StopResponse | ShutdownResponse;
export type NativeEvent = SelectionResultEvent | HostErrorEvent;
export type NativeMessage = NativeRequest | NativeResponse | NativeEvent;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const HANDLE_PATTERN = /^(0|[1-9][0-9]*|0x[0-9a-f]+)$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SESSION_NONCE_PATTERN = /^[0-9a-f]{32,256}$/i;
const RFC3339_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const WINDOWS_BASENAME_FORBIDDEN_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isPhysicalPoint(value: unknown): value is PhysicalPoint {
  return isRecord(value) && hasOnlyKeys(value, ["x", "y"]) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isPhysicalRect(value: unknown): value is PhysicalRect {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["x", "y", "width", "height"]) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0
  );
}

function isStringArray(value: unknown, maxItems = Number.MAX_SAFE_INTEGER): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string");
}

function hasUniqueItems(value: readonly unknown[]): boolean {
  return new Set(value).size === value.length;
}

function isOptionalBoundedString(value: unknown, minLength: number, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length >= minLength && value.length <= maxLength);
}

function isWindowsBasename(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 260 &&
    value !== "." && value !== ".." && !value.endsWith(".") && !value.endsWith(" ") &&
    !WINDOWS_BASENAME_FORBIDDEN_PATTERN.test(value);
}

function hasValidUtf16AndNoNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const unit = value.charCodeAt(offset);
  return unit < 0xdc00 || unit > 0xdfff;
}

function isCapability(value: unknown): value is NativeCapability {
  return ["mouse-hook", "uia-selection", "uia-point-approximation", "desktop-capture", "ocr"].includes(
    value as NativeCapability,
  );
}

function isStartConfig(value: unknown): value is StartConfig {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "enableUia",
      "enableOcrFallback",
      "ocrActivation",
      "settleDelayMs",
      "minDragDistancePx",
      "uiaTimeoutMs",
      "ocrTimeoutMs",
      "excludedProcessNames",
    ])
  ) return false;
  if (value.enableUia !== undefined && typeof value.enableUia !== "boolean") return false;
  if (value.enableOcrFallback !== undefined && typeof value.enableOcrFallback !== "boolean") return false;
  if (value.ocrActivation !== undefined && !["fallback", "alt-drag"].includes(value.ocrActivation as string)) return false;
  if (value.settleDelayMs !== undefined && !isBoundedInteger(value.settleDelayMs, 0, 500)) return false;
  if (value.minDragDistancePx !== undefined && (!isFiniteNumber(value.minDragDistancePx) || value.minDragDistancePx < 2 || value.minDragDistancePx > 64)) return false;
  if (value.uiaTimeoutMs !== undefined && !isBoundedInteger(value.uiaTimeoutMs, 50, 2_000)) return false;
  if (value.ocrTimeoutMs !== undefined && !isBoundedInteger(value.ocrTimeoutMs, 250, 10_000)) return false;
  if (value.excludedProcessNames === undefined) return true;
  if (!isStringArray(value.excludedProcessNames, 256) || !value.excludedProcessNames.every(isWindowsBasename)) return false;
  return new Set(value.excludedProcessNames.map((name) => name.toLocaleLowerCase("en-US"))).size === value.excludedProcessNames.length;
}

export function isSelectionResult(value: unknown): value is SelectionResult {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "selectionId", "source", "text", "ranges", "confidence", "physicalRects", "releasePoint",
    "monitor", "target", "coordinateSpace", "timestamp",
  ])) return false;
  if (typeof value.selectionId !== "string" || !UUID_PATTERN.test(value.selectionId)) return false;
  if (!["uia", "uia-point-approx", "ocr"].includes(value.source as string)) return false;
  if (typeof value.text !== "string" || value.text.length < 1 || value.text.length > MAX_SELECTION_TEXT_LENGTH || !hasValidUtf16AndNoNul(value.text)) return false;
  if (!isFiniteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1) return false;
  if (!Array.isArray(value.physicalRects) || value.physicalRects.length > MAX_SELECTION_RECTS || !value.physicalRects.every(isPhysicalRect)) return false;
  if (!isPhysicalPoint(value.releasePoint) || value.coordinateSpace !== "physical-px" || !isIsoTimestamp(value.timestamp)) return false;

  if (!Array.isArray(value.ranges) || value.ranges.length > MAX_SELECTION_RANGES) return false;
  let previousEnd = 0;
  for (const range of value.ranges) {
    if (!isRecord(range) || !hasOnlyKeys(range, ["start", "end", "text", "physicalRects"])) return false;
    if (!isBoundedInteger(range.start, 0) || !isBoundedInteger(range.end, 1) || range.end <= range.start || range.end > value.text.length) return false;
    if (range.start < previousEnd || !isUtf16Boundary(value.text, range.start) || !isUtf16Boundary(value.text, range.end)) return false;
    if (range.text !== undefined && (
      typeof range.text !== "string" || range.text.length > MAX_SELECTION_TEXT_LENGTH ||
      !hasValidUtf16AndNoNul(range.text) ||
      range.text.normalize() !== value.text.slice(range.start, range.end).normalize()
    )) return false;
    if (range.physicalRects !== undefined && (!Array.isArray(range.physicalRects) || range.physicalRects.length > MAX_SELECTION_RECTS || !range.physicalRects.every(isPhysicalRect))) return false;
    previousEnd = range.end;
  }

  const monitor = value.monitor;
  if (!isRecord(monitor) || !hasOnlyKeys(monitor, ["id", "handle", "bounds", "workArea", "dpiX", "dpiY", "scaleFactor"])) return false;
  if (typeof monitor.id !== "string" || monitor.id.length < 1 || monitor.id.length > 128) return false;
  if (typeof monitor.handle !== "string" || !HANDLE_PATTERN.test(monitor.handle)) return false;
  if (!isPhysicalRect(monitor.bounds) || !isPhysicalRect(monitor.workArea)) return false;
  if (!isBoundedInteger(monitor.dpiX, 48, 768) || !isBoundedInteger(monitor.dpiY, 48, 768)) return false;
  if (!isFiniteNumber(monitor.scaleFactor) || monitor.scaleFactor < 0.5 || monitor.scaleFactor > 8) return false;

  const target = value.target;
  if (!isRecord(target) || !hasOnlyKeys(target, ["pid", "hwnd", "processName"])) return false;
  if (typeof target.pid !== "string" || target.pid.length > 20 || !DECIMAL_PATTERN.test(target.pid)) return false;
  if (typeof target.hwnd !== "string" || target.hwnd.length > 32 || !HANDLE_PATTERN.test(target.hwnd)) return false;
  return target.processName === undefined || isWindowsBasename(target.processName);
}

function isBaseEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.v !== NATIVE_IPC_VERSION || !["request", "response", "event"].includes(value.kind as string)) return false;
  if (typeof value.method !== "string" || value.method.length < 1 || value.method.length > 64 || !isIsoTimestamp(value.timestamp) || !isRecord(value.payload)) return false;
  if (value.kind === "event") {
    return hasOnlyKeys(value, ["v", "kind", "seq", "method", "timestamp", "payload"]) && isBoundedInteger(value.seq, 0);
  }
  return hasOnlyKeys(value, ["v", "kind", "id", "method", "timestamp", "payload"]) && typeof value.id === "string" && value.id.length <= 128 && MESSAGE_ID_PATTERN.test(value.id);
}

/** Lightweight dependency-free boundary guard. The JSON Schema remains the canonical validator. */
export function isNativeMessage(value: unknown): value is NativeMessage {
  if (!isBaseEnvelope(value) || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (value.kind === "event" && value.method === "selection/result") {
    return isSelectionResult(payload) && Date.parse(value.timestamp as string) >= Date.parse(payload.timestamp);
  }
  if (value.kind === "event" && value.method === "host/error") {
    if (!hasOnlyKeys(payload, ["code", "message", "scope", "recoverable", "relatedRequestId", "selectionId", "details"])) return false;
    const validDetails = payload.details === undefined || (
      isRecord(payload.details) &&
      Object.keys(payload.details).length <= 32 &&
      Object.values(payload.details).every((item) => item === null || typeof item === "string" || typeof item === "boolean" || isFiniteNumber(item))
    );
    return typeof payload.code === "string" && payload.code.length >= 3 && ERROR_CODE_PATTERN.test(payload.code) && payload.code.length <= 64 &&
      typeof payload.message === "string" && payload.message.length >= 1 && payload.message.length <= 1024 &&
      ["protocol", "hook", "uia", "capture", "ocr", "host"].includes(payload.scope as string) &&
      typeof payload.recoverable === "boolean" &&
      (payload.relatedRequestId === undefined || (typeof payload.relatedRequestId === "string" && payload.relatedRequestId.length <= 128 && MESSAGE_ID_PATTERN.test(payload.relatedRequestId))) &&
      (payload.selectionId === undefined || (typeof payload.selectionId === "string" && UUID_PATTERN.test(payload.selectionId))) &&
      validDetails;
  }
  if (value.kind === "request" && value.method === "hello") {
    return hasOnlyKeys(payload, ["desktopVersion", "supportedVersions", "sessionNonce", "requestedCapabilities"]) &&
      typeof payload.desktopVersion === "string" && payload.desktopVersion.length >= 1 && payload.desktopVersion.length <= 64 &&
      Array.isArray(payload.supportedVersions) && payload.supportedVersions.length >= 1 && hasUniqueItems(payload.supportedVersions) && payload.supportedVersions.every((version) => version === 1) &&
      typeof payload.sessionNonce === "string" && SESSION_NONCE_PATTERN.test(payload.sessionNonce) &&
      (payload.requestedCapabilities === undefined || (Array.isArray(payload.requestedCapabilities) && hasUniqueItems(payload.requestedCapabilities) && payload.requestedCapabilities.every(isCapability)));
  }
  if (value.kind === "response" && value.method === "ready") {
    return hasOnlyKeys(payload, ["selectedVersion", "hostVersion", "hostPid", "sessionNonce", "capabilities"]) && payload.selectedVersion === 1 &&
      typeof payload.hostVersion === "string" && payload.hostVersion.length >= 1 && payload.hostVersion.length <= 64 &&
      typeof payload.hostPid === "string" && payload.hostPid.length <= 20 && DECIMAL_PATTERN.test(payload.hostPid) &&
      typeof payload.sessionNonce === "string" && SESSION_NONCE_PATTERN.test(payload.sessionNonce) &&
      Array.isArray(payload.capabilities) && hasUniqueItems(payload.capabilities) && payload.capabilities.every(isCapability);
  }
  if (value.method === "health" && value.kind === "request") return Object.keys(payload).length === 0;
  if (value.method === "health" && value.kind === "response") {
    return hasOnlyKeys(payload, ["status", "listening", "uptimeMs", "lastEventSeq", "degradedCapabilities"]) &&
      ["starting", "ready", "degraded", "stopping"].includes(payload.status as string) &&
      typeof payload.listening === "boolean" && isBoundedInteger(payload.uptimeMs, 0) &&
      (payload.lastEventSeq === undefined || isBoundedInteger(payload.lastEventSeq, 0)) &&
      (payload.degradedCapabilities === undefined || (Array.isArray(payload.degradedCapabilities) && hasUniqueItems(payload.degradedCapabilities) && payload.degradedCapabilities.every(isCapability)));
  }
  if (value.method === "start" && value.kind === "request") return isStartConfig(payload);
  if (value.method === "start" && value.kind === "response") return hasOnlyKeys(payload, ["ok", "listening", "effectiveConfig"]) && payload.ok === true && payload.listening === true && (payload.effectiveConfig === undefined || isStartConfig(payload.effectiveConfig));
  if (value.method === "stop" && value.kind === "request") return hasOnlyKeys(payload, ["reason"]) && isOptionalBoundedString(payload.reason, 0, 256);
  if (value.method === "stop" && value.kind === "response") return hasOnlyKeys(payload, ["ok", "listening"]) && payload.ok === true && payload.listening === false;
  if (value.method === "shutdown" && value.kind === "request") return hasOnlyKeys(payload, ["reason", "gracePeriodMs"]) && isOptionalBoundedString(payload.reason, 0, 256) && (payload.gracePeriodMs === undefined || isBoundedInteger(payload.gracePeriodMs, 0, 5_000));
  if (value.method === "shutdown" && value.kind === "response") return hasOnlyKeys(payload, ["ok"]) && payload.ok === true;
  return false;
}

export function assertNativeMessage(value: unknown): asserts value is NativeMessage {
  if (!isNativeMessage(value)) throw new TypeError("Message does not satisfy Native IPC v1");
}
