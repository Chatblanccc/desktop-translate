import {
  isPhase4TranslationProviderId,
  isPhase4TranslationSourceLanguage,
  isPhase4TranslationTargetLanguage,
  type LanguageCode,
} from "./translation.js";

/** Shared Electron UI shell contracts. Keep renderer-facing payloads dependency-free. */

export const UI_SHELL_VERSION = 3 as const;

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

export const SELECTION_LIFECYCLES = [
  "disabled",
  "starting",
  "listening",
  "degraded",
  "faulted",
] as const;
export type SelectionLifecycle = (typeof SELECTION_LIFECYCLES)[number];

export const OCR_ACTIVATIONS = ["fallback", "alt-drag"] as const;
export type OcrActivation = (typeof OCR_ACTIVATIONS)[number];

/** Exact phrase required for the irreversible local-data reset command. */
export const CLEAR_LOCAL_DATA_CONFIRMATION = "清除全部本地数据" as const;

export const BALL_EDGES = ["left", "right"] as const;
export type BallEdge = (typeof BALL_EDGES)[number];

export const CREDENTIAL_STATUSES = ["missing", "configured", "unavailable"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * Renderer-safe projection of the stored Baidu credentials. The secret value is
 * deliberately absent; `secretConfigured` only controls the fixed UI mask.
 */
export type BaiduCredentialSummary =
  | { readonly appId: ""; readonly secretConfigured: false }
  | { readonly appId: string; readonly secretConfigured: true };

export interface TranslationUiState {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly sourceLanguage: LanguageCode | "auto";
  readonly targetLanguage: LanguageCode;
  readonly credentialStatus: CredentialStatus;
  readonly consentVersion: number;
}

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
  readonly selection: {
    readonly enabled: boolean;
    readonly lifecycle: SelectionLifecycle;
    readonly ocrActivation: OcrActivation;
  };
  /** Non-sensitive configuration only. Provider credentials never enter this snapshot. */
  readonly translation: TranslationUiState;
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
  selection: Object.freeze({
    enabled: true,
    lifecycle: "starting",
    ocrActivation: "fallback",
  }),
  translation: Object.freeze({
    enabled: false,
    providerId: "baidu",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    credentialStatus: "missing",
    consentVersion: 0,
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

export interface SetSelectionEnabledPayload {
  readonly value: boolean;
}

export interface SetOcrActivationPayload {
  readonly value: OcrActivation;
}

export interface ClearAllLocalDataPayload {
  readonly confirmation: typeof CLEAR_LOCAL_DATA_CONFIRMATION;
}

export type UiShellSettingsWritePayload =
  | { readonly kind: "setBallVisible"; readonly value: boolean }
  | { readonly kind: "setEdgeSnap"; readonly value: boolean }
  | { readonly kind: "setTheme"; readonly value: ThemeMode }
  | { readonly kind: "setSelectionEnabled"; readonly value: boolean }
  | { readonly kind: "setOcrActivation"; readonly value: OcrActivation }
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

export function isSelectionLifecycle(value: unknown): value is SelectionLifecycle {
  return typeof value === "string" && SELECTION_LIFECYCLES.includes(value as SelectionLifecycle);
}

export function isOcrActivation(value: unknown): value is OcrActivation {
  return typeof value === "string" && OCR_ACTIVATIONS.includes(value as OcrActivation);
}

export function isCredentialStatus(value: unknown): value is CredentialStatus {
  return typeof value === "string" && CREDENTIAL_STATUSES.includes(value as CredentialStatus);
}

export function isBaiduCredentialSummary(value: unknown): value is BaiduCredentialSummary {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  if (!hasOnlyKeys(value, ["appId", "secretConfigured"])) return false;
  if (value.secretConfigured === false) return value.appId === "";
  return value.secretConfigured === true && isRendererSafeBaiduAppId(value.appId);
}

function isRendererSafeBaiduAppId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
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
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "ball", "theme", "native", "selection", "translation"])
  ) return false;
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

  const selection = value.selection;
  if (!isRecord(selection) || !hasOnlyKeys(selection, ["enabled", "lifecycle", "ocrActivation"])) return false;
  if (
    typeof selection.enabled !== "boolean" ||
    !isSelectionLifecycle(selection.lifecycle) ||
    !isOcrActivation(selection.ocrActivation)
  ) return false;

  const translation = value.translation;
  if (
    !isRecord(translation) ||
    !hasOnlyKeys(translation, [
      "enabled",
      "providerId",
      "sourceLanguage",
      "targetLanguage",
      "credentialStatus",
      "consentVersion",
    ])
  ) return false;
  if (
    typeof translation.enabled !== "boolean" ||
    !isPhase4TranslationProviderId(translation.providerId) ||
    !isPhase4TranslationSourceLanguage(translation.sourceLanguage) ||
    !isPhase4TranslationTargetLanguage(translation.targetLanguage) ||
    !isCredentialStatus(translation.credentialStatus) ||
    typeof translation.consentVersion !== "number" ||
    !Number.isSafeInteger(translation.consentVersion) ||
    translation.consentVersion < 0 ||
    translation.consentVersion > 1_000_000
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

export function isSetSelectionEnabledPayload(value: unknown): value is SetSelectionEnabledPayload {
  return isRecord(value) && hasOnlyKeys(value, ["value"]) && typeof value.value === "boolean";
}

export function isSetOcrActivationPayload(value: unknown): value is SetOcrActivationPayload {
  return isRecord(value) && hasOnlyKeys(value, ["value"]) && isOcrActivation(value.value);
}

export function isClearAllLocalDataPayload(value: unknown): value is ClearAllLocalDataPayload {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["confirmation"]) &&
    value.confirmation === CLEAR_LOCAL_DATA_CONFIRMATION
  );
}

export function isUiShellSettingsWritePayload(value: unknown): value is UiShellSettingsWritePayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "setBallVisible":
    case "setEdgeSnap":
    case "setSelectionEnabled":
      return hasOnlyKeys(value, ["kind", "value"]) && typeof value.value === "boolean";
    case "setTheme":
      return hasOnlyKeys(value, ["kind", "value"]) && isThemeMode(value.value);
    case "setOcrActivation":
      return hasOnlyKeys(value, ["kind", "value"]) && isOcrActivation(value.value);
    case "resetBallPosition":
      return hasOnlyKeys(value, ["kind"]);
    default:
      return false;
  }
}
