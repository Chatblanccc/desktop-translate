import { describe, expect, it, vi } from 'vitest';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import { SELECTION_CARD_CHANNELS } from '../../shared/selection-card-channels.js';
import { registerSelectionCardIpc } from './selection-card-ipc.js';
import type { InvokeEventLike, IpcMainPort } from './ui-shell-ipc.js';

const card: SelectionCardViewModel = {
  selectionId: '123e4567-e89b-42d3-a456-426614174000',
  text: 'source text',
  source: 'uia',
  confidence: 1
};

function setup(role: 'card' | 'ball' = 'card') {
  const handlers = new Map<string, (event: InvokeEventLike, ...args: readonly unknown[]) => unknown>();
  const ipcMain: IpcMainPort = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => { handlers.delete(channel); }
  };
  const mainFrame = { url: 'file:///card.html' };
  const event: InvokeEventLike = { sender: { id: 1, mainFrame }, senderFrame: mainFrame };
  const dismiss = vi.fn();
  const dispose = registerSelectionCardIpc({
    ipcMain,
    resolveRole: () => role,
    getCurrent: () => card,
    dismiss
  });
  return { handlers, event, dismiss, dispose };
}

describe('selection card IPC', () => {
  it('allows only the registered card main frame', () => {
    const { handlers, event, dismiss } = setup();
    expect(handlers.get(SELECTION_CARD_CHANNELS.getCurrent)?.(event)).toEqual(card);
    handlers.get(SELECTION_CARD_CHANNELS.dismiss)?.(event);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('rejects other roles, subframes, and arguments', () => {
    const wrongRole = setup('ball');
    expect(() => wrongRole.handlers.get(SELECTION_CARD_CHANNELS.getCurrent)?.(wrongRole.event))
      .toThrow(/rejected/u);
    const cardRole = setup();
    expect(() => cardRole.handlers.get(SELECTION_CARD_CHANNELS.getCurrent)?.(
      { ...cardRole.event, senderFrame: { url: 'file:///subframe.html' } }
    )).toThrow(/rejected/u);
    expect(() => cardRole.handlers.get(SELECTION_CARD_CHANNELS.dismiss)?.(cardRole.event, {}))
      .toThrow(/does not accept/u);
  });

  it('removes both handlers during shutdown', () => {
    const { handlers, dispose } = setup();
    expect(handlers.size).toBe(2);
    dispose();
    expect(handlers.size).toBe(0);
  });
});
