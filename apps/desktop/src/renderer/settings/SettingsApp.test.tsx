// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsApp } from './SettingsApp.js';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type SettingsRendererApi,
  type UiShellSnapshot
} from '../shared/shell-api.js';

afterEach(cleanup);

const STORED_SECRET_MASK = '••••••••••••';

type SettingsViewLabel = '常规与外观' | '划词取词' | '在线翻译' | '隐私与关于';

function openSettingsView(label: SettingsViewLabel): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

function createSettingsApi(snapshot: UiShellSnapshot = DEFAULT_UI_SHELL_SNAPSHOT): {
  readonly api: SettingsRendererApi;
  readonly getBaiduCredentialSummary: ReturnType<typeof vi.fn>;
  readonly setBallVisible: ReturnType<typeof vi.fn>;
  readonly setEdgeSnap: ReturnType<typeof vi.fn>;
  readonly setTheme: ReturnType<typeof vi.fn>;
  readonly setSelectionEnabled: ReturnType<typeof vi.fn>;
  readonly setOcrActivation: ReturnType<typeof vi.fn>;
  readonly setTranslationEnabled: ReturnType<typeof vi.fn>;
  readonly setTranslationSourceLanguage: ReturnType<typeof vi.fn>;
  readonly setTranslationTargetLanguage: ReturnType<typeof vi.fn>;
  readonly saveBaiduCredentials: ReturnType<typeof vi.fn>;
  readonly deleteBaiduCredentials: ReturnType<typeof vi.fn>;
  readonly testTranslationProvider: ReturnType<typeof vi.fn>;
  readonly openProviderPrivacyPolicy: ReturnType<typeof vi.fn>;
  readonly openProviderServiceTerms: ReturnType<typeof vi.fn>;
  readonly resetBallPosition: ReturnType<typeof vi.fn>;
  readonly clearAllLocalData: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  const getBaiduCredentialSummary = vi.fn().mockResolvedValue(
    snapshot.translation.credentialStatus === 'configured'
      ? { appId: 'configured-app-id', secretConfigured: true }
      : { appId: '', secretConfigured: false }
  );
  const setBallVisible = vi.fn().mockResolvedValue(undefined);
  const setEdgeSnap = vi.fn().mockResolvedValue(undefined);
  const setTheme = vi.fn().mockResolvedValue(undefined);
  const setSelectionEnabled = vi.fn().mockResolvedValue(undefined);
  const setOcrActivation = vi.fn().mockResolvedValue(undefined);
  const setTranslationEnabled = vi.fn().mockResolvedValue(undefined);
  const setTranslationSourceLanguage = vi.fn().mockResolvedValue(undefined);
  const setTranslationTargetLanguage = vi.fn().mockResolvedValue(undefined);
  const saveBaiduCredentials = vi.fn().mockResolvedValue(undefined);
  const deleteBaiduCredentials = vi.fn().mockResolvedValue(undefined);
  const testTranslationProvider = vi.fn().mockResolvedValue({ ok: true });
  const openProviderPrivacyPolicy = vi.fn().mockResolvedValue(undefined);
  const openProviderServiceTerms = vi.fn().mockResolvedValue(undefined);
  const resetBallPosition = vi.fn().mockResolvedValue(undefined);
  const clearAllLocalData = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();

  return {
    api: {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      getBaiduCredentialSummary,
      onSnapshotChanged: vi.fn().mockReturnValue(unsubscribe),
      setBallVisible,
      setEdgeSnap,
      setTheme,
      setSelectionEnabled,
      setOcrActivation,
      setTranslationEnabled,
      setTranslationSourceLanguage,
      setTranslationTargetLanguage,
      saveBaiduCredentials,
      deleteBaiduCredentials,
      testTranslationProvider,
      openProviderPrivacyPolicy,
      openProviderServiceTerms,
      resetBallPosition,
      clearAllLocalData
    },
    getBaiduCredentialSummary,
    setBallVisible,
    setEdgeSnap,
    setTheme,
    setSelectionEnabled,
    setOcrActivation,
    setTranslationEnabled,
    setTranslationSourceLanguage,
    setTranslationTargetLanguage,
    saveBaiduCredentials,
    deleteBaiduCredentials,
    testTranslationProvider,
    openProviderPrivacyPolicy,
    openProviderServiceTerms,
    resetBallPosition,
    clearAllLocalData,
    unsubscribe
  };
}

describe('SettingsApp', () => {
  it('presents the Phase 6 settings navigation without internal phase labels', async () => {
    const { api } = createSettingsApi();
    render(<SettingsApp api={api} />);

    expect(await screen.findByRole('navigation')).toBeTruthy();
    expect(screen.getByRole('button', { name: '划词取词' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: '划词取词' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '常规' })).toBeNull();

    openSettingsView('常规与外观');
    expect(screen.getByRole('button', { name: '常规与外观' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: '常规' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '划词取词' })).toBeNull();
    expect(screen.queryByText(/Phase \d/u)).toBeNull();
  });

  it('requires a two-step exact confirmation before clearing all local data', async () => {
    const { api, clearAllLocalData } = createSettingsApi();
    render(<SettingsApp api={api} />);
    openSettingsView('隐私与关于');

    const begin = await screen.findByRole('button', { name: '开始清除…' });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(begin);

    const finalConfirmation = screen.getByRole('button', { name: '确认清除并退出' });
    expect((finalConfirmation as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('确认短语'), {
      target: { value: '清除全部本地数据 ' }
    });
    expect((finalConfirmation as HTMLButtonElement).disabled).toBe(true);
    expect(clearAllLocalData).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('确认短语'), {
      target: { value: '清除全部本地数据' }
    });
    expect((finalConfirmation as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(finalConfirmation);

    await waitFor(() => expect(clearAllLocalData).toHaveBeenCalledWith('清除全部本地数据'));
  });

  it('can cancel the destructive confirmation without invoking Main', async () => {
    const { api, clearAllLocalData } = createSettingsApi();
    render(<SettingsApp api={api} />);
    openSettingsView('隐私与关于');
    const begin = await screen.findByRole('button', { name: '开始清除…' });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(begin);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByLabelText('确认短语')).toBeNull();
    expect(clearAllLocalData).not.toHaveBeenCalled();
  });

  it('exposes the planned shell controls and delegates changes', async () => {
    const { api, setBallVisible, setEdgeSnap, setTheme, resetBallPosition } = createSettingsApi();
    render(<SettingsApp api={api} />);
    openSettingsView('常规与外观');

    const visibleToggle = await screen.findByRole('checkbox', { name: /显示悬浮球/ });
    const snapToggle = screen.getByRole('checkbox', { name: /自动吸附屏幕边缘/ });

    await waitFor(() => {
      expect((visibleToggle as HTMLInputElement).disabled).toBe(false);
    });

    fireEvent.click(visibleToggle);
    await waitFor(() => {
      expect(setBallVisible).toHaveBeenCalledWith(false);
      expect((snapToggle as HTMLInputElement).disabled).toBe(false);
    });

    fireEvent.click(snapToggle);
    await waitFor(() => {
      expect(setEdgeSnap).toHaveBeenCalledWith(false);
    });

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    await waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith('dark');
    });

    fireEvent.click(screen.getByRole('button', { name: '重置位置' }));
    await waitFor(() => {
      expect(resetBallPosition).toHaveBeenCalledOnce();
    });
  });

  it('renders degraded capabilities and the application version', async () => {
    const degradedSnapshot: UiShellSnapshot = {
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      native: {
        status: 'degraded',
        degradedCapabilities: ['ocr']
      }
    };
    const { api } = createSettingsApi(degradedSnapshot);
    render(<SettingsApp api={api} />);
    openSettingsView('隐私与关于');

    await waitFor(() => {
      expect(screen.getByText('原生服务：部分可用')).toBeTruthy();
    });
    expect(screen.getByText('OCR 未配置')).toBeTruthy();
    expect(screen.getAllByText(/0\.5\.0/).length).toBeGreaterThan(0);
  });

  it('persists Phase 3 selection and OCR activation controls', async () => {
    const { api, setSelectionEnabled, setOcrActivation } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      native: { status: 'ready', degradedCapabilities: [] },
      selection: { enabled: true, lifecycle: 'listening', ocrActivation: 'fallback' }
    });
    render(<SettingsApp api={api} />);

    const selectionToggle = await screen.findByRole('checkbox', { name: /启用划词取词/ });
    await waitFor(() => expect((selectionToggle as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(selectionToggle);
    await waitFor(() => expect(setSelectionEnabled).toHaveBeenCalledWith(false));

    fireEvent.click(screen.getByRole('radio', { name: /仅 Alt \+ 拖动/u }));
    await waitFor(() => expect(setOcrActivation).toHaveBeenCalledWith('alt-drag'));
    expect(screen.getByText(/划词取词：已启用/)).toBeTruthy();
    expect(screen.getAllByText('服务状态：')).toHaveLength(2);
  });

  it('allows selection to be paused while the native host is unavailable', async () => {
    const { api, setSelectionEnabled } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      native: { status: 'unavailable', degradedCapabilities: [] },
      selection: { enabled: true, lifecycle: 'faulted', ocrActivation: 'fallback' }
    });
    render(<SettingsApp api={api} />);
    const selectionToggle = await screen.findByRole('checkbox', { name: /启用划词取词/ });
    await waitFor(() => expect((selectionToggle as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(selectionToggle);
    await waitFor(() => expect(setSelectionEnabled).toHaveBeenCalledWith(false));
  });

  it('keeps the selection toggle optimistic while Main persists it and rolls back on failure', async () => {
    const { api, setSelectionEnabled } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      native: { status: 'ready', degradedCapabilities: [] },
      selection: { enabled: true, lifecycle: 'listening', ocrActivation: 'fallback' }
    });
    let rejectAction: ((reason?: unknown) => void) | undefined;
    setSelectionEnabled.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectAction = reject;
    }));
    render(<SettingsApp api={api} />);

    const enabled = await screen.findByRole('checkbox', { name: /启用划词取词/u });
    await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(enabled);

    expect((enabled as HTMLInputElement).checked).toBe(false);
    expect((enabled as HTMLInputElement).disabled).toBe(true);
    rejectAction?.(new Error('persistence failed'));

    await waitFor(() => {
      expect((enabled as HTMLInputElement).checked).toBe(true);
      expect((enabled as HTMLInputElement).disabled).toBe(false);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/设置未能保存/u);
  });

  it('requires consent before saving credentials and enables configured translation', async () => {
    const {
      api,
      saveBaiduCredentials,
      deleteBaiduCredentials,
      setTranslationEnabled,
      setTranslationSourceLanguage,
      setTranslationTargetLanguage,
      openProviderPrivacyPolicy,
      openProviderServiceTerms
    } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      translation: {
        enabled: false,
        providerId: 'baidu',
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        credentialStatus: 'configured',
        consentVersion: 1
      }
    });
    render(<SettingsApp api={api} />);
    openSettingsView('在线翻译');
    const enabled = await screen.findByRole('checkbox', { name: /启用百度在线翻译/u });
    await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(enabled);
    await waitFor(() => expect(setTranslationEnabled).toHaveBeenCalledWith(true));

    fireEvent.change(screen.getByRole('combobox', { name: /目标语言/u }), {
      target: { value: 'en' }
    });
    await waitFor(() => expect(setTranslationTargetLanguage).toHaveBeenCalledWith('en'));

    fireEvent.change(screen.getByRole('combobox', { name: /源语言/u }), {
      target: { value: 'ja' }
    });
    await waitFor(() => expect(setTranslationSourceLanguage).toHaveBeenCalledWith('ja'));

    const appIdInput = screen.getByLabelText('APP ID') as HTMLInputElement;
    const secretInput = screen.getByLabelText('密钥') as HTMLInputElement;
    await waitFor(() => expect(appIdInput.value).toBe('configured-app-id'));
    expect(secretInput.type).toBe('password');
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe(STORED_SECRET_MASK);
    expect(screen.getByText('密钥已安全保存；输入新密钥将替换现有密钥。')).toBeTruthy();

    fireEvent.change(appIdInput, { target: { value: '  app-id  ' } });
    fireEvent.change(secretInput, { target: { value: 'secret-key' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解/u }));
    fireEvent.click(screen.getByRole('button', { name: '替换凭据' }));
    await waitFor(() => expect(saveBaiduCredentials).toHaveBeenCalledWith(
      'app-id', 'secret-key', 1
    ));
    await waitFor(() => expect(appIdInput.value).toBe('app-id'));
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe(STORED_SECRET_MASK);
    expect(document.body.textContent).not.toContain('secret-key');

    const privacyButton = screen.getByRole('button', { name: '查看百度翻译隐私说明' });
    await waitFor(() => expect((privacyButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(privacyButton);
    await waitFor(() => expect(openProviderPrivacyPolicy).toHaveBeenCalledOnce());
    const termsButton = screen.getByRole('button', {
      name: '查看百度翻译开放平台服务条款'
    });
    await waitFor(() => expect((termsButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(termsButton);
    await waitFor(() => expect(openProviderServiceTerms).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: '删除凭据' }));
    await waitFor(() => expect(deleteBaiduCredentials).toHaveBeenCalledOnce());
    await waitFor(() => expect(appIdInput.value).toBe(''));
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe('');
    expect(screen.queryByText('密钥已安全保存；输入新密钥将替换现有密钥。')).toBeNull();
  });

  it('keeps the credential form disabled until the safe summary is loaded', async () => {
    const { api, getBaiduCredentialSummary } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      translation: {
        ...DEFAULT_UI_SHELL_SNAPSHOT.translation,
        credentialStatus: 'configured',
        consentVersion: 1
      }
    });
    let resolveSummary: ((value: { appId: string; secretConfigured: true }) => void) | undefined;
    getBaiduCredentialSummary.mockImplementation(() => new Promise((resolve) => {
      resolveSummary = resolve;
    }));

    render(<SettingsApp api={api} />);
    openSettingsView('在线翻译');
    const appIdInput = await screen.findByLabelText('APP ID') as HTMLInputElement;
    const secretInput = screen.getByLabelText('密钥') as HTMLInputElement;
    const credentialFieldset = appIdInput.closest('fieldset') as HTMLFieldSetElement;

    await waitFor(() => expect(credentialFieldset.disabled).toBe(true));
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe('');

    resolveSummary?.({ appId: 'loaded-app-id', secretConfigured: true });
    await waitFor(() => {
      expect(credentialFieldset.disabled).toBe(false);
      expect(appIdInput.value).toBe('loaded-app-id');
    });
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe(STORED_SECRET_MASK);
  });

  it('fails safely when the configured credential summary cannot be read', async () => {
    const { api, getBaiduCredentialSummary } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      translation: {
        ...DEFAULT_UI_SHELL_SNAPSHOT.translation,
        credentialStatus: 'configured',
        consentVersion: 1
      }
    });
    getBaiduCredentialSummary.mockRejectedValue(new Error('sensitive storage detail'));

    render(<SettingsApp api={api} />);
    openSettingsView('在线翻译');

    expect((await screen.findByRole('alert')).textContent).toContain(
      '暂时无法读取已保存的凭据'
    );
    const appIdInput = screen.getByLabelText('APP ID') as HTMLInputElement;
    const secretInput = screen.getByLabelText('密钥') as HTMLInputElement;
    expect(appIdInput.value).toBe('');
    expect(secretInput.value).toBe('');
    expect(secretInput.placeholder).toBe('');
    expect(appIdInput.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('sensitive storage detail');
  });

  it('keeps the translation toggle optimistic while Main persists it and rolls back on failure', async () => {
    const { api, setTranslationEnabled } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      translation: {
        enabled: false,
        providerId: 'baidu',
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        credentialStatus: 'configured',
        consentVersion: 1
      }
    });
    let rejectAction: ((reason?: unknown) => void) | undefined;
    setTranslationEnabled.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectAction = reject;
    }));
    render(<SettingsApp api={api} />);
    openSettingsView('在线翻译');

    const enabled = await screen.findByRole('checkbox', { name: /启用百度在线翻译/u });
    await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(enabled);

    expect((enabled as HTMLInputElement).checked).toBe(true);
    expect((enabled as HTMLInputElement).disabled).toBe(true);
    rejectAction?.(new Error('persistence failed'));

    await waitFor(() => {
      expect((enabled as HTMLInputElement).checked).toBe(false);
      expect((enabled as HTMLInputElement).disabled).toBe(false);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/设置未能保存/u);
  });

  it('allows unavailable credentials to be deleted or replaced through the recovery path', async () => {
    const { api, saveBaiduCredentials, deleteBaiduCredentials } = createSettingsApi({
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      translation: {
        enabled: false,
        providerId: 'baidu',
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        credentialStatus: 'unavailable',
        consentVersion: 1
      }
    });
    render(<SettingsApp api={api} />);
    openSettingsView('在线翻译');

    const appId = await screen.findByLabelText('APP ID');
    await waitFor(() => expect((appId as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(appId, { target: { value: 'replacement-app' } });
    fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'replacement-secret' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解/u }));
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }));
    await waitFor(() => expect(saveBaiduCredentials).toHaveBeenCalledWith(
      'replacement-app', 'replacement-secret', 1
    ));

    const deleteButton = screen.getByRole('button', { name: '删除凭据' });
    await waitFor(() => expect((deleteButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteBaiduCredentials).toHaveBeenCalledOnce());
  });

  it('shows a safe message when the initial snapshot cannot be loaded', async () => {
    const { api } = createSettingsApi();
    api.getSnapshot = vi.fn().mockRejectedValue(new Error('sensitive native detail'));
    render(<SettingsApp api={api} />);

    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取应用状态');
    expect(screen.queryByText('sensitive native detail')).toBeNull();
  });

  it('keeps settings read-only until the persisted snapshot is available', () => {
    const { api, setBallVisible } = createSettingsApi();
    api.getSnapshot = vi.fn(() => new Promise<UiShellSnapshot>(() => undefined));
    render(<SettingsApp api={api} />);
    openSettingsView('常规与外观');

    const visibleToggle = screen.getByRole('checkbox', { name: /显示悬浮球/ });
    expect((visibleToggle as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(visibleToggle);
    expect(setBallVisible).not.toHaveBeenCalled();
  });

  it('removes the snapshot listener when the settings window unmounts', () => {
    const { api, unsubscribe } = createSettingsApi();
    const view = render(<SettingsApp api={api} />);

    view.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
