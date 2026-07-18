import { describe, expect, it, vi } from 'vitest';
import { UiShellState } from './shell-state.js';

describe('UiShellState', () => {
  it('publishes initialized settings and isolated snapshots', () => {
    const state = new UiShellState();
    const changed = vi.fn();
    state.on('changed', changed);
    state.initialize({
      ball: { visible: false, edgeSnap: true },
      theme: 'dark',
      selection: { enabled: true, ocrActivation: 'fallback' },
      translation: {
        enabled: false,
        providerId: 'baidu',
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        consentVersion: 0
      }
    });
    const snapshot = state.getSnapshot();
    expect(snapshot.ball.visible).toBe(false);
    expect(snapshot.theme).toBe('dark');
    expect(changed).toHaveBeenCalledOnce();
    (snapshot.native.degradedCapabilities as string[]).push('mutated');
    expect(state.getSnapshot().native.degradedCapabilities).toEqual([]);
  });

  it('keeps an optional anchor while updating individual preferences', () => {
    const state = new UiShellState();
    state.setBallAnchor({ displayId: '1', edge: 'right', verticalRatio: 0.5 });
    state.setBallVisible(false);
    state.setEdgeSnap(false);
    expect(state.getSnapshot().ball).toEqual({
      visible: false,
      edgeSnap: false,
      anchor: { displayId: '1', edge: 'right', verticalRatio: 0.5 }
    });
  });

  it('tracks Phase 3 Native and selection lifecycle transitions', () => {
    const state = new UiShellState();
    state.initialize({
      ball: { visible: true, edgeSnap: true },
      theme: 'system',
      selection: { enabled: false, ocrActivation: 'fallback' },
      translation: {
        enabled: false,
        providerId: 'baidu',
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        consentVersion: 0
      }
    });
    expect(state.getSnapshot().selection.lifecycle).toBe('disabled');
    state.setSelectionEnabled(true);
    state.setSelectionLifecycle('listening');
    state.setOcrActivation('alt-drag');
    state.setNativeStatus('degraded', ['ocr']);
    expect(state.getSnapshot()).toMatchObject({
      native: { status: 'degraded', degradedCapabilities: ['ocr'] },
      selection: { enabled: true, lifecycle: 'listening', ocrActivation: 'alt-drag' }
    });
    state.setBallAnchor(undefined);
    expect(state.getSnapshot().ball.anchor).toBeUndefined();
    state.setSelectionEnabled(false);
    expect(state.getSnapshot().selection.lifecycle).toBe('disabled');
  });

  it('fails closed until translation credentials and consent are configured', () => {
    const state = new UiShellState();
    state.initialize({
      ball: { visible: true, edgeSnap: true },
      theme: 'system',
      selection: { enabled: true, ocrActivation: 'fallback' },
      translation: {
        enabled: true,
        providerId: 'baidu',
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        consentVersion: 1
      }
    }, 'missing');
    expect(state.getSnapshot().translation.enabled).toBe(false);
    state.setTranslationCredentialStatus('configured');
    state.setTranslationConsentVersion(1);
    state.setTranslationEnabled(true);
    state.setTranslationTargetLanguage('en');
    expect(state.getSnapshot().translation).toMatchObject({
      enabled: true,
      credentialStatus: 'configured',
      consentVersion: 1,
      targetLanguage: 'en'
    });
  });
});
