import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { loadRoster } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask, ChatMessage, ChatRecord } from '../src/chat/types.js';
import { newPipelineState, type PipelineContractLink } from '../src/pipeline/state.js';
import { loadModelRegistry } from '../src/providers/registry.js';

const contract: PipelineContractLink = {
  ref: 'blobs/contract.json', hash: 'a'.repeat(64), contractSha256: 'b'.repeat(64), artifactId: 'contract-artifact', revision: 1,
};

function fixture(auto = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dmw-pipeline-gate-'));
  const registry = loadModelRegistry();
  const roster = loadRoster('config/roster.json', registry);
  const runtime = new ChatRuntime({ store: new ChatStore(root), drivers: {}, api: createApiChatBinding(roster, registry, null) });
  const chat = runtime.create({});
  chat.pipeline = newPipelineState({ preset: 'flagship', auto });
  chat.pipeline.stage = 'gate-a';
  chat.pipeline.contract = { ...contract };
  runtime.store.save(chat);
  const messages = () => runtime.store.messages(chat.id).items.filter(message => message.pipelineGate) as ChatMessage[];
  return { root, runtime, chat, messages, close: async () => { await runtime.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

test('Gate A confirmation is one pending-only user decision and advances to implementation', async () => {
  const f = fixture(); try {
    const result = f.runtime.decidePipelineGate(f.chat.id, 'A', { decision: 'confirm' });
    assert.equal(result.pipeline!.stage, 'implementation');
    assert.equal(result.pipeline!.gateDecisions.length, 1);
    const message = f.messages()[0]!;
    assert.equal(message.role, 'user');
    assert.equal(message.auto, undefined);
    assert.deepEqual(message.pipelineGate, { id: 'A', revision: 1, decision: 'confirm' });
    assert.equal(result.pipeline!.gateDecisions[0]!.messageId, message.id);
    assert.ok(result.constraintMessageIds.includes(message.id));
    assert.throws(() => f.runtime.decidePipelineGate(f.chat.id, 'A', { decision: 'confirm' }), /当前未开放/);
    assert.equal(f.messages().length, 1, 'rejected duplicate must not append a second decision message');
  } finally { await f.close(); }
});

test('Gate A revision preserves the prior contract and queues a new root from the exact feedback source', async () => {
  const f = fixture(); try {
    const previous: AgentTask = {
      id: 'architecture-v1', turnId: 'turn-v1', role: 'claude', phase: 'architecture', goal: 'first architecture', status: 'completed',
      createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read',
    };
    f.chat.tasks.push(previous);
    f.chat.pipeline!.architectureTaskId = previous.id;
    f.runtime.store.save(f.chat);

    f.runtime.decidePipelineGate(f.chat.id, 'A', { decision: 'revise', feedback: '保留完全离线运行，并重新核对 AC-002。' });
    const state = f.chat.pipeline!;
    const message = f.messages()[0]!;
    const next = f.chat.tasks.find(task => task.id === state.architectureTaskId)!;
    assert.equal(state.stage, 'architecture');
    assert.equal(state.revision, 2);
    assert.equal(state.contract, undefined);
    assert.deepEqual(state.priorContracts, [contract]);
    assert.equal(message.role, 'user');
    assert.equal(message.text, '保留完全离线运行，并重新核对 AC-002。');
    assert.ok(f.chat.constraintMessageIds.includes(message.id));
    assert.equal(next.status, 'queued');
    assert.equal(next.turnId, message.turnId);
    assert.equal(next.phase, 'architecture');
    assert.match(next.goal, /architecture-v1/);
    assert.ok(f.chat.todos?.some(step => step.taskId === next.id && step.id.startsWith('arch-2-')));
  } finally { await f.close(); }
});

test('Gate A cancellation records its user source and makes the pipeline terminal', async () => {
  const f = fixture(); try {
    f.runtime.decidePipelineGate(f.chat.id, 'A', { decision: 'cancel' });
    assert.equal(f.chat.pipeline!.stage, 'cancelled');
    const message = f.messages()[0]!;
    assert.equal(message.role, 'user');
    assert.equal(message.text, '关卡 A 终止');
    assert.ok(f.chat.constraintMessageIds.includes(message.id));
    assert.throws(() => f.runtime.decidePipelineGate(f.chat.id, 'A', { decision: 'confirm' }), /当前未开放/);
  } finally { await f.close(); }
});

test('automatic Gate A confirmation is a marked system message and never becomes user source', async () => {
  const f = fixture(true); try {
    f.chat.pipeline!.stage = 'architecture';
    const architecture: AgentTask = {
      id: 'architecture-auto', turnId: 'turn-auto', role: 'claude', phase: 'architecture', goal: 'auto architecture', status: 'completed',
      createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read',
    };
    f.chat.tasks.push(architecture);
    f.chat.pipeline!.architectureTaskId = architecture.id;
    f.runtime.store.save(f.chat);

    f.runtime['advancePipelineGate'](f.chat);
    assert.equal(f.chat.pipeline!.stage, 'implementation');
    const message = f.messages()[0]!;
    assert.equal(message.role, 'system');
    assert.equal(message.auto, true);
    assert.equal(f.chat.pipeline!.gateDecisions[0]!.automatic, true);
    assert.ok(!f.chat.constraintMessageIds.includes(message.id));
  } finally { await f.close(); }
});
