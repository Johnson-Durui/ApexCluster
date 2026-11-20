import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, apiPromptVersion } from '../src/chat/context.js';
import { ChatStore } from '../src/chat/store.js';
import type { FrozenApiRoster, Roster } from '../src/chat/roster.js';
import type { AgentTask, ChatRecord } from '../src/chat/types.js';

const capabilities = {
  askUser: false, delegateSeats: [] as string[], writeMain: false, writeIsolated: true,
  integrate: false, acceptance: false, exec: true,
};

function fixture(role: 'claude' | 'opus' | 'carbon', phase: AgentTask['phase'], delegation: 'explicit' | 'proactive') {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'api-context-')));
  const chat = store.create() as ChatRecord;
  const roster: Roster = {
    version: 1,
    rootSeat: role,
    seats: [{
      id: role, kind: 'lead', promptFile: `${role}.md`, strengths: `strength-${role}`,
      bindings: { default: { model: `model-${role}`, effort: 'max', delegation } },
      can: capabilities,
    }],
    pools: [{
      id: 'grok', binding: { model: 'grok-4.7', effort: 'high', delegation: 'none' },
      maxConcurrent: 64, maxWindowsPerTask: 2, strengths: 'bounded research',
    }],
    layers: { architecture: { pools: ['grok'] }, implementation: { pools: ['grok'] } },
  };
  chat.apiRoster = { roster, modelHashes: {} } satisfies FrozenApiRoster;
  const task: AgentTask = {
    id: 'task', turnId: 'turn', role, phase, goal: 'work', status: 'running', createdAt: '', updatedAt: '',
    segment: 1, invocationIds: [], noProgressSegments: 0, mode: role === 'opus' && phase === 'implementation' ? 'edit' : 'read',
  };
  chat.tasks.push(task);
  return { chat, task, store };
}

test('API prompt sections are ordered and use roster facts plus API tool names', () => {
  const { chat, task, store } = fixture('opus', 'implementation', 'proactive');
  const prompt = buildContext(chat, task, store).systemPrompt;
  const headings = ['# 席位身份', '# 新聊天共同规则', '# 实现层规则', '# Opus', '# 主动委派', '# API 窗口规则', '# 名册事实（程序生成）'];
  let cursor = -1;
  for (const heading of headings) {
    const next = prompt.indexOf(heading);
    assert.ok(next > cursor, `${heading} must follow the previous API prompt section`);
    cursor = next;
  }
  assert.match(prompt, /"model":"model-opus"/);
  assert.match(prompt, /"effort":"max"/);
  assert.match(prompt, /task_collect/);
  assert.match(prompt, /task_disposition/);
  assert.doesNotMatch(prompt, /grok_collect|grok_disposition|grok-4\.7-high-fast/);
  assert.match(prompt, /没有工具回执就不得声称读取、写入、执行或验证已经发生/);
});

test('API prompt version binds resolved phase and delegation sections', () => {
  const explicit = fixture('claude', 'architecture', 'explicit');
  const architectureVersion = apiPromptVersion(explicit.chat, explicit.task);
  assert.equal(architectureVersion, apiPromptVersion(explicit.chat, explicit.task));
  assert.match(architectureVersion, /^chat-api-v1-[a-f0-9]{64}$/);
  explicit.task.phase = 'implementation';
  assert.notEqual(apiPromptVersion(explicit.chat, explicit.task), architectureVersion);

  const proactive = fixture('claude', 'architecture', 'proactive');
  assert.notEqual(apiPromptVersion(proactive.chat, proactive.task), architectureVersion);
});

test('architecture prompts require real cross-reading, contract evidence, and bounded idea work', () => {
  const opus = fixture('opus', 'cluster', 'proactive');
  const opusPrompt = buildContext(opus.chat, opus.task, opus.store).systemPrompt;
  assert.match(opusPrompt, /核心架构至少调用一次 `cluster_submit` 的 `full` 模式/);
  assert.match(opusPrompt, /必须用 `result_read` 读到 Astra 备忘录的完整登记引用/);
  assert.match(opusPrompt, /没有成功读取回执时停止并报告/);
  assert.match(opusPrompt, /契约冻结后由全新 Astra `verify` 任务/);

  const carbon = fixture('carbon', 'cluster', 'proactive');
  const carbonPrompt = buildContext(carbon.chat, carbon.task, carbon.store).systemPrompt;
  assert.match(carbonPrompt, /只在 `full` 集群的第一波提供思路/);
  assert.match(carbonPrompt, /不预写他们的回应/);
  assert.match(carbonPrompt, /提交登记引用并结束本波任务/);
});
