import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatSettings, McpSetting } from '../../../lib/chat-api';
import { CAPABILITIES_CHANGED_EVENT, reloadThenAnnounce } from '../SettingsPanel';
import { McpItem, McpSection, renameTool } from './McpSection';
import { carryRowKeys, draftWrite, initialPanelState, panelReducer, type PanelAction, type PanelState } from './panelState';
import { StaleDraftPrompt } from './SaveBar';
import { RuntimeSection } from './ServicesSection';
import { SkillsSection } from './SkillsSection';
import { resolveSettingsDraft, settingsHash } from './settingsDraft';

const mcp = (id: string): McpSetting => ({ id, enabled: true, transport: 'http', url: 'http://127.0.0.1:3000', toolAllowlist: ['search', 'fetch'], toolAccess: { search: 'read', fetch: 'read' }, allowWrites: false, writeToolAllowlist: [], timeoutMs: 30_000, maxOutputBytes: 1024 });
const settings = (): ChatSettings => ({
  version: 1,
  skills: [{ id: 'team', root: 'D:\\Skills', enabled: true }, { id: 'own', root: 'E:\\Skills', enabled: false }],
  mcp: [mcp('mcp_1'), mcp('mcp_2'), mcp('mcp_3')],
  documentWorker: { enabled: true, url: 'http://127.0.0.1:18781' },
  media: {},
});
const run = (state: PanelState, ...actions: PanelAction[]) => actions.reduce(panelReducer, state);
const editUrl = (url: string): PanelAction => ({ type: 'edit', update: current => ({ ...current, documentWorker: { ...current.documentWorker, url } }) });
/** The React elements in a tree, without rendering function components (their props stay unexpanded). */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach(child => elements(child, out));
  else if (isValidElement(node)) { out.push(node); elements((node.props as { children?: ReactNode }).children, out); }
  return out;
}

describe('settings panel state: the stale-draft prompt (草稿基于较早读取的配置)', () => {
  const server = settings();
  const older = { ...server, documentWorker: { ...server.documentWorker, enabled: false } };
  const staleState = () => run(initialPanelState, { type: 'loaded', settings: server, draft: resolveSettingsDraft({ hash: 'older-hash', settings: older }, server) });

  it('leaves the stored draft alone while the prompt waits for a decision', () => {
    const state = staleState();
    expect(state.staleDraft).toEqual(older);
    expect(state.settings).toBe(server);
    expect(draftWrite(state)).toEqual({ kind: 'keep' });
  });

  it('treats an edit made while the prompt shows as declining the old draft, so the edit reaches the session draft', () => {
    const state = run(staleState(), editUrl('http://127.0.0.1:19999'));
    expect(state.staleDraft).toBeNull();
    const write = draftWrite(state);
    expect(write.kind).toBe('write');
    if (write.kind !== 'write') return;
    expect(write.draft.hash).toBe(settingsHash(server));
    expect(write.draft.settings.documentWorker.url).toBe('http://127.0.0.1:19999');
  });

  it('closes the prompt after a save, 放弃更改 or applied advanced JSON, so an older draft cannot come back over them', () => {
    const saved = { ...server, documentWorker: { ...server.documentWorker, url: 'http://127.0.0.1:18790' } };
    expect(run(staleState(), { type: 'saved', settings: saved }).staleDraft).toBeNull();
    expect(run(staleState(), { type: 'discard' }).staleDraft).toBeNull();
    expect(run(staleState(), { type: 'replace', settings: saved }).staleDraft).toBeNull();
    expect(draftWrite(run(staleState(), { type: 'saved', settings: saved }))).toEqual({ kind: 'clear' });
  });

  it('restores the draft into the form (dirty, still unsaved) or drops it', () => {
    const restored = run(staleState(), { type: 'restoreDraft' });
    expect(restored.settings).toEqual(older);
    expect(restored.staleDraft).toBeNull();
    expect(draftWrite(restored).kind).toBe('write');
    const dropped = run(staleState(), { type: 'dropDraft' });
    expect(dropped.settings).toBe(server);
    expect(draftWrite(dropped)).toEqual({ kind: 'clear' });
  });

  it('says on the prompt that editing the form drops the old draft', () => {
    expect(renderToStaticMarkup(<StaleDraftPrompt onRestore={() => undefined} onDiscard={() => undefined} />)).toContain('直接编辑表单则视为放弃这份草稿');
  });
});

describe('settings rows keep their key while their ID or tool name is typed in', () => {
  const loadedState = () => run(initialPanelState, { type: 'loaded', settings: settings(), draft: { kind: 'none' } });
  const typeMcpId = (index: number, id: string): PanelAction => ({ type: 'edit', update: current => ({ ...current, mcp: current.mcp.map((item, at) => at === index ? { ...item, id } : item) }) });

  it('gives every MCP and Skill row its own key and carries it across edits, removals and additions', () => {
    const state = loadedState();
    expect(new Set([...state.rowKeys.mcp, ...state.rowKeys.skills]).size).toBe(5);
    const typed = run(state, typeMcpId(0, 'mcp_1x'), typeMcpId(0, 'mcp_1xy'));
    expect(typed.rowKeys).toEqual(state.rowKeys);
    const removed = run(state, { type: 'edit', update: current => ({ ...current, mcp: current.mcp.filter((_, at) => at !== 1) }) });
    expect(removed.rowKeys.mcp).toEqual([state.rowKeys.mcp[0], state.rowKeys.mcp[2]]);
    const added = run(removed, { type: 'edit', update: current => ({ ...current, skills: [...current.skills, { id: 'new', root: 'C:\\x', enabled: true }] }) });
    expect(added.rowKeys.skills.slice(0, 2)).toEqual(state.rowKeys.skills);
    expect([...state.rowKeys.mcp, ...state.rowKeys.skills]).not.toContain(added.rowKeys.skills[2]);
  });

  it('falls back to leading keys when a list is replaced by a shorter one', () => {
    let next = 0;
    expect(carryRowKeys([{}, {}, {}], ['a', 'b', 'c'], [{}, {}], () => `n${++next}`)).toEqual(['a', 'b']);
    expect(carryRowKeys([], [], [{}], () => `n${++next}`)).toEqual(['n1']);
  });

  it('keys MCP items by the row key, not by the ID being typed', () => {
    const base = settings();
    const keys = ['row-1', 'row-2', 'row-3'];
    const itemKeys = (value: ChatSettings) => elements(McpSection({ settings: value, onChange: () => undefined, rowKeys: keys })).filter(element => element.type === McpItem).map(element => element.key);
    const typed = { ...base, mcp: base.mcp.map((item, at) => at === 0 ? { ...item, id: 'mcp_1x' } : item) };
    expect(itemKeys(base)).toEqual(keys);
    expect(itemKeys(typed)).toEqual(itemKeys(base));
  });

  it('keys tool rows by position, so renaming a tool keeps its row (and its focused input)', () => {
    const item = mcp('docs');
    const rowKeys = (value: McpSetting) => elements(McpItem({ item: value, onUpdate: () => undefined, onRemove: () => undefined })).filter(element => (element.props as { className?: string }).className === 'tool-access-row').map(element => element.key);
    const renamed = renameTool(item, 'search', 'searchx');
    expect(renamed.toolAllowlist).toEqual(['searchx', 'fetch']);
    expect(rowKeys(renamed)).toEqual(rowKeys(item));
  });

  it('keys Skill rows by the row key, not by the ID being typed', () => {
    const base = settings();
    const rowKeys = (value: ChatSettings) => elements(SkillsSection({ settings: value, onChange: () => undefined, rowKeys: ['row-4', 'row-5'] })).filter(element => (element.props as { className?: string }).className === 'settings-item skill-setting').map(element => element.key);
    const typed = { ...base, skills: base.skills.map((skill, at) => at === 0 ? { ...skill, id: 'teamx' } : skill) };
    expect(rowKeys(base)).toEqual(['row-4', 'row-5']);
    expect(rowKeys(typed)).toEqual(rowKeys(base));
  });
});

describe('重载状态 tells the rest of the app', () => {
  it('announces workbench:capabilities-changed after a successful reload, and stays quiet when the read fails', async () => {
    const target = new EventTarget();
    let heard = 0;
    target.addEventListener(CAPABILITIES_CHANGED_EVENT, () => { heard++; });
    expect(CAPABILITIES_CHANGED_EVENT).toBe('workbench:capabilities-changed');
    expect(await reloadThenAnnounce(async () => true, target)).toBe(true);
    expect(heard).toBe(1);
    expect(await reloadThenAnnounce(async () => false, target)).toBe(false);
    expect(heard).toBe(1);
  });

  it('makes the 运行状态 heading a focus target for when an inline prompt closes', () => {
    const html = renderToStaticMarkup(<RuntimeSection services={[]} loading={false} saving={false} dirty={0} onReload={() => undefined} />);
    expect(html).toMatch(/<h2 id="service-status-heading" tabindex="-1">运行状态<\/h2>/);
  });
});
