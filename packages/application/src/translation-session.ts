import type { SelectionResult } from "../../contracts/src/native-ipc.js";
import type { SelectionCardViewModel } from "../../contracts/src/selection-card.js";
import {
  isTranslationRequestId,
  type TranslationFailure,
  type TranslationResult,
} from "../../contracts/src/translation.js";
/*
 * Selection and provider payloads are validated at their trust boundaries. Request IDs are
 * also checked here because this reducer directly constructs renderer-facing card models.
 */

export type TranslationSessionState =
  | { readonly stage: "source-only"; readonly selection: SelectionResult }
  | {
      readonly stage: "translating";
      readonly selection: SelectionResult;
      readonly requestId: string;
    }
  | {
      readonly stage: "translated";
      readonly selection: SelectionResult;
      readonly requestId: string;
      readonly translation: TranslationResult;
    }
  | {
      readonly stage: "failed";
      readonly selection: SelectionResult;
      readonly requestId: string;
      readonly failure: TranslationFailure;
    }
  | undefined;

export type TranslationSessionEvent =
  | {
      readonly type: "selection.received";
      readonly selection: SelectionResult;
      readonly translationEnabled: boolean;
      readonly requestId?: string;
    }
  | { readonly type: "translation.succeeded"; readonly result: TranslationResult }
  | { readonly type: "translation.failed"; readonly failure: TranslationFailure }
  | { readonly type: "translation.retry-requested"; readonly requestId: string }
  | { readonly type: "session.cancel" }
  | { readonly type: "session.dismiss" };

export type TranslationSessionEffect =
  | {
      readonly type: "translation.request";
      readonly selection: SelectionResult;
      readonly requestId: string;
    }
  | { readonly type: "translation.cancel"; readonly requestId: string }
  | { readonly type: "card.present"; readonly card: SelectionCardViewModel }
  | { readonly type: "card.dismiss" };

export interface TranslationSessionTransition {
  readonly state: TranslationSessionState;
  readonly effects: readonly TranslationSessionEffect[];
}

function baseCard(selection: SelectionResult) {
  return {
    selectionId: selection.selectionId,
    sourceText: selection.text,
    source: selection.source,
    confidence: selection.confidence,
  } as const;
}

function sourceCard(selection: SelectionResult): SelectionCardViewModel {
  return { kind: "source-only", ...baseCard(selection) };
}

function translatingCard(
  selection: SelectionResult,
  requestId: string,
): SelectionCardViewModel {
  return { kind: "translating", ...baseCard(selection), requestId };
}

function translatedCard(
  selection: SelectionResult,
  result: TranslationResult,
): SelectionCardViewModel {
  const card = {
    kind: "translated" as const,
    ...baseCard(selection),
    requestId: result.requestId,
    translatedText: result.translatedText,
    targetLanguage: result.targetLanguage,
    attribution: { ...result.attribution },
    fromCache: result.fromCache,
  };
  return result.detectedSourceLanguage === undefined
    ? card
    : { ...card, detectedSourceLanguage: result.detectedSourceLanguage };
}

function failedCard(
  selection: SelectionResult,
  failure: TranslationFailure,
): SelectionCardViewModel {
  const card = {
    kind: "failed" as const,
    ...baseCard(selection),
    requestId: failure.requestId,
    code: failure.code,
    retryable: failure.retryable,
  };
  return failure.retryAfterMs === undefined
    ? card
    : { ...card, retryAfterMs: failure.retryAfterMs };
}

function present(card: SelectionCardViewModel): TranslationSessionEffect {
  return { type: "card.present", card };
}

function cancel(state: TranslationSessionState): TranslationSessionEffect[] {
  return state?.stage === "translating"
    ? [{ type: "translation.cancel", requestId: state.requestId }]
    : [];
}

function dismiss(state: TranslationSessionState): TranslationSessionEffect[] {
  return state === undefined ? [] : [...cancel(state), { type: "card.dismiss" }];
}

/**
 * Pure latest-wins translation reducer. It deliberately has no Native lifecycle state so
 * Electron Main can integrate it without replacing the proven selection-host supervisor.
 */
export function transitionTranslationSession(
  state: TranslationSessionState,
  event: TranslationSessionEvent,
): TranslationSessionTransition {
  switch (event.type) {
    case "selection.received": {
      const previousEffects = dismiss(state);
      if (!event.translationEnabled || !isTranslationRequestId(event.requestId)) {
        return {
          state: { stage: "source-only", selection: event.selection },
          effects: [...previousEffects, present(sourceCard(event.selection))],
        };
      }
      return {
        state: {
          stage: "translating",
          selection: event.selection,
          requestId: event.requestId,
        },
        effects: [
          ...previousEffects,
          present(translatingCard(event.selection, event.requestId)),
          { type: "translation.request", selection: event.selection, requestId: event.requestId },
        ],
      };
    }

    case "translation.succeeded": {
      if (
        state?.stage !== "translating" ||
        state.selection.selectionId !== event.result.selectionId ||
        state.requestId !== event.result.requestId
      ) return { state, effects: [] };
      return {
        state: {
          stage: "translated",
          selection: state.selection,
          requestId: state.requestId,
          translation: event.result,
        },
        effects: [present(translatedCard(state.selection, event.result))],
      };
    }

    case "translation.failed": {
      if (
        state?.stage !== "translating" ||
        state.selection.selectionId !== event.failure.selectionId ||
        state.requestId !== event.failure.requestId
      ) return { state, effects: [] };
      if (event.failure.code === "cancelled") {
        return {
          state: { stage: "source-only", selection: state.selection },
          effects: [present(sourceCard(state.selection))],
        };
      }
      return {
        state: {
          stage: "failed",
          selection: state.selection,
          requestId: state.requestId,
          failure: event.failure,
        },
        effects: [present(failedCard(state.selection, event.failure))],
      };
    }

    case "translation.retry-requested":
      if (
        state?.stage !== "failed" ||
        state.requestId === event.requestId ||
        !isTranslationRequestId(event.requestId)
      ) {
        return { state, effects: [] };
      }
      return {
        state: {
          stage: "translating",
          selection: state.selection,
          requestId: event.requestId,
        },
        effects: [
          present(translatingCard(state.selection, event.requestId)),
          { type: "translation.request", selection: state.selection, requestId: event.requestId },
        ],
      };

    case "session.cancel":
      if (state === undefined) return { state, effects: [] };
      return {
        state: { stage: "source-only", selection: state.selection },
        effects: [...cancel(state), present(sourceCard(state.selection))],
      };

    case "session.dismiss":
      return { state: undefined, effects: dismiss(state) };
  }
}
