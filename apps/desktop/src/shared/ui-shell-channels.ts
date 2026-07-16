export const UI_SHELL_CHANNELS = Object.freeze({
  getSnapshot: 'ui-shell:get-snapshot',
  snapshotChanged: 'ui-shell:snapshot-changed',
  openSettings: 'ui-shell:open-settings',
  openContextMenu: 'ui-shell:open-context-menu',
  setBallVisible: 'ui-shell:set-ball-visible',
  setEdgeSnap: 'ui-shell:set-edge-snap',
  setTheme: 'ui-shell:set-theme',
  resetBallPosition: 'ui-shell:reset-ball-position'
} as const);
