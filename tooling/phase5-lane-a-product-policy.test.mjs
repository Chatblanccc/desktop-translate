import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentRuntimeControlBlockers,
  PRODUCT_LANE_A_REQUIRED_ASSERTIONS,
  qualifyProductLaneA
} from './phase5-lane-a-product-policy.mjs';

const allAssertions = Object.fromEntries(
  PRODUCT_LANE_A_REQUIRED_ASSERTIONS.map((name) => [name, true])
);

test('product Lane A can pass only when every product and security gate is true', () => {
  assert.deepEqual(qualifyProductLaneA({
    fullScheduleComplete: true,
    assertions: allAssertions,
    blockers: []
  }), {
    status: 'PASS',
    acceptance: true,
    missingAssertions: []
  });

  for (const name of PRODUCT_LANE_A_REQUIRED_ASSERTIONS) {
    const result = qualifyProductLaneA({
      fullScheduleComplete: true,
      assertions: { ...allAssertions, [name]: false },
      blockers: []
    });
    assert.equal(result.status, 'NOT_IMPLEMENTED_BLOCKER');
    assert.equal(result.acceptance, false);
    assert.deepEqual(result.missingAssertions, [name]);
  }
});

test('schedule incompleteness and implementation blockers remain fail closed', () => {
  assert.equal(qualifyProductLaneA({
    fullScheduleComplete: false,
    assertions: allAssertions,
    blockers: []
  }).acceptance, false);
  assert.equal(qualifyProductLaneA({
    fullScheduleComplete: true,
    assertions: allAssertions,
    blockers: currentRuntimeControlBlockers()
  }).acceptance, false);
});

test('current runtime control blockers identify the attested contract and packaged API gaps', () => {
  assert.deepEqual(currentRuntimeControlBlockers().map(({ code }) => code), [
    'ATTESTED_MANIFEST_LACKS_RUNTIME_CONTROL_CONTRACT',
    'PACKAGED_TEST_CONTROL_DISABLED',
    'PRODUCT_ACTION_DRIVER_NOT_IMPLEMENTED'
  ]);
});
