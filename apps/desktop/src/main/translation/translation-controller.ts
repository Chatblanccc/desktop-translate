import { randomUUID } from 'node:crypto';
import {
  transitionTranslationSession,
  type TranslationSessionEffect,
  type TranslationSessionState
} from '@desktop-translate/application';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import type { SelectionResult } from '@desktop-translate/contracts/native-ipc';
import type {
  TranslationFailure,
  TranslationProvider
} from '@desktop-translate/translation';
import { TranslationProviderError } from '@desktop-translate/translation';

export interface TranslationRuntimeSettings {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly sourceLanguage: string | 'auto';
  readonly targetLanguage: string;
  readonly credentialStatus: 'missing' | 'configured' | 'unavailable';
  readonly consentVersion: number;
}

export interface CardBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TranslationControllerOptions {
  readonly provider: TranslationProvider;
  readonly getSettings: () => TranslationRuntimeSettings;
  readonly presentCard: (card: SelectionCardViewModel, bounds: CardBounds) => void;
  readonly hideCard: () => void;
  readonly now?: () => Date;
  readonly createRequestId?: () => string;
  /** Covers credential resolution and Provider I/O as one end-to-end deadline. */
  readonly requestTimeoutMs?: number;
}

const CURRENT_TRANSLATION_CONSENT_VERSION = 1;
const DEFAULT_TRANSLATION_REQUEST_TIMEOUT_MS = 8_000;

function normalizeProviderText(value: string): string {
  return value.normalize('NFC').replaceAll('\r\n', '\n').trim();
}

function toFailure(error: unknown, requestId: string, selectionId: string): TranslationFailure {
  if (error instanceof TranslationProviderError) return error.failure;
  return {
    requestId,
    selectionId,
    code: 'unknown',
    message: 'Translation failed',
    retryable: false
  };
}

function timeoutFailure(requestId: string, selectionId: string): TranslationFailure {
  return {
    requestId,
    selectionId,
    code: 'network-unavailable',
    message: 'Translation request timed out',
    retryable: true
  };
}

export class TranslationController {
  private session: TranslationSessionState;
  private currentBounds: CardBounds | undefined;
  private activeRequest: {
    readonly requestId: string;
    readonly abortController: AbortController;
  } | undefined;
  private readonly now: () => Date;
  private readonly createRequestId: () => string;
  private readonly requestTimeoutMs: number;

  public constructor(private readonly options: TranslationControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TRANSLATION_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs)
      || this.requestTimeoutMs < 1
      || this.requestTimeoutMs > 120_000
    ) {
      throw new TypeError('Translation request timeout is invalid');
    }
  }

  public handleSelection(selection: SelectionResult, bounds: CardBounds): void {
    const settings = this.options.getSettings();
    this.currentBounds = { ...bounds };
    const translationEnabled = this.canTranslate(settings);
    this.apply(transitionTranslationSession(this.session, {
      type: 'selection.received',
      selection,
      translationEnabled,
      ...(translationEnabled ? { requestId: this.createRequestId() } : {})
    }));
  }

  public retry(): void {
    if (this.session?.stage !== 'failed') return;
    const settings = this.options.getSettings();
    if (!this.canTranslate(settings)) return;
    this.apply(transitionTranslationSession(this.session, {
      type: 'translation.retry-requested',
      requestId: this.createRequestId()
    }));
  }

  /** Called after WindowManager has already hidden the card. */
  public dismiss(): void {
    this.apply(transitionTranslationSession(this.session, { type: 'session.dismiss' }));
    this.currentBounds = undefined;
  }

  public cancelAndHide(): void {
    this.apply(transitionTranslationSession(this.session, { type: 'session.dismiss' }));
    this.currentBounds = undefined;
  }

  public hasInFlightRequest(): boolean {
    return this.session?.stage === 'translating';
  }

  private canTranslate(settings: TranslationRuntimeSettings): boolean {
    return settings.enabled
      && settings.providerId === this.options.provider.id
      && settings.credentialStatus === 'configured'
      && settings.consentVersion >= CURRENT_TRANSLATION_CONSENT_VERSION;
  }

  private requestTranslation(selection: SelectionResult, requestId: string): void {
    const settings = this.options.getSettings();
    const abortController = new AbortController();
    this.activeRequest = { requestId, abortController };

    const text = normalizeProviderText(selection.text);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort('translation-timeout');
    }, this.requestTimeoutMs);
    let rejectCancellation!: (reason: TranslationProviderError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = (): void => {
      rejectCancellation(new TranslationProviderError(timedOut
        ? timeoutFailure(requestId, selection.selectionId)
        : {
            requestId,
            selectionId: selection.selectionId,
            code: 'cancelled',
            message: 'Translation request was cancelled',
            retryable: false
          }));
    };
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    const providerRequest = this.options.provider.translate({
      requestId,
      selectionId: selection.selectionId,
      text,
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage
    }, {
      signal: abortController.signal,
      now: this.now
    });
    void Promise.race([providerRequest, cancellation]).then((result) => {
      this.apply(transitionTranslationSession(this.session, {
        type: 'translation.succeeded',
        result
      }));
    }).catch((error: unknown) => {
      const failure = timedOut
        ? timeoutFailure(requestId, selection.selectionId)
        : toFailure(error, requestId, selection.selectionId);
      this.apply(transitionTranslationSession(this.session, {
        type: 'translation.failed',
        failure
      }));
    }).finally(() => {
      clearTimeout(timeout);
      abortController.signal.removeEventListener('abort', onAbort);
      if (this.activeRequest?.requestId === requestId) this.activeRequest = undefined;
    });
  }

  private apply(transition: {
    readonly state: TranslationSessionState;
    readonly effects: readonly TranslationSessionEffect[];
  }): void {
    this.session = transition.state;
    for (const effect of transition.effects) this.execute(effect);
  }

  private execute(effect: TranslationSessionEffect): void {
    switch (effect.type) {
      case 'translation.cancel':
        if (this.activeRequest?.requestId === effect.requestId) {
          this.activeRequest.abortController.abort('translation-invalidated');
          this.activeRequest = undefined;
        }
        break;
      case 'translation.request':
        this.requestTranslation(effect.selection, effect.requestId);
        break;
      case 'card.present':
        if (this.currentBounds !== undefined) {
          this.options.presentCard(effect.card, this.currentBounds);
        }
        break;
      case 'card.dismiss':
        this.options.hideCard();
        break;
    }
  }
}
