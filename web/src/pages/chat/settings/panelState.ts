// SettingsPanel form state as a pure reducer (BUILD-SPEC-B §6.4), so the draft and row-key rules are testable without
// a DOM. `loaded` is the server copy, `settings` the form, and `staleDraft` a draft made on older settings that waits
// for a decision (草稿基于较早读取的配置). Any change to the form declines that draft, so edits made while the prompt
// shows still reach the session draft. MCP and Skill rows get keys that never come from an edited field, so typing in
// an ID never remounts its row.
import type { ChatSettings } from '../../../lib/chat-api';
import { countSettingsChanges, settingsHash, type DraftResolution, type StoredSettingsDraft } from './settingsDraft';

export interface RowKeys { mcp: string[]; skills: string[] }

export interface PanelState {
  loaded: ChatSettings | null;
  settings: ChatSettings | null;
  staleDraft: ChatSettings | null;
  rowKeys: RowKeys;
  /** The last row-key number handed out; keys are never reused within a panel. */
  seq: number;
}

export type PanelAction =
  /** Settings read from the server, with what to do about a stored draft. */
  | { type: 'loaded'; settings: ChatSettings; draft: DraftResolution }
  /** A form edit. */
  | { type: 'edit'; update(current: ChatSettings): ChatSettings }
  /** The advanced JSON applied to the form. */
  | { type: 'replace'; settings: ChatSettings }
  | { type: 'restoreDraft' }
  | { type: 'dropDraft' }
  /** 放弃更改: back to the loaded settings. */
  | { type: 'discard' }
  | { type: 'saved'; settings: ChatSettings };

export const initialPanelState: PanelState = { loaded: null, settings: null, staleDraft: null, rowKeys: { mcp: [], skills: [] }, seq: 0 };

/**
 * Carries row keys from one list to the next. Rows edited in place keep their key. A removal keeps the survivors'
 * keys when they are the same objects in the same order. Added rows get new keys. A list replaced with fewer rows
 * keeps the leading keys.
 */
export function carryRowKeys<T>(previous: readonly T[], keys: readonly string[], next: readonly T[], mint: () => string): string[] {
  const base = keys.slice(0, previous.length);
  while (base.length < previous.length) base.push(mint());
  if (next.length >= previous.length) {
    while (base.length < next.length) base.push(mint());
    return base;
  }
  const kept: string[] = [];
  let from = 0;
  for (const item of next) {
    const at = previous.indexOf(item, from);
    if (at < 0) return base.slice(0, next.length);
    kept.push(base[at]);
    from = at + 1;
  }
  return kept;
}

function withSettings(state: PanelState, settings: ChatSettings | null, patch: Partial<PanelState> = {}): PanelState {
  if (!settings) return { ...state, ...patch, settings };
  let seq = state.seq;
  const mint = () => `row-${++seq}`;
  const before = state.settings;
  const carry = <T>(previous: readonly T[] | undefined, keys: string[], next: readonly T[]) =>
    previous === next && keys.length === next.length ? keys : carryRowKeys(previous ?? [], keys, next, mint);
  const rowKeys = {
    mcp: carry(before?.mcp, state.rowKeys.mcp, settings.mcp),
    skills: carry(before?.skills, state.rowKeys.skills, settings.skills),
  };
  return { ...state, ...patch, settings, rowKeys, seq };
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'loaded': {
      const settings = action.draft.kind === 'restore' ? action.draft.settings : action.settings;
      const staleDraft = action.draft.kind === 'stale' ? action.draft.settings : null;
      return withSettings(state, settings, { loaded: action.settings, staleDraft });
    }
    case 'edit':
      return state.settings ? withSettings(state, action.update(state.settings), { staleDraft: null }) : state;
    case 'replace':
      return withSettings(state, action.settings, { staleDraft: null });
    case 'restoreDraft':
      return state.staleDraft ? withSettings(state, state.staleDraft, { staleDraft: null }) : state;
    case 'dropDraft':
      return { ...state, staleDraft: null };
    case 'discard':
      return withSettings(state, state.loaded, { staleDraft: null });
    case 'saved':
      return withSettings(state, action.settings, { loaded: action.settings, staleDraft: null });
  }
}

export type DraftWrite = { kind: 'keep' } | { kind: 'clear' } | { kind: 'write'; draft: StoredSettingsDraft };

/**
 * What the session draft should hold: the form while it has changes, nothing while it is clean. A stale draft that
 * still waits for a decision is left alone; the first edit declines it (see `edit`), so the next call writes the form.
 */
export function draftWrite({ loaded, settings, staleDraft }: Pick<PanelState, 'loaded' | 'settings' | 'staleDraft'>): DraftWrite {
  if (!loaded || !settings || staleDraft) return { kind: 'keep' };
  return countSettingsChanges(loaded, settings) > 0 ? { kind: 'write', draft: { hash: settingsHash(loaded), settings } } : { kind: 'clear' };
}
