import type { AgentTask, ChatArtifact, ChatMessage, ChatRecord, ChatRole, ChatSnapshot, ChatStream, ChatSummary, ChatTodo, TaskStatus } from './chat-api';

export const FIXED_DEMO_PROMPT = '帮我做一个团队会议室预约小工具：先出 PRD 和技术架构，再完成可运行的 Web 应用和自动化测试。需要支持按楼层筛选、冲突检测和 iCal 导出。';

const STORAGE_KEY = 'dmw:fixed-demo:v1';
const DURATION_MS = 240_000;
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const PRODUCT_URL = '/fixed-demo/project/index.html';
const URLS = Object.freeze({
  prd: '/fixed-demo/prd.md', architecture: '/fixed-demo/architecture.md', source: '/fixed-demo/source.mjs',
  tests: '/fixed-demo/tests.txt', project: '/fixed-demo/project.zip',
});
type ArtifactId = keyof typeof URLS;
const ASSET_IDS = Object.keys(URLS) as ArtifactId[];
const UUID_ID = /^fixed-demo-roomdesk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ManifestArtifact { id: ArtifactId; name: string; url: string; bytes: number; hash: string }
interface DemoManifest { version: 1; scenarioId: 'roomdesk-v1'; prompt: string; artifacts: ManifestArtifact[]; productUrl: string }
interface LoadedAssets { manifest: DemoManifest; text: Record<'prd' | 'architecture' | 'source' | 'tests', string> }
interface StoredDemo {
  id: string; clientMessageId: string; createdAt: number; updatedAt: number; elapsedMs: number; paused: boolean; cancelled: boolean;
}

const phases = [
  { id: 'plan', start: 0, end: 10_000, role: 'claude' as ChatRole, task: 'root', text: '预设演示：Claude 正在整理团队会议室预约工具（RoomDesk）的交付计划，先形成 PRD 与技术架构，再实现可运行应用并核对测试。' },
  { id: 'prd', start: 10_000, end: 45_000, role: 'claude' as ChatRole, task: 'docs' },
  { id: 'architecture', start: 45_000, end: 85_000, role: 'claude' as ChatRole, task: 'docs' },
  { id: 'source', start: 85_000, end: 150_000, role: 'sol' as ChatRole, task: 'build' },
  { id: 'tests', start: 150_000, end: 185_000, role: 'astra' as ChatRole, task: 'verify' },
  { id: 'summary', start: 185_000, end: 190_000, role: 'claude' as ChatRole, task: 'root', text: '预设演示：PRD、技术架构、可运行源码、附带测试报告和项目包已经整理完成。测试文字来自静态交付件，不代表现场模型调用。' },
  { id: 'product', start: 190_000, end: 240_000, role: 'claude' as ChatRole, task: 'root', text: '预设演示：可在软件内预览 RoomDesk 会议室预约应用成品。根任务将在 240 秒演示结束时完成。' },
] as const;

let assetsPromise: Promise<LoadedAssets> | undefined;
const subscriptions = new Map<string, { listeners: Set<(snapshot: ChatSnapshot) => void>; errors: Set<(error: Error) => void>; timer: ReturnType<typeof setInterval>; phase?: string }>();

export function isFixedDemoPrompt(text: string): boolean { return text.trim().normalize('NFC') === FIXED_DEMO_PROMPT.normalize('NFC'); }
export function isFixedDemoId(id: string | undefined): boolean { return typeof id === 'string' && UUID_ID.test(id); }

function safeRecords(): StoredDemo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is StoredDemo => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<StoredDemo>;
      const validDate = (value: unknown, max = MAX_DATE_MS) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
      return isFixedDemoId(row.id) && typeof row.clientMessageId === 'string'
        && validDate(row.createdAt, MAX_DATE_MS - DURATION_MS) && validDate(row.updatedAt) && (row.updatedAt as number) >= (row.createdAt as number)
        && validDate(row.elapsedMs, DURATION_MS) && typeof row.paused === 'boolean' && typeof row.cancelled === 'boolean';
    });
  } catch (error) {
    console.warn('固定演示存储不可读，已忽略损坏数据。', error);
    return [];
  }
}

function saveRecords(records: StoredDemo[]): void {
  const trimmed = [...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed)); }
  catch (error) { throw new Error(`固定演示保存失败：${error instanceof Error ? error.message : String(error)}`); }
}

function currentElapsed(record: StoredDemo, now = Date.now()): number {
  const delta = record.paused || record.cancelled ? 0 : Math.max(0, now - record.updatedAt);
  return Math.min(DURATION_MS, Math.max(0, record.elapsedMs + delta));
}

function findRecord(id: string): StoredDemo {
  if (!isFixedDemoId(id)) throw new Error('无效的固定演示会话。');
  const record = safeRecords().find(item => item.id === id);
  if (!record) throw new Error('固定演示会话不存在或已过期。');
  return record;
}

function validateStaticUrl(id: ArtifactId, value: unknown): string {
  if (typeof value !== 'string') throw new Error(`固定演示资产 ${id} 缺少 URL。`);
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== URLS[id] || url.search || url.hash) throw new Error(`固定演示资产 ${id} URL 不在允许列表。`);
  return url.pathname;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loadAssets(): Promise<LoadedAssets> {
  if (assetsPromise) return assetsPromise;
  assetsPromise = (async () => {
    const response = await fetch('/fixed-demo/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`固定演示清单加载失败（${response.status}）。`);
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object') throw new Error('固定演示清单格式无效。');
    const manifest = raw as DemoManifest;
    if (manifest.version !== 1 || manifest.scenarioId !== 'roomdesk-v1' || manifest.prompt !== FIXED_DEMO_PROMPT || manifest.productUrl !== PRODUCT_URL || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 5) throw new Error('固定演示清单身份不匹配。');
    const byId = new Map<ArtifactId, ManifestArtifact>();
    for (const item of manifest.artifacts) {
      if (!item || !Object.hasOwn(URLS, item.id) || byId.has(item.id)) throw new Error('固定演示资产列表无效。');
      validateStaticUrl(item.id, item.url);
      if (typeof item.name !== 'string' || !item.name || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[0-9a-f]{64}$/i.test(item.hash)) throw new Error(`固定演示资产 ${item.id} 元数据无效。`);
      const limit = item.id === 'project' ? MAX_PROJECT_BYTES : MAX_ASSET_BYTES;
      if (item.bytes > limit) throw new Error(`固定演示资产 ${item.id} 超过大小上限。`);
      byId.set(item.id, item);
    }
    if (Object.keys(URLS).some(id => !byId.has(id as ArtifactId))) throw new Error('固定演示资产不完整。');
    const loaded = await Promise.all(ASSET_IDS.map(async id => {
      const item = byId.get(id)!;
      const assetResponse = await fetch(URLS[id], { cache: 'no-store' });
      if (!assetResponse.ok) throw new Error(`固定演示资产 ${id} 加载失败（${assetResponse.status}）。`);
      const bytes = await assetResponse.arrayBuffer();
      const limit = id === 'project' ? MAX_PROJECT_BYTES : MAX_ASSET_BYTES;
      if (bytes.byteLength !== item.bytes || bytes.byteLength > limit || await sha256(bytes) !== item.hash.toLowerCase()) throw new Error(`固定演示资产 ${id} 校验失败。`);
      return id === 'project' ? null : [id, new TextDecoder('utf-8', { fatal: true }).decode(bytes)] as const;
    }));
    return { manifest: { ...manifest, artifacts: [...byId.values()] }, text: Object.fromEntries(loaded.filter(item => item !== null)) as LoadedAssets['text'] };
  })().catch(error => { assetsPromise = undefined; throw error; });
  return assetsPromise;
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function phaseAt(elapsed: number) { return phases.find(phase => elapsed < phase.end) ?? phases[phases.length - 1]; }
function progressive(text: string, elapsed: number, start: number, end: number): string {
  const chars = Array.from(text); const ratio = Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
  return chars.slice(0, Math.floor(chars.length * ratio)).join('');
}
function phaseText(phase: typeof phases[number], assets: LoadedAssets): string {
  if ('text' in phase) return phase.text;
  const prefix = phase.id === 'tests' ? '预设演示报告（非现场模型运行）：\n\n' : phase.id === 'source' ? '预设演示：Sol 正在呈现可运行项目的实际源码。\n\n' : '';
  return prefix + assets.text[phase.id];
}
function taskStatus(record: StoredDemo, elapsed: number, end: number): TaskStatus { return elapsed >= end ? 'completed' : record.cancelled ? 'cancelled' : 'running'; }

function makeTask(record: StoredDemo, id: string, role: ChatRole, goal: string, mode: AgentTask['mode'], status: TaskStatus): AgentTask {
  return { id: `${record.id}-${id}`, turnId: `${record.id}-turn`, ...(id === 'root' ? {} : { parentTaskId: `${record.id}-root` }), role, goal: `预设演示：${goal}`, status,
    createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt), segment: 1, invocationIds: [], noProgressSegments: 0, mode };
}

function buildSnapshot(record: StoredDemo, assets: LoadedAssets): ChatSnapshot {
  const elapsed = currentElapsed(record); const completed = elapsed >= DURATION_MS; const phase = phaseAt(elapsed);
  const rootStatus: TaskStatus = completed ? 'completed' : record.cancelled ? 'cancelled' : 'running';
  const tasks: AgentTask[] = [makeTask(record, 'root', 'claude', '统筹团队会议室预约工具（RoomDesk）的文档、实现、验证与交付', 'edit', rootStatus)];
  if (elapsed >= 10_000) tasks.push(makeTask(record, 'docs', 'claude', '编写 PRD 与技术架构书', 'edit', taskStatus(record, elapsed, 85_000)));
  if (elapsed >= 85_000) tasks.push(makeTask(record, 'build', 'sol', '实现可运行项目并整理源码', 'edit', taskStatus(record, elapsed, 150_000)));
  if (elapsed >= 150_000) tasks.push(makeTask(record, 'verify', 'astra', '呈现附带的预设测试报告并核对交付件', 'verify', taskStatus(record, elapsed, 185_000)));

  const messages: ChatMessage[] = [{ id: `${record.id}-user`, seq: 1, role: 'user', text: FIXED_DEMO_PROMPT, createdAt: iso(record.createdAt), turnId: `${record.id}-turn`, clientMessageId: record.clientMessageId }];
  const completions = [
    [10_000, '交付计划已形成，开始编写产品需求文档。'], [45_000, '产品需求文档已完成，进入技术架构设计。'],
    [85_000, '技术架构书已完成，进入可运行项目实现。'], [150_000, '项目源码已整理，开始呈现附带测试报告。'],
    [185_000, '预设测试报告已呈现，开始整理交付总结。'], [190_000, '交付件已齐备，可预览 RoomDesk 应用成品。'], [240_000, '四分钟预设演示完成。'],
  ] as const;
  for (const [at, text] of completions) if (elapsed >= at) messages.push({ id: `${record.id}-message-${at}`, seq: messages.length + 1, role: 'assistant', text: `预设演示：${text}`, createdAt: iso(record.createdAt + at), turnId: `${record.id}-turn`, taskId: `${record.id}-root` });

  const artifactEnds: Record<ArtifactId, number> = { prd: 45_000, architecture: 85_000, source: 150_000, tests: 185_000, project: 190_000 };
  const artifactTasks: Record<ArtifactId, string> = { prd: 'docs', architecture: 'docs', source: 'build', tests: 'verify', project: 'root' };
  const artifactKinds: Record<ArtifactId, ChatArtifact['kind']> = { prd: 'file', architecture: 'file', source: 'file', tests: 'report', project: 'file' };
  const artifacts: ChatArtifact[] = assets.manifest.artifacts.filter(item => elapsed >= artifactEnds[item.id]).map(item => ({
    id: item.id, taskId: `${record.id}-${artifactTasks[item.id]}`, name: item.name, relativePath: item.url, hash: item.hash, bytes: item.bytes,
    kind: artifactKinds[item.id], createdAt: iso(record.createdAt + artifactEnds[item.id]),
  }));
  const todoDefs = [
    ['plan', '形成交付计划', 10_000, 'root'], ['prd', '完成产品需求文档', 45_000, 'docs'], ['architecture', '完成技术架构书', 85_000, 'docs'],
    ['source', '完成可运行项目', 150_000, 'build'], ['delivery', '完成测试与项目交付', 190_000, 'verify'],
  ] as const;
  const todos: ChatTodo[] = todoDefs.map(([id, text, end, task]) => ({ id: `${record.id}-todo-${id}`, taskId: `${record.id}-${task}`, text, status: elapsed >= end ? 'completed' : record.cancelled ? 'failed' : elapsed >= (phases.find(p => p.id === id)?.start ?? 150_000) ? 'in_progress' : 'pending', updatedAt: iso(record.updatedAt) }));
  const streamText = progressive(phaseText(phase, assets), elapsed, phase.start, phase.end);
  const streams: ChatStream[] = completed || record.cancelled ? [] : [{ invocationId: `${record.id}-stream-${phase.id}`, taskId: `${record.id}-${phase.task}`, role: phase.role, text: streamText, status: 'running' }];
  const chat: ChatRecord = { version: 1, id: record.id, title: '预设演示 · RoomDesk 会议室预约工具', createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt), seq: messages.length,
    messageSeq: messages.length, turns: [{ id: `${record.id}-turn`, rootTaskId: `${record.id}-root`, status: rootStatus, createdAt: iso(record.createdAt), ...(completed || record.cancelled ? { completedAt: iso(record.updatedAt) } : {}) }],
    tasks, invocations: [], tickets: [], artifacts, checkpoints: [], constraintMessageIds: [], todos };
  return { chat, messages, capabilities: [], streams, recentEvents: [] };
}

export async function startFixedDemo(clientMessageId: string): Promise<ChatSnapshot> {
  if (!clientMessageId.trim()) throw new Error('固定演示需要客户端消息 ID。');
  const assets = await loadAssets(); const now = Date.now(); const id = `fixed-demo-roomdesk-${crypto.randomUUID()}`;
  const record: StoredDemo = { id, clientMessageId, createdAt: now, updatedAt: now, elapsedMs: 0, paused: false, cancelled: false };
  saveRecords([record, ...safeRecords()]);
  return buildSnapshot(record, assets);
}

export async function getFixedDemoSnapshot(id: string): Promise<ChatSnapshot> {
  const assets = await loadAssets();
  return buildSnapshot(findRecord(id), assets);
}

export function listFixedDemos(): ChatSummary[] {
  return safeRecords().sort((a, b) => b.updatedAt - a.updatedAt).map(record => {
    const elapsed = currentElapsed(record); return { id: record.id, title: '预设演示 · RoomDesk 会议室预约工具', updatedAt: iso(record.updatedAt), status: record.cancelled ? 'cancelled' : elapsed >= DURATION_MS ? 'completed' : record.paused ? 'paused' : 'running' };
  });
}

export function subscribeFixedDemo(id: string, listener: (snapshot: ChatSnapshot) => void, onError: (error: Error) => void): () => void {
  if (!isFixedDemoId(id)) { onError(new Error('无效的固定演示会话。')); return () => undefined; }
  let entry = subscriptions.get(id);
  if (!entry) {
    const listeners = new Set<(snapshot: ChatSnapshot) => void>(); const errors = new Set<(error: Error) => void>();
    const tick = () => getFixedDemoSnapshot(id).then(snapshot => {
      const current = subscriptions.get(id); if (!current) return;
      const phase = phaseAt(getFixedDemoPlayback(id).elapsedMs).id;
      if (current.phase !== undefined && current.phase !== phase && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('workbench:chat-updated', { detail: { chatId: id } }));
      current.phase = phase; current.listeners.forEach(fn => fn(snapshot));
    }).catch(error => subscriptions.get(id)?.errors.forEach(fn => fn(error instanceof Error ? error : new Error(String(error)))));
    entry = { listeners, errors, timer: setInterval(tick, 200) }; subscriptions.set(id, entry); tick();
  } else getFixedDemoSnapshot(id).then(listener).catch(error => onError(error instanceof Error ? error : new Error(String(error))));
  entry.listeners.add(listener); entry.errors.add(onError);
  return () => { const current = subscriptions.get(id); if (!current) return; current.listeners.delete(listener); current.errors.delete(onError); if (!current.listeners.size) { clearInterval(current.timer); subscriptions.delete(id); } };
}

export async function pauseFixedDemo(id: string, paused: boolean): Promise<ChatRecord> {
  const records = safeRecords(); const index = records.findIndex(item => item.id === id); if (index < 0) throw new Error('固定演示会话不存在或已过期。');
  const record = records[index]; if (record.cancelled && !paused) throw new Error('已取消的固定演示不能继续。');
  const now = Date.now(); record.elapsedMs = currentElapsed(record, now); record.updatedAt = now; record.paused = paused || record.elapsedMs >= DURATION_MS; saveRecords(records);
  return (await getFixedDemoSnapshot(id)).chat;
}

export async function cancelFixedDemo(id: string): Promise<ChatRecord> {
  const records = safeRecords(); const index = records.findIndex(item => item.id === id); if (index < 0) throw new Error('固定演示会话不存在或已过期。');
  const record = records[index]; const now = Date.now(); record.elapsedMs = currentElapsed(record, now); record.updatedAt = now; record.paused = true; record.cancelled = true; saveRecords(records);
  return (await getFixedDemoSnapshot(id)).chat;
}

export function fixedDemoArtifactUrl(id: string, artifactId: string): string {
  if (!isFixedDemoId(id)) throw new Error('无效的固定演示会话。');
  if (!Object.hasOwn(URLS, artifactId)) throw new Error('未知的固定演示产物。');
  return URLS[artifactId as ArtifactId];
}

export function getFixedDemoPlayback(id: string): { elapsedMs: number; durationMs: 240000; paused: boolean; completed: boolean; cancelled: boolean; productReady: boolean } {
  const record = findRecord(id); const elapsedMs = currentElapsed(record);
  return { elapsedMs, durationMs: DURATION_MS, paused: record.paused, completed: elapsedMs >= DURATION_MS, cancelled: record.cancelled, productReady: elapsedMs >= 190_000 };
}
