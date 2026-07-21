import { describe, expect, it, vi } from 'vitest';
import type { MetricsSink, MetricsSinkState } from './metrics-sink.js';
import type { Phase5MetricSample } from './phase5-metrics.js';
import { Phase5RuntimeMetrics } from './runtime-metrics.js';

function createSink(enabled = true, rejectWrite = false) {
  const samples: Phase5MetricSample[] = [];
  const state: MetricsSinkState = enabled
    ? { status: 'enabled', recordsWritten: 0 }
    : { status: 'disabled', recordsWritten: 0, reason: 'not-enabled' };
  const sink: MetricsSink = {
    getState: () => state,
    record: vi.fn(async (sample) => {
      if (rejectWrite) throw new Error('private path write failure');
      samples.push(sample);
    }),
    close: vi.fn(async () => undefined)
  };
  return { sink, samples };
}

describe('Phase 5 runtime metrics recorder', () => {
  it('records only derived monotonic durations and waits for writes on close', async () => {
    const { sink, samples } = createSink();
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValueOnce(200);
    const metrics = new Phase5RuntimeMetrics({
      sink,
      context: {
        gitSha: 'a'.repeat(40),
        binarySha256: 'b'.repeat(64),
        buildMode: 'signed-rc',
        measurementMode: 'real-acquisition'
      },
      now
    });

    const startedAt = metrics.beginDuration();
    metrics.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    metrics.recordDuration({
      metricId: 'PERF-06',
      role: 'main',
      scenario: 'renderer-paint-ack',
      source: 'renderer',
      startedAt: 150,
      status: 'failure',
      errorCode: 'PAINT_ACK_TIMEOUT',
      characterCountBucket: '17-64'
    });
    expect(metrics.enabled).toBe(true);
    await metrics.close();

    expect(metrics.enabled).toBe(false);
    expect(metrics.measurementMode).toBe('real-acquisition');
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      metricId: 'PERF-03',
      value: 25,
      gitSha: 'a'.repeat(40),
      binarySha256: 'b'.repeat(64)
    });
    expect(samples[1]).toMatchObject({
      metricId: 'PERF-06',
      value: 50,
      status: 'failure',
      errorCode: 'PAINT_ACK_TIMEOUT'
    });
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it('is behavior-neutral when disabled, invalid or unable to write', async () => {
    const disabled = createSink(false);
    const disabledMetrics = new Phase5RuntimeMetrics({
      sink: disabled.sink,
      context: {
        gitSha: 'a'.repeat(40),
        buildMode: 'development',
        measurementMode: 'instrumentation-only'
      },
      now: () => 10
    });
    disabledMetrics.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt: 0,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    expect(disabled.sink.record).not.toHaveBeenCalled();

    const rejecting = createSink(true, true);
    const clock = vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(4).mockReturnValue(10);
    const metrics = new Phase5RuntimeMetrics({
      sink: rejecting.sink,
      context: {
        gitSha: 'a'.repeat(40),
        buildMode: 'development',
        measurementMode: 'instrumentation-only'
      },
      now: clock
    });
    metrics.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt: Number.NaN,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    metrics.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt: 5,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    metrics.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt: 0,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    await expect(metrics.close()).resolves.toBeUndefined();
    await expect(metrics.close()).resolves.toBeUndefined();
    expect(rejecting.sink.record).toHaveBeenCalledOnce();
    expect(rejecting.sink.close).toHaveBeenCalledOnce();
    expect(metrics.enabled).toBe(false);
    metrics.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt: 0,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    expect(rejecting.sink.record).toHaveBeenCalledOnce();
  });
});
