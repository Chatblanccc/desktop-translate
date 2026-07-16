import { useEffect, useState, type JSX } from 'react';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import type { SelectionCardRendererBridge } from '../../preload/card-bridge.js';

export interface CardAppProps {
  readonly api: SelectionCardRendererBridge;
}

export function CardApp({ api }: CardAppProps): JSX.Element {
  const [card, setCard] = useState<SelectionCardViewModel | undefined>();

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = api.onChanged((value) => {
      receivedChange = true;
      if (active) setCard(value);
    });
    void api.getCurrent().then((value) => {
      if (active && !receivedChange) setCard(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  if (card === undefined) return <main className="card-shell" aria-hidden="true" />;
  const sourceLabel = card.source === 'ocr' ? '本地 OCR' : '应用文字';

  return (
    <main className="card-shell" aria-labelledby="card-title">
      <header className="card-header">
        <span>
          <h1 id="card-title">识别结果</h1>
          <span className="card-source">
            {sourceLabel}
            {card.source === 'ocr' ? ` · ${Math.round(card.confidence * 100)}%` : ''}
          </span>
        </span>
        <button
          className="card-close"
          type="button"
          aria-label="关闭识别结果"
          onClick={() => { void api.dismiss(); }}
        >
          ×
        </button>
      </header>
      <p className="card-text">{card.text}</p>
      <footer>Phase 3 · 原文预览</footer>
    </main>
  );
}
