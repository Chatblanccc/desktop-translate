import type { SelectionSource } from "./native-ipc.js";

export const MAX_SELECTION_CARD_TEXT_LENGTH = 32_768;

export interface SelectionCardViewModel {
  readonly selectionId: string;
  readonly text: string;
  readonly source: SelectionSource;
  readonly confidence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
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

export function isSelectionCardViewModel(value: unknown): value is SelectionCardViewModel {
  if (!isRecord(value) || !hasOnlyKeys(value, ["selectionId", "text", "source", "confidence"])) {
    return false;
  }
  return (
    typeof value.selectionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.selectionId) &&
    typeof value.text === "string" &&
    value.text.length >= 1 &&
    value.text.length <= MAX_SELECTION_CARD_TEXT_LENGTH &&
    hasValidUtf16AndNoNul(value.text) &&
    ["uia", "uia-point-approx", "ocr"].includes(value.source as string) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}
