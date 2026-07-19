import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArguments,
  requiredArgument,
  sha256File,
  writeJson
} from './phase5-supply-chain-lib.mjs';
import {
  AuditReportError,
  evaluatePnpmAuditReport
} from './phase5-dependency-audit-lib.mjs';

const registry = 'https://registry.npmjs.org/';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const outputPath = requiredArgument(args, '--output');
if (args.size !== 1) throw new Error('Only --output is accepted; the official npm registry and severity policy cannot be overridden');

const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  windowsHide: true
}).trim();
const commandArguments = [
  `--config.userconfig=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  `--registry=${registry}`,
  'audit',
  '--json',
  '--audit-level',
  'high'
];
const result = runPnpmAudit(commandArguments);

let report;
let evaluation;
let endpointFailure;
try {
  if (result.error || typeof result.stdout !== 'string' || result.stdout.trim().length === 0) {
    throw new AuditReportError('pnpm audit did not return JSON evidence');
  }
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new AuditReportError('pnpm audit returned malformed JSON');
  }
  evaluation = evaluatePnpmAuditReport(report);
  if (result.status !== 0 && evaluation.status === 'PASS') {
    throw new AuditReportError('pnpm audit exited unsuccessfully without reporting a blocking vulnerability');
  }
} catch (error) {
  endpointFailure = error instanceof AuditReportError
    ? error
    : new AuditReportError('The npm advisory endpoint could not be evaluated safely');
}

const generatedAt = new Date().toISOString();
const common = {
  schemaVersion: 1,
  generatedAt,
  gitSha,
  lockfile: {
    path: 'pnpm-lock.yaml',
    sha256: await sha256File(join(workspaceRoot, 'pnpm-lock.yaml'))
  },
  registry,
  command: {
    executable: 'pnpm',
    arguments: commandArguments
  },
  policy: {
    blockedSeverities: ['high', 'critical'],
    endpointFailure: 'BLOCK'
  }
};

if (endpointFailure) {
  await writeJson(outputPath, {
    ...common,
    status: 'BLOCKED',
    endpoint: {
      status: 'FAILED',
      processExitCode: result.status,
      errorCode: endpointFailure.code
    },
    gateReasons: ['Official npm advisory endpoint failure blocks the formal Phase 5 gate.']
  });
  console.error(`[phase5:audit] BLOCKED: ${endpointFailure.message}`);
  process.exitCode = 1;
} else {
  const gateReasons = evaluation.status === 'PASS'
    ? []
    : [`${evaluation.blockingCount} Critical/High vulnerability finding(s) block the formal Phase 5 gate.`];
  await writeJson(outputPath, {
    ...common,
    status: evaluation.status,
    endpoint: {
      status: 'PASS',
      processExitCode: result.status
    },
    vulnerabilities: evaluation.vulnerabilities,
    findings: evaluation.findings,
    gateReasons,
    report
  });
  if (evaluation.status === 'BLOCKED') {
    console.error(`[phase5:audit] BLOCKED: ${gateReasons[0]}`);
    process.exitCode = 1;
  } else {
    console.log(`[phase5:audit] PASS: official npm audit reports 0 Critical and 0 High vulnerabilities; evidence=${outputPath}`);
  }
}

function runPnpmAudit(pnpmArguments) {
  const environment = sanitizedEnvironment();
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm ${pnpmArguments.join(' ')}`], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: environment
    });
  }
  return spawnSync('pnpm', pnpmArguments, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: environment
  });
}

function sanitizedEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)$/iu.test(key)) continue;
    if (/^npm_config_.*(?:auth|token|userconfig)/iu.test(key)) continue;
    environment[key] = value;
  }
  environment.npm_config_registry = registry;
  return environment;
}
