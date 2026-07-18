import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BAIDU_TRANSLATION_ENDPOINT,
  BAIDU_TRANSPORT_AUDIT_METADATA,
  FetchBaiduTransport,
  type BaiduTransportRequest
} from '@desktop-translate/translation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPhase4AuditTransport,
  Phase4AuditTransport
} from './phase4-audit-transport.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-translate-phase4-audit-'));
  temporaryDirectories.push(directory);
  return directory;
}

function request(secretLiteralPresent = false, includeMetadata = true): BaiduTransportRequest {
  const value: BaiduTransportRequest = {
    url: BAIDU_TRANSLATION_ENDPOINT,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      accept: 'application/json'
    },
    body: new URLSearchParams([
      ['q', 'private source text'],
      ['from', 'auto'],
      ['to', 'zh'],
      ['appid', 'private-app-id'],
      ['salt', '1435660288'],
      ['sign', '0123456789abcdef0123456789abcdef']
    ]).toString(),
    signal: new AbortController().signal,
    timeoutMs: 8_000,
    maxResponseBytes: 256 * 1024
  };
  if (includeMetadata) {
    Object.defineProperty(value, BAIDU_TRANSPORT_AUDIT_METADATA, {
      value: Object.freeze({ secretLiteralPresent }),
      enumerable: false
    });
  }
  return value;
}

function realTransport() {
  const fetch = vi.fn(async () => new Response('private response body', { status: 200 }));
  return { fetch, transport: new FetchBaiduTransport({ fetch }) };
}

describe('Phase 4 real transport audit', () => {
  it('is completely absent when the validation environment path is not configured', async () => {
    const directory = await temporaryDirectory();
    const auditPath = join(directory, 'audit.jsonl');

    expect(createPhase4AuditTransport(undefined)).toBeUndefined();
    await expect(access(auditPath)).rejects.toThrow();
  });

  it('writes only the allowlisted derived JSONL fields before delegating the same request', async () => {
    const directory = await temporaryDirectory();
    const auditPath = join(directory, 'audit.jsonl');
    const { fetch, transport } = realTransport();
    const send = vi.spyOn(transport, 'send');
    const audit = new Phase4AuditTransport({
      filePath: auditPath,
      transport,
      runId: '00000000-0000-4000-8000-000000000004',
      now: () => new Date('2026-07-18T12:34:56.789Z'),
      pid: 4242
    });
    const outbound = request(false);

    await expect(audit.send(outbound)).resolves.toEqual({
      status: 200,
      body: 'private response body'
    });
    await audit.close();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(outbound);
    expect(fetch).toHaveBeenCalledOnce();
    const text = await readFile(auditPath, 'utf8');
    const lines = text.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'PID',
      'UTC',
      'appIdLength',
      'appIdPresent',
      'fieldNames',
      'forbiddenFields',
      'headerNames',
      'host',
      'method',
      'path',
      'port',
      'qUtf8Bytes',
      'queryPresent',
      'requestCount',
      'runId',
      'saltDigits',
      'scheme',
      'secretLiteralPresent',
      'signHex32'
    ].sort());
    expect(record).toEqual({
      runId: '00000000-0000-4000-8000-000000000004',
      UTC: '2026-07-18T12:34:56.789Z',
      PID: 4242,
      scheme: 'https',
      host: 'fanyi-api.baidu.com',
      path: '/api/trans/vip/translate',
      port: '443',
      queryPresent: false,
      method: 'POST',
      headerNames: ['accept', 'content-type'],
      fieldNames: ['appid', 'from', 'q', 'salt', 'sign', 'to'],
      qUtf8Bytes: Buffer.byteLength('private source text', 'utf8'),
      appIdPresent: true,
      appIdLength: 'private-app-id'.length,
      saltDigits: true,
      signHex32: true,
      forbiddenFields: [],
      secretLiteralPresent: false,
      requestCount: 1
    });
    for (const forbiddenValue of [
      'private source text',
      'private-app-id',
      '1435660288',
      '0123456789abcdef0123456789abcdef',
      'private response body'
    ]) {
      expect(text).not.toContain(forbiddenValue);
    }
  });

  it('appends request counts while retaining only the derived secret-presence boolean', async () => {
    const directory = await temporaryDirectory();
    const auditPath = join(directory, 'audit.jsonl');
    const { transport } = realTransport();
    const audit = new Phase4AuditTransport({ filePath: auditPath, transport });

    await audit.send(request(false));
    await audit.send(request(true));
    await audit.close();

    const records = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(({ requestCount, secretLiteralPresent }) => ({
      requestCount,
      secretLiteralPresent
    }))).toEqual([
      { requestCount: 1, secretLiteralPresent: false },
      { requestCount: 2, secretLiteralPresent: true }
    ]);
    expect(records[0]?.runId).toBe(records[1]?.runId);
  });

  it.each([
    {
      name: 'a relative target',
      path: 'relative-phase4-audit.jsonl',
      includeMetadata: true,
      reason: 'invalid-path'
    },
    {
      name: 'a drive-ambiguous rooted target',
      path: '\\rooted-phase4-audit.jsonl',
      includeMetadata: true,
      reason: 'invalid-path'
    },
    {
      name: 'missing provider audit metadata',
      path: undefined,
      includeMetadata: false,
      reason: 'missing-request-metadata'
    },
    {
      name: 'an unwritable target',
      path: undefined,
      includeMetadata: true,
      reason: 'write-failed'
    }
  ] as const)('disables audit without logging or changing the real request for $name', async (fixture) => {
    const directory = await temporaryDirectory();
    const auditPath = fixture.path
      ?? (fixture.reason === 'write-failed'
        ? join(directory, 'missing-parent', 'audit.jsonl')
        : join(directory, 'audit.jsonl'));
    const { transport } = realTransport();
    const send = vi.spyOn(transport, 'send');
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ];
    const audit = new Phase4AuditTransport({ filePath: auditPath, transport });
    const outbound = request(false, fixture.includeMetadata);

    await expect(audit.send(outbound)).resolves.toMatchObject({ status: 200 });
    await audit.close();

    expect(send).toHaveBeenCalledWith(outbound);
    expect(audit.getState()).toMatchObject({
      status: 'disabled',
      requestCount: 1,
      reason: fixture.reason
    });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
