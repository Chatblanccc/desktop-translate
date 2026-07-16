import type { HostError, SelectionResult } from "../../contracts/src/native-ipc.js";
import type { TranslationFailure, TranslationResult } from "../../contracts/src/translation.js";

export type ApplicationMode =
  | "booting"
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "faulted"
  | "shutting-down";

export type ActiveSelection =
  | { readonly stage: "translating"; readonly selection: SelectionResult; readonly requestId: string }
  | { readonly stage: "presented"; readonly selection: SelectionResult; readonly translation: TranslationResult }
  | { readonly stage: "failed"; readonly selection: SelectionResult; readonly failure: TranslationFailure };

export interface ApplicationState {
  readonly mode: ApplicationMode;
  /** Desired state survives a Native Host restart. */
  readonly listeningRequested: boolean;
  readonly nativeReady: boolean;
  readonly activeSelection: ActiveSelection | undefined;
  readonly lastHostError: HostError | undefined;
}

export type ApplicationEvent =
  | { readonly type: "native.ready" }
  | { readonly type: "native.started" }
  | { readonly type: "native.stopped" }
  | { readonly type: "native.disconnected" }
  | { readonly type: "native.error"; readonly error: HostError }
  | { readonly type: "listening.enable" }
  | { readonly type: "listening.disable" }
  | { readonly type: "selection.received"; readonly selection: SelectionResult; readonly requestId: string }
  | { readonly type: "translation.succeeded"; readonly result: TranslationResult }
  | { readonly type: "translation.failed"; readonly failure: TranslationFailure }
  | { readonly type: "selection.dismissed" }
  | { readonly type: "app.shutdown" };

export type ApplicationEffect =
  | { readonly type: "native.start" }
  | { readonly type: "native.stop" }
  | { readonly type: "native.shutdown" }
  | { readonly type: "native.reconnect" }
  | { readonly type: "translation.request"; readonly selection: SelectionResult; readonly requestId: string }
  | { readonly type: "translation.cancel"; readonly requestId: string }
  | { readonly type: "card.present"; readonly result: TranslationResult; readonly selection: SelectionResult }
  | { readonly type: "card.present-error"; readonly failure: TranslationFailure; readonly selection: SelectionResult }
  | { readonly type: "card.dismiss" };

export interface Transition {
  readonly state: ApplicationState;
  readonly effects: readonly ApplicationEffect[];
}

export function createInitialState(listeningRequested = true): ApplicationState {
  return {
    mode: "booting",
    listeningRequested,
    nativeReady: false,
    activeSelection: undefined,
    lastHostError: undefined,
  };
}

function cancelAndDismiss(active: ActiveSelection | undefined): ApplicationEffect[] {
  if (!active) return [];
  const effects: ApplicationEffect[] = [];
  if (active.stage === "translating") effects.push({ type: "translation.cancel", requestId: active.requestId });
  effects.push({ type: "card.dismiss" });
  return effects;
}

/**
 * Deterministic orchestration reducer. It never performs I/O and intentionally ignores
 * stale translation completions whose selectionId/requestId no longer match.
 */
export function transition(state: ApplicationState, event: ApplicationEvent): Transition {
  if (state.mode === "shutting-down") return { state, effects: [] };

  switch (event.type) {
    case "native.ready": {
      if (state.listeningRequested) {
        return {
          state: { ...state, mode: "starting", nativeReady: true, lastHostError: undefined },
          effects: [{ type: "native.start" }],
        };
      }
      return { state: { ...state, mode: "idle", nativeReady: true, lastHostError: undefined }, effects: [] };
    }

    case "native.started": {
      if (!state.nativeReady || state.mode !== "starting") return { state, effects: [] };
      if (!state.listeningRequested) {
        return { state: { ...state, mode: "stopping" }, effects: [{ type: "native.stop" }] };
      }
      return { state: { ...state, mode: "listening" }, effects: [] };
    }

    case "native.stopped": {
      if (!state.nativeReady) return { state, effects: [] };
      if (state.listeningRequested) {
        return { state: { ...state, mode: "starting" }, effects: [{ type: "native.start" }] };
      }
      return { state: { ...state, mode: "idle" }, effects: [] };
    }

    case "native.disconnected": {
      const effects = cancelAndDismiss(state.activeSelection);
      effects.push({ type: "native.reconnect" });
      return {
        state: { ...state, mode: "booting", nativeReady: false, activeSelection: undefined },
        effects,
      };
    }

    case "native.error": {
      if (event.error.recoverable) {
        return { state: { ...state, lastHostError: event.error }, effects: [] };
      }
      return {
        state: {
          ...state,
          mode: "faulted",
          listeningRequested: false,
          activeSelection: undefined,
          lastHostError: event.error,
        },
        effects: cancelAndDismiss(state.activeSelection),
      };
    }

    case "listening.enable": {
      if (state.listeningRequested) return { state, effects: [] };
      if (state.nativeReady && (state.mode === "idle" || state.mode === "faulted")) {
        return {
          state: { ...state, mode: "starting", listeningRequested: true, lastHostError: undefined },
          effects: [{ type: "native.start" }],
        };
      }
      return { state: { ...state, listeningRequested: true }, effects: [] };
    }

    case "listening.disable": {
      if (!state.listeningRequested && (state.mode === "idle" || state.mode === "stopping")) return { state, effects: [] };
      const effects = cancelAndDismiss(state.activeSelection);
      if (state.nativeReady && ["starting", "listening"].includes(state.mode)) effects.push({ type: "native.stop" });
      return {
        state: {
          ...state,
          mode: state.nativeReady && ["starting", "listening"].includes(state.mode) ? "stopping" : "idle",
          listeningRequested: false,
          activeSelection: undefined,
        },
        effects,
      };
    }

    case "selection.received": {
      if (state.mode !== "listening" || !state.listeningRequested) return { state, effects: [] };
      const effects = cancelAndDismiss(state.activeSelection);
      effects.push({ type: "translation.request", selection: event.selection, requestId: event.requestId });
      return {
        state: {
          ...state,
          activeSelection: { stage: "translating", selection: event.selection, requestId: event.requestId },
        },
        effects,
      };
    }

    case "translation.succeeded": {
      const active = state.activeSelection;
      if (
        !active ||
        active.stage !== "translating" ||
        active.selection.selectionId !== event.result.selectionId ||
        active.requestId !== event.result.requestId
      ) return { state, effects: [] };
      return {
        state: { ...state, activeSelection: { stage: "presented", selection: active.selection, translation: event.result } },
        effects: [{ type: "card.present", result: event.result, selection: active.selection }],
      };
    }

    case "translation.failed": {
      const active = state.activeSelection;
      if (
        !active ||
        active.stage !== "translating" ||
        active.selection.selectionId !== event.failure.selectionId ||
        active.requestId !== event.failure.requestId
      ) return { state, effects: [] };
      if (event.failure.code === "cancelled") {
        return { state: { ...state, activeSelection: undefined }, effects: [] };
      }
      return {
        state: { ...state, activeSelection: { stage: "failed", selection: active.selection, failure: event.failure } },
        effects: [{ type: "card.present-error", failure: event.failure, selection: active.selection }],
      };
    }

    case "selection.dismissed": {
      return {
        state: { ...state, activeSelection: undefined },
        effects: cancelAndDismiss(state.activeSelection),
      };
    }

    case "app.shutdown": {
      const effects = cancelAndDismiss(state.activeSelection);
      if (state.nativeReady) effects.push({ type: "native.shutdown" });
      return {
        state: { ...state, mode: "shutting-down", listeningRequested: false, activeSelection: undefined },
        effects,
      };
    }
  }
}
