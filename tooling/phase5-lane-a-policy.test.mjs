import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FAULT_INTERVAL_MS,
  DEFAULT_LIFECYCLE_INTERVAL_MS,
  DEFAULT_SELECTION_INTERVAL_MS,
  EIGHT_HOURS_MS,
  qualifyFullSchedule
} from './phase5-lane-a-policy.mjs';

function counters(overrides = {}) {
  return {
    selections: 960,
    faultsInjected: 15,
    faultsRecovered: 15,
    lifecycleExercises: 3,
    invariantFailures: 0,
    maxSchedulingDelayMs: 5_000,
    acquisition: { 'simulated-uia-result': 672, 'simulated-ocr-result': 288 },
    translation: {
      'source-only': 192,
      success: 576,
      'recoverable-failure-manual-retry': 144,
      'non-recoverable-failure': 48
    },
    fault: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`fault-${index}`, index < 7 ? 2 : 1])),
    lifecycle: { dismiss: 1, pause: 1, settings: 1 },
    ...overrides
  };
}

function qualify(overrides = {}) {
  return qualifyFullSchedule({
    requested: true,
    durationMs: EIGHT_HOURS_MS,
    actualDurationMs: EIGHT_HOURS_MS,
    intervals: {
      selection: DEFAULT_SELECTION_INTERVAL_MS,
      fault: DEFAULT_FAULT_INTERVAL_MS,
      lifecycle: DEFAULT_LIFECYCLE_INTERVAL_MS
    },
    identityVerified: true,
    counters: counters(),
    ...overrides
  });
}

test('only the complete frozen eight-hour schedule receives the harness schedule status', () => {
  assert.deepEqual(qualify(), {
    fullScheduleComplete: true,
    status: 'HARNESS_SCHEDULE_PASS_REQUIRES_PRODUCT_AND_RESOURCE_EVIDENCE'
  });
});

test('missing events, unrecovered faults, long scheduling gaps, duration gaps, or identity gaps fail closed', () => {
  for (const candidate of [
    qualify({ counters: counters({ selections: 959 }) }),
    qualify({ counters: counters({ faultsRecovered: 14 }) }),
    qualify({ counters: counters({ maxSchedulingDelayMs: 5_001 }) }),
    qualify({ actualDurationMs: EIGHT_HOURS_MS - 1 }),
    qualify({ identityVerified: false })
  ]) {
    assert.deepEqual(candidate, { fullScheduleComplete: false, status: 'FAIL' });
  }
});

test('short development schedules stay explicitly non-acceptance', () => {
  const result = qualifyFullSchedule({
    requested: false,
    durationMs: 1_000,
    actualDurationMs: 1_000,
    intervals: { selection: 100, fault: 250, lifecycle: 400 },
    identityVerified: false,
    counters: counters({ selections: 10, faultsInjected: 3, faultsRecovered: 3, lifecycleExercises: 2 })
  });
  assert.deepEqual(result, { fullScheduleComplete: false, status: 'SMOKE_PASS_NOT_ACCEPTANCE' });
});
