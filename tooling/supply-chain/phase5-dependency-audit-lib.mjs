const severities = ['info', 'low', 'moderate', 'high', 'critical'];

export class AuditReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditReportError';
    this.code = 'AUDIT_ENDPOINT_FAILURE';
  }
}

export function evaluatePnpmAuditReport(report) {
  if (!isRecord(report) || isRecord(report.error)) {
    throw new AuditReportError('The npm advisory endpoint did not return a successful pnpm audit report');
  }
  const reported = report.metadata?.vulnerabilities;
  if (!isRecord(reported)) {
    throw new AuditReportError('The pnpm audit report is missing metadata.vulnerabilities');
  }

  const vulnerabilities = {};
  for (const severity of severities) {
    const value = reported[severity] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AuditReportError(`The pnpm audit report contains an invalid ${severity} count`);
    }
    vulnerabilities[severity] = value;
  }
  vulnerabilities.total = severities.reduce((sum, severity) => sum + vulnerabilities[severity], 0);

  const findings = normalizeFindings(report);
  const blockingFindings = findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical');
  const blockingCount = Math.max(vulnerabilities.high + vulnerabilities.critical, blockingFindings.length);
  return {
    status: blockingCount === 0 ? 'PASS' : 'BLOCKED',
    vulnerabilities,
    blockingCount,
    findings
  };
}

function normalizeFindings(report) {
  const findings = [];
  for (const [key, advisory] of Object.entries(report.advisories ?? {})) {
    if (!isRecord(advisory)) continue;
    findings.push({
      id: String(advisory.id ?? key),
      package: String(advisory.module_name ?? advisory.moduleName ?? 'unknown'),
      severity: normalizeSeverity(advisory.severity),
      title: String(advisory.title ?? 'No advisory title'),
      url: safeHttpsUrl(advisory.url),
      vulnerableVersions: optionalString(advisory.vulnerable_versions),
      patchedVersions: optionalString(advisory.patched_versions),
      paths: normalizePaths(advisory.findings)
    });
  }

  for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    if (!isRecord(vulnerability)) continue;
    const via = Array.isArray(vulnerability.via) ? vulnerability.via.filter(isRecord) : [];
    if (via.length === 0) {
      findings.push({
        id: `package:${packageName}`,
        package: packageName,
        severity: normalizeSeverity(vulnerability.severity),
        title: `Known vulnerability in ${packageName}`,
        url: undefined,
        vulnerableVersions: optionalString(vulnerability.range),
        patchedVersions: undefined,
        paths: normalizeNodePaths(vulnerability.nodes)
      });
      continue;
    }
    for (const advisory of via) {
      findings.push({
        id: String(advisory.source ?? advisory.id ?? `package:${packageName}`),
        package: String(advisory.name ?? advisory.dependency ?? packageName),
        severity: normalizeSeverity(advisory.severity ?? vulnerability.severity),
        title: String(advisory.title ?? `Known vulnerability in ${packageName}`),
        url: safeHttpsUrl(advisory.url),
        vulnerableVersions: optionalString(advisory.range ?? vulnerability.range),
        patchedVersions: undefined,
        paths: normalizeNodePaths(vulnerability.nodes)
      });
    }
  }

  const unique = new Map();
  for (const finding of findings) {
    const normalized = Object.fromEntries(Object.entries(finding).filter(([, value]) => value !== undefined));
    unique.set(`${normalized.id}:${normalized.package}:${normalized.severity}`, normalized);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.severity}:${left.package}:${left.id}`.localeCompare(`${right.severity}:${right.package}:${right.id}`, 'en')
  );
}

function normalizePaths(findings) {
  if (!Array.isArray(findings)) return [];
  const paths = findings.flatMap((finding) => Array.isArray(finding?.paths) ? finding.paths : []);
  return normalizeNodePaths(paths);
}

function normalizeNodePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 500))].sort();
}

function normalizeSeverity(value) {
  const normalized = String(value ?? 'unknown').toLowerCase();
  return severities.includes(normalized) ? normalized : 'unknown';
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
