import type { JSX, MouseEvent } from 'react';
import {
  type BallRendererApi,
  type SelectionLifecycle,
  useDocumentTheme,
  useUiShellSnapshot
} from '../shared/shell-api.js';

const STATUS_LABELS: Readonly<Record<SelectionLifecycle, string>> = {
  disabled: '划词取词已暂停',
  starting: '划词取词正在启动',
  listening: '划词取词监听中',
  degraded: '划词取词监听中，部分能力暂不可用',
  faulted: '划词取词故障'
};

export interface BallAppProps {
  readonly api: BallRendererApi;
}

export function BallApp({ api }: BallAppProps): JSX.Element {
  const { snapshot } = useUiShellSnapshot(api);
  const selectionStatus = snapshot.selection.lifecycle;
  const statusLabel = STATUS_LABELS[selectionStatus];

  useDocumentTheme(snapshot.theme);

  const openSettings = (): void => {
    void api.openSettings();
  };

  const openContextMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    void api.openContextMenu();
  };

  return (
    <div
      className="ball-frame"
      data-selection-status={selectionStatus}
      title="按住上方把手拖动悬浮球"
    >
      <span className="ball-drag-handle" aria-hidden="true" />
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
