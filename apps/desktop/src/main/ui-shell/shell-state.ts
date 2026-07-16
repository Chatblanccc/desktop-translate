import { EventEmitter } from 'node:events';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type BallAnchor,
  type NativeUiStatus,
  type OcrActivation,
  type SelectionLifecycle,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import type { Phase3UiSettings } from '@desktop-translate/storage';

export class UiShellState extends EventEmitter {
  private snapshot: UiShellSnapshot = DEFAULT_UI_SHELL_SNAPSHOT;

  public getSnapshot(): UiShellSnapshot {
    return structuredClone(this.snapshot);
  }

  public initialize(settings: Phase3UiSettings): void {
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

  private replace(snapshot: UiShellSnapshot): void {
    this.snapshot = snapshot;
    this.emit('changed', this.getSnapshot());
  }
}
