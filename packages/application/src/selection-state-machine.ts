import type { HostError, SelectionResult } from "../../contracts/src/native-ipc.js";

export type ApplicationMode =
  | "booting"
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "faulted"
  | "shutting-down";

export interface ActiveSelection {
  readonly stage: "presented";
  readonly selection: SelectionResult;
}

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
  | { readonly type: "selection.received"; readonly selection: SelectionResult }
  | { readonly type: "selection.dismissed" }
  | { readonly type: "app.shutdown" };

export type ApplicationEffect =
  | { readonly type: "native.start" }
  | { readonly type: "native.stop" }
  | { readonly type: "native.shutdown" }
  | { readonly type: "native.reconnect" }
  | { readonly type: "card.present-source"; readonly selection: SelectionResult }
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

function dismiss(active: ActiveSelection | undefined): ApplicationEffect[] {
  return active === undefined ? [] : [{ type: "card.dismiss" }];
}

/** Pure Phase 3 orchestration reducer. It never performs I/O or requests translation. */
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
      const effects = [...dismiss(state.activeSelection), { type: "native.reconnect" } as const];
      return {
        state: { ...state, mode: "booting", nativeReady: false, activeSelection: undefined },
        effects,
      };
    }

    case "native.error":
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
        effects: dismiss(state.activeSelection),
      };

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
      const effects = dismiss(state.activeSelection);
      if (state.nativeReady && (state.mode === "starting" || state.mode === "listening")) {
        effects.push({ type: "native.stop" });
      }
      return {
        state: {
          ...state,
          mode: state.nativeReady && (state.mode === "starting" || state.mode === "listening")
            ? "stopping"
            : "idle",
          listeningRequested: false,
          activeSelection: undefined,
        },
        effects,
      };
    }

    case "selection.received":
      if (state.mode !== "listening" || !state.listeningRequested) return { state, effects: [] };
      return {
        state: { ...state, activeSelection: { stage: "presented", selection: event.selection } },
        effects: [...dismiss(state.activeSelection), { type: "card.present-source", selection: event.selection }],
      };

    case "selection.dismissed":
      return {
        state: { ...state, activeSelection: undefined },
        effects: dismiss(state.activeSelection),
      };

    case "app.shutdown": {
      const effects = dismiss(state.activeSelection);
      if (state.nativeReady) effects.push({ type: "native.shutdown" });
      return {
        state: {
          ...state,
          mode: "shutting-down",
          listeningRequested: false,
          activeSelection: undefined,
        },
        effects,
      };
    }
  }
}
