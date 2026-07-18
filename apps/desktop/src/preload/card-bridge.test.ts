import { describe, expect, it, vi } from 'vitest';
import { SELECTION_CARD_CHANNELS } from '../shared/selection-card-channels.js';
import {
  createSelectionCardRendererBridge
} from './card-bridge.js';
import type { IpcRendererBridgePort } from './bridge.js';

const valid = {
  kind: 'source-only' as const,
  selectionId: '123e4567-e89b-42d3-a456-426614174000',
  sourceText: 'source text',
  source: 'ocr' as const,
  confidence: 0.75
};

function createIpc() {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn();
  const removeListener = vi.fn();
  const port: IpcRendererBridgePort = { invoke, on, removeListener };
  return { port, invoke, on, removeListener };
}

describe('selection card preload bridge', () => {
  it('validates current card and void dismiss responses', async () => {
    const { port, invoke } = createIpc();
    invoke.mockResolvedValueOnce(valid).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const api = createSelectionCardRendererBridge(port);
    await expect(api.getCurrent()).resolves.toEqual(valid);
    await expect(api.dismiss()).resolves.toBeUndefined();
    await expect(api.retry()).resolves.toBeUndefined();
    expect(invoke.mock.calls).toEqual([
      [SELECTION_CARD_CHANNELS.getCurrent],
      [SELECTION_CARD_CHANNELS.dismiss],
      [SELECTION_CARD_CHANNELS.retry]
    ]);
    invoke.mockResolvedValueOnce({ ...valid, sourceText: '' });
    await expect(api.getCurrent()).rejects.toThrow(/invalid/u);
    invoke.mockResolvedValueOnce({ unexpected: true });
    await expect(api.dismiss()).rejects.toThrow(/unexpected/u);
    invoke.mockResolvedValueOnce({ unexpected: true });
    await expect(api.retry()).rejects.toThrow(/unexpected/u);
  });

  it('strips events, ignores malformed pushes, and removes its own listener', () => {
    const { port, on, removeListener } = createIpc();
    const listener = vi.fn();
    const unsubscribe = createSelectionCardRendererBridge(port).onChanged(listener);
    const wrapped = on.mock.calls[0]?.[1] as (event: unknown, value: unknown) => void;
    wrapped({ sensitive: true }, valid);
    wrapped({}, undefined);
    wrapped({}, { ...valid, confidence: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, valid);
    expect(listener).toHaveBeenNthCalledWith(2, undefined);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(SELECTION_CARD_CHANNELS.changed, wrapped);
    expect(() => createSelectionCardRendererBridge(port).onChanged(
      undefined as unknown as typeof listener
    )).toThrow(/must be a function/u);
  });
});
