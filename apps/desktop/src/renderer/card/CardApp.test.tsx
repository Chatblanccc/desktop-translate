// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectionCardRendererBridge } from '../../preload/card-bridge.js';
import { CardApp } from './CardApp.js';

afterEach(cleanup);

const card = {
  selectionId: '123e4567-e89b-42d3-a456-426614174000',
  text: 'Phase Three source text',
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
      onChanged: vi.fn().mockReturnValue(unsubscribe)
    };
    const view = render(<CardApp api={api} />);
    await screen.findByRole('heading', { name: '识别结果' });
    expect(screen.getByText(card.text)).toBeTruthy();
    expect(screen.getByText(/本地 OCR · 75%/u)).toBeTruthy();
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
      onChanged: vi.fn((next) => {
        listener = next as typeof listener;
        return vi.fn();
      })
    };
    render(<CardApp api={api} />);
    await waitFor(() => expect(listener).toBeTypeOf('function'));
    act(() => { listener?.(card); });
    await waitFor(() => expect(screen.getByText(card.text)).toBeTruthy());
  });

  it('does not overwrite a pushed card with a stale initial response', async () => {
    let resolveInitial: ((value: undefined) => void) | undefined;
    let listener: ((value: typeof card | undefined) => void) | undefined;
    const api: SelectionCardRendererBridge = {
      getCurrent: vi.fn(() => new Promise<undefined>((resolve) => { resolveInitial = resolve; })),
      dismiss: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((next) => {
        listener = next as typeof listener;
        return vi.fn();
      })
    };
    render(<CardApp api={api} />);
    await waitFor(() => expect(listener).toBeTypeOf('function'));
    act(() => { listener?.(card); });
    await screen.findByText(card.text);
    act(() => { resolveInitial?.(undefined); });
    await waitFor(() => expect(screen.getByText(card.text)).toBeTruthy());
  });
});
