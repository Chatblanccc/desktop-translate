import { contextBridge } from 'electron';

export interface Phase1BuildInfo {
  readonly phase: 1;
  readonly uiEnabled: false;
}

const phase1BuildInfo: Phase1BuildInfo = Object.freeze({
  phase: 1,
  uiEnabled: false
});

// Phase 1 has no renderer-facing operations. Phase 2 must add narrowly scoped,
// sender-validated methods here instead of exposing generic Electron IPC.
contextBridge.exposeInMainWorld('desktopTranslatePhase1', phase1BuildInfo);
