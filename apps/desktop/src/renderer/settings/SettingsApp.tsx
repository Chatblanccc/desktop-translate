import { useId, useState, type JSX } from 'react';
import {
  type NativeUiStatus,
  type SettingsRendererApi,
  type ThemeMode,
  useDocumentTheme,
  useUiShellSnapshot
} from '../shared/shell-api.js';

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.2.0-phase2';

const NATIVE_STATUS: Readonly<
  Record<NativeUiStatus, { readonly title: string; readonly description: string }>
> = {
  unavailable: {
    title: '未连接',
    description: '原生服务未配置，桌面界面仍可正常使用。'
  },
  starting: {
    title: '正在连接',
    description: '正在检查原生服务状态。'
  },
  ready: {
    title: '可用',
    description: '原生服务运行正常；Phase 2 不会启动全局取词。'
  },
  degraded: {
    title: '部分可用',
    description: '桌面界面运行正常，部分原生能力尚未配置。'
  },
  faulted: {
    title: '连接故障',
    description: '原生服务暂时不可用，桌面界面不会因此退出。'
  }
};

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  ocr: 'OCR 未配置',
  selection: '选区能力不可用',
  hook: '全局取词未启动'
};

const THEME_OPTIONS: ReadonlyArray<{ readonly value: ThemeMode; readonly label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
];

type PendingAction = 'ball-visible' | 'edge-snap' | 'theme' | 'reset' | null;

export interface SettingsAppProps {
  readonly api: SettingsRendererApi;
}

interface SettingRowProps {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}

function SettingRow({
  title,
  description,
  checked,
  disabled,
  onChange
}: SettingRowProps): JSX.Element {
  const controlId = useId();

  return (
    <div className="setting-row">
      <label className="setting-copy" htmlFor={controlId}>
        <span className="setting-title">{title}</span>
        <span className="setting-description">{description}</span>
      </label>
      <span className="switch-control">
        <input
          id={controlId}
          className="switch-input"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </span>
    </div>
  );
}

export function SettingsApp({ api }: SettingsAppProps): JSX.Element {
  const { snapshot, loading, error: snapshotError } = useUiShellSnapshot(api);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const nativeStatus = NATIVE_STATUS[snapshot.native.status];
  const controlsDisabled = loading || pendingAction !== null;

  useDocumentTheme(snapshot.theme);

  const runAction = (action: Exclude<PendingAction, null>, operation: () => Promise<void>): void => {
    setPendingAction(action);
    setActionError(null);
    void operation().catch(() => {
      setActionError('设置未能保存，请稍后重试。');
    }).finally(() => {
      setPendingAction(null);
    });
  };

  const unavailableCapabilities = snapshot.native.degradedCapabilities.map(
    (capability) => CAPABILITY_LABELS[capability] ?? `${capability} 暂不可用`
  );

  return (
    <main className="settings-app" aria-busy={loading}>
      <header className="app-header">
        <span className="app-mark" aria-hidden="true">
          <span className="app-mark-icon" />
        </span>
        <span>
          <span className="app-name">桌面翻译</span>
          <span className="app-stage">Phase 2 · 内部开发预览</span>
        </span>
      </header>

      {(snapshotError !== null || actionError !== null) && (
        <div className="error-banner" role="alert">
          {actionError ?? snapshotError}
        </div>
      )}

      <section className="settings-section" aria-labelledby="general-heading">
        <h1 id="general-heading">常规</h1>
        <div className="settings-card">
          <SettingRow
            title="显示悬浮球"
            description="在桌面边缘显示快捷入口。"
            checked={snapshot.ball.visible}
            disabled={controlsDisabled}
            onChange={(visible) => {
              runAction('ball-visible', () => api.setBallVisible(visible));
            }}
          />
          <SettingRow
            title="自动吸附屏幕边缘"
            description="拖动结束后吸附到最近的左侧或右侧。"
            checked={snapshot.ball.edgeSnap}
            disabled={controlsDisabled}
            onChange={(enabled) => {
              runAction('edge-snap', () => api.setEdgeSnap(enabled));
            }}
          />
          <div className="setting-row setting-row-action">
            <span className="setting-copy">
              <span className="setting-title">悬浮球位置</span>
              <span className="setting-description">将悬浮球恢复到主屏幕右侧默认位置。</span>
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                runAction('reset', () => api.resetBallPosition());
              }}
            >
              {pendingAction === 'reset' ? '重置中…' : '重置位置'}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">外观</h2>
        <fieldset className="settings-card theme-fieldset">
          <legend className="setting-title">应用主题</legend>
          <p className="setting-description">选择设置窗口和悬浮球的显示方式。</p>
          <div className="theme-options">
            {THEME_OPTIONS.map((option) => (
              <label className="theme-option" key={option.value}>
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={snapshot.theme === option.value}
                  disabled={controlsDisabled}
                  onChange={() => {
                    runAction('theme', () => api.setTheme(option.value));
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="settings-section" aria-labelledby="status-heading">
        <h2 id="status-heading">关于与状态</h2>
        <div className="settings-card">
          <output className="status-row" aria-live="polite" aria-atomic="true">
            <span
              className="native-status-dot"
              data-status={snapshot.native.status}
              aria-hidden="true"
            />
            <span className="setting-copy">
              <span className="setting-title">原生服务：{nativeStatus.title}</span>
              <span className="setting-description">{nativeStatus.description}</span>
              {unavailableCapabilities.length > 0 && (
                <span className="capability-list">{unavailableCapabilities.join(' · ')}</span>
              )}
            </span>
          </output>
          <div className="version-row">
            <span>应用版本</span>
            <output>{APP_VERSION}</output>
          </div>
        </div>
      </section>
    </main>
  );
}
