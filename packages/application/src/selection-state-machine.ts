import type { HostError, SelectionResult } from "../../contracts/src/native-ipc.js";
import type {
  TranslationFailure,
  TranslationResult,
} from "../../contracts/src/translation.js";
import {
  transitionTranslationSession,
  type TranslationSessionEffect,
  type TranslationSessionState,
} from "./translation-session.js";

export type ApplicationMode =
  | "booting"
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "faulted"
  | "shutting-down";

export type ActiveSelection = Exclude<TranslationSessionState, undefined>;

export interface ApplicationState {
  readonly mode: ApplicationMode;
  /** Desired state survives a Native Host restart. */
  readonly listeningRequested: boolean;
  readonly nativeReady: boolean;
  readonly translationEnabled: boolean;
  readonly activeSelection: TranslationSessionState;
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
  | { readonly type: "translation.enable" }
  | { readonly type: "translation.disable" }
  | {
      readonly type: "selection.received";
      readonly selection: SelectionResult;
      readonly requestId?: string;
    }
  | { readonly type: "translation.succeeded"; readonly result: TranslationResult }
  | { readonly type: "translation.failed"; readonly failure: TranslationFailure }
  | { readonly type: "translation.retry-requested"; readonly requestId: string }
  | { readonly type: "selection.dismissed" }
  | { readonly type: "display.changed" }
  | { readonly type: "app.shutdown" };

export type ApplicationEffect =
  | { readonly type: "native.start" }
  | { readonly type: "native.stop" }
  | { readonly type: "native.shutdown" }
  | { readonly type: "native.reconnect" }
  | TranslationSessionEffect;

export interface Transition {
  readonly state: ApplicationState;
  readonly effects: readonly ApplicationEffect[];
}

export function createInitialState(
  listeningRequested = true,
  translationEnabled = false,
): ApplicationState {
  return {
    mode: "booting",
    listeningRequested,
    nativeReady: false,
    translationEnabled,
    activeSelection: undefined,
    lastHostError: undefined,
  };
}

function dismissSession(state: ApplicationState): Transition {
  const session = transitionTranslationSession(state.activeSelection, { type: "session.dismiss" });
  return {
    state: { ...state, activeSelection: session.state },
    effects: session.effects,
  };
}

/**
 * Pure application reducer. Native lifecycle handling composes the independently usable
 * translation session reducer rather than duplicating its cancellation and latest-wins rules.
 */
export function transition(state: ApplicationState, event: ApplicationEvent): Transition {
  if (state.mode === "shutting-down") return { state, effects: [] };

  switch (event.type) {
    case "native.ready":
      return state.listeningRequested
        ? {
            state: { ...state, mode: "starting", nativeReady: true, lastHostError: undefined },
            effects: [{ type: "native.start" }],
          }
        : {
            state: { ...state, mode: "idle", nativeReady: true, lastHostError: undefined },
            effects: [],
          };

    case "native.started":
      if (!state.nativeReady || state.mode !== "starting") return { state, effects: [] };
      return state.listeningRequested
        ? { state: { ...state, mode: "listening" }, effects: [] }
        : { state: { ...state, mode: "stopping" }, effects: [{ type: "native.stop" }] };

    case "native.stopped":
      if (!state.nativeReady) return { state, effects: [] };
      return state.listeningRequested
        ? { state: { ...state, mode: "starting" }, effects: [{ type: "native.start" }] }
        : { state: { ...state, mode: "idle" }, effects: [] };

    case "native.disconnected": {
      const session = dismissSession(state);
      return {
        state: { ...session.state, mode: "booting", nativeReady: false },
        effects: [...session.effects, { type: "native.reconnect" }],
      };
    }

    case "native.error":
      if (event.error.recoverable) {
        return { state: { ...state, lastHostError: event.error }, effects: [] };
      }
      {
        const session = dismissSession(state);
        return {
          state: {
            ...session.state,
            mode: "faulted",
            listeningRequested: false,
            lastHostError: event.error,
          },
          effects: session.effects,
        };
      }

    case "listening.enable":
      if (state.listeningRequested) return { state, effects: [] };
      if (state.nativeReady && (state.mode === "idle" || state.mode === "faulted")) {
        return {
          state: { ...state, mode: "starting", listeningRequested: true, lastHostError: undefined },
          effects: [{ type: "native.start" }],
        };
      }
      return { state: { ...state, listeningRequested: true }, effects: [] };

    case "listening.disable": {
      if (!state.listeningRequested && (state.mode === "idle" || state.mode === "stopping")) {
        return { state, effects: [] };
      }
      const session = dismissSession(state);
      const effects: ApplicationEffect[] = [...session.effects];
      if (state.nativeReady && (state.mode === "starting" || state.mode === "listening")) {
        effects.push({ type: "native.stop" });
      }
      return {
        state: {
          ...session.state,
          mode: state.nativeReady && (state.mode === "starting" || state.mode === "listening")
            ? "stopping"
            : "idle",
          listeningRequested: false,
        },
        effects,
      };
    }

    case "translation.enable":
      return state.translationEnabled
        ? { state, effects: [] }
        : { state: { ...state, translationEnabled: true }, effects: [] };

    case "translation.disable": {
      if (!state.translationEnabled) return { state, effects: [] };
      const session = transitionTranslationSession(state.activeSelection, { type: "session.cancel" });
      return {
        state: { ...state, translationEnabled: false, activeSelection: session.state },
        effects: session.effects,
      };
    }

    case "selection.received": {
      if (state.mode !== "listening" || !state.listeningRequested) {
        return { state, effects: [] };
      }
      const session = transitionTranslationSession(state.activeSelection, {
        type: "selection.received",
        selection: event.selection,
        translationEnabled: state.translationEnabled,
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      });
      return {
        state: { ...state, activeSelection: session.state },
        effects: session.effects,
      };
    }

    case "translation.succeeded": {
      const session = transitionTranslationSession(state.activeSelection, event);
      return {
        state: { ...state, activeSelection: session.state },
        effects: session.effects,
      };
    }

    case "translation.failed": {
      const session = transitionTranslationSession(state.activeSelection, event);
      return {
        state: { ...state, activeSelection: session.state },
        effects: session.effects,
      };
    }

    case "translation.retry-requested": {
      if (!state.translationEnabled || state.mode !== "listening" || !state.listeningRequested) {
        return { state, effects: [] };
      }
      const session = transitionTranslationSession(state.activeSelection, event);
      return {
        state: { ...state, activeSelection: session.state },
        effects: session.effects,
      };
    }

    case "selection.dismissed":
    case "display.changed":
      return dismissSession(state);

    case "app.shutdown": {
      const session = dismissSession(state);
      const effects: ApplicationEffect[] = [...session.effects];
      if (state.nativeReady) effects.push({ type: "native.shutdown" });
      return {
        state: {
          ...session.state,
          mode: "shutting-down",
          listeningRequested: false,
        },
        effects,
      };
    }
  }
}
