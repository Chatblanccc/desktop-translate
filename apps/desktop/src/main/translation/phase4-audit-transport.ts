import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  BAIDU_TRANSPORT_AUDIT_METADATA,
  FetchBaiduTransport,
  type BaiduTransportRequest,
  type BaiduTransportResponse
} from '@desktop-translate/translation';

export const PHASE4_AUDIT_FILE_ENV = 'DESKTOP_TRANSLATE_PHASE4_AUDIT_FILE';

const ALLOWED_FORM_FIELDS = new Set(['appid', 'from', 'q', 'salt', 'sign', 'to']);

export type Phase4AuditDisabledReason =
  | 'invalid-path'
  | 'missing-request-metadata'
  | 'record-failed'
  | 'write-failed';

export interface Phase4AuditState {
  readonly status: 'enabled' | 'disabled';
  readonly runId: string;
  readonly requestCount: number;
  readonly reason?: Phase4AuditDisabledReason;
}

interface Phase4AuditRecord {
  readonly runId: string;
  readonly UTC: string;
  readonly PID: number;
  readonly scheme: string;
  readonly host: string;
  readonly path: string;
  readonly port: string;
  readonly queryPresent: boolean;
  readonly method: string;
  readonly headerNames: readonly string[];
  readonly fieldNames: readonly string[];
  readonly qUtf8Bytes: number;
  readonly appIdPresent: boolean;
  readonly appIdLength: number;
  readonly saltDigits: boolean;
  readonly signHex32: boolean;
  readonly forbiddenFields: readonly string[];
  readonly secretLiteralPresent: boolean;
  readonly requestCount: number;
}

export interface Phase4AuditTransportOptions {
  readonly filePath: string;
  readonly transport?: FetchBaiduTransport;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly pid?: number;
}

/** Main-process-only validation wrapper. It never records field values or bodies. */
export class Phase4AuditTransport {
  readonly #filePath: string;
  readonly #transport: FetchBaiduTransport;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #pid: number;
  #disabledReason: Phase4AuditDisabledReason | undefined;
  #requestCount = 0;
  #handle: FileHandle | undefined;
  #needsSeparator = false;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: Phase4AuditTransportOptions) {
    this.#filePath = options.filePath;
    this.#transport = options.transport ?? new FetchBaiduTransport();
    this.#runId = options.runId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
    this.#pid = options.pid ?? process.pid;
    if (!isSafeAbsoluteFilePath(this.#filePath)) this.#disabledReason = 'invalid-path';
  }

  public getState(): Phase4AuditState {
    return Object.freeze({
      status: this.#disabledReason === undefined ? 'enabled' : 'disabled',
      runId: this.#runId,
      requestCount: this.#requestCount,
      ...(this.#disabledReason === undefined ? {} : { reason: this.#disabledReason })
    });
  }

  public async send(request: BaiduTransportRequest): Promise<BaiduTransportResponse> {
    this.#requestCount += 1;
    const requestCount = this.#requestCount;
    if (this.#disabledReason === undefined) {
      const metadata = request[BAIDU_TRANSPORT_AUDIT_METADATA];
      if (metadata === undefined) {
        await this.#disable('missing-request-metadata');
      } else {
        let record: Phase4AuditRecord | undefined;
        try {
          record = createAuditRecord(
            request,
            metadata.secretLiteralPresent,
            this.#runId,
            this.#now().toISOString(),
            this.#pid,
            requestCount
          );
        } catch {
          await this.#disable('record-failed');
        }
        if (record !== undefined) await this.#append(record);
      }
    }
    return this.#transport.send(request);
  }

  public async close(): Promise<void> {
    await this.#writeQueue;
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close().catch(() => undefined);
  }

  async #append(record: Phase4AuditRecord): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      if (this.#disabledReason !== undefined) return;
      try {
        const handle = await this.#getHandle();
        const prefix = this.#needsSeparator ? '\n' : '';
        this.#needsSeparator = false;
        await handle.appendFile(`${prefix}${JSON.stringify(record)}\n`, 'utf8');
        await handle.datasync();
      } catch {
        await this.#disable('write-failed');
      }
    });
    await this.#writeQueue;
  }

  async #getHandle(): Promise<FileHandle> {
    if (this.#handle !== undefined) return this.#handle;
    const flags = constants.O_APPEND
      | constants.O_CREAT
      | constants.O_RDWR
      | constants.O_NOFOLLOW;
    const handle = await open(this.#filePath, flags, 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new TypeError('Phase 4 audit target must be a regular file');
      if (stats.size > 0) {
        const finalByte = Buffer.alloc(1);
        const result = await handle.read(finalByte, 0, 1, stats.size - 1);
        this.#needsSeparator = result.bytesRead === 1 && finalByte[0] !== 0x0a;
      }
      this.#handle = handle;
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #disable(reason: Phase4AuditDisabledReason): Promise<void> {
    if (this.#disabledReason !== undefined) return;
    this.#disabledReason = reason;
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close().catch(() => undefined);
  }
}

export function createPhase4AuditTransport(
  filePath: string | undefined
): Phase4AuditTransport | undefined {
  if (filePath === undefined) return undefined;
  return new Phase4AuditTransport({ filePath });
}

function createAuditRecord(
  request: BaiduTransportRequest,
  secretLiteralPresent: boolean,
  runId: string,
  UTC: string,
  PID: number,
  requestCount: number
): Phase4AuditRecord {
  const url = new URL(request.url);
  const params = new URLSearchParams(request.body);
  const fieldNames = [...params.keys()].sort();
  const headerNames = Object.keys(request.headers).map((name) => name.toLowerCase()).sort();
  const appId = params.get('appid');
  const salt = params.get('salt');
  const sign = params.get('sign');
  return Object.freeze({
    runId,
    UTC,
    PID,
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    path: url.pathname,
    port: url.port || (url.protocol === 'https:' ? '443' : ''),
    queryPresent: url.search.length > 0,
    method: request.method,
    headerNames: Object.freeze(headerNames),
    fieldNames: Object.freeze(fieldNames),
    qUtf8Bytes: Buffer.byteLength(params.get('q') ?? '', 'utf8'),
    appIdPresent: appId !== null && appId.length > 0,
    appIdLength: appId?.length ?? 0,
    saltDigits: salt !== null && /^\d{1,32}$/u.test(salt),
    signHex32: sign !== null && /^[0-9a-f]{32}$/u.test(sign),
    forbiddenFields: Object.freeze(
      fieldNames.filter((fieldName) => !ALLOWED_FORM_FIELDS.has(fieldName))
    ),
    secretLiteralPresent,
    requestCount
  });
}

function isSafeAbsoluteFilePath(filePath: string): boolean {
  if (!isAbsolute(filePath) || filePath.includes('\0')) return false;
  if (process.platform !== 'win32') return true;
  if (!/^[a-z]:[\\/]/iu.test(filePath)) return false;
  const normalized = filePath.replaceAll('/', '\\');
  return !normalized.slice(2).includes(':');
}
