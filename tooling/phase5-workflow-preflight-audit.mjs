import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

const preflightFilePattern = /phase5-environment-preflight\.ps1/giu;
const currentToken = '${{ github.token }}';
const repositoryExpression = "'${{ github.repository }}'";
const evidencePrefix = '"artifacts/phase5/${{ github.sha }}/${{ github.run_id }}-${{ github.run_attempt }}/environment/';

const formalJobs = Object.freeze({
  'lane-a-harness-schedule': jobPolicy({
    role: 'LaneA',
    profile: 'B',
    condition: "github.event_name == 'workflow_dispatch' && inputs.run_lane_a_harness",
    runsOn: ['self-hosted', 'Windows', 'X64', 'phase5-lab'],
    labels: "@('self-hosted', 'Windows', 'X64', 'phase5-lab')",
    output: `${evidencePrefix}lane-a.json"`,
    runnerBinding: ['PHASE5_LAB_RUNNER_ID', '${{ vars.PHASE5_LAB_RUNNER_ID }}'],
    exclusive: true
  }),
  'phase5-performance': jobPolicy({
    role: 'Perf',
    profile: 'B',
    condition: "github.event_name == 'workflow_dispatch' && inputs.run_phase5_performance && startsWith(github.ref, 'refs/tags/phase5-rc-')",
    runsOn: ['self-hosted', 'Windows', 'X64', 'phase5-lab'],
    labels: "@('self-hosted', 'Windows', 'X64', 'phase5-lab')",
    output: `${evidencePrefix}performance.json"`,
    runnerBinding: ['PHASE5_LAB_RUNNER_ID', '${{ vars.PHASE5_LAB_RUNNER_ID }}'],
    exclusive: true
  }),
  'lane-b-preflight': jobPolicy({
    role: 'LaneB',
    profile: 'C',
    condition: "github.event_name == 'workflow_dispatch' && inputs.run_lane_b_preflight && startsWith(github.ref, 'refs/tags/phase5-rc-')",
    runsOn: ['self-hosted', 'Windows', 'X64', 'phase5-lane-b'],
    labels: "@('self-hosted', 'Windows', 'X64', 'phase5-lane-b')",
    output: `${evidencePrefix}lane-b.json"`,
    environment: 'phase5-lane-b',
    runnerBinding: ['PHASE5_LANE_B_RUNNER_ID', '${{ secrets.PHASE5_LANE_B_RUNNER_ID }}'],
    expectedPublisher: true,
    exclusive: true
  }),
  'protected-release': jobPolicy({
    role: 'Release',
    profile: 'B',
    condition: "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/phase5-rc-')",
    runsOn: ['self-hosted', 'Windows', 'X64', 'phase5-release'],
    labels: "@('self-hosted', 'Windows', 'X64', 'phase5-release')",
    output: `${evidencePrefix}release.json"`,
    environment: 'phase5-release',
    runnerBinding: ['PHASE5_RELEASE_RUNNER_ID', '${{ secrets.PHASE5_RELEASE_RUNNER_ID }}'],
    expectedPublisher: true,
    exclusive: true
  }),
  'protected-release-clean-download': jobPolicy({
    role: 'CleanDownload',
    profile: 'B',
    condition: "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/phase5-rc-')",
    runsOn: 'windows-2022',
    labels: "@('windows-2022')",
    output: `${evidencePrefix}clean-download.json"`,
    environment: 'phase5-release',
    expectedPublisher: true,
    exclusive: false
  })
});

function jobPolicy(value) {
  const permissions = value.role === 'Release'
    ? {
        actions: 'read',
        contents: 'read',
        'id-token': 'write',
        attestations: 'write',
        'artifact-metadata': 'write'
      }
    : { actions: 'read', contents: 'read' };
  return Object.freeze({ ...value, permissions: Object.freeze(permissions) });
}

function fail(message) {
  throw new Error(`Phase 5 workflow preflight audit failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function scalarOccurrenceCount(value, seen = new Set()) {
  if (typeof value === 'string') return value.match(preflightFilePattern)?.length ?? 0;
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) fail('YAML aliases are not allowed in the audited workflow structure');
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((total, child) => total + scalarOccurrenceCount(child, seen), 0);
}

function parseRunInvocations(run, jobId, stepIndex) {
  if (typeof run !== 'string') return [];
  const lines = run.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const invocations = [];
  let hereStringQuote;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (hereStringQuote) {
      if (trimmed === `${hereStringQuote}@`) hereStringQuote = undefined;
      continue;
    }
    const hereStringStart = trimmed.match(/@(['"])\s*$/u);
    if (hereStringStart) {
      hereStringQuote = hereStringStart[1];
      continue;
    }
    if (!/^&[ \t]+\.[\\/]tooling[\\/]phase5-environment-preflight\.ps1[ \t]+`[ \t]*$/iu.test(trimmed)) {
      continue;
    }

    const startLine = index;
    const args = Object.create(null);
    let hasContinuation = true;
    while (hasContinuation) {
      index += 1;
      if (index >= lines.length) {
        fail(`${jobId} step ${stepIndex} has a truncated preflight invocation after line ${startLine + 1}`);
      }
      const argumentLine = lines[index].trim();
      hasContinuation = /`[ \t]*$/u.test(argumentLine);
      const withoutContinuation = argumentLine.replace(/[ \t]*`[ \t]*$/u, '').trim();
      const argument = withoutContinuation.match(/^-([A-Za-z][A-Za-z0-9]*)(?:[ \t]+(.+))?$/u);
      if (!argument) {
        fail(`${jobId} step ${stepIndex} has an unparseable preflight argument on line ${index + 1}`);
      }
      const [, name, rawValue] = argument;
      if (own(args, name)) fail(`${jobId} step ${stepIndex} repeats preflight argument -${name}`);
      args[name] = rawValue ?? null;
    }
    invocations.push({ args, startLine, endLine: index, jobId, stepIndex });
  }
  return invocations;
}

function collectParsedInvocations(workflow) {
  const invocations = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    assert(job && typeof job === 'object' && !Array.isArray(job), `job ${jobId} must be a mapping`);
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, stepIndex) => {
      if (step && typeof step === 'object' && !Array.isArray(step)) {
        invocations.push(...parseRunInvocations(step.run, jobId, stepIndex));
      }
    });
  }
  return invocations;
}

function expectedArguments(policy) {
  const args = {
    Mode: 'Formal',
    HardwareProfile: policy.profile,
    RunnerRole: policy.role,
    OutputPath: policy.output,
    Repository: repositoryExpression,
    RunnerLabels: policy.labels
  };
  if (policy.expectedPublisher) args.ExpectedPublisherSubject = '$env:PHASE5_EXPECTED_SIGNING_SUBJECT';
  if (policy.environment) args.CurrentGitHubEnvironment = policy.environment;
  if (policy.exclusive) {
    args.ExclusiveInteractiveSession = null;
    args.ForegroundInputExclusive = null;
  }
  return args;
}

function assertExactArguments(actual, expected, jobId) {
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  assert(JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `${jobId} preflight argument names must be exactly [${expectedNames.join(', ')}], got [${actualNames.join(', ')}]`);
  for (const name of expectedNames) {
    assert(actual[name] === expected[name],
      `${jobId} preflight -${name} must be exactly ${String(expected[name])}`);
  }
}

function assertDedicatedExecutableStep(step, invocation, jobId) {
  assert(step.shell === 'pwsh', `${jobId} preflight step shell must be exactly pwsh`);
  assert(!own(step, 'if'), `${jobId} preflight step must not have a step-level if condition`);
  assert(step.env && typeof step.env === 'object' && !Array.isArray(step.env),
    `${jobId} preflight step must have its own env mapping`);
  assert(step.env.GH_TOKEN === currentToken,
    `${jobId} preflight step GH_TOKEN must be exactly the current github.token`);

  const lines = step.run.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const before = lines.slice(0, invocation.startLine).map((line) => line.trim()).filter(Boolean);
  const after = lines.slice(invocation.endLine + 1).map((line) => line.trim()).filter(Boolean);
  assert(JSON.stringify(before) === JSON.stringify(["$ErrorActionPreference = 'Stop'"]),
    `${jobId} preflight step must execute immediately after the fail-closed error preference`);
  assert(after.length === 0, `${jobId} preflight step must be dedicated to one executable preflight invocation`);
}

function assertRunsOn(actual, expected, jobId) {
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected),
      `${jobId} runs-on labels must be exactly [${expected.join(', ')}]`);
    return;
  }
  assert(actual === expected, `${jobId} runs-on must be exactly ${expected}`);
}

function assertFormalJob(workflow, parsedInvocations, jobId, policy) {
  const job = workflow.jobs[jobId];
  assert(job && typeof job === 'object' && !Array.isArray(job), `required formal job ${jobId} is missing`);
  assert(job.if === policy.condition, `${jobId} job if condition must be exactly ${policy.condition}`);
  assert(job.if !== false && String(job.if).trim().toLowerCase() !== 'false', `${jobId} job is statically dead`);
  assertRunsOn(job['runs-on'], policy.runsOn, jobId);

  if (policy.environment) {
    assert(job.environment === policy.environment, `${jobId} environment must be exactly ${policy.environment}`);
    assert(job.env && job.env.PHASE5_GITHUB_ENVIRONMENT === policy.environment,
      `${jobId} job env PHASE5_GITHUB_ENVIRONMENT must match ${policy.environment}`);
  } else {
    assert(!own(job, 'environment'), `${jobId} must not declare a protected environment`);
  }
  assert(job.permissions && typeof job.permissions === 'object' && !Array.isArray(job.permissions),
    `${jobId} must declare job-local permissions`);
  const actualPermissions = Object.entries(job.permissions).sort(([left], [right]) => left.localeCompare(right));
  const expectedPermissions = Object.entries(policy.permissions).sort(([left], [right]) => left.localeCompare(right));
  assert(JSON.stringify(actualPermissions) === JSON.stringify(expectedPermissions),
    `${jobId} job-local permissions must be exactly ${JSON.stringify(Object.fromEntries(expectedPermissions))}`);
  if (policy.runnerBinding) {
    const [name, value] = policy.runnerBinding;
    assert(job.env && job.env[name] === value, `${jobId} job env ${name} must be exactly ${value}`);
  }

  const jobInvocations = parsedInvocations.filter((item) => item.jobId === jobId);
  assert(jobInvocations.length === 1, `${jobId} must contain exactly one parsed executable preflight invocation`);
  const invocation = jobInvocations[0];
  const step = job.steps[invocation.stepIndex];
  assertDedicatedExecutableStep(step, invocation, jobId);
  assertExactArguments(invocation.args, expectedArguments(policy), jobId);
}

export function parseWorkflowYaml(workflowText) {
  let workflow;
  try {
    workflow = load(workflowText);
  } catch (error) {
    fail(`workflow YAML could not be parsed: ${error.message}`);
  }
  assert(workflow && typeof workflow === 'object' && !Array.isArray(workflow), 'workflow root must be a mapping');
  assert(workflow.jobs && typeof workflow.jobs === 'object' && !Array.isArray(workflow.jobs), 'workflow jobs must be a mapping');
  return workflow;
}

export function auditPhase5WorkflowDocument(workflow) {
  const rawOccurrences = scalarOccurrenceCount(workflow);
  const parsedInvocations = collectParsedInvocations(workflow);
  assert(rawOccurrences === parsedInvocations.length,
    `found ${rawOccurrences} preflight path occurrence(s) but only ${parsedInvocations.length} executable invocation(s)`);
  assert(parsedInvocations.length === Object.keys(formalJobs).length,
    `workflow must contain exactly ${Object.keys(formalJobs).length} executable preflight invocations`);
  for (const invocation of parsedInvocations) {
    assert(own(formalJobs, invocation.jobId),
      `unexpected preflight invocation in job ${invocation.jobId}`);
  }
  for (const [jobId, policy] of Object.entries(formalJobs)) {
    assertFormalJob(workflow, parsedInvocations, jobId, policy);
  }
  return {
    status: 'PASS',
    jobIds: Object.keys(formalJobs),
    roles: Object.values(formalJobs).map((policy) => policy.role)
  };
}

export function auditPhase5WorkflowText(workflowText) {
  return auditPhase5WorkflowDocument(parseWorkflowYaml(workflowText));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--workflow') {
    throw new Error('Usage: node phase5-workflow-preflight-audit.mjs --workflow <phase5-windows.yml>');
  }
  const workflowPath = resolve(args[1]);
  const result = auditPhase5WorkflowText(await readFile(workflowPath, 'utf8'));
  console.log(`[phase5:environment-preflight:workflow] ${result.status}: ${result.roles.join(', ')}`);
}
