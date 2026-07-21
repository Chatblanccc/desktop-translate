import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditPhase5WorkflowDocument,
  auditPhase5WorkflowText,
  parseWorkflowYaml
} from './phase5-workflow-preflight-audit.mjs';

const workflowPath = fileURLToPath(new URL('../.github/workflows/phase5-windows.yml', import.meta.url));
const workflowText = await readFile(workflowPath, 'utf8');
const baseline = parseWorkflowYaml(workflowText);

function cloneWorkflow() {
  return structuredClone(baseline);
}

function preflightStep(workflow, jobId) {
  return workflow.jobs[jobId].steps.find((step) =>
    typeof step?.run === 'string' && step.run.includes('./tooling/phase5-environment-preflight.ps1'));
}

test('current workflow and a CRLF checkout pass the exact structural audit', () => {
  assert.deepEqual(auditPhase5WorkflowText(workflowText).roles,
    ['LaneA', 'Perf', 'LaneB', 'Release', 'CleanDownload']);
  const crlf = workflowText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '\r\n');
  assert.deepEqual(auditPhase5WorkflowText(crlf).roles,
    ['LaneA', 'Perf', 'LaneB', 'Release', 'CleanDownload']);
});

test('a dead job or dead preflight step is rejected', () => {
  const deadJob = cloneWorkflow();
  deadJob.jobs['phase5-performance'].if = false;
  assert.throws(() => auditPhase5WorkflowDocument(deadJob), /job if condition must be exactly/u);

  const deadStep = cloneWorkflow();
  preflightStep(deadStep, 'phase5-performance').if = false;
  assert.throws(() => auditPhase5WorkflowDocument(deadStep), /must not have a step-level if/u);
});

test('here-string and ordinary string decoys are enumerated but never accepted as executable invocations', () => {
  const hereString = cloneWorkflow();
  hereString.jobs['pr-deterministic'].steps.push({
    shell: 'pwsh',
    run: `$decoy = @'
& ./tooling/phase5-environment-preflight.ps1 \`
  -Mode Formal \`
  -HardwareProfile B \`
  -RunnerRole Release
'@
Write-Host $decoy`
  });
  assert.throws(() => auditPhase5WorkflowDocument(hereString), /occurrence\(s\).*executable invocation/u);

  const stringDecoy = cloneWorkflow();
  stringDecoy.jobs['pr-deterministic'].steps.push({
    shell: 'pwsh',
    run: "Write-Host './tooling/phase5-environment-preflight.ps1 -Mode Formal'"
  });
  assert.throws(() => auditPhase5WorkflowDocument(stringDecoy), /occurrence\(s\).*executable invocation/u);
});

test('a truncated argument set without OutputPath is rejected', () => {
  const workflow = cloneWorkflow();
  const step = preflightStep(workflow, 'lane-a-harness-schedule');
  step.run = step.run.replace(/^\s+-OutputPath[^\n]+\n/mu, '');
  assert.throws(() => auditPhase5WorkflowDocument(workflow), /argument names.*OutputPath/u);
});

test('wrong hardware profile and output binding are rejected', () => {
  const wrongProfile = cloneWorkflow();
  const profileStep = preflightStep(wrongProfile, 'lane-b-preflight');
  profileStep.run = profileStep.run.replace('-HardwareProfile C', '-HardwareProfile B');
  assert.throws(() => auditPhase5WorkflowDocument(wrongProfile), /HardwareProfile must be exactly C/u);

  const wrongOutput = cloneWorkflow();
  const outputStep = preflightStep(wrongOutput, 'protected-release');
  outputStep.run = outputStep.run.replace('environment/release.json', 'environment/performance.json');
  assert.throws(() => auditPhase5WorkflowDocument(wrongOutput), /OutputPath must be exactly/u);
});

test('job-local permissions and step-local current token cannot be satisfied elsewhere', () => {
  const misplacedPermissions = cloneWorkflow();
  misplacedPermissions.permissions = { ...misplacedPermissions.permissions, actions: 'read' };
  delete misplacedPermissions.jobs['lane-b-preflight'].permissions.actions;
  assert.throws(() => auditPhase5WorkflowDocument(misplacedPermissions), /job-local permissions must be exactly/u);

  const excessPermissions = cloneWorkflow();
  excessPermissions.jobs['lane-a-harness-schedule'].permissions['id-token'] = 'write';
  assert.throws(() => auditPhase5WorkflowDocument(excessPermissions), /job-local permissions must be exactly/u);

  const misplacedToken = cloneWorkflow();
  const job = misplacedToken.jobs['lane-b-preflight'];
  job.env.GH_TOKEN = '${{ github.token }}';
  delete preflightStep(misplacedToken, 'lane-b-preflight').env.GH_TOKEN;
  assert.throws(() => auditPhase5WorkflowDocument(misplacedToken), /step GH_TOKEN/u);
});

test('wrong labels/environment and an extra unknown role fail closed', () => {
  const wrongLabels = cloneWorkflow();
  const labelStep = preflightStep(wrongLabels, 'protected-release-clean-download');
  labelStep.run = labelStep.run.replace("@('windows-2022')", "@('self-hosted', 'Windows')");
  assert.throws(() => auditPhase5WorkflowDocument(wrongLabels), /RunnerLabels must be exactly/u);

  const wrongEnvironment = cloneWorkflow();
  wrongEnvironment.jobs['protected-release'].environment = 'phase5-unprotected';
  assert.throws(() => auditPhase5WorkflowDocument(wrongEnvironment), /environment must be exactly phase5-release/u);

  const mismatchedEnvironmentVariable = cloneWorkflow();
  mismatchedEnvironmentVariable.jobs['lane-b-preflight'].env.PHASE5_GITHUB_ENVIRONMENT = 'phase5-release';
  assert.throws(() => auditPhase5WorkflowDocument(mismatchedEnvironmentVariable),
    /PHASE5_GITHUB_ENVIRONMENT must match phase5-lane-b/u);

  const extraRole = cloneWorkflow();
  extraRole.jobs['pr-deterministic'].steps.push({
    shell: 'pwsh',
    env: { GH_TOKEN: '${{ github.token }}' },
    run: `$ErrorActionPreference = 'Stop'
& ./tooling/phase5-environment-preflight.ps1 \`
  -Mode Formal \`
  -HardwareProfile B \`
  -RunnerRole UnsupportedRole \`
  -OutputPath "artifacts/phase5/unsupported.json" \`
  -Repository '\${{ github.repository }}' \`
  -RunnerLabels @('windows-2022')`
  });
  assert.throws(() => auditPhase5WorkflowDocument(extraRole), /exactly 5 executable preflight invocations/u);
});
