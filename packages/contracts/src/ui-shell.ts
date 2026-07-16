/** Shared Electron UI shell contracts. Keep renderer-facing payloads dependency-free. */

export const UI_SHELL_VERSION = 1 as const;

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const NATIVE_UI_STATUSES = [
  "unavailable",
  "starting",
  "ready",
  "degraded",
  "faulted",
] as const;
export type NativeUiStatus = (typeof NATIVE_UI_STATUSES)[number];

export const BALL_EDGES = ["left", "right"] as const;
export type BallEdge = (typeof BALL_EDGES)[number];

export interface BallAnchor {
  readonly displayId: string;
  readonly edge: BallEdge;
  readonly verticalRatio: number;
}

export interface UiShellSnapshot {
  readonly version: typeof UI_SHELL_VERSION;
  readonly ball: {
    readonly visible: boolean;
    readonly edgeSnap: boolean;
    readonly anchor?: BallAnchor;
  };
  readonly theme: ThemeMode;
  readonly native: {
    readonly status: NativeUiStatus;
    readonly degradedCapabilities: readonly string[];
  };
}

export const DEFAULT_UI_SHELL_SNAPSHOT: UiShellSnapshot = Object.freeze({
  version: UI_SHELL_VERSION,
  ball: Object.freeze({
    visible: true,
    edgeSnap: true,
  }),
  theme: "system",
  native: Object.freeze({
    status: "unavailable",
    degradedCapabilities: Object.freeze([] as string[]),
  }),
});

export interface SetBallVisiblePayload {
  readonly value: boolean;
}

export interface SetEdgeSnapPayload {
  readonly value: boolean;
}

export interface SetThemePayload {
  readonly value: ThemeMode;
}

export type UiShellSettingsWritePayload =
  | { readonly kind: "setBallVisible"; readonly value: boolean }
  | { readonly kind: "setEdgeSnap"; readonly value: boolean }
  | { readonly kind: "setTheme"; readonly value: ThemeMode }
  | { readonly kind: "resetBallPosition" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && THEME_MODES.includes(value as ThemeMode);
}

export function isNativeUiStatus(value: unknown): value is NativeUiStatus {
  return typeof value === "string" && NATIVE_UI_STATUSES.includes(value as NativeUiStatus);
}

export function isBallAnchor(value: unknown): value is BallAnchor {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["displayId", "edge", "verticalRatio"]) &&
    typeof value.displayId === "string" &&
    value.displayId.length >= 1 &&
    value.displayId.length <= 128 &&
    BALL_EDGES.includes(value.edge as BallEdge) &&
    typeof value.verticalRatio === "number" &&
    Number.isFinite(value.verticalRatio) &&
    value.verticalRatio >= 0 &&
    value.verticalRatio <= 1
  );
}

function isDegradedCapability(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

export function isUiShellSnapshot(value: unknown): value is UiShellSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "ball", "theme", "native"])) return false;
  if (value.version !== UI_SHELL_VERSION || !isThemeMode(value.theme)) return false;

  const ball = value.ball;
  if (!isRecord(ball) || !hasOnlyKeys(ball, ["visible", "edgeSnap", "anchor"])) return false;
  if (typeof ball.visible !== "boolean" || typeof ball.edgeSnap !== "boolean") return false;
  if (ball.anchor !== undefined && !isBallAnchor(ball.anchor)) return false;

  const native = value.native;
  if (!isRecord(native) || !hasOnlyKeys(native, ["status", "degradedCapabilities"])) return false;
  if (!isNativeUiStatus(native.status) || !Array.isArray(native.degradedCapabilities)) return false;
  if (
    native.degradedCapabilities.length > 32 ||
    !native.degradedCapabilities.every(isDegradedCapability) ||
    new Set(native.degradedCapabilities).size !== native.degradedCapabilities.length
  ) return false;

  return true;
}

export function isSetBallVisiblePayload(value: unknown): value is SetBallVisiblePayload {
  return isRecord(value) && hasOnlyKeys(value, ["value"]) && typeof value.value === "boolean";
}

export function isSetEdgeSnapPayload(value: unknown): value is SetEdgeSnapPayload {
  return isRecord(value) && hasOnlyKeys(value, ["value"]) && typeof value.value === "boolean";
}

export function isSetThemePayload(value: unknown): value is SetThemePayload {
  return isRecord(value) && hasOnlyKeys(value, ["value"]) && isThemeMode(value.value);
}

export function isUiShellSettingsWritePayload(value: unknown): value is UiShellSettingsWritePayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "setBallVisible":
    case "setEdgeSnap":
      return hasOnlyKeys(value, ["kind", "value"]) && typeof value.value === "boolean";
    case "setTheme":
      return hasOnlyKeys(value, ["kind", "value"]) && isThemeMode(value.value);
    case "resetBallPosition":
      return hasOnlyKeys(value, ["kind"]);
    default:
      return false;
  }
}
