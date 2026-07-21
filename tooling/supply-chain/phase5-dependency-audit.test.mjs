import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuditReportError,
  evaluatePnpmAuditReport
} from './phase5-dependency-audit-lib.mjs';

test('passes when the official report has no Critical or High vulnerabilities', () => {
  const result = evaluatePnpmAuditReport(reportWithCounts({ low: 2, moderate: 1 }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.blockingCount, 0);
  assert.deepEqual(result.vulnerabilities, {
    info: 0,
    low: 2,
    moderate: 1,
    high: 0,
    critical: 0,
    total: 3
  });
});

test('blocks Critical and High findings and normalizes advisory evidence', () => {
  const report = reportWithCounts({ high: 1, critical: 1 });
  report.advisories = {
    1234: {
      id: 1234,
      module_name: 'unsafe-package',
      severity: 'high',
      title: 'Synthetic high-severity advisory',
      url: 'https://github.com/advisories/GHSA-test-test-test',
      vulnerable_versions: '<2.0.0',
      patched_versions: '>=2.0.0',
      findings: [{ paths: ['root>unsafe-package'] }]
    }
  };
  const result = evaluatePnpmAuditReport(report);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blockingCount, 2);
  assert.equal(result.findings[0].package, 'unsafe-package');
  assert.equal(result.findings[0].severity, 'high');
});

test('fails closed when the endpoint response lacks vulnerability metadata', () => {
  assert.throws(
    () => evaluatePnpmAuditReport({ error: { code: 'E500' } }),
    (error) => error instanceof AuditReportError && error.code === 'AUDIT_ENDPOINT_FAILURE'
  );
  assert.throws(
    () => evaluatePnpmAuditReport({ advisories: {} }),
    (error) => error instanceof AuditReportError && error.code === 'AUDIT_ENDPOINT_FAILURE'
  );
});

test('blocks a High advisory even if endpoint summary counts are inconsistent', () => {
  const report = reportWithCounts();
  report.advisories = {
    9999: {
      id: 9999,
      module_name: 'inconsistent-package',
      severity: 'high',
      title: 'Synthetic inconsistent advisory',
      url: 'https://github.com/advisories/GHSA-test-test-test'
    }
  };
  const result = evaluatePnpmAuditReport(report);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blockingCount, 1);
});

function reportWithCounts(overrides = {}) {
  return {
    actions: [],
    advisories: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        ...overrides
      }
    }
  };
}
