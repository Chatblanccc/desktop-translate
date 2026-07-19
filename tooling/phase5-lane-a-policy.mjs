export const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;
export const DEFAULT_SELECTION_INTERVAL_MS = 30_000;
export const DEFAULT_FAULT_INTERVAL_MS = 30 * 60 * 1_000;
export const DEFAULT_LIFECYCLE_INTERVAL_MS = 2 * 60 * 60 * 1_000;

export function qualifyFullSchedule({ requested, durationMs, actualDurationMs, intervals, identityVerified, counters }) {
  const complete = requested
    && durationMs === EIGHT_HOURS_MS
    && actualDurationMs >= EIGHT_HOURS_MS
    && intervals.selection === DEFAULT_SELECTION_INTERVAL_MS
    && intervals.fault === DEFAULT_FAULT_INTERVAL_MS
    && intervals.lifecycle === DEFAULT_LIFECYCLE_INTERVAL_MS
    && identityVerified === true
    && counters.maxSchedulingDelayMs <= 5_000
    && counters.invariantFailures === 0
    && hasExactFullScheduleCounts(counters);
  return {
    fullScheduleComplete: complete,
    status: counters.invariantFailures > 0 || (requested && !complete)
      ? 'FAIL'
      : complete
        ? 'HARNESS_SCHEDULE_PASS_REQUIRES_PRODUCT_AND_RESOURCE_EVIDENCE'
        : 'SMOKE_PASS_NOT_ACCEPTANCE'
  };
}

export function hasExactFullScheduleCounts(values) {
  return values.selections === 960
    && values.faultsInjected === 15
    && values.faultsRecovered === 15
    && values.lifecycleExercises === 3
    && values.acquisition['simulated-uia-result'] === 672
    && values.acquisition['simulated-ocr-result'] === 288
    && values.translation['source-only'] === 192
    && values.translation.success === 576
    && values.translation['recoverable-failure-manual-retry'] === 144
    && values.translation['non-recoverable-failure'] === 48
    && Object.values(values.fault).every((count) => count >= 1)
    && Object.values(values.lifecycle).every((count) => count === 1);
}
