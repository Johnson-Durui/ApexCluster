// Settings draft and dirty logic (BUILD-SPEC-B §6.4). Pure helpers, so the rules are testable without a DOM.
// Unsaved edits survive navigation in sessionStorage together with a hash of the settings JSON they were made on.
// `ChatSettings.version` is a schema version and cannot detect staleness, so the hash is what decides "stale".
import type { ChatSettings } from '../../../lib/chat-api';

export const SETTINGS_DRAFT_KEY = 'dmw:settings:draft:v1';

/** JSON with object keys sorted, so key order never counts as a change. `undefined` members are dropped, as in JSON. */
export function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** FNV-1a (32-bit) over the stable JSON: a short fingerprint of the loaded settings. */
export function settingsHash(settings: ChatSettings): string {
  const text = stableJson(settings);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Changed entries between two lists, order-insensitive: an edit, an addition or a removal each count once. */
function listChanges(base: unknown[] = [], next: unknown[] = []): number {
  const pool = new Map<string, number>();
  for (const item of base) {
    const key = stableJson(item);
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  let added = 0;
  for (const item of next) {
    const key = stableJson(item);
    const left = pool.get(key) ?? 0;
    if (left > 0) pool.set(key, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of pool.values()) removed += left;
  return Math.max(added, removed);
}

/**
 * The number of changed settings items: the document worker, each MCP service, each Skill source, each media
 * provider entry, and any other top-level field (from the advanced JSON). "N 项未保存更改" counts these items.
 */
export function countSettingsChanges(base: ChatSettings | null, next: ChatSettings | null): number {
  if (!base || !next) return 0;
  let changes = 0;
  if (stableJson(base.documentWorker) !== stableJson(next.documentWorker)) changes++;
  changes += listChanges(base.mcp, next.mcp);
  changes += listChanges(base.skills, next.skills);
  const baseMedia = (base.media ?? {}) as Record<string, unknown>;
  const nextMedia = (next.media ?? {}) as Record<string, unknown>;
  for (const kind of new Set([...Object.keys(baseMedia), ...Object.keys(nextMedia)])) {
    if (stableJson(baseMedia[kind]) !== stableJson(nextMedia[kind])) changes++;
  }
  const known = new Set(['documentWorker', 'mcp', 'skills', 'media']);
  const baseRecord = base as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(nextRecord)])) {
    if (!known.has(key) && stableJson(baseRecord[key]) !== stableJson(nextRecord[key])) changes++;
  }
  return changes;
}

export interface StoredSettingsDraft { hash: string; settings: ChatSettings }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const sessionStore = (): DraftStorage | undefined => typeof sessionStorage === 'undefined' ? undefined : sessionStorage;

function isSettings(value: unknown): value is ChatSettings {
  const record = value as Partial<ChatSettings> | null;
  return !!record && typeof record === 'object' && record.version === 1 && Array.isArray(record.skills) && Array.isArray(record.mcp)
    && !!record.documentWorker && typeof record.documentWorker === 'object' && !!record.media && typeof record.media === 'object';
}

/** Reads the stored draft. Missing, malformed or throwing storage means "no draft". */
export function readSettingsDraft(storage: DraftStorage | undefined = sessionStore()): StoredSettingsDraft | null {
  try {
    const raw = storage?.getItem(SETTINGS_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSettingsDraft>;
    return typeof parsed.hash === 'string' && isSettings(parsed.settings) ? { hash: parsed.hash, settings: parsed.settings } : null;
  } catch { return null; }
}

export function writeSettingsDraft(draft: StoredSettingsDraft, storage: DraftStorage | undefined = sessionStore()) {
  try { storage?.setItem(SETTINGS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage unavailable: the draft lives only in memory */ }
}

export function clearSettingsDraft(storage: DraftStorage | undefined = sessionStore()) {
  try { storage?.removeItem(SETTINGS_DRAFT_KEY); } catch { /* storage unavailable */ }
}

export type DraftResolution =
  | { kind: 'none' }
  /** The draft was made on the settings just loaded: restore it with the bar dirty. */
  | { kind: 'restore'; settings: ChatSettings }
  /** The settings changed since the draft was made: ask before restoring (草稿基于较早读取的配置). */
  | { kind: 'stale'; settings: ChatSettings };

/** Decides what to do with a stored draft once settings have loaded. A draft equal to the loaded settings is dropped. */
export function resolveSettingsDraft(draft: StoredSettingsDraft | null, loaded: ChatSettings): DraftResolution {
  if (!draft || countSettingsChanges(loaded, draft.settings) === 0) return { kind: 'none' };
  return draft.hash === settingsHash(loaded) ? { kind: 'restore', settings: draft.settings } : { kind: 'stale', settings: draft.settings };
}

export const dirtyLabel = (count: number) => count > 0 ? `${count} 项未保存更改` : '没有未保存的更改';
