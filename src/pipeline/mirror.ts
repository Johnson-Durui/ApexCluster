import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatStore } from '../chat/store.js';
import type { AgentTask, ChatEvent, ChatRecord } from '../chat/types.js';
import type {
  ImplementationState,
  ManagedPipelineFile,
  PipelineMirrorEventInput,
  PipelineMirrorIntent,
  PipelineMirrorIntentFile,
  PipelineWorkspaceHost,
} from './implementation-types.js';

const managedPaths = new Set(['.agent/STATE.json', '.agent/HANDOFF.md']);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptHash = (intent: Omit<PipelineMirrorIntent, 'receiptHash'>) => sha256(JSON.stringify(intent));

function implementation(chat: ChatRecord): ImplementationState {
  const state = chat.pipeline?.implementation;
  if (!state) throw new Error('流水线镜像缺少实现状态');
  return state;
}

function validateFiles(files: readonly PipelineMirrorIntentFile[]): void {
  assert.ok(files.length >= 1 && files.length <= 2, '流水线镜像文件数量无效');
  assert.equal(new Set(files.map(file => file.path)).size, files.length, '流水线镜像路径重复');
  for (const file of files) {
    assert.ok(managedPaths.has(file.path), `流水线镜像路径不受支持：${file.path}`);
    assert.equal(file.desiredHash, sha256(file.text), `流水线镜像内容哈希漂移：${file.path}`);
    if (file.expectedHash !== undefined) assert.match(file.expectedHash, /^[a-f0-9]{64}$/);
  }
}

function validateIntent(intent: PipelineMirrorIntent): void {
  assert.equal(intent.version, 1, '流水线镜像意图版本无效');
  assert.match(intent.id, /^[0-9a-f-]{36}$/i, '流水线镜像意图 ID 无效');
  assert.ok(intent.taskId, '流水线镜像任务身份缺失');
  validateFiles(intent.files);
  const { receiptHash: stored, ...unsigned } = intent;
  assert.equal(stored, receiptHash(unsigned), '流水线镜像回执漂移');
  if (intent.event) assert.ok(intent.event.type, '流水线镜像事件类型缺失');
}

function mirrorReceipt(id: string, files: readonly PipelineMirrorIntentFile[]) {
  return { id, files: files.map(file => ({ path: file.path, hash: file.desiredHash })) };
}

function bindReceipt(event: PipelineMirrorEventInput | undefined, id: string, files: readonly PipelineMirrorIntentFile[]): PipelineMirrorEventInput | undefined {
  if (!event) return undefined;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('流水线镜像事件数据必须是对象');
  return { ...event, data: { ...(event.data as Record<string, unknown>), mirrorReceipt: mirrorReceipt(id, files) } };
}

function updateHashes(state: ImplementationState, files: readonly PipelineMirrorIntentFile[]): void {
  for (const file of files) {
    if (file.path === '.agent/STATE.json') state.stateFileHash = file.desiredHash;
    else state.handoffFileHash = file.desiredHash;
  }
}

/** Coordinates a durable chat intent with idempotent exact-byte workspace mirrors. */
export class PipelineMirrorCoordinator {
  constructor(private readonly store: ChatStore, private readonly host: PipelineWorkspaceHost) {}

  stage(
    chat: ChatRecord,
    task: AgentTask,
    files: readonly ManagedPipelineFile[],
    event?: PipelineMirrorEventInput,
  ): ChatEvent | undefined {
    const state = implementation(chat);
    if (state.mirrorIntent) throw new Error('已有未对账的流水线镜像意图');
    const prepared = files.map(file => ({ ...file, desiredHash: sha256(file.text) }));
    validateFiles(prepared);
    const id = randomUUID();
    const unsigned = { version: 1 as const, id, taskId: task.id, files: prepared, event: bindReceipt(event, id, prepared) };
    const intent: PipelineMirrorIntent = { ...unsigned, receiptHash: receiptHash(unsigned) };
    state.mirrorIntent = intent;
    try { this.store.save(chat); }
    catch (error) { delete state.mirrorIntent; throw error; }
    return this.reconcile(chat, task);
  }

  reconcile(chat: ChatRecord, task: AgentTask): ChatEvent | undefined {
    const state = implementation(chat);
    const intent = state.mirrorIntent;
    if (!intent) return undefined;
    validateIntent(intent);
    assert.equal(task.id, intent.taskId, '流水线镜像任务身份漂移');
    this.host.writePipelineFiles(chat, task, intent.files);
    // With expected == desired, the gateway can only confirm exact bytes or reject drift.
    this.host.writePipelineFiles(chat, task, intent.files.map(file => ({ ...file, expectedHash: file.desiredHash })));
    const previous = { stateFileHash: state.stateFileHash, handoffFileHash: state.handoffFileHash };
    const previousSeq = chat.seq;
    updateHashes(state, intent.files);
    delete state.mirrorIntent;
    try {
      if (intent.event) return this.store.commitEvent(chat, intent.event);
      this.store.save(chat);
    }
    catch (error) {
      // commitEvent advances the sequence only once the event is in the durable WAL.
      if (chat.seq === previousSeq) {
        state.stateFileHash = previous.stateFileHash;
        state.handoffFileHash = previous.handoffFileHash;
        state.mirrorIntent = intent;
      }
      throw error;
    }
    return undefined;
  }
}
