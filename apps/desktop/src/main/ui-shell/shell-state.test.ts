import { describe, expect, it, vi } from 'vitest';
import { UiShellState } from './shell-state.js';

describe('UiShellState', () => {
  it('publishes initialized settings and isolated snapshots', () => {
    const state = new UiShellState();
    const changed = vi.fn();
    state.on('changed', changed);
    state.initialize({ ball: { visible: false, edgeSnap: true }, theme: 'dark' });
    const snapshot = state.getSnapshot();
    expect(snapshot.ball.visible).toBe(false);
    expect(snapshot.theme).toBe('dark');
    expect(changed).toHaveBeenCalledOnce();
    (snapshot.native.degradedCapabilities as string[]).push('mutated');
    expect(state.getSnapshot().native.degradedCapabilities).toEqual([]);
  });

  it('keeps an optional anchor while updating individual preferences', () => {
    const state = new UiShellState();
    state.setBallAnchor({ displayId: '1', edge: 'right', verticalRatio: 0.5 });
    state.setBallVisible(false);
    state.setEdgeSnap(false);
    expect(state.getSnapshot().ball).toEqual({
      visible: false,
      edgeSnap: false,
      anchor: { displayId: '1', edge: 'right', verticalRatio: 0.5 }
    });
  });
});
