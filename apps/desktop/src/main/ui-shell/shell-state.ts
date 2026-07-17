import { EventEmitter } from 'node:events';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type BallAnchor,
  type NativeUiStatus,
  type OcrActivation,
  type SelectionLifecycle,
  type CredentialStatus,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import type { Phase4UiSettings } from '@desktop-translate/storage';

export class UiShellState extends EventEmitter {
  private snapshot: UiShellSnapshot = DEFAULT_UI_SHELL_SNAPSHOT;

  public getSnapshot(): UiShellSnapshot {
    return structuredClone(this.snapshot);
  }

  public initialize(
    settings: Phase4UiSettings,
    credentialStatus: CredentialStatus = 'missing'
  ): void {
    this.replace({
      ...this.snapshot,
      ball: settings.ball.anchor === undefined
        ? { visible: settings.ball.visible, edgeSnap: settings.ball.edgeSnap }
        : {
            visible: settings.ball.visible,
            edgeSnap: settings.ball.edgeSnap,
            anchor: settings.ball.anchor
          },
      theme: settings.theme,
      selection: {
        enabled: settings.selection.enabled,
        lifecycle: settings.selection.enabled ? 'starting' : 'disabled',
        ocrActivation: settings.selection.ocrActivation
      },
      translation: {
        ...settings.translation,
        credentialStatus,
        enabled: settings.translation.enabled
          && credentialStatus === 'configured'
          && settings.translation.consentVersion >= 1
      }
    });
  }

  public setBallVisible(visible: boolean): void {
    this.replace({ ...this.snapshot, ball: { ...this.snapshot.ball, visible } });
  }

  public setEdgeSnap(edgeSnap: boolean): void {
    this.replace({ ...this.snapshot, ball: { ...this.snapshot.ball, edgeSnap } });
  }

  public setBallAnchor(anchor: BallAnchor | undefined): void {
    const ball = anchor === undefined
      ? { visible: this.snapshot.ball.visible, edgeSnap: this.snapshot.ball.edgeSnap }
      : { ...this.snapshot.ball, anchor };
    this.replace({ ...this.snapshot, ball });
  }

  public setTheme(theme: ThemeMode): void {
    this.replace({ ...this.snapshot, theme });
  }

  public setNativeStatus(
    status: NativeUiStatus,
    degradedCapabilities: readonly string[] = []
  ): void {
    this.replace({
      ...this.snapshot,
      native: { status, degradedCapabilities: [...degradedCapabilities] }
    });
  }

  public setSelectionEnabled(enabled: boolean): void {
    this.replace({
      ...this.snapshot,
      selection: {
        ...this.snapshot.selection,
        enabled,
        lifecycle: enabled ? 'starting' : 'disabled'
      }
    });
  }

  public setSelectionLifecycle(lifecycle: SelectionLifecycle): void {
    this.replace({
      ...this.snapshot,
      selection: { ...this.snapshot.selection, lifecycle }
    });
  }

  public setOcrActivation(ocrActivation: OcrActivation): void {
    this.replace({
      ...this.snapshot,
      selection: { ...this.snapshot.selection, ocrActivation }
    });
  }

  public setTranslationEnabled(enabled: boolean): void {
    this.replace({
      ...this.snapshot,
      translation: { ...this.snapshot.translation, enabled }
    });
  }

  public setTranslationTargetLanguage(targetLanguage: string): void {
    this.replace({
      ...this.snapshot,
      translation: { ...this.snapshot.translation, targetLanguage }
    });
  }

  public setTranslationSourceLanguage(sourceLanguage: string): void {
    this.replace({
      ...this.snapshot,
      translation: { ...this.snapshot.translation, sourceLanguage }
    });
  }

  public setTranslationCredentialStatus(credentialStatus: CredentialStatus): void {
    this.replace({
      ...this.snapshot,
      translation: {
        ...this.snapshot.translation,
        credentialStatus,
        enabled: credentialStatus === 'configured' && this.snapshot.translation.enabled
      }
    });
  }

  public setTranslationConsentVersion(consentVersion: number): void {
    this.replace({
      ...this.snapshot,
      translation: { ...this.snapshot.translation, consentVersion }
    });
  }

  private replace(snapshot: UiShellSnapshot): void {
    this.snapshot = snapshot;
    this.emit('changed', this.getSnapshot());
  }
}
