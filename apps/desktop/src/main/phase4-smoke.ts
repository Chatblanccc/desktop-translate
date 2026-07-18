import assert from 'node:assert/strict';
import type { SelectionResult } from '@desktop-translate/contracts/native-ipc';
import {
  BAIDU_TRANSLATION_ENDPOINT,
  BaiduTranslationProvider,
  type BaiduTransport,
  type BaiduTransportRequest
} from '@desktop-translate/translation';
import { TranslationController } from './translation/translation-controller.js';

const selection: SelectionResult = {
  selectionId: '11111111-1111-4111-8111-111111111111',
  source: 'uia',
  text: 'architecture',
  ranges: [{ start: 0, end: 12, text: 'architecture' }],
  confidence: 1,
  physicalRects: [{ x: 100, y: 100, width: 120, height: 24 }],
  releasePoint: { x: 220, y: 124 },
  monitor: {
    id: 'DISPLAY1',
    handle: '0x1234',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1
  },
  target: { pid: '4242', hwnd: '0xABCDEF', processName: 'notepad.exe' },
  coordinateSpace: 'physical-px',
  timestamp: '2026-07-16T12:00:00.000Z'
};

let capturedRequest: BaiduTransportRequest | undefined;
const transport: BaiduTransport = {
  async send(request) {
    capturedRequest = request;
    return {
      status: 200,
      body: JSON.stringify({
        from: 'en',
        to: 'zh',
        trans_result: [{ src: 'architecture', dst: '架构' }]
      })
    };
  }
};

const provider = new BaiduTranslationProvider({
  credentials: { appId: 'phase4-smoke-app', secretKey: 'phase4-smoke-key' },
  transport,
  createSalt: () => '123456789'
});

const cards: Array<{ readonly kind: string; readonly translatedText?: string }> = [];
const controller = new TranslationController({
  provider,
  getSettings: () => ({
    enabled: true,
    providerId: 'baidu',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    credentialStatus: 'configured',
    consentVersion: 1
  }),
  presentCard: (card) => cards.push(card),
  hideCard: () => undefined,
  now: () => new Date('2026-07-16T12:00:00.000Z'),
  createRequestId: () => '22222222-2222-4222-8222-222222222222'
});

controller.handleSelection(selection, { x: 100, y: 134, width: 380, height: 320 });
await new Promise<void>((resolve, reject) => {
  const startedAt = Date.now();
  const poll = (): void => {
    if (cards.at(-1)?.kind === 'translated') {
      resolve();
      return;
    }
    if (Date.now() - startedAt > 2_000) {
      reject(new Error('Phase 4 smoke timed out'));
      return;
    }
    setTimeout(poll, 10);
  };
  poll();
});

assert.equal(cards[0]?.kind, 'translating');
assert.deepEqual(cards.at(-1), expectTranslatedCard());
assert.equal(capturedRequest?.url, BAIDU_TRANSLATION_ENDPOINT);
assert.equal(capturedRequest?.method, 'POST');
assert.equal(capturedRequest?.timeoutMs, 8_000);
assert.equal(capturedRequest?.maxResponseBytes, 256 * 1024);
const body = new URLSearchParams(capturedRequest?.body);
assert.equal(body.get('q'), selection.text);
assert.equal(body.get('from'), 'auto');
assert.equal(body.get('to'), 'zh');
assert.equal(body.get('appid'), 'phase4-smoke-app');
assert.equal(body.has('sign'), true);

console.log(JSON.stringify({
  phase: 4,
  provider: provider.id,
  card: cards.at(-1)?.kind,
  outboundFields: [...body.keys()].sort()
}));

function expectTranslatedCard() {
  return {
    kind: 'translated',
    selectionId: selection.selectionId,
    sourceText: selection.text,
    source: selection.source,
    confidence: selection.confidence,
    requestId: '22222222-2222-4222-8222-222222222222',
    translatedText: '架构',
    targetLanguage: 'zh-CN',
    detectedSourceLanguage: 'en',
    attribution: { providerId: 'baidu', providerDisplayName: '百度翻译' },
    fromCache: false
  };
}
