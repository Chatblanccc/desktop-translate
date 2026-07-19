export const PRODUCT_LANE_A_STATUS = Object.freeze({
  pass: 'PASS',
  blocked: 'NOT_IMPLEMENTED_BLOCKER'
});

export const PRODUCT_LANE_A_REQUIRED_ASSERTIONS = Object.freeze([
  'attestedIdentityVerified',
  'fakeProductionIsolationVerified',
  'productProcessExercised',
  'selectionControlExecuted',
  'translationControlExecuted',
  'faultControlExecuted',
  'lifecycleControlExecuted',
  'mainResultsConfirmed',
  'rendererResultsConfirmed',
  'resourceGateExecuted',
  'residualProcessGateExecuted',
  'werGateExecuted',
  'privacyGateExecuted',
  'gracefulExitVerified'
]);

export function qualifyProductLaneA({
  fullScheduleComplete,
  assertions,
  blockers = []
}) {
  const missingAssertions = PRODUCT_LANE_A_REQUIRED_ASSERTIONS.filter(
    (name) => assertions?.[name] !== true
  );
  const acceptance = fullScheduleComplete === true
    && missingAssertions.length === 0
    && blockers.length === 0;
  return {
    status: acceptance ? PRODUCT_LANE_A_STATUS.pass : PRODUCT_LANE_A_STATUS.blocked,
    acceptance,
    missingAssertions
  };
}

export function currentRuntimeControlBlockers() {
  return Object.freeze([
    Object.freeze({
      code: 'ATTESTED_MANIFEST_LACKS_RUNTIME_CONTROL_CONTRACT',
      detail: 'The attested build manifest does not bind an artifact extraction format, product executable, control endpoint, protocol version, or response evidence path.'
    }),
    Object.freeze({
      code: 'PACKAGED_TEST_CONTROL_DISABLED',
      detail: 'The current main-process test API and fake translation transport are explicitly disabled when Electron app.isPackaged is true.'
    }),
    Object.freeze({
      code: 'PRODUCT_ACTION_DRIVER_NOT_IMPLEMENTED',
      detail: 'No attested packaged control plane can currently deliver selection, translation, fault, and lifecycle actions and confirm both Main and Renderer outcomes.'
    })
  ]);
}
