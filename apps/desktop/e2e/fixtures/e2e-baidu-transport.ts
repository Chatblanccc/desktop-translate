import { appendFileSync } from 'node:fs';
import {
  BAIDU_TRANSLATION_ENDPOINT,
  type BaiduTransport,
  type BaiduTransportRequest,
  type BaiduTransportResponse
} from '@desktop-translate/translation';

export type E2eBaiduTransportMode = 'block' | 'baidu-success';

export interface E2eBaiduTransportOptions {
  readonly mode: E2eBaiduTransportMode;
  readonly tracePath: string;
}

/**
 * Main-process-only transport used by Electron E2E. It records metadata only:
 * neither credentials nor selected text are persisted in the trace.
 */
export function createE2eBaiduTransport(options: E2eBaiduTransportOptions): BaiduTransport {
  return Object.freeze({
    async send(request: BaiduTransportRequest): Promise<BaiduTransportResponse> {
      if (options.mode === 'block') {
        appendTrace(options.tracePath, {
          kind: 'blocked',
          url: request.url,
          method: request.method
        });
        throw new Error('E2E transport blocked an unexpected Main-process request');
      }

      const body = new URLSearchParams(request.body);
      const query = body.get('q') ?? '';
      const sourceLanguage = body.get('from') ?? '';
      const targetLanguage = body.get('to') ?? '';
      const appId = body.get('appid') ?? '';
      const signature = body.get('sign') ?? '';
      const requestIsValid =
        request.url === BAIDU_TRANSLATION_ENDPOINT
        && request.method === 'POST'
        && request.headers['content-type'] === 'application/x-www-form-urlencoded;charset=UTF-8'
        && query.length > 0
        && (sourceLanguage === 'auto' || sourceLanguage === 'en')
        && targetLanguage === 'zh'
        && appId.length > 0
        && /^[a-f0-9]{32}$/u.test(signature);

      appendTrace(options.tracePath, {
        kind: requestIsValid ? 'baidu-request' : 'invalid-baidu-request',
        method: request.method,
        sourceLanguage,
        targetLanguage,
        queryBytes: new TextEncoder().encode(query).byteLength,
        appIdPresent: appId.length > 0,
        signatureShapeValid: /^[a-f0-9]{32}$/u.test(signature)
      });

      if (!requestIsValid) {
        return { status: 400, body: JSON.stringify({ error_code: '54000' }) };
      }
      return {
        status: 200,
        body: JSON.stringify({
          from: 'en',
          to: 'zh',
          trans_result: [{ src: query, dst: `E2E translated (${query.length})` }]
        })
      };
    }
  });
}

function appendTrace(path: string, value: Readonly<Record<string, unknown>>): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}
