// Global capability settings, mounted on 环境与连接 (BUILD-SPEC-B §6.4). Sections carry the ids the page's section
// nav scrolls to: env-runtime env-api env-docworker env-mcp env-skills env-media env-advanced (in that order, so the
// media copy "以上方运行状态为准" stays true). Unsaved edits survive navigation as a session draft; a sticky bar
// counts them. A successful save, and a successful 重载状态, announce `workbench:capabilities-changed` so the status
// bar and the page's nav glyphs refetch too.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { chatApi, type ApiChatConfiguration, type ChatCapabilities, type ChatSettings, type ExecCapability, type ServiceCapability } from '../../lib/chat-api';
import { AdvancedSection } from './settings/AdvancedSection';
import { ApiConfigurationStatus } from './settings/ApiSection';
import { McpSection } from './settings/McpSection';
import { MediaSettingsSection } from './settings/MediaSection';
import { draftWrite, initialPanelState, panelReducer } from './settings/panelState';
import { SettingsSaveBar, StaleDraftPrompt } from './settings/SaveBar';
import { DocWorkerSection, RuntimeSection } from './settings/ServicesSection';
import { SkillsSection } from './settings/SkillsSection';
import { clearSettingsDraft, countSettingsChanges, readSettingsDraft, resolveSettingsDraft, writeSettingsDraft } from './settings/settingsDraft';
import './settings.css';

// Every export the tests and other pages import from this module stays here.
export { ServiceStatusList } from './settings/ServicesSection';
export { ApiConfigurationStatus } from './settings/ApiSection';
export { mcpApiKeyHeader, renameTool, setToolAccess } from './settings/McpSection';
export { MediaSettingsSection, mediaProvider, newCodexMedia, newMedia, selectMediaProvider, updateCodexMedia, type MediaProvider } from './settings/MediaSection';

/** Dispatched on window after a successful save or 重载状态, so the status bar and pages refetch capabilities. */
export const CAPABILITIES_CHANGED_EVENT = 'workbench:capabilities-changed';
const stringify = (settings: ChatSettings) => JSON.stringify(settings, null, 2);

/**
 * 重载状态: re-reads settings and capabilities, then announces the change only when the read succeeded. The mount-time
 * read does not announce, or every listener would fetch twice on each page open. SettingsPanel does not listen to its
 * own event, so this cannot loop.
 */
export async function reloadThenAnnounce(load: () => Promise<boolean>, target: EventTarget = window): Promise<boolean> {
  const ok = await load();
  if (ok) target.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
  return ok;
}

export interface SettingsPanelProps {
  /** Called with the number of unsaved changes whenever it changes (the Environment status cell shows it). */
  onDirtyChange?(count: number): void;
}

export default function SettingsPanel({ onDirtyChange }: SettingsPanelProps = {}) {
  const [{ loaded, settings, staleDraft, rowKeys }, dispatch] = useReducer(panelReducer, initialPanelState);
  const [services, setServices] = useState<ServiceCapability[]>([]);
  const [exec, setExec] = useState<ExecCapability>();
  const [apiConfiguration, setApiConfiguration] = useState<ApiChatConfiguration>();
  const [advancedEdit, setAdvancedEdit] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = useMemo(() => countSettingsChanges(loaded, settings), [loaded, settings]);
  const dirtyListener = useRef(onDirtyChange);
  dirtyListener.current = onDirtyChange;
  /** 运行状态's heading: where focus lands once an inline prompt that held it goes away. */
  const runtimeHeading = useRef<HTMLHeadingElement>(null);

  function applyCapabilities(capabilities: ChatCapabilities) {
    setServices(capabilities.services ?? []);
    setExec(capabilities.exec);
    setApiConfiguration(capabilities.apiConfiguration);
  }

  /** Resolves true when settings and capabilities were read. */
  async function load(signal?: AbortSignal, options: { discard?: boolean } = {}): Promise<boolean> {
    setLoading(true); setError(''); setNotice('');
    if (options.discard) clearSettingsDraft();
    try {
      const [nextSettings, capabilities] = await Promise.all([chatApi.settings(signal), chatApi.capabilities(signal)]);
      dispatch({ type: 'loaded', settings: nextSettings, draft: resolveSettingsDraft(readSettingsDraft(), nextSettings) });
      setAdvancedEdit(null);
      applyCapabilities(capabilities);
      return true;
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : '能力设置读取失败');
      return false;
    } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);

  // The draft follows the form: written while dirty, removed when clean, untouched while a stale draft awaits a decision.
  useEffect(() => {
    const next = draftWrite({ loaded, settings, staleDraft });
    if (next.kind === 'write') writeSettingsDraft(next.draft);
    else if (next.kind === 'clear') clearSettingsDraft();
  }, [loaded, settings, staleDraft]);
  useEffect(() => { dirtyListener.current?.(dirty); }, [dirty]);
  const hasChanges = dirty > 0;
  useEffect(() => {
    if (!hasChanges) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasChanges]);

  function commit(updater: (current: ChatSettings) => ChatSettings) {
    dispatch({ type: 'edit', update: updater });
    setAdvancedEdit(null);
    setNotice('');
  }
  function applyAdvanced() {
    try {
      const parsed = JSON.parse(advancedEdit ?? (settings ? stringify(settings) : '')) as ChatSettings;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills) || !Array.isArray(parsed.mcp)) throw new Error('JSON 缺少 version、skills 或 mcp');
      dispatch({ type: 'replace', settings: parsed }); setAdvancedEdit(null); setError(''); setNotice('高级 JSON 已应用到表单，尚未保存。');
    } catch (cause) { setError(cause instanceof Error ? `高级配置无效：${cause.message}` : '高级配置无效'); }
  }
  function discard() {
    dispatch({ type: 'discard' }); setAdvancedEdit(null); setError(''); setNotice('');
    clearSettingsDraft();
  }
  async function save() {
    if (!settings || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await chatApi.saveSettings(settings);
      window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
      const [saved, capabilities] = await Promise.all([chatApi.settings(), chatApi.capabilities()]);
      dispatch({ type: 'saved', settings: saved }); setAdvancedEdit(null); applyCapabilities(capabilities);
      clearSettingsDraft();
      setNotice('配置已保存并重新加载运行状态。');
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? `当前不能保存：${cause.message}` : cause instanceof Error ? cause.message : '能力设置保存失败');
    } finally { setSaving(false); }
  }
  // The prompt unmounts with its focused button, so focus moves to the next stable landmark first.
  function resolveStaleDraft(restore: boolean) {
    dispatch({ type: restore ? 'restoreDraft' : 'dropDraft' });
    if (restore) setAdvancedEdit(null);
    setNotice(restore ? '草稿已恢复，尚未保存。' : '已放弃草稿，表单为当前配置。');
    runtimeHeading.current?.focus();
  }

  if (loading && !settings) return <div className="settings-panel is-pending"><p className="panel settings-card settings-loading" role="status">正在读取能力配置与运行状态…</p></div>;
  if (!settings) return <div className="settings-panel is-pending"><div className="panel settings-card settings-feedback">
    <p className="chat-error" role="alert">{error || '能力设置不可用'}</p>
    <button type="button" className="button compact" onClick={() => void load()}>重试</button>
  </div></div>;
  return <div className="settings-panel">
    {staleDraft ? <StaleDraftPrompt onRestore={() => resolveStaleDraft(true)} onDiscard={() => resolveStaleDraft(false)} /> : null}
    <RuntimeSection exec={exec} services={services} loading={loading} saving={saving} dirty={dirty} headingRef={runtimeHeading}
      onReload={() => void reloadThenAnnounce(() => load(undefined, { discard: dirty > 0 }))} />
    <ApiConfigurationStatus configuration={apiConfiguration} />
    <DocWorkerSection settings={settings} onChange={commit} />
    <McpSection settings={settings} onChange={commit} rowKeys={rowKeys.mcp} />
    <SkillsSection settings={settings} onChange={commit} rowKeys={rowKeys.skills} />
    <MediaSettingsSection settings={settings} onChange={next => commit(() => next)} />
    <AdvancedSection value={advancedEdit ?? stringify(settings)} onValue={setAdvancedEdit} onApply={applyAdvanced} />
    <SettingsSaveBar dirty={dirty} saving={saving} error={error} notice={notice} onDiscard={discard} onSave={() => void save()} />
  </div>;
}
