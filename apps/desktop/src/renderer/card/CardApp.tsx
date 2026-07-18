import { useEffect, useState, type JSX } from 'react';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import type { SelectionCardRendererBridge } from '../../preload/card-bridge.js';

export interface CardAppProps {
  readonly api: SelectionCardRendererBridge;
}

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  'credentials-missing': '尚未配置在线翻译凭据。',
  'authentication-failed': '翻译凭据无效，请在设置中更新。',
  'quota-exceeded': '翻译额度已用尽。',
  'rate-limited': '请求过于频繁，请稍后重试。',
  'network-unavailable': '网络不可用，已保留本地原文。',
  'provider-unavailable': '翻译服务暂时不可用。',
  'unsupported-language': '当前语言组合暂不支持。',
  'invalid-request': '所选文本无法发送翻译。',
  'malformed-response': '翻译服务返回了无效结果。',
  unknown: '翻译失败，已保留本地原文。'
};

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
  const isTranslationCard = card.kind !== 'source-only';

  return (
    <main className="card-shell" aria-labelledby="card-title">
      <header className="card-header">
        <span>
          <h1 id="card-title">{isTranslationCard ? '翻译结果' : '识别结果'}</h1>
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
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll long card content. */}
      <section className="card-content" aria-label="翻译内容" tabIndex={0}>
        <section className="card-text-section" aria-labelledby="source-text-label">
          <h2 id="source-text-label">原文</h2>
          <p className="card-text">{card.sourceText}</p>
        </section>

        {card.kind === 'translating' && (
          <section className="translation-state" aria-live="polite" aria-busy="true">
            <span className="translation-spinner" aria-hidden="true" />
            正在通过百度翻译处理…
          </section>
        )}

        {card.kind === 'translated' && (
          <section className="card-text-section translated-section" aria-labelledby="translated-text-label">
            <h2 id="translated-text-label">译文 · {card.targetLanguage}</h2>
            <p className="card-text translated-text">{card.translatedText}</p>
          </section>
        )}

        {card.kind === 'failed' && (
          <section className="translation-error" aria-live="polite" aria-atomic="true">
            <p>{FAILURE_LABELS[card.code] ?? FAILURE_LABELS.unknown}</p>
            {card.retryable && (
              <button
                className="card-retry"
                type="button"
                onClick={() => { void api.retry(); }}
              >
                重试翻译
              </button>
            )}
          </section>
        )}
      </section>
      <footer>
        {card.kind === 'translated'
          ? `${card.attribution.providerDisplayName}${card.fromCache ? ' · 内存缓存' : ''}`
          : card.kind === 'source-only' ? '在线翻译未启用 · 原文预览' : 'Phase 4 · 在线翻译'}
      </footer>
    </main>
  );
}
