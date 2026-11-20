import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChatEvent, ChatMessage, ChatRecord } from './types.js';

interface EventSegment { file: string; first: number; last: number; count: number; bytes: number }
interface KeyedArrayPatch { key: string; remove: string[]; upsert: Record<string, unknown>[]; order?: string[] }
interface StatePatch { set: Record<string, unknown>; delete: string[]; arrays: Record<string, KeyedArrayPatch> }
interface StateEntry {
  version: 1; revision: number; previousHash: string; patch: StatePatch; event?: ChatEvent; afterHash: string; hash: string;
}
interface ChatStoreOptions { afterWriteAhead?: (event: ChatEvent) => void }

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const safe = (v: string) => { if (!/^[A-Za-z0-9._-]+$/.test(v) || v === '.' || v === '..') throw new Error('非法路径'); return v; };
const atomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`; writeFileSync(tmp, text, 'utf8');
  try {
    for (let attempt = 0;; attempt++) {
      try { renameSync(tmp, file); break; }
      catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
    }
  } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
};
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.stringify(value);
const clone = <T>(value: T): T => structuredClone(value);
const keyed = (value: unknown): value is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(value) && value.every(item => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')
  && new Set(value.map(item => (item as { id: string }).id)).size === value.length;

function statePatch(before: ChatRecord, after: ChatRecord): StatePatch {
  const patch: StatePatch = { set: {}, delete: [], arrays: {} };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const left = (before as unknown as Record<string, unknown>)[key];
    const right = (after as unknown as Record<string, unknown>)[key];
    if (right === undefined) { if (left !== undefined) patch.delete.push(key); continue; }
    if (json(left) === json(right)) continue;
    if (keyed(left) && keyed(right)) {
      const old = new Map(left.map(item => [item.id, json(item)]));
      const nextIds = right.map(item => item.id);
      const nextSet = new Set(nextIds);
      const remove = left.filter(item => !nextSet.has(item.id)).map(item => item.id);
      const upsert = right.filter(item => old.get(item.id) !== json(item)).map(item => clone(item));
      const natural = [...left.filter(item => nextSet.has(item.id)).map(item => item.id), ...right.filter(item => !old.has(item.id)).map(item => item.id)];
      patch.arrays[key] = { key: 'id', remove, upsert, ...(json(natural) === json(nextIds) ? {} : { order: nextIds }) };
    } else patch.set[key] = clone(right);
  }
  return patch;
}

function applyStatePatch(chat: ChatRecord, patch: StatePatch): ChatRecord {
  const target = chat as unknown as Record<string, unknown>;
  for (const key of patch.delete) delete target[key];
  for (const [key, value] of Object.entries(patch.set)) target[key] = clone(value);
  for (const [field, change] of Object.entries(patch.arrays)) {
    const current = target[field];
    if (!keyed(current)) throw new Error('状态增量与基础快照不一致');
    const removed = new Set(change.remove);
    const replacements = new Map(change.upsert.map(item => [String(item[change.key]), item]));
    let next = current.filter(item => !removed.has(item.id)).map(item => replacements.get(item.id) ?? item);
    const present = new Set(next.map(item => item.id));
    for (const item of change.upsert) if (!present.has(String(item[change.key]))) next.push(clone(item) as typeof next[number]);
    if (change.order) {
      const byId = new Map(next.map(item => [item.id, item]));
      if (change.order.length !== next.length || change.order.some(id => !byId.has(id))) throw new Error('状态增量顺序无效');
      next = change.order.map(id => byId.get(id)!);
    }
    target[field] = next;
  }
  return chat;
}

export class ChatStore {
  private readonly root: string;
  private readonly eventIndexes = new Map<string, EventSegment[]>();
  private readonly stateCache = new Map<string, { chat: ChatRecord; revision: number; hash: string }>();
  private readonly messageSeq = new Map<string, number>();
  constructor(root: string, private readonly options: ChatStoreOptions = {}) { this.root = path.resolve(root); mkdirSync(this.root, { recursive: true }); }
  private dir(chatId: string) { return path.join(this.root, 'chats', safe(chatId)); }
  private messagesDir(chatId: string) { const d = path.join(this.dir(chatId), 'messages'); mkdirSync(d, { recursive: true }); return d; }
  private eventsDir(chatId: string) { const d = path.join(this.dir(chatId), 'events'); mkdirSync(d, { recursive: true }); return d; }
  private eventIndex(chatId: string, revalidate = true): EventSegment[] {
    if (!revalidate) {
      const cached = this.eventIndexes.get(chatId);
      if (cached) return cached;
    }
    const dir = this.eventsDir(chatId); const f = path.join(dir, 'index.json');
    const files = readdirSync(dir).filter(x => /^events-\d{6}\.jsonl$/.test(x)).sort();
    let prior: Array<{file:string;first:number;last:number;count:number;bytes:number}> | undefined;
    try { const parsed: unknown = JSON.parse(readFileSync(f, 'utf8')); if (Array.isArray(parsed)) prior = parsed; } catch { /* Rebuild a missing or malformed index. */ }
    if (prior && prior.some(entry => typeof entry?.file === 'string' && (!files.includes(entry.file) || (Number.isSafeInteger(entry.bytes) && statSync(path.join(dir, entry.file)).size < entry.bytes)))) throw new Error('已索引事件分段缺失或截断，需人工恢复');
    try {
      const index = prior!;
      let expected = 1;
      if (!Array.isArray(index) || index.length !== files.length || !index.every((entry, i) => {
        const valid = entry.file === files[i] && entry.first === expected && entry.count > 0 && entry.last === entry.first + entry.count - 1 && entry.bytes === statSync(path.join(dir, entry.file)).size;
        expected = entry.last + 1; return valid;
      })) throw new Error('事件索引不一致');
      this.eventIndexes.set(chatId, index); return index;
    } catch {
      const rebuilt: Array<{file:string;first:number;last:number;count:number;bytes:number}> = []; let expected = 1;
      for (const file of files) {
        const raw = readFileSync(path.join(dir, file), 'utf8');
        if (raw && !raw.endsWith('\n')) throw new Error('事件日志尾部不完整，需人工恢复');
        let first = expected; let count = 0;
        for (const line of raw.split('\n').filter(Boolean)) {
          const event = JSON.parse(line) as ChatEvent;
          if (event.chatId !== chatId || event.seq !== expected++) throw new Error('事件日志序号或身份不一致，需人工恢复');
          count++;
        }
        if (!count) throw new Error('事件日志包含空分段，需人工恢复');
        rebuilt.push({ file, first, last: expected - 1, count, bytes: Buffer.byteLength(raw) });
      }
      atomic(f, JSON.stringify(rebuilt)); this.eventIndexes.set(chatId, rebuilt); return rebuilt;
    }
  }
  private snapshot(chatId: string) { return path.join(this.dir(chatId), 'chat.json'); }
  private stateLog(chatId: string) { return path.join(this.dir(chatId), 'state.jsonl'); }
  private materializeEvent(event: ChatEvent): void {
    const d = this.eventsDir(event.chatId); const index = this.eventIndex(event.chatId, false);
    const last = index.at(-1)?.last ?? 0;
    if (event.seq !== last + 1) throw new Error('写前事件与事件日志序号不一致');
    const line = JSON.stringify(event) + '\n'; const bytes = Buffer.byteLength(line);
    if (bytes > 8 * 1024 * 1024) throw new Error('单个事件超过分段容量');
    let segment = index.at(-1);
    const created = !segment || segment.count >= 10_000 || segment.bytes + bytes > 8 * 1024 * 1024;
    if (created) {
      segment = { file: `events-${String(index.length + 1).padStart(6, '0')}.jsonl`, first: event.seq, last: event.seq - 1, count: 0, bytes: 0 };
      index.push(segment);
    }
    appendFileSync(path.join(d, segment!.file), line);
    segment!.last = event.seq; segment!.count++; segment!.bytes += bytes;
    if (created || event.seq % 1000 === 0) atomic(path.join(d, 'index.json'), JSON.stringify(index));
  }
  private recoverEvents(chatId: string, committed: ChatEvent[]): void {
    if (!committed.length) return;
    const index = this.eventIndex(chatId);
    const materializedLast = index.at(-1)?.last ?? 0;
    const expected = new Map(committed.filter(event => event.seq <= materializedLast).map(event => [event.seq, event]));
    if (expected.size) {
      let first = Number.POSITIVE_INFINITY; for (const seq of expected.keys()) first = Math.min(first, seq);
      for (const segment of index) {
        if (segment.last < first || segment.first > materializedLast) continue;
        for (const line of readFileSync(path.join(this.eventsDir(chatId), segment.file), 'utf8').split('\n').filter(Boolean)) {
          const event = JSON.parse(line) as ChatEvent; const wanted = expected.get(event.seq); if (!wanted) continue;
          if (json(event) !== json(wanted)) throw new Error('写前事件与已物化事件不一致，需人工恢复');
          expected.delete(event.seq);
        }
      }
      if (expected.size) throw new Error('写前事件未在日志中物化，需人工恢复');
    }
    for (const event of committed.filter(item => item.seq > materializedLast)) {
      const last = index.at(-1)?.last ?? 0;
      if (event.seq === last + 1) this.materializeEvent(event);
      else throw new Error('写前事件序号不连续，需人工恢复');
    }
  }
  private load(chatId: string): ChatRecord {
    const f = this.snapshot(chatId); if (!existsSync(f)) throw new Error('聊天不存在');
    let chat = JSON.parse(readFileSync(f, 'utf8')) as ChatRecord;
    let revision = 0; let currentHash = digest(chat);
    const journal = this.stateLog(chatId);
    const committed: ChatEvent[] = [];
    if (existsSync(journal)) {
      let raw = readFileSync(journal, 'utf8');
      if (raw && !raw.endsWith('\n')) {
        const end = raw.lastIndexOf('\n');
        raw = end < 0 ? '' : raw.slice(0, end + 1);
        atomic(journal, raw);
      }
      for (const line of raw.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as StateEntry;
        const unsigned = { version: entry.version, revision: entry.revision, previousHash: entry.previousHash, patch: entry.patch,
          ...(entry.event ? { event: entry.event } : {}), afterHash: entry.afterHash };
        if (entry.version !== 1 || entry.revision !== revision + 1 || entry.previousHash !== currentHash || entry.hash !== digest(unsigned)) throw new Error('状态增量序号或哈希不一致，需人工恢复');
        chat = applyStatePatch(chat, entry.patch);
        currentHash = digest({ previousHash: currentHash, patch: entry.patch, ...(entry.event ? { event: entry.event } : {}) });
        if (currentHash !== entry.afterHash) throw new Error('状态增量结果哈希不一致，需人工恢复');
        if (entry.event) committed.push(entry.event);
        revision = entry.revision;
      }
    }
    this.recoverEvents(chatId, committed);
    this.stateCache.set(chatId, { chat: clone(chat), revision, hash: currentHash });
    return chat;
  }
  create(input: { title?: string; workspaceId?: string; apiRoster?: ChatRecord['apiRoster']; pipeline?: ChatRecord['pipeline'] } = {}): ChatRecord {
    const t = now(); const chat: ChatRecord = { version: 1, id: id(), title: input.title?.trim() || '新聊天', createdAt: t, updatedAt: t, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.apiRoster ? { apiRoster: input.apiRoster } : {}), seq: 0, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [] };
    if (input.pipeline) chat.pipeline = input.pipeline;
    mkdirSync(this.dir(chat.id), { recursive: true }); this.messagesDir(chat.id); this.eventsDir(chat.id); this.save(chat); this.messageSeq.set(chat.id, 0); return chat;
  }
  list() { const base = path.join(this.root, 'chats'); if (!existsSync(base)) return []; return readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => { try { const c = this.load(e.name); return [{ id: c.id, title: c.title, ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}), updatedAt: c.updatedAt, status: c.turns.at(-1)?.status ?? 'completed' }]; } catch { return []; } }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string) {
    const chat = this.load(id); const previousSeq = chat.seq; const previousMessageSeq = chat.messageSeq; const previousConstraints = JSON.stringify(chat.constraintMessageIds); const index = this.eventIndex(id); chat.seq = Math.max(chat.seq, index.at(-1)?.last ?? 0);
    if (chat.apiRoster && chat.seq > previousSeq) {
      for (let since = previousSeq;;) {
        const page = this.events(id, since, 500);
        if (page.items.some(event => event.type !== 'stream_delta')) throw new Error('API 事件日志包含没有对应状态提交的事件，需人工恢复');
        if (!page.hasMore) break; since = page.next;
      }
    }
    let expected = 1; const constraints: string[] = [];
    for (const file of readdirSync(this.messagesDir(id)).filter(x => /^messages-\d{6}\.jsonl$/.test(x)).sort()) {
      const raw = readFileSync(path.join(this.messagesDir(id), file), 'utf8');
      if (raw && !raw.endsWith('\n')) throw new Error('消息日志尾部不完整，需人工恢复');
      for (const line of raw.split('\n').filter(Boolean)) { const message = JSON.parse(line) as ChatMessage; if (message.seq !== expected++) throw new Error('消息日志序号不一致，需人工恢复'); if (message.role === 'user') constraints.push(message.id); }
    }
    if (chat.messageSeq > expected - 1 || chat.seq > (index.at(-1)?.last ?? 0)) throw new Error('快照领先于日志，需人工恢复');
    chat.messageSeq = expected - 1; this.messageSeq.set(id, chat.messageSeq); chat.constraintMessageIds = constraints;
    if (chat.seq !== previousSeq || chat.messageSeq !== previousMessageSeq || JSON.stringify(constraints) !== previousConstraints) this.save(chat);
    return chat;
  }
  save(chat: ChatRecord) {
    mkdirSync(this.dir(chat.id), { recursive: true }); chat.updatedAt = now();
    const snapshot = this.snapshot(chat.id);
    if (!chat.apiRoster || !existsSync(snapshot)) {
      atomic(snapshot, JSON.stringify(chat, null, 2) + '\n');
      if (chat.apiRoster) this.stateCache.set(chat.id, { chat: clone(chat), revision: 0, hash: digest(chat) });
      return;
    }
    const state = this.stateCache.get(chat.id) ?? (() => { this.load(chat.id); return this.stateCache.get(chat.id)!; })();
    const patch = statePatch(state.chat, chat);
    if (!Object.keys(patch.set).length && !patch.delete.length && !Object.keys(patch.arrays).length) return;
    const revision = state.revision + 1; const previousHash = state.hash; const afterHash = digest({ previousHash, patch });
    const unsigned = { version: 1 as const, revision, previousHash, patch, afterHash };
    const entry: StateEntry = { ...unsigned, hash: digest(unsigned) };
    appendFileSync(this.stateLog(chat.id), JSON.stringify(entry) + '\n', 'utf8');
    this.stateCache.set(chat.id, { chat: applyStatePatch(state.chat, patch), revision, hash: afterHash });
  }
  /** Atomically bind an API state mutation to its exact event through the state write-ahead log. */
  commitEvent(chat: ChatRecord, input: Omit<ChatEvent, 'seq' | 'chatId' | 'at'>): ChatEvent {
    if (!chat.apiRoster) { const event = this.appendEvent(chat, input); this.save(chat); return event; }
    const index = this.eventIndex(chat.id, false);
    if (chat.seq !== (index.at(-1)?.last ?? 0)) throw new Error('事件序号与日志不一致');
    const event = { ...input, seq: chat.seq + 1, chatId: chat.id, at: now() } as ChatEvent;
    if (Buffer.byteLength(JSON.stringify(event) + '\n') > 8 * 1024 * 1024) throw new Error('单个事件超过分段容量');
    const next = { ...chat, seq: event.seq, updatedAt: now() };
    const state = this.stateCache.get(chat.id) ?? (() => { this.load(chat.id); return this.stateCache.get(chat.id)!; })();
    const patch = statePatch(state.chat, next);
    const revision = state.revision + 1; const previousHash = state.hash;
    const afterHash = digest({ previousHash, patch, event });
    const unsigned = { version: 1 as const, revision, previousHash, patch, event, afterHash };
    const entry: StateEntry = { ...unsigned, hash: digest(unsigned) };
    appendFileSync(this.stateLog(chat.id), JSON.stringify(entry) + '\n', 'utf8');
    chat.seq = next.seq; chat.updatedAt = next.updatedAt;
    this.stateCache.set(chat.id, { chat: applyStatePatch(state.chat, patch), revision, hash: afterHash });
    this.options.afterWriteAhead?.(event);
    this.materializeEvent(event);
    return event;
  }
  appendMessage(chat: ChatRecord, input: Omit<ChatMessage,'id'|'seq'|'createdAt'>) { const m = { ...input, id: id(), seq: ++chat.messageSeq, createdAt: now() } as ChatMessage; const file = path.join(this.messagesDir(chat.id), `messages-${String(Math.floor((m.seq - 1) / 1000) + 1).padStart(6,'0')}.jsonl`); appendFileSync(file, JSON.stringify(m) + '\n'); this.messageSeq.set(chat.id, m.seq); if (m.role === 'user' && !chat.constraintMessageIds.includes(m.id)) chat.constraintMessageIds.push(m.id); this.save(chat); return m; }
  private latestMessageSeq(chatId: string): number {
    if (!existsSync(this.snapshot(chatId))) throw new Error('聊天不存在');
    const cached = this.messageSeq.get(chatId); if (cached !== undefined) return cached;
    const files = readdirSync(this.messagesDir(chatId)).filter(x => /^messages-\d{6}\.jsonl$/.test(x)).sort();
    const last = files.at(-1); if (!last) return 0;
    const lines = readFileSync(path.join(this.messagesDir(chatId), last), 'utf8').trim().split('\n').filter(Boolean);
    const seq = lines.length ? (JSON.parse(lines.at(-1)!) as ChatMessage).seq : 0; this.messageSeq.set(chatId, seq); return seq;
  }
  messages(chatId: string, opts: { before?: number; limit?: number } = {}) { const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50); const before = opts.before ?? this.latestMessageSeq(chatId) + 1; const out: ChatMessage[] = []; const files = readdirSync(this.messagesDir(chatId)).filter(x => x.startsWith('messages-')).sort().reverse(); for (const f of files) { for (const line of readFileSync(path.join(this.messagesDir(chatId), f), 'utf8').trim().split('\n').filter(Boolean).reverse()) { const m = JSON.parse(line) as ChatMessage; if (m.seq < before) out.push(m); if (out.length >= limit) break; } if (out.length >= limit) break; } out.sort((a,b)=>a.seq-b.seq); return { items: out, ...(out.length && out[0]!.seq > 1 ? { nextBefore: out[0]!.seq } : {}) }; }
  message(chatId: string, messageId: string) { if (!existsSync(this.snapshot(chatId))) throw new Error('聊天不存在'); for (const f of readdirSync(this.messagesDir(chatId))) for (const line of readFileSync(path.join(this.messagesDir(chatId), f), 'utf8').split('\n')) if (line) { const m = JSON.parse(line) as ChatMessage; if (m.id === messageId) return m; } throw new Error('消息不存在'); }
  appendEvent(chat: ChatRecord, input: Omit<ChatEvent,'seq'|'chatId'|'at'>) { const d=this.eventsDir(chat.id); const index=this.eventIndex(chat.id, false); if (chat.seq !== (index.at(-1)?.last ?? 0)) throw new Error('事件序号与日志不一致'); const e={...input,seq:chat.seq+1,chatId:chat.id,at:now()} as ChatEvent; const line=JSON.stringify(e)+'\n'; const bytes=Buffer.byteLength(line); if(bytes>8*1024*1024)throw new Error('单个事件超过分段容量'); let seg=index.at(-1); const created=!seg||seg.count>=10000||seg.bytes+bytes>8*1024*1024; if(created){seg={file:`events-${String(index.length+1).padStart(6,'0')}.jsonl`,first:e.seq,last:e.seq-1,count:0,bytes:0};index.push(seg)} if(!seg)throw new Error('无法创建事件分段'); appendFileSync(path.join(d,seg.file),line); chat.seq=e.seq; seg.last=e.seq;seg.count++;seg.bytes+=bytes; if(created||e.seq%1000===0)atomic(path.join(d,'index.json'),JSON.stringify(index)); return e; }
  events(chatId: string, since=0, limit=500) { const d=this.eventsDir(chatId), max=Math.min(limit,500), out:ChatEvent[]=[]; const index=this.eventIndex(chatId); for(const seg of index){if(seg.last<=since)continue;let expected=seg.first;for(const line of readFileSync(path.join(d,seg.file),'utf8').split('\n').filter(Boolean)){const e=JSON.parse(line) as ChatEvent;if(e.chatId!==chatId||e.seq!==expected++)throw new Error('事件日志序号或身份不一致，需人工恢复');if(e.seq>since)out.push(e);if(out.length>=max)break}if(out.length>=max)break}const next=out.at(-1)?.seq??since;return {items:out,hasMore:next<(index.at(-1)?.last??0),next}; }
  putBlob(chatId: string, name: string, text: string) { const rel = `blobs/${safe(name)}`; const file=path.join(this.dir(chatId),rel); mkdirSync(path.dirname(file),{recursive:true}); const b=Buffer.from(text); writeFileSync(file,b,{flag:'wx'}); return {relativePath:rel,hash:crypto.createHash('sha256').update(b).digest('hex'),bytes:b.length}; }
  readBlob(chatId: string, relativePath: string) { const parts=relativePath.replaceAll('\\','/').split('/'); if(parts.length!==2||parts[0]!=='blobs') throw new Error('非法 blob 路径'); return readFileSync(path.join(this.dir(chatId), 'blobs', safe(parts[1]!))); }
  invocationDirectory(chatId: string, invocationId: string) { const d=path.join(this.dir(chatId),'invocations',safe(invocationId)); mkdirSync(d,{recursive:true}); return d; }
  sessionDirectory(chatId: string) { const d = path.join(this.dir(chatId), 'files'); mkdirSync(d, { recursive: true }); return d; }
  appendStream(chatId: string, invocationId: string, delta: string) { appendFileSync(path.join(this.invocationDirectory(chatId, invocationId), 'stream.txt'), delta, 'utf8'); }
  readStream(chatId: string, invocationId: string): string {
    const file = path.join(this.dir(chatId), 'invocations', safe(invocationId), 'stream.txt');
    if (!existsSync(file)) return '';
    if (statSync(file).size > 8_000_000) throw new Error('流式记录大小异常');
    return readFileSync(file, 'utf8');
  }
}
