// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectionCardRendererBridge } from '../../preload/card-bridge.js';
import { CardApp } from './CardApp.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = {
  kind: 'source-only' as const,
  selectionId: '123e4567-e89b-42d3-a456-426614174000',
  sourceText: 'Phase Three source text',
  source: 'ocr' as const,
  confidence: 0.75
};

describe('CardApp', () => {
  it('renders source-only OCR content and delegates dismiss', async () => {
    const dismiss = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn().mockResolvedValue(card),
      dismiss,
      retry: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(unsubscribe)
    };
    const view = render(<CardApp api={api} />);
    await screen.findByRole('heading', { name: '识别结果' });
    expect(screen.getByText(card.sourceText)).toBeTruthy();
    expect(screen.queryByText(/本地 OCR/u)).toBeNull();
    expect(view.container.querySelector('.card-origin-section')).toBeNull();
    expect(screen.getByText('在线翻译：未启用 · 仅显示原文')).toBeTruthy();
    expect(screen.queryByText(/译文/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭识别结果' }));
    expect(dismiss).toHaveBeenCalledOnce();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('accepts the latest pushed card', async () => {
    let listener: ((value: typeof card | undefined) => void) | undefined;
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((next) => {
        listener = next as typeof listener;
        return vi.fn();
      })
    };
    render(<CardApp api={api} />);
    await waitFor(() => expect(listener).toBeTypeOf('function'));
    act(() => { listener?.(card); });
    await waitFor(() => expect(screen.getByText(card.sourceText)).toBeTruthy());
  });

  it('does not overwrite a pushed card with a stale initial response', async () => {
    let resolveInitial: ((value: undefined) => void) | undefined;
    let listener: ((value: typeof card | undefined) => void) | undefined;
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn(() => new Promise<undefined>((resolve) => { resolveInitial = resolve; })),
      dismiss: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((next) => {
        listener = next as typeof listener;
        return vi.fn();
      })
    };
    render(<CardApp api={api} />);
    await waitFor(() => expect(listener).toBeTypeOf('function'));
    act(() => { listener?.(card); });
    await screen.findByText(card.sourceText);
    act(() => { resolveInitial?.(undefined); });
    await waitFor(() => expect(screen.getByText(card.sourceText)).toBeTruthy());
  });

  it('acknowledges a strict paint probe only after commit and two animation frames', async () => {
    let cardListener: ((value: typeof card | undefined) => void) | undefined;
    let paintListener: ((token: number) => void) | undefined;
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
    const acknowledgePaint = vi.fn();
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((listener) => {
        cardListener = listener as typeof cardListener;
        return vi.fn();
      }),
      onPaintProbe: vi.fn((listener) => {
        paintListener = listener;
        return vi.fn();
      }),
      acknowledgePaint
    };
    render(<CardApp api={api} />);
    await waitFor(() => {
      expect(cardListener).toBeTypeOf('function');
      expect(paintListener).toBeTypeOf('function');
    });

    act(() => {
      cardListener?.(card);
      paintListener?.(11);
    });
    expect(acknowledgePaint).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    const first = [...frames.entries()][0]!;
    frames.delete(first[0]);
    act(() => { first[1](16); });
    expect(acknowledgePaint).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    const second = [...frames.entries()][0]!;
    frames.delete(second[0]);
    act(() => { second[1](32); });
    expect(acknowledgePaint).toHaveBeenCalledOnce();
    expect(acknowledgePaint).toHaveBeenCalledWith(11);
  });

  it('renders hostile markup and URLs as scrollable plain text', async () => {
    const hostile = '<img src=x onerror="globalThis.pwned=true"><script>pwned()</script>'
      + ' https://evil.example/<svg/onload=pwned()>';
    const sourceText = `${hostile}\n${'long-selection '.repeat(1_000)}`;
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn().mockResolvedValue({ ...card, sourceText }),
      dismiss: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(vi.fn())
    };

    const view = render(<CardApp api={api} />);
    const region = await screen.findByRole('region', { name: '识别内容' });
    expect(view.container.querySelector('.card-text')?.textContent).toBe(sourceText);
    expect(view.container.querySelector('.card-text img, .card-text script, .card-text svg, .card-text a')).toBeNull();
    expect(region.getAttribute('tabindex')).toBe('0');
    region.focus();
    expect(document.activeElement).toBe(region);

    const styles = readFileSync(resolve('src/renderer/card/styles.css'), 'utf8');
    expect(styles).toMatch(/\.card-content\s*\{[\s\S]*?overflow:\s*auto;/u);
  });

  it('renders translated content and delegates retry for safe failures', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const translated = {
      ...card,
      kind: 'translated' as const,
      requestId: '223e4567-e89b-42d3-a456-426614174000',
      translatedText: '第四阶段译文',
      targetLanguage: 'zh-CN',
      attribution: { providerId: 'baidu', providerDisplayName: '百度翻译' },
      fromCache: false
    };
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn().mockResolvedValue(translated),
      dismiss: vi.fn().mockResolvedValue(undefined),
      retry,
      onChanged: vi.fn().mockReturnValue(vi.fn())
    };
    const view = render(<CardApp api={api} />);
    expect(await screen.findByText(translated.translatedText)).toBeTruthy();
    expect(screen.queryByText(translated.sourceText)).toBeNull();
    expect(view.container.querySelector('.card-origin-section')).toBeNull();
    expect(view.container.querySelector('.translated-section')).toBeTruthy();
    view.unmount();

    const failed = {
      ...card,
      kind: 'failed' as const,
      requestId: translated.requestId,
      code: 'network-unavailable' as const,
      retryable: true
    };
    vi.mocked(api.getCurrent).mockResolvedValue(failed);
    const failedView = render(<CardApp api={api} />);
    expect(await screen.findByText(failed.sourceText)).toBeTruthy();
    expect(failedView.container.querySelector('.card-origin-section')).toBeNull();
    expect(
      failedView.container.querySelector('.card-content')?.firstElementChild?.classList.contains('translation-error')
    ).toBe(true);
    expect(screen.getByText('翻译失败 · 已保留原文')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '重试翻译' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('resets scroll position and announces a completed translation', async () => {
    let listener: ((value: typeof translated | typeof translating | undefined) => void) | undefined;
    const requestId = '223e4567-e89b-42d3-a456-426614174000';
    const translating = {
      ...card,
      kind: 'translating' as const,
      requestId
    };
    const translated = {
      ...card,
      kind: 'translated' as const,
      requestId,
      translatedText: '翻译已完成',
      targetLanguage: 'zh-CN',
      attribution: { providerId: 'baidu', providerDisplayName: '百度翻译' },
      fromCache: false
    };
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn().mockResolvedValue(translating),
      dismiss: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((next) => {
        listener = next as typeof listener;
        return vi.fn();
      })
    };

    const view = render(<CardApp api={api} />);
    await waitFor(() => expect(listener).toBeTypeOf('function'));
    await waitFor(() => expect(view.container.querySelector('.card-shell')?.getAttribute('data-kind')).toBe('translating'));
    expect(view.container.querySelector('.card-origin-section')).toBeNull();
    expect(
      view.container.querySelector('.card-content')?.firstElementChild?.classList.contains('translation-state')
    ).toBe(true);
    const content = view.container.querySelector<HTMLElement>('.card-content');
    expect(content).toBeTruthy();
    content!.scrollTop = 96;

    act(() => { listener?.(translated); });

    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('翻译完成');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(content!.scrollTop).toBe(0);
  });
});
