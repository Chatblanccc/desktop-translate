import { describe, expect, it, vi } from 'vitest';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import type { SelectionResult } from '@desktop-translate/contracts/native-ipc';
import {
  TranslationProviderError,
  type TranslationProvider
} from '@desktop-translate/translation';
import { TranslationController } from './translation-controller.js';

const selection: SelectionResult = {
  selectionId: '123e4567-e89b-42d3-a456-426614174000',
  source: 'uia',
  text: ' architecture ',
  ranges: [{ start: 1, end: 13, text: 'architecture' }],
  confidence: 1,
  physicalRects: [{ x: 10, y: 20, width: 100, height: 20 }],
  releasePoint: { x: 110, y: 40 },
  monitor: {
    id: 'DISPLAY1',
    handle: '0x1234',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1
  },
  target: { pid: '100', hwnd: '0xABCD', processName: 'notepad.exe' },
  coordinateSpace: 'physical-px',
  timestamp: '2026-07-16T12:00:00.000Z'
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function createHarness(enabled = true, requestTimeoutMs = 8_000) {
  const requests: Array<ReturnType<typeof deferred<Awaited<ReturnType<TranslationProvider['translate']>>>>> = [];
  const signals: AbortSignal[] = [];
  const provider: TranslationProvider = {
    id: 'baidu',
    displayName: '百度翻译',
    capabilities: {
      translation: true,
      languageDetection: true,
      dictionary: false,
      pronunciation: false,
      examples: false,
      maxTextLength: 6_000
    },
    translate: vi.fn((_request, context) => {
      const pending = deferred<Awaited<ReturnType<TranslationProvider['translate']>>>();
      signals.push(context.signal);
      requests.push(pending);
      return pending.promise;
    })
  };
  const cards: SelectionCardViewModel[] = [];
  const settings = {
    enabled,
    providerId: 'baidu',
    sourceLanguage: 'auto' as const,
    targetLanguage: 'zh-CN',
    credentialStatus: 'configured' as const,
    consentVersion: 1
  };
  const hideCard = vi.fn();
  let requestNumber = 0;
  const controller = new TranslationController({
    provider,
    getSettings: () => settings,
    presentCard: (card) => cards.push(card),
    hideCard,
    now: () => new Date('2026-07-16T12:00:00.000Z'),
    createRequestId: () => `123e4567-e89b-42d3-a456-42661417410${requestNumber++}`,
    requestTimeoutMs
  });
  return { controller, provider, requests, signals, cards, hideCard, settings };
}

describe('TranslationController', () => {
  it('keeps the Phase 3 source-only path when translation is disabled', () => {
    const harness = createHarness(false);
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    expect(harness.cards.at(-1)).toMatchObject({ kind: 'source-only', sourceText: selection.text });
    expect(harness.provider.translate).not.toHaveBeenCalled();
  });

  it('presents loading then a matching translated result', async () => {
    const harness = createHarness();
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    expect(harness.cards.at(-1)).toMatchObject({ kind: 'translating' });
    const call = vi.mocked(harness.provider.translate).mock.calls[0]?.[0];
    expect(call?.text).toBe('architecture');
    harness.requests[0]?.resolve({
      requestId: call!.requestId,
      selectionId: selection.selectionId,
      originalText: 'architecture',
      translatedText: '架构',
      detectedSourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      attribution: { providerId: 'baidu', providerDisplayName: '百度翻译' },
      receivedAt: '2026-07-16T12:00:00.000Z',
      fromCache: false
    });
    await vi.waitFor(() => expect(harness.cards.at(-1)).toMatchObject({
      kind: 'translated',
      translatedText: '架构'
    }));
  });

  it('aborts the old request and ignores its late result when a new selection arrives', async () => {
    const harness = createHarness();
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    const firstCall = vi.mocked(harness.provider.translate).mock.calls[0]![0];
    const next = { ...selection, selectionId: '123e4567-e89b-42d3-a456-426614174001', text: 'system' };
    harness.controller.handleSelection(next, { x: 2, y: 3, width: 380, height: 320 });
    expect(harness.signals[0]?.aborted).toBe(true);
    const secondCall = vi.mocked(harness.provider.translate).mock.calls[1]![0];
    harness.requests[0]?.resolve({
      requestId: firstCall.requestId,
      selectionId: selection.selectionId,
      originalText: 'architecture',
      translatedText: '旧结果',
      targetLanguage: 'zh-CN',
      attribution: { providerId: 'baidu', providerDisplayName: '百度翻译' },
      receivedAt: '2026-07-16T12:00:00.000Z',
      fromCache: false
    });
    harness.requests[1]?.resolve({
      requestId: secondCall.requestId,
      selectionId: next.selectionId,
      originalText: 'system',
      translatedText: '系统',
      targetLanguage: 'zh-CN',
      attribution: { providerId: 'baidu', providerDisplayName: '百度翻译' },
      receivedAt: '2026-07-16T12:00:00.000Z',
      fromCache: false
    });
    await vi.waitFor(() => expect(harness.cards.at(-1)).toMatchObject({
      kind: 'translated', selectionId: next.selectionId, translatedText: '系统'
    }));
    expect(harness.cards).not.toContainEqual(expect.objectContaining({ translatedText: '旧结果' }));
  });

  it('ignores a failure that arrives after its request was cancelled', async () => {
    const harness = createHarness();
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    const firstCall = vi.mocked(harness.provider.translate).mock.calls[0]![0];
    const next = {
      ...selection,
      selectionId: '123e4567-e89b-42d3-a456-426614174001',
      text: 'second selection'
    };

    harness.controller.handleSelection(next, { x: 2, y: 3, width: 380, height: 320 });
    expect(harness.signals[0]?.aborted).toBe(true);
    harness.requests[0]?.reject(new TranslationProviderError({
      requestId: firstCall.requestId,
      selectionId: selection.selectionId,
      code: 'provider-unavailable',
      message: 'late provider failure',
      providerId: 'baidu',
      retryable: true
    }));
    await Promise.resolve();

    expect(harness.cards.at(-1)).toMatchObject({
      kind: 'translating',
      selectionId: next.selectionId
    });
    expect(harness.cards).not.toContainEqual(expect.objectContaining({
      kind: 'failed',
      selectionId: selection.selectionId
    }));
  });

  it('presents a stable failure and retry uses a new request id', async () => {
    const harness = createHarness();
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    const call = vi.mocked(harness.provider.translate).mock.calls[0]![0];
    harness.requests[0]?.reject(new TranslationProviderError({
      requestId: call.requestId,
      selectionId: selection.selectionId,
      code: 'network-unavailable',
      message: 'sensitive provider detail',
      providerId: 'baidu',
      retryable: true
    }));
    await vi.waitFor(() => expect(harness.cards.at(-1)).toMatchObject({
      kind: 'failed', code: 'network-unavailable', retryable: true
    }));
    expect(JSON.stringify(harness.cards.at(-1))).not.toContain('sensitive provider detail');
    harness.controller.retry();
    expect(vi.mocked(harness.provider.translate).mock.calls[1]![0].requestId).not.toBe(call.requestId);
  });

  it('coalesces a double-click retry while the replacement request is active', async () => {
    const harness = createHarness();
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    const call = vi.mocked(harness.provider.translate).mock.calls[0]![0];
    harness.requests[0]?.reject(new TranslationProviderError({
      requestId: call.requestId,
      selectionId: selection.selectionId,
      code: 'network-unavailable',
      message: 'safe failure',
      providerId: 'baidu',
      retryable: true
    }));
    await vi.waitFor(() => expect(harness.cards.at(-1)?.kind).toBe('failed'));

    harness.controller.retry();
    harness.controller.retry();

    expect(harness.provider.translate).toHaveBeenCalledTimes(2);
    expect(harness.signals[1]?.aborted).toBe(false);
    expect(harness.cards.at(-1)?.kind).toBe('translating');
  });

  it('dismisses and hides without publishing cancelled failures', async () => {
    const harness = createHarness();
    harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
    harness.controller.cancelAndHide();
    expect(harness.signals[0]?.aborted).toBe(true);
    expect(harness.hideCard).toHaveBeenCalledOnce();
    expect(harness.controller.hasInFlightRequest()).toBe(false);
    await Promise.resolve();
    expect(harness.cards.at(-1)?.kind).toBe('translating');
  });

  it('applies the total timeout even when the Provider is still resolving credentials', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(true, 10);
      harness.controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.cards.at(-1)).toMatchObject({
        kind: 'failed',
        code: 'network-unavailable',
        retryable: true
      });
      expect(harness.controller.hasInFlightRequest()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
