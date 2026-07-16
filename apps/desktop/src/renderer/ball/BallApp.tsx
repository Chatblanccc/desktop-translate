import type { JSX, MouseEvent } from 'react';
import {
  type BallRendererApi,
  type NativeUiStatus,
  useDocumentTheme,
  useUiShellSnapshot
} from '../shared/shell-api.js';

const STATUS_LABELS: Readonly<Record<NativeUiStatus, string>> = {
  unavailable: '原生服务未连接',
  starting: '原生服务正在连接',
  ready: '原生服务可用',
  degraded: '部分能力暂不可用',
  faulted: '原生服务连接故障'
};

export interface BallAppProps {
  readonly api: BallRendererApi;
}

export function BallApp({ api }: BallAppProps): JSX.Element {
  const { snapshot } = useUiShellSnapshot(api);
  const nativeStatus = snapshot.native.status;
  const statusLabel = STATUS_LABELS[nativeStatus];

  useDocumentTheme(snapshot.theme);

  const openSettings = (): void => {
    void api.openSettings();
  };

  const openContextMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    void api.openContextMenu();
  };

  return (
    <div className="ball-frame" data-native-status={nativeStatus}>
      <button
        className="ball-button"
        type="button"
        title={`桌面翻译 · ${statusLabel}`}
        aria-label={`打开桌面翻译设置，${statusLabel}`}
        onClick={openSettings}
        onContextMenu={openContextMenu}
      >
        <span className="ball-icon" aria-hidden="true" />
      </button>
      <span className="ball-status" title={statusLabel} aria-hidden="true" />
    </div>
  );
}
