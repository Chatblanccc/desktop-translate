import {
  ArrowResetRegular,
  CircleFilled,
  GlobeRegular,
  ScanTextRegular,
  SettingsRegular,
  ShieldAddFilled,
  ShieldRegular,
  type FluentIcon
} from '@fluentui/react-icons';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import {
  CLEAR_LOCAL_DATA_CONFIRMATION,
  type BaiduCredentialSummary,
  type NativeUiStatus,
  type OcrActivation,
  type SettingsRendererApi,
  type ThemeMode,
  useDocumentTheme,
  useUiShellSnapshot
} from '../shared/shell-api.js';

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.5.0';

type SettingsView = 'general' | 'selection' | 'translation' | 'privacy';

const SETTINGS_NAVIGATION: ReadonlyArray<{
  readonly id: SettingsView;
  readonly label: string;
  readonly icon: FluentIcon;
}> = [
  { id: 'general', label: '常规与外观', icon: SettingsRegular },
  { id: 'selection', label: '划词取词', icon: ScanTextRegular },
  { id: 'translation', label: '在线翻译', icon: GlobeRegular },
  { id: 'privacy', label: '隐私与关于', icon: ShieldRegular }
];

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
    description: '原生服务运行正常，可按取词设置启动监听。'
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

const OCR_OPTIONS: ReadonlyArray<{
  readonly value: OcrActivation;
  readonly label: string;
  readonly description: string;
}> = [
  { value: 'fallback', label: '自动识别（默认）', description: '自动判断并使用 OCR 识别' },
  { value: 'alt-drag', label: '仅 Alt + 拖动', description: '按住 Alt 并拖动画选区域时才识别' }
];

const TARGET_LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' }
] as const;

const SOURCE_LANGUAGE_OPTIONS = [
  { value: 'auto', label: '自动检测' },
  ...TARGET_LANGUAGE_OPTIONS
] as const;

const TRANSLATION_CONSENT_VERSION = 1;
const STORED_SECRET_MASK = '••••••••••••';
const EMPTY_CREDENTIAL_SUMMARY: BaiduCredentialSummary = Object.freeze({
  appId: '',
  secretConfigured: false
});

type PendingAction =
  | 'ball-visible'
  | 'edge-snap'
  | 'theme'
  | 'selection-enabled'
  | 'ocr-activation'
  | 'translation-enabled'
  | 'translation-source-language'
  | 'translation-target-language'
  | 'save-provider-credentials'
  | 'delete-provider-credentials'
  | 'test-provider'
  | 'open-provider-privacy'
  | 'open-provider-service-terms'
  | 'reset'
  | 'clear-local-data'
  | null;

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
      <span className="switch-cluster">
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
        <span className="switch-label" aria-hidden="true">{checked ? '开' : '关'}</span>
      </span>
    </div>
  );
}

export function SettingsApp({ api }: SettingsAppProps): JSX.Element {
  const { snapshot, loading, error: snapshotError } = useUiShellSnapshot(api);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [providerAppId, setProviderAppId] = useState('');
  const [providerSecretKey, setProviderSecretKey] = useState('');
  const [providerSummary, setProviderSummary] = useState<BaiduCredentialSummary | null>(null);
  const [providerSummaryLoaded, setProviderSummaryLoaded] = useState(false);
  const [providerConsent, setProviderConsent] = useState(false);
  const [providerFeedback, setProviderFeedback] = useState<string | null>(null);
  const [pendingSelectionEnabled, setPendingSelectionEnabled] = useState<boolean | null>(null);
  const [pendingTranslationEnabled, setPendingTranslationEnabled] = useState<boolean | null>(null);
  const [showClearDataConfirmation, setShowClearDataConfirmation] = useState(false);
  const [clearDataConfirmation, setClearDataConfirmation] = useState('');
  const [activeView, setActiveView] = useState<SettingsView>('selection');
  const contentRef = useRef<HTMLDivElement>(null);
  const clearDataInputRef = useRef<HTMLInputElement>(null);
  const nativeStatus = NATIVE_STATUS[snapshot.native.status];
  const controlsDisabled = loading || snapshotError !== null || pendingAction !== null;
  const credentialUnavailable = snapshot.translation.credentialStatus === 'unavailable';
  const providerConfigured = snapshot.translation.credentialStatus === 'configured';
  const providerSummaryLoading = providerConfigured && !providerSummaryLoaded;
  const storedSecretConfigured = providerConfigured
    && providerSummary?.secretConfigured === true;
  const credentialControlsDisabled = controlsDisabled || providerSummaryLoading;

  useDocumentTheme(snapshot.theme);

  useEffect(() => {
    if (pendingSelectionEnabled === snapshot.selection.enabled) {
      setPendingSelectionEnabled(null);
    }
  }, [pendingSelectionEnabled, snapshot.selection.enabled]);

  useEffect(() => {
    if (pendingTranslationEnabled === snapshot.translation.enabled) {
      setPendingTranslationEnabled(null);
    }
  }, [pendingTranslationEnabled, snapshot.translation.enabled]);

  useEffect(() => {
    let active = true;

    if (!providerConfigured) {
      setProviderSummary(EMPTY_CREDENTIAL_SUMMARY);
      setProviderSummaryLoaded(false);
      setProviderAppId('');
      setProviderSecretKey('');
      return () => {
        active = false;
      };
    }

    setProviderSummary(null);
    setProviderSummaryLoaded(false);
    void api.getBaiduCredentialSummary().then((summary) => {
      if (!active) return;
      setProviderSummary(summary);
      setProviderSummaryLoaded(true);
      setProviderAppId(summary.appId);
      setProviderSecretKey('');
    }, () => {
      if (!active) return;
      setProviderSummary(EMPTY_CREDENTIAL_SUMMARY);
      setProviderSummaryLoaded(true);
      setProviderAppId('');
      setProviderSecretKey('');
      setActionError('暂时无法读取已保存的凭据，请重新输入完整凭据。');
    });

    return () => {
      active = false;
    };
  }, [api, providerConfigured]);

  useEffect(() => {
    if (showClearDataConfirmation) clearDataInputRef.current?.focus();
  }, [showClearDataConfirmation]);

  const navigateTo = (view: SettingsView): void => {
    setActiveView(view);
    contentRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
  };

  const runAction = (
    action: Exclude<PendingAction, null>,
    operation: () => Promise<void>,
    onFailure?: () => void
  ): void => {
    setPendingAction(action);
    setActionError(null);
    void operation().catch(() => {
      onFailure?.();
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
        <span className="app-brand-copy">
          <span className="app-name">桌面翻译 <span aria-hidden="true">·</span> 设置</span>
        </span>
      </header>

      <aside className="settings-sidebar" aria-label="设置导航">

        <nav className="settings-navigation">
          {SETTINGS_NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className="settings-navigation-item"
                data-active={activeView === item.id}
                type="button"
                key={item.id}
                aria-current={activeView === item.id ? 'page' : undefined}
                onClick={() => navigateTo(item.id)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <footer className="sidebar-footer">
          <div className="sidebar-service-status">
            <span className="native-status-dot" data-status={snapshot.native.status} aria-hidden="true" />
            <span className="sidebar-service-copy">
              <span>服务状态：</span>
              <strong data-status={snapshot.native.status}>
                {snapshot.native.status === 'ready' ? '运行中' : nativeStatus.title}
              </strong>
            </span>
          </div>
          <span className="sidebar-version">版本 {APP_VERSION.replace(/-phase\d+$/i, '')}</span>
        </footer>
      </aside>

      <div className="settings-content" ref={contentRef}>
        {(snapshotError !== null || actionError !== null) && (
          <div className="error-banner" role="alert">
            {actionError ?? snapshotError}
          </div>
        )}

      <section hidden={activeView !== 'general'} className="settings-section settings-section-general" aria-labelledby="general-heading">
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
              <span className="setting-description">将悬浮球恢复到鼠标所在屏幕右侧默认位置。</span>
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                runAction('reset', () => api.resetBallPosition());
              }}
            >
              <ArrowResetRegular aria-hidden="true" />
              {pendingAction === 'reset' ? '重置中…' : '重置位置'}
            </button>
          </div>
        </div>
      </section>

      <section hidden={activeView !== 'selection'} className="settings-section settings-section-featured" aria-labelledby="selection-heading">
        <div className="section-heading">
          <div>
            <h1 id="selection-heading">划词取词</h1>
            <p>配置在屏幕上划词取词的行为与显示。</p>
          </div>
        </div>
        <div className="settings-card">
          <SettingRow
            title="启用划词取词"
            description="监听鼠标划选，优先读取应用提供的真实文字选区。"
            checked={pendingSelectionEnabled ?? snapshot.selection.enabled}
            disabled={controlsDisabled}
            onChange={(enabled) => {
              setPendingSelectionEnabled(enabled);
              runAction(
                'selection-enabled',
                () => api.setSelectionEnabled(enabled),
                () => setPendingSelectionEnabled(null)
              );
            }}
          />
          <fieldset className="selection-mode-fieldset">
            <legend className="setting-title">本地 OCR 使用方式</legend>
            <p className="setting-description">
              当应用无法提供真实文本时，使用本地 OCR 识别文字。识别过程完全在本机进行，数据不会上传或保存。
            </p>
            <div className="ocr-options">
              {OCR_OPTIONS.map((option) => (
                <label
                  className="ocr-option"
                  key={option.value}
                  aria-label={`${option.label}：${option.description}`}
                >
                  <input
                    type="radio"
                    name="ocr-activation"
                    value={option.value}
                    checked={snapshot.selection.ocrActivation === option.value}
                    disabled={controlsDisabled}
                    onChange={() => {
                      runAction('ocr-activation', () => api.setOcrActivation(option.value));
                    }}
                  />
                  <span className="ocr-option-copy">
                    <span className="ocr-option-title">{option.label}</span>
                    <span className="ocr-option-description">{option.description}</span>
                  </span>
                </label>
              ))}
              <span className="privacy-assurance">
                <ShieldAddFilled aria-hidden="true" />
                本地处理，数据不外传
              </span>
            </div>
          </fieldset>
          <div className="selection-status-heading">
            <span className="setting-title">取词状态</span>
            <span className="setting-description">显示当前划词取词功能与服务运行状态。</span>
          </div>
          <div className="selection-status-panel">
            <output
              className="selection-lifecycle"
              data-status={snapshot.selection.lifecycle}
              aria-live="polite"
            >
              <CircleFilled aria-hidden="true" />
              <span className="selection-lifecycle-copy">
                <span className="selection-lifecycle-title">划词取词：{
                  snapshot.selection.lifecycle === 'disabled' ? '已暂停'
                    : snapshot.selection.lifecycle === 'starting' ? '正在启动'
                      : snapshot.selection.lifecycle === 'listening' ? '已启用'
                        : snapshot.selection.lifecycle === 'degraded' ? '部分可用'
                          : '发生故障'
                }</span>
                <span className="selection-lifecycle-description">
                  {snapshot.selection.lifecycle === 'listening'
                    ? '监听服务运行正常，可随时使用。'
                    : nativeStatus.description}
                </span>
              </span>
            </output>
            <div className="service-lifecycle" data-status={snapshot.native.status}>
              <span>服务状态：</span>
              <strong>{snapshot.native.status === 'ready' ? '运行中' : nativeStatus.title}</strong>
            </div>
          </div>
        </div>
      </section>

      <section hidden={activeView !== 'general'} className="settings-section settings-section-appearance" aria-labelledby="appearance-heading">
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

      <section hidden={activeView !== 'translation'} className="settings-section settings-section-translation" aria-labelledby="translation-heading">
        <h1 id="translation-heading">在线翻译</h1>
        <div className="settings-card provider-settings-card">
          <SettingRow
            title="启用百度在线翻译"
            description={providerConfigured
              ? '划词原文将发送给百度翻译，失败时仍保留本地原文。'
              : '请先保存自己的百度翻译 APP ID 和密钥。'}
            checked={pendingTranslationEnabled ?? snapshot.translation.enabled}
            disabled={
              controlsDisabled
              || !providerConfigured
              || snapshot.translation.consentVersion < TRANSLATION_CONSENT_VERSION
            }
            onChange={(enabled) => {
              setPendingTranslationEnabled(enabled);
              runAction(
                'translation-enabled',
                () => api.setTranslationEnabled(enabled),
                () => setPendingTranslationEnabled(null)
              );
            }}
          />

          <div className="provider-language-row">
            <label className="setting-copy" htmlFor="translation-source-language">
              <span className="setting-title">源语言</span>
              <span className="setting-description">默认自动检测，也可以限定常用源语言。</span>
            </label>
            <select
              id="translation-source-language"
              value={snapshot.translation.sourceLanguage}
              disabled={controlsDisabled}
              onChange={(event) => {
                runAction(
                  'translation-source-language',
                  () => api.setTranslationSourceLanguage(event.currentTarget.value)
                );
              }}
            >
              {SOURCE_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="provider-language-row">
            <label className="setting-copy" htmlFor="translation-target-language">
              <span className="setting-title">目标语言</span>
              <span className="setting-description">可随时调整译文语言。</span>
            </label>
            <select
              id="translation-target-language"
              value={snapshot.translation.targetLanguage}
              disabled={controlsDisabled}
              onChange={(event) => {
                runAction(
                  'translation-target-language',
                  () => api.setTranslationTargetLanguage(event.currentTarget.value)
                );
              }}
            >
              {TARGET_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <fieldset
            className="provider-credentials"
            disabled={credentialControlsDisabled}
            aria-busy={providerSummaryLoading}
          >
            <legend className="setting-title">百度翻译凭据</legend>
            <p className="setting-description">
              凭据仅由 Electron Main 使用，并通过 Windows 安全存储加密后写入本机数据库；APP ID 会明文显示，密钥只显示固定掩码。
            </p>
            <label className="provider-input-label" htmlFor="provider-app-id">
              <span>APP ID</span>
              <input
                id="provider-app-id"
                type="text"
                autoComplete="off"
                maxLength={128}
                value={providerAppId}
                onChange={(event) => setProviderAppId(event.currentTarget.value)}
              />
            </label>
            <label className="provider-input-label" htmlFor="provider-secret-key">
              <span>密钥</span>
              <span className="provider-input-control">
                <input
                  id="provider-secret-key"
                  aria-label="密钥"
                  type="password"
                  autoComplete="new-password"
                  maxLength={512}
                  value={providerSecretKey}
                  placeholder={storedSecretConfigured ? STORED_SECRET_MASK : undefined}
                  aria-describedby={storedSecretConfigured ? 'provider-secret-hint' : undefined}
                  onChange={(event) => setProviderSecretKey(event.currentTarget.value)}
                />
                {storedSecretConfigured && (
                  <span id="provider-secret-hint" className="provider-secret-hint">
                    密钥已安全保存；输入新密钥将替换现有密钥。
                  </span>
                )}
              </span>
            </label>
            <label className="provider-consent" htmlFor="provider-consent">
              <input
                id="provider-consent"
                type="checkbox"
                checked={providerConsent}
                onChange={(event) => setProviderConsent(event.currentTarget.checked)}
              />
              <span>我已了解：启用后，选中的最终文本和语言参数会发送给百度翻译。</span>
            </label>
            <div className="provider-actions">
              <button
                className="primary-button"
                type="button"
                disabled={
                  credentialControlsDisabled
                  || providerAppId.trim().length === 0
                  || providerSecretKey.trim().length === 0
                  || !providerConsent
                }
                onClick={() => {
                  runAction('save-provider-credentials', async () => {
                    const trimmedAppId = providerAppId.trim();
                    await api.saveBaiduCredentials(
                      trimmedAppId,
                      providerSecretKey.trim(),
                      TRANSLATION_CONSENT_VERSION
                    );
                    setProviderSummary({ appId: trimmedAppId, secretConfigured: true });
                    setProviderSummaryLoaded(true);
                    setProviderAppId(trimmedAppId);
                    setProviderSecretKey('');
                    setProviderConsent(false);
                    setProviderFeedback('凭据已安全保存。');
                  });
                }}
              >
                {pendingAction === 'save-provider-credentials'
                  ? '保存中…'
                  : providerConfigured ? '替换凭据' : '保存凭据'}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={credentialControlsDisabled || !providerConfigured}
                onClick={() => {
                  runAction('test-provider', async () => {
                    const result = await api.testTranslationProvider();
                    setProviderFeedback(result.ok
                      ? '连接测试成功。'
                      : `连接测试失败：${result.code ?? 'unknown'}`);
                  });
                }}
              >
                {pendingAction === 'test-provider' ? '测试中…' : '测试连接'}
              </button>
              <button
                className="secondary-button danger-button"
                type="button"
                disabled={
                  credentialControlsDisabled
                  || snapshot.translation.credentialStatus === 'missing'
                }
                onClick={() => {
                  runAction('delete-provider-credentials', async () => {
                    await api.deleteBaiduCredentials();
                    setProviderSummary(EMPTY_CREDENTIAL_SUMMARY);
                    setProviderSummaryLoaded(false);
                    setProviderAppId('');
                    setProviderSecretKey('');
                    setProviderConsent(false);
                    setProviderFeedback('凭据已删除，在线翻译已关闭。');
                  });
                }}
              >
                删除凭据
              </button>
              <button
                className="link-button"
                type="button"
                disabled={credentialControlsDisabled}
                onClick={() => {
                  runAction('open-provider-privacy', () => api.openProviderPrivacyPolicy());
                }}
              >
                查看百度翻译隐私说明
              </button>
              <button
                className="link-button"
                type="button"
                disabled={credentialControlsDisabled}
                onClick={() => {
                  runAction('open-provider-service-terms', () => api.openProviderServiceTerms());
                }}
              >
                查看百度翻译开放平台服务条款
              </button>
            </div>
            <p className="provider-network-notice">
              “测试连接”会立即联网，但只发送固定英文探针，不发送当前选区文本。
            </p>
            <output className="provider-status" aria-live="polite">
              安全存储状态：{
                credentialUnavailable ? '不可用'
                  : providerConfigured ? '凭据已配置'
                    : '未配置凭据'
              }
              {providerFeedback === null ? '' : ` · ${providerFeedback}`}
            </output>
          </fieldset>
        </div>
      </section>

      <section hidden={activeView !== 'privacy'} className="settings-section settings-section-privacy" aria-labelledby="data-heading">
        <h1 id="data-heading">数据与隐私</h1>
        <div className="settings-card danger-zone">
          <div className="setting-row setting-row-action">
            <span className="setting-copy">
              <span className="setting-title">清除全部本地数据</span>
              <span className="setting-description">
                删除应用设置、Provider 凭据、本地数据库、性能指标和临时数据，然后退出应用。此操作无法撤销。
              </span>
            </span>
            {!showClearDataConfirmation && (
              <button
                className="secondary-button danger-button"
                type="button"
                disabled={controlsDisabled}
                aria-expanded={showClearDataConfirmation}
                aria-controls="clear-data-confirmation-panel"
                onClick={() => {
                  setClearDataConfirmation('');
                  setShowClearDataConfirmation(true);
                }}
              >
                开始清除…
              </button>
            )}
          </div>
          {showClearDataConfirmation && (
            <fieldset id="clear-data-confirmation-panel" className="clear-data-confirmation">
              <legend className="sr-only">清除全部本地数据最终确认</legend>
              <p className="clear-data-warning">
                请先确认没有需要保留的本地数据。请输入“{CLEAR_LOCAL_DATA_CONFIRMATION}”，再点击最终确认。
              </p>
              <label className="provider-input-label" htmlFor="clear-data-confirmation">
                <span>确认短语</span>
                <input
                  id="clear-data-confirmation"
                  ref={clearDataInputRef}
                  type="text"
                  autoComplete="off"
                  value={clearDataConfirmation}
                  disabled={controlsDisabled}
                  onChange={(event) => setClearDataConfirmation(event.currentTarget.value)}
                />
              </label>
              <div className="provider-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() => {
                    setClearDataConfirmation('');
                    setShowClearDataConfirmation(false);
                  }}
                >
                  取消
                </button>
                <button
                  className="primary-button destructive-button"
                  type="button"
                  disabled={
                    controlsDisabled || clearDataConfirmation !== CLEAR_LOCAL_DATA_CONFIRMATION
                  }
                  onClick={() => {
                    runAction(
                      'clear-local-data',
                      () => api.clearAllLocalData(CLEAR_LOCAL_DATA_CONFIRMATION)
                    );
                  }}
                >
                  {pendingAction === 'clear-local-data' ? '正在清除并退出…' : '确认清除并退出'}
                </button>
              </div>
            </fieldset>
          )}
        </div>
      </section>

      <section hidden={activeView !== 'privacy'} className="settings-section settings-section-status" aria-labelledby="status-heading">
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
            <output>{APP_VERSION.replace(/-phase\d+$/i, '')}</output>
          </div>
        </div>
      </section>
      </div>
    </main>
  );
}
