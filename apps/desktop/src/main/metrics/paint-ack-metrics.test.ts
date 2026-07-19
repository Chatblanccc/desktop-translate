import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE5_METRICS_CHANNELS } from '../../shared/phase5-metrics-channels.js';
import type { Phase5RuntimeDurationRecord, Phase5RuntimeMetricsPort } from './runtime-metrics.js';
import {
  Phase5PaintMetricsController,
  registerPhase5PaintAckIpc,
  type PaintAckIpcMainPort
} from './paint-ack-metrics.js';

afterEach(() => {
  vi.useRealTimers();
});

function metrics() {
  const records: Phase5RuntimeDurationRecord[] = [];
  const value: Phase5RuntimeMetricsPort = {
    enabled: true,
    measurementMode: 'real-acquisition',
    beginDuration: vi.fn(() => 100),
    recordDuration: vi.fn((record) => { records.push(record); }),
    close: vi.fn(async () => undefined)
  };
  return { value, records };
}

describe('Phase 5 renderer paint acknowledgement', () => {
  it('accepts only the pending token from the exact card WebContents', () => {
    const runtime = metrics();
    const controller = new Phase5PaintMetricsController({ metrics: runtime.value });
    const target = {
      id: 7,
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    };

    const dispatch = controller.begin(target, '17-64');
    expect(runtime.value.beginDuration).toHaveBeenCalledOnce();
    expect(target.send).not.toHaveBeenCalled();
    dispatch?.();
    expect(target.send).toHaveBeenCalledWith(
      PHASE5_METRICS_CHANNELS.cardPaintProbe,
      { token: 1 }
    );
    expect(controller.acknowledge(8, { token: 1 })).toBe(false);
    expect(controller.acknowledge(7, { token: 1, text: 'private source text' })).toBe(false);
    expect(controller.acknowledge(7, { token: 2 })).toBe(false);
    expect(controller.acknowledge(7, { token: 1 })).toBe(true);
    expect(controller.acknowledge(7, { token: 1 })).toBe(false);
    expect(runtime.records).toEqual([expect.objectContaining({
      metricId: 'PERF-06',
      status: 'success',
      startedAt: 100,
      characterCountBucket: '17-64'
    })]);
    controller.dispose();
  });

  it('records a stable timeout failure and cancels pending work on dispose', () => {
    vi.useFakeTimers();
    const runtime = metrics();
    const controller = new Phase5PaintMetricsController({ metrics: runtime.value, timeoutMs: 50 });
    const target = { id: 9, isDestroyed: () => false, send: vi.fn() };
    controller.begin(target, '1-16')?.();
    vi.advanceTimersByTime(50);
    expect(runtime.records).toEqual([expect.objectContaining({
      metricId: 'PERF-06',
      status: 'failure',
      errorCode: 'PAINT_ACK_TIMEOUT'
    })]);

    controller.begin(target, '1-16')?.();
    controller.dispose();
    vi.advanceTimersByTime(100);
    expect(runtime.records).toHaveLength(1);
    expect(controller.begin(target, '1-16')).toBeUndefined();
    expect(controller.acknowledge(9, { token: 2 })).toBe(false);
    controller.dispose();
  });

  it('does nothing when metrics or the target are unavailable', () => {
    const runtime = metrics();
    const disabled = { ...runtime.value, enabled: false };
    expect(new Phase5PaintMetricsController({ metrics: disabled }).begin({
      id: 1,
      isDestroyed: () => false,
      send: vi.fn()
    }, '0')).toBeUndefined();
    expect(new Phase5PaintMetricsController({ metrics: runtime.value }).begin({
      id: 1,
      isDestroyed: () => true,
      send: vi.fn()
    }, '0')).toBeUndefined();
  });

  it('registers one role-bound, main-frame-only acknowledgement listener', () => {
    let registered: ((event: never, ...args: readonly unknown[]) => void) | undefined;
    const ipcMain: PaintAckIpcMainPort = {
      on: vi.fn((_channel, listener) => { registered = listener as typeof registered; }),
      removeListener: vi.fn()
    };
    const acknowledge = vi.fn(() => true);
    const mainFrame = { url: 'file:///card.html' };
    const event = { sender: { id: 7, mainFrame }, senderFrame: mainFrame };
    const dispose = registerPhase5PaintAckIpc({
      ipcMain,
      resolveRole: () => 'card',
      acknowledge
    });

    expect(ipcMain.on).toHaveBeenCalledWith(
      PHASE5_METRICS_CHANNELS.cardPaintAck,
      expect.any(Function)
    );
    registered?.(event as never, { token: 1 });
    expect(acknowledge).toHaveBeenCalledWith(7, { token: 1 });
    for (const invalid of [
      [{ ...event, senderFrame: null }, { token: 1 }],
      [{ ...event, senderFrame: { url: 'file:///subframe.html' } }, { token: 1 }],
      [event, { token: 1, body: 'private body' }],
      [event, { token: 0 }],
      [event]
    ] as const) registered?.(invalid[0] as never, ...invalid.slice(1));
    expect(acknowledge).toHaveBeenCalledOnce();
    dispose();
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      PHASE5_METRICS_CHANNELS.cardPaintAck,
      registered
    );
  });
});
