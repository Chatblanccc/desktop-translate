import { useEffect, useState } from 'react';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type OcrActivation,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';

export {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type BallAnchor,
  type NativeUiStatus,
  type OcrActivation,
  type SelectionLifecycle,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';

export type SnapshotChangedListener = (snapshot: UiShellSnapshot) => void;

export interface UiShellReaderApi {
  getSnapshot(): Promise<UiShellSnapshot>;
  onSnapshotChanged(listener: SnapshotChangedListener): () => void;
}

export interface BallRendererApi extends UiShellReaderApi {
  openSettings(): Promise<void>;
  openContextMenu(): Promise<void>;
}

export interface SettingsRendererApi extends UiShellReaderApi {
  setBallVisible(visible: boolean): Promise<void>;
  setEdgeSnap(enabled: boolean): Promise<void>;
  setTheme(theme: ThemeMode): Promise<void>;
  setSelectionEnabled(enabled: boolean): Promise<void>;
  setOcrActivation(activation: OcrActivation): Promise<void>;
  setTranslationEnabled(enabled: boolean): Promise<void>;
  setTranslationSourceLanguage(language: string): Promise<void>;
  setTranslationTargetLanguage(language: string): Promise<void>;
  saveBaiduCredentials(appId: string, secretKey: string, consentVersion: number): Promise<void>;
  deleteBaiduCredentials(): Promise<void>;
  testTranslationProvider(): Promise<{ readonly ok: boolean; readonly code?: string }>;
  openProviderPrivacyPolicy(): Promise<void>;
  openProviderServiceTerms(): Promise<void>;
  resetBallPosition(): Promise<void>;
}

export interface UiShellSnapshotState {
  readonly snapshot: UiShellSnapshot;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useUiShellSnapshot(api: UiShellReaderApi): UiShellSnapshotState {
  const [snapshot, setSnapshot] = useState<UiShellSnapshot>(DEFAULT_UI_SHELL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let receivedSubscriptionSnapshot = false;
    const acceptSnapshot = (nextSnapshot: UiShellSnapshot): void => {
      if (!active) {
        return;
      }

      setSnapshot(nextSnapshot);
      setLoading(false);
      setError(null);
    };
    const acceptSubscriptionSnapshot = (nextSnapshot: UiShellSnapshot): void => {
      receivedSubscriptionSnapshot = true;
      acceptSnapshot(nextSnapshot);
    };

    const unsubscribe = api.onSnapshotChanged(acceptSubscriptionSnapshot);

    void api.getSnapshot().then((initialSnapshot) => {
      if (receivedSubscriptionSnapshot) {
        return;
      }

      acceptSnapshot(initialSnapshot);
    }, () => {
      if (!active || receivedSubscriptionSnapshot) {
        return;
      }

      setLoading(false);
      setError('暂时无法读取应用状态，请稍后重试。');
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  return { snapshot, loading, error };
}

export function useDocumentTheme(theme: ThemeMode): void {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);
}
