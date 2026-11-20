import assert from 'node:assert/strict';
import type { ChatRecord } from '../../../../src/chat/types.js';
import type { MilestoneDefinition, PipelineTaskBinding } from '../../../../src/pipeline/implementation-types.js';
import type { ScriptedTurn } from '../../../../src/providers/scripted.js';
import type { ProviderEvent } from '../../../../src/providers/types.js';
import { architectureScript, response, type ToolCall } from './script.js';

export const implementationMilestones: MilestoneDefinition[] = [
  {
    id: 'M-STORE', title: '实现待办存储', owner: 'opus', acceptanceIds: ['AC-001'], dependsOn: [],
    paths: ['demo/cli.mjs', 'demo/todo.test.mjs'],
    checks: [{ id: 'CHECK-STORE', acceptanceIds: ['AC-001'], argv: ['node', '--test', 'demo/todo.test.mjs'], cwd: '.', timeoutMs: 10_000 }],
  },
  {
    id: 'M-CLI', title: '实现待办命令行', owner: 'sol', acceptanceIds: ['AC-002'], dependsOn: ['M-STORE'],
    paths: ['demo/smoke.mjs', 'demo/cli.test.mjs'],
    checks: [{ id: 'CHECK-CLI', acceptanceIds: ['AC-002'], argv: ['node', '--test', 'demo/cli.test.mjs'], cwd: '.', timeoutMs: 10_000 }],
  },
];

export const implementationPlanInput = { milestones: implementationMilestones };

export interface PipelineScriptOptions { failMilestoneVerify?: boolean; failFinalCommand?: boolean; adversarialDrift?: boolean }

const todoSource = `// 模拟数据：M7 todo-cli 实现
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const store = path.join(directory, 'todos.json');
const read = () => fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : [];
const [command, ...words] = process.argv.slice(2);
if (command === 'add' && words.join(' ').trim()) {
  const todos = read(); const item = { id: todos.length + 1, text: words.join(' '), done: false };
  todos.push(item); fs.writeFileSync(store, JSON.stringify(todos)); console.log(JSON.stringify(item));
} else if (command === 'list') console.log(JSON.stringify(read()));
else { console.error('usage: add <text> | list'); process.exitCode = 2; }
`;
const todoTest = `// 模拟数据：AC-001 命令验收
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
test('add exits zero and prints the new item', () => { fs.rmSync('demo/todos.json', { force: true }); const run = spawnSync(process.execPath, ['demo/cli.mjs', 'add', 'first'], { encoding: 'utf8' }); assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).text, 'first'); });
`;
const cliSource = `// 模拟数据：M7 同一命令内执行最终 AC
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
fs.rmSync(new URL('todos.json', import.meta.url), { force: true });
for (const args of [['cli.mjs', 'add', 'first'], ['cli.mjs', 'add', 'second'], ['cli.mjs', 'list']]) { const run = spawnSync(process.execPath, args, { encoding: 'utf8' }); process.stdout.write(run.stdout); process.stderr.write(run.stderr); if (run.status !== 0) process.exit(run.status ?? 1); }
`;
const cliTest = `// 模拟数据：AC-002 命令验收
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
test('list preserves creation order', () => { fs.rmSync('demo/todos.json', { force: true }); for (const text of ['first', 'second']) assert.equal(spawnSync(process.execPath, ['demo/cli.mjs', 'add', text]).status, 0); const run = spawnSync(process.execPath, ['demo/cli.mjs', 'list'], { encoding: 'utf8' }); assert.equal(run.status, 0); assert.deepEqual(JSON.parse(run.stdout).map(item => item.text), ['first', 'second']); });
`;
const brokenFinalSource = `// 模拟数据：负向夹具专用的最终 AC 故障\nconsole.error('forced-final-command-failure'); process.exit(19);\n`;
const weakCliTest = `// 模拟数据：负向夹具中故意不足的里程碑检查\nimport test from 'node:test'; import assert from 'node:assert/strict'; test('weak check', () => assert.equal(1, 1));\n`;

type BoundTask = ChatRecord['tasks'][number] & { pipelineWork?: PipelineTaskBinding };
type ToolResult = { text: string };
const results = (turn: ScriptedTurn): ToolResult[] => turn.input.toolResults ?? [];
function parsed<T>(turn: ScriptedTurn, index = -1): T {
  const item = results(turn).at(index);
  assert.ok(item);
  return JSON.parse(item.text) as T;
}
const complete = (text: string) => response(['task_complete', { result: `模拟数据：${text}` }]);

/** Architecture plus implementation producer. Docker ownership remains in the test harness. */
export function pipelineScript(getChat: () => ChatRecord, options: PipelineScriptOptions = {}) {
  const architecture = architectureScript(getChat);
  const stages = new Map<string, number>();
  const driftAuthors = new Set<string>();
  let driftInjected = false;
  const milestones = options.failMilestoneVerify ? implementationMilestones.map(item => item.id !== 'M-STORE' ? item : ({ ...item,
    checks: item.checks.map(check => ({ ...check, argv: ['sh', '-lc',
      'if [ -e /cache/m7-verify-marker ]; then echo forced-program-verify-failure >&2; exit 17; fi; touch /cache/m7-verify-marker; node --test demo/todo.test.mjs'] })) })) : implementationMilestones;
  const selectedMilestones = options.failFinalCommand ? milestones.map(item => item.id !== 'M-CLI' ? item : ({ ...item,
    paths: [...item.paths, 'demo/cli.mjs'].sort() })) : milestones;
  const planInput = { milestones: selectedMilestones };
  return (turn: ScriptedTurn): ProviderEvent[] => {
    const chat = getChat();
    const task = chat.tasks.find(item => item.id === turn.init.cacheKey) as BoundTask | undefined;
    assert.ok(task);
    const work = task.pipelineWork;
    if (!work || chat.pipeline?.stage === 'architecture' || chat.pipeline?.stage === 'gate-a') return architecture(turn);
    if (work.kind === 'product-review') return architecture(turn);
    const stage = stages.get(task.id) ?? 0;
    stages.set(task.id, stage + 1);

    if (work.kind === 'implementation-sol') {
      const implementation = chat.pipeline!.implementation!;
      if (!implementation.proposals.length) return response(['impl_plan_submit', planInput]);
      const integrating = implementation.milestones.find(item => item.status === 'integrating');
      if (integrating) {
        const definition = selectedMilestones.find(item => item.id === integrating.id)!;
        const authorTaskId = integrating.attempts.at(-1)!.authorTaskId;
        return response(['integrate_edit', { taskId: authorTaskId, allowedFiles: definition.paths }]);
      }
      const verifying = implementation.milestones.find(item => item.status === 'verifying');
      if (verifying) return response(['milestone_verify', { milestoneId: verifying.id }]);
      if (implementation.milestones.length && implementation.milestones.every(item => item.status === 'complete')) {
        return complete('实现协调器已集成 Opus 候选，并完成所有真实 Docker 里程碑检查');
      }
      const pending = chat.tasks.filter(item => item.parentTaskId === task.id && !['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status));
      if (pending.length) return response(['task_collect', { taskIds: pending.map(item => item.id), wait: true }]);
      return response(['task_yield', { next: '模拟数据：等待当前作者、评审或计划互签收口' }]);
    }
    if (work.kind === 'plan-review') {
      if (stage === 0) return response(['result_read', { ref: work.subjectRef, offset: 0 }]);
      if (stage === 1) return response(['review_submit', { subjectHash: work.subjectHash, outcome: 'passed', defects: [] }]);
      return complete('计划评审已绑定冻结哈希并通过');
    }
    if (work.kind === 'alignment') {
      if (stage === 0) return response(['result_read', { ref: chat.pipeline!.contract!.ref, offset: 0 }]);
      return response(['task_complete', { report: { status: 'completed',
        summary: `一致 AC-001：${work.milestoneId} 的机械越界提醒有效，拒绝后只采用声明范围内的改动。`,
        evidenceRefs: [chat.pipeline!.contract!.ref], changedFiles: [], deviations: [], concerns: ['需核对对齐提醒后的最终冻结候选'] } }]);
    }
    if (work.kind === 'milestone-author') {
      if (stage === 0) return response(['user_source_list', {}]);
      if (stage === 1) {
        const source = parsed<{ sources: { id: string; kind: string }[] }>(turn).sources.find(item => item.kind === 'message')!;
        return response(['user_source_read', { sourceId: source.id, offset: 0 }]);
      }
      if (stage === 2 && options.adversarialDrift && !driftInjected && work.milestoneId === 'M-STORE') {
        driftInjected = true;
        driftAuthors.add(task.id);
        return response(['file_write', { path: 'forbidden/outside.txt', text: '模拟数据：这一越界写入必须被程序拒绝', expectedHash: null }]);
      }
      if (stage === 3 && driftAuthors.has(task.id)) {
        const rejected = parsed<{ ok: boolean; code: string; issues: string[]; next: string }>(turn);
        assert.deepEqual([rejected.ok, rejected.code, rejected.next], [false, 'MILESTONE_PATH_DRIFT', 'task_yield']);
        assert.ok(rejected.issues.some(issue => issue.includes('forbidden/outside.txt')));
        return response(['task_yield', { next: '模拟数据：已接受对齐提醒，新窗口仅写冻结路径 demo/cli.mjs 与 demo/todo.test.mjs' }]);
      }
      const authorStage = driftAuthors.has(task.id) ? stage - 2 : stage;
      if (authorStage === 2) {
        if (work.milestoneId === 'M-CLI' && options.failFinalCommand) return response(
          ['file_read', { path: 'demo/cli.mjs' }], ['file_read', { path: 'demo/smoke.mjs' }]);
        return response(['file_read', { path: work.milestoneId === 'M-STORE' ? 'demo/cli.mjs' : 'demo/smoke.mjs' }]);
      }
      if (authorStage === 3) {
        const current = parsed<{ hash: string }>(turn, 0);
        const writes: ToolCall[] = work.milestoneId === 'M-STORE'
          ? [['file_write', { path: 'demo/cli.mjs', text: todoSource, expectedHash: current.hash }], ['file_write', { path: 'demo/todo.test.mjs', text: todoTest, expectedHash: null }]]
          : options.failFinalCommand
            ? [['file_write', { path: 'demo/cli.mjs', text: brokenFinalSource, expectedHash: current.hash }],
              ['file_write', { path: 'demo/smoke.mjs', text: cliSource, expectedHash: parsed<{ hash: string }>(turn, 1).hash }],
              ['file_write', { path: 'demo/cli.test.mjs', text: weakCliTest, expectedHash: null }]]
            : [['file_write', { path: 'demo/smoke.mjs', text: cliSource, expectedHash: current.hash }], ['file_write', { path: 'demo/cli.test.mjs', text: cliTest, expectedHash: null }]];
        return response(...writes);
      }
      return complete(`${work.milestoneId} 作者完成`);
    }
    if (work.kind === 'milestone-review') {
      if (stage === 0) return response(['result_read', { ref: work.subjectRef, offset: 0 }]);
      const definition = selectedMilestones.find(item => item.id === work.milestoneId)!;
      if (stage <= definition.checks.length) {
        const check = definition.checks[stage - 1]!;
        return response(['exec', { argv: check.argv, cwd: check.cwd, timeoutMs: check.timeoutMs, purpose: 'test' }]);
      }
      if (stage === definition.checks.length + 1) {
        return response(['review_submit', { subjectHash: work.subjectHash, outcome: 'passed', defects: [] }]);
      }
      return complete(`${work.milestoneId} 交叉评审已绑定真实 Docker 回执并通过`);
    }
    if (work.kind === 'implementation-lead') {
      if (stage === 0) return response(['agent_submit', { role: 'astra', phase: 'acceptance', mode: 'verify', purpose: 'execution_review',
        goal: '模拟数据：独立重跑冻结 CONTRACT 的命令 AC，并核对 TRACE 和真实 Docker 回执' }]);
      const reviewer = chat.tasks.find(item => item.executionReviewOfTaskId === task.id);
      assert.ok(reviewer);
      if (stage === 1) return response(['task_collect', { taskIds: [reviewer.id], wait: true }]);
      if (stage === 2) {
        const report = chat.artifacts.find(item => item.taskId === reviewer.id && item.name === 'execution-review.md');
        assert.ok(report);
        return response(['result_read', { ref: report.relativePath, offset: 0 }]);
      }
      if (stage === 3) return response(['task_disposition', { taskId: reviewer.id, disposition: 'adopted' }]);
      return complete('实现层、TRACE 和 Astra 独立 Docker 验收均已登记');
    }
    return complete(`${work.kind} 完成`);
  };
}
