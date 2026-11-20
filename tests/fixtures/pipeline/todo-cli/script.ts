import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChatRecord } from '../../../../src/chat/types.js';
import type { ScriptedTurn } from '../../../../src/providers/scripted.js';
import type { ProviderEvent } from '../../../../src/providers/types.js';

export type Scenario = {
  version: 1;
  preset: string;
  cluster: { mode: 'full'; crossRounds: 1 };
  requirements: { id: string; text: string }[];
  acceptance: { id: string; requirementIds: string[]; kind: 'command'; description: string; command: string }[];
  expectedArtifacts: string[];
};

export type ToolCall = [name: string, args: Record<string, unknown>];
type ToolResult = { callId: string; text: string };
type ExecutionRead = { contractHash: string; evidenceHash: string; viewRef: string };

export const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
export const requirement = readFileSync(new URL('requirement.md', import.meta.url), 'utf8');
export const scenario = JSON.parse(readFileSync(new URL('scenario.json', import.meta.url), 'utf8')) as Scenario;

export function response(...calls: ToolCall[]): ProviderEvent[] {
  return [
    { type: 'usage', input: 80, cachedInput: 0, output: 40 },
    ...calls.map(([name, args], index) => ({ type: 'tool_call' as const, callId: `call-${index}`, name, args })),
    { type: 'end', reason: 'tool_calls' },
  ];
}

const completed = (text = '模拟数据：完成') => response(['task_complete', { result: text }]);
const results = (turn: ScriptedTurn): ToolResult[] => turn.input.toolResults ?? [];
function data<T>(turn: ScriptedTurn, index = -1): T {
  const item = results(turn).at(index);
  assert.ok(item, `missing scripted tool result at ${index}`);
  return JSON.parse(item.text) as T;
}

const demoSource = (validateEntries = true) => `// 模拟数据：todo-cli 离线 Demo
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const store = path.join(directory, 'todos.json');
const read = () => {
  if (!fs.existsSync(store)) return [];
  const todos = JSON.parse(fs.readFileSync(store, 'utf8'));
  if (!Array.isArray(todos) || (${validateEntries} && todos.some(todo => todo === null || typeof todo !== 'object' || Array.isArray(todo) ||
    typeof todo.text !== 'string' || !todo.text.trim()))) {
    throw new Error('Invalid todo data in todos.json');
  }
  return todos;
};
const [command, ...words] = process.argv.slice(2);
if (command === 'add' && words.join(' ').trim()) {
  const todos = read();
  const item = { id: todos.length + 1, text: words.join(' '), done: false };
  todos.push(item);
  fs.writeFileSync(store, JSON.stringify(todos));
  console.log(JSON.stringify(item));
} else if (command === 'list') {
  console.log(JSON.stringify(read()));
} else {
  console.error('usage: add <text> | list');
  process.exitCode = 2;
}
`;

const demoSmokeSource = () => `// 模拟数据：同一真实 Docker 命令内执行 add 和 list
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

for (const args of [['cli.mjs', 'add', 'first'], ['cli.mjs', 'list']]) {
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.ifError(run.error);
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) process.exit(run.status ?? 1);
}

if (process.argv.includes('--positive-only')) process.exit(0);
const store = new URL('todos.json', import.meta.url);
const valid = readFileSync(store, 'utf8');
try {
  for (const entry of [null, [], {}, { text: 7 }, { text: '   ' }]) {
    const invalid = JSON.stringify([{ text: 'keep' }, entry]) + '\\n';
    for (const args of [['list'], ['add', 'second']]) {
      writeFileSync(store, invalid);
      const run = spawnSync(process.execPath, ['cli.mjs', ...args], { encoding: 'utf8' });
      assert.ifError(run.error);
      assert.ok(Number.isInteger(run.status) && run.status !== 0, args[0] + ' accepted ' + JSON.stringify(entry));
      assert.equal(run.stdout, '');
      assert.equal(readFileSync(store, 'utf8'), invalid);
    }
  }
} finally {
  writeFileSync(store, valid);
}
`;

const prd = () => `# 模拟数据：Todo CLI PRD

## 需求

- **R-001**：模拟数据：用户可以新增待办。
- **R-002**：模拟数据：用户可以按创建顺序列出待办。

## 验收

- **AC-001**：模拟数据：add 命令退出码为 0，覆盖 R-001，命令可验。
- **AC-002**：模拟数据：list 命令按创建顺序打印 JSON 数组，覆盖 R-002，命令可验。
`;

function sourceId(turn: ScriptedTurn): string {
  const listed = data<{ sources: { id: string; kind: string }[] }>(turn);
  const original = listed.sources.find(item => item.kind === 'message');
  assert.ok(original, `missing original message source: ${JSON.stringify(listed.sources)}`);
  return original.id;
}

/** Functional offline architecture producer reused by M6, M7 and M8 acceptance. */
export function architectureScript(getChat: () => ChatRecord, repairDemo = false) {
  const rootStages = new Map<string, number>();
  const childStages = new Map<string, number>();
  const sourceIds = new Map<string, string>();
  const reviewReads = new Map<string, ExecutionRead>();
  const reviewReports = new Map<string, string>();
  const reviewViews = new Map<string, string>();

  return (turn: ScriptedTurn): ProviderEvent[] => {
    const chat = getChat();
    const task = chat.tasks.find(item => item.id === turn.init.cacheKey)!;
    assert.ok(task, `missing task for cache key ${turn.init.cacheKey}`);
    const repairing = chat.pipeline?.demoRepairFrom !== undefined;
    const rejectedDemo = repairDemo && !repairing;

    if (!task.parentTaskId) {
      const rootStage = rootStages.get(task.id) ?? 0;
      rootStages.set(task.id, rootStage + 1);
      if (rootStage === 0) {
        return response(['task_yield', { next: '模拟数据：在新窗口继续架构层，不改变计划和来源' }]);
      }
      switch (rootStage - 1) {
        case 0: return response(['user_source_list', {}]);
        case 1: {
          sourceIds.set(task.id, sourceId(turn));
          if (repairing) {
            const carried = chat.pipeline!.clusters.find(item => item.id === chat.pipeline!.carriedClusterId);
            const previous = chat.tasks.find(item => item.id !== task.id && !item.parentTaskId && item.status === 'failed');
            const report = chat.artifacts.find(item => item.id === previous?.executionReviewAttempts?.at(-1)?.review?.reportArtifactId);
            assert.ok(carried?.summaryRef && report);
            assert.equal(sourceIds.get(task.id), sourceIds.get(previous!.id));
            rootStages.set(task.id, 6);
            return response(['result_read', { ref: carried.summaryRef, offset: 0 }], ['result_read', { ref: report.relativePath, offset: 0 }]);
          }
          return response(['cluster_submit', { mode: scenario.cluster.mode, crossRounds: scenario.cluster.crossRounds,
            draft: '模拟数据：目标、范围、关键决策点和待定问题初稿' }]);
        }
        case 2: return response(['task_collect', { groupId: chat.pipeline!.clusters[0]!.groupId, wait: true }]);
        case 3:
          assert.equal(data<{ status: string }>(turn).status, 'completed');
          return response(['result_read', { ref: chat.pipeline!.clusters[0]!.summaryRef!, offset: 0 }]);
        case 4:
          assert.match(results(turn)[0]!.text, /模拟数据/);
          return response(['task_disposition', { groupId: chat.pipeline!.clusters[0]!.groupId, disposition: 'adopted' }]);
        case 5:
          return response(
            ['artifact_publish', { name: 'PRD.md', text: prd(), kind: 'file' }],
            ['artifact_publish', { name: 'ARCHITECTURE.md', text: '# 模拟数据：架构\n\nNode.js 标准库 CLI，JSON 文件持久化，Docker 断网验证。', kind: 'file' }],
          );
        case 6: return response(['agent_submit', { role: 'astra', phase: 'architecture', mode: 'read', goal: '发布模拟数据 DEV_GUIDE.md' }]);
        case 7: {
          const child = chat.tasks.find(item => item.parentTaskId === task.id && item.role === 'astra' && item.phase === 'architecture')!;
          return response(['task_collect', { taskIds: [child.id], wait: true }]);
        }
        case 8: {
          const child = chat.tasks.find(item => item.parentTaskId === task.id && item.role === 'astra' && item.phase === 'architecture')!;
          return response(['task_disposition', { taskId: child.id, disposition: 'adopted' }]);
        }
        case 9: return response(['agent_submit', { role: 'sol', phase: 'demo', mode: 'edit', goal: '实现并用真实 Docker 运行 demo/todo-cli' }]);
        case 10: {
          const child = chat.tasks.find(item => item.parentTaskId === task.id && item.role === 'sol' && item.phase === 'demo')!;
          return response(['task_collect', { taskIds: [child.id], wait: true }]);
        }
        case 11: {
          const child = chat.tasks.find(item => item.parentTaskId === task.id && item.role === 'sol' && item.phase === 'demo')!;
          return response(['task_disposition', { taskId: child.id, disposition: 'adopted' }]);
        }
        case 12:
          return response(['contract_submit', {
            requirements: scenario.requirements.map(item => ({ ...item,
              text: repairing ? item.text + '模拟数据：未获授权的验收范围变更' : item.text,
              sourceIds: [sourceIds.get(task.id)!],
            })),
            acceptance: repairing ? scenario.acceptance : scenario.acceptance.slice(0, 1),
          }]);
        case 13: {
          const rejected = data<{ ok: boolean; issues: { code: string; message: string }[] }>(turn);
          assert.equal(rejected.ok, false);
          assert.ok(rejected.issues.some(issue => repairing ? issue.code === 'DEMO_REPAIR_SCOPE' :
            issue.code === 'MISSING_PRD_ACCEPTANCE' && issue.message.includes('AC-002')));
          return response(['contract_submit', {
            requirements: scenario.requirements.map(item => ({ ...item, sourceIds: [sourceIds.get(task.id)!] })),
            acceptance: scenario.acceptance,
          }]);
        }
        case 14:
          assert.equal(data<{ ok: boolean }>(turn).ok, true);
          return response(['agent_submit', { role: 'astra', phase: 'acceptance', mode: 'verify', purpose: 'execution_review',
            goal: '独立评审架构层全部冻结产物和真实 Demo 回执' }]);
        case 15: {
          const child = chat.tasks.find(item => item.executionReviewOfTaskId === task.id)!;
          return response(['task_collect', { taskIds: [child.id], wait: true }]);
        }
        case 16: {
          const child = chat.tasks.find(item => item.executionReviewOfTaskId === task.id)!;
          const report = chat.artifacts.find(item => item.taskId === child.id && item.name === 'execution-review.md')!;
          return response(['result_read', { ref: report.relativePath, offset: 0 }]);
        }
        case 17: {
          const child = chat.tasks.find(item => item.executionReviewOfTaskId === task.id)!;
          return response(['task_disposition', { taskId: child.id, disposition: 'adopted' }]);
        }
        default: {
          if (rejectedDemo) return response(['agent_submit', { role: 'sol', phase: 'demo', mode: 'edit', goal: '修复冻结评审报告中发现的模拟数据校验失败' }]);
          const prior = results(turn)[0]?.text;
          if (prior) {
            const parsed = JSON.parse(prior) as { accepted?: boolean };
            if (parsed.accepted === false) throw new Error(`root completion rejected: ${prior}`);
          }
          return completed('模拟数据：架构层产物、真实 Docker Demo 和 Astra 独立评审均已登记');
        }
      }
    }

    if (task.phase === 'cluster') {
      const unread = (task.clusterReadTaskIds ?? []).filter(id => !task.resultReadPages?.some(page => chat.tasks.find(item => item.id === id)?.resultRef === page.ref));
      if (unread.length) return response(...unread.map(id => ['result_read', { ref: chat.tasks.find(item => item.id === id)!.resultRef!, offset: 0 }] as ToolCall));
      return completed(`模拟数据：${task.role} ${task.clusterReadTaskIds?.length ? '已读取对方备忘录并回应' : '独立备忘录'}`);
    }

    const stage = childStages.get(task.id) ?? 0;
    childStages.set(task.id, stage + 1);
    if (task.role === 'sol' && task.phase === 'demo') {
      if (stage === 0) return response(['user_source_list', {}]);
      if (stage === 1) {
        sourceIds.set(task.id, sourceId(turn));
        return response(['user_source_read', { sourceId: sourceIds.get(task.id)!, offset: 0 }]);
      }
      const command = { argv: rejectedDemo ? ['node', 'smoke.mjs', '--positive-only'] : ['node', 'smoke.mjs'], cwd: 'demo', timeoutMs: 10_000, purpose: 'test' };
      if (stage === 2) return response(
        ['file_list', { path: 'demo' }],
        ['file_read', { path: 'demo/cli.mjs' }],
      );
      if (stage === 3) {
        if (repairing) {
          const previous = data<{ hash: string; text: string }>(turn);
          assert.match(previous.text, /false && todos.some/);
          childStages.set(task.id, 6);
          return response(['file_write', { path: 'demo/cli.mjs', text: demoSource(), expectedHash: previous.hash }]);
        }
        assert.deepEqual(data<string[]>(turn, 0), []);
        assert.deepEqual(data<{ exists: false; path: string; hash: null }>(turn), { exists: false, path: 'demo/cli.mjs', hash: null });
        return response(['exec', { ...command, cwd: '.' }]);
      }
      if (stage === 4) {
        assert.equal(data<{ code: string }>(turn).code, 'DEMO_CWD_REQUIRED');
        return response(['exec', command]);
      }
      if (stage === 5) {
        assert.equal(data<{ code: string }>(turn).code, 'DEMO_SOURCE_REQUIRED');
        return response(
          ['file_write', { path: 'demo/cli.mjs', text: demoSource(!rejectedDemo), expectedHash: null }],
          ['file_write', { path: 'demo/smoke.mjs', text: demoSmokeSource(), expectedHash: null }],
        );
      }
      if (stage === 6) return response(['exec', { ...command, cwd: './demo' }]);
      if (stage === 7) {
        const receipt = data<{ receiptRef: string }>(turn);
        return response(['artifact_publish', { name: 'DEMO_REPORT.md',
          text: `# 模拟数据：Demo 报告\n\n真实 Docker 在同一 smoke 命令中执行 \`add\` 和 \`list\`。\n\n不可变回执：\`${receipt.receiptRef}\`。`, kind: 'report' }]);
      }
      return completed('模拟数据：todo-cli Demo 已由真实 Docker 断网执行');
    }

    if (task.role === 'astra' && task.phase === 'architecture') {
      if (stage === 0) return response(['artifact_publish', { name: 'DEV_GUIDE.md',
        text: '# 模拟数据：开发指南\n\n使用 Node.js 22，执行 `node demo/cli.mjs add first` 和 `node demo/cli.mjs list`。', kind: 'file' }]);
      return completed('模拟数据：开发指南已发布');
    }

    if (task.executionReviewOfTaskId) {
      if (stage === 0) return response(['user_source_list', {}]);
      if (stage === 1) {
        sourceIds.set(task.id, sourceId(turn));
        return response(['user_source_read', { sourceId: sourceIds.get(task.id)!, offset: 0 }]);
      }
      if (stage === 2) {
        const reviewed = chat.tasks.find(item => item.id === task.executionReviewOfTaskId)!;
        if (task.pipelineWork?.kind === 'product-review') return response(...scenario.acceptance.map(item =>
          ['exec', { argv: ['sh', '-lc', item.command], cwd: '.', timeoutMs: 60_000, purpose: 'test' }] as ToolCall));
        const argv = reviewed.phase === 'implementation' || repairDemo ? ['node', 'smoke.mjs'] : ['node', 'cli.mjs', 'list'];
        return response(['exec', { argv, cwd: 'demo', timeoutMs: 10_000, purpose: 'test' }]);
      }
      if (stage === 3) {
        if (repairDemo) assert.equal(data<{ ok: boolean }>(turn).ok, !rejectedDemo);
        return response(['execution_read', {}]);
      }
      if (stage === 4) {
        const execution = data<ExecutionRead>(turn);
        reviewReads.set(task.id, execution);
        return response(['result_read', { ref: execution.viewRef, offset: 0 }]);
      }
      if (stage === 5) {
        const page = results(turn)[0]!.text;
        const viewText = (reviewViews.get(task.id) ?? '') + page.slice(page.indexOf('\n') + 1);
        reviewViews.set(task.id, viewText);
        const next = /^\[程序分页 offset=\d+ next=(\d+|null)\]/u.exec(page)?.[1];
        assert.ok(next);
        if (next !== 'null') {
          childStages.set(task.id, stage);
          return response(['result_read', { ref: reviewReads.get(task.id)!.viewRef, offset: Number(next) }]);
        }
        const view = JSON.parse(viewText) as { requiredRefs: { ref: string }[] };
        return response(...[...new Set(view.requiredRefs.map(item => item.ref))].map(ref => ['result_read', { ref, offset: 0 }] as ToolCall));
      }
      if (stage === 6) {
        assert.ok(results(turn).length >= 5);
        const execution = reviewReads.get(task.id)!;
        return response(['artifact_publish', { name: 'execution-review.md',
          text: `# 模拟数据：Astra 独立评审\n\n${rejectedDemo ? 'Demo 条目校验失败' : 'passed'} ${execution.contractHash} ${execution.evidenceHash}`, kind: 'report' }]);
      }
      if (stage === 7) {
        const report = data<{ id: string }>(turn);
        reviewReports.set(task.id, report.id);
        const execution = reviewReads.get(task.id)!;
        const root = chat.tasks.find(item => item.id === task.executionReviewOfTaskId)!;
        return response(['execution_submit_review', {
          contractHash: execution.contractHash, evidenceHash: execution.evidenceHash, outcome: rejectedDemo ? 'failed' : 'passed',
          stepVerdicts: chat.todos!.filter(item => item.taskId === root.id)
            .map(item => ({ stepId: item.id, outcome: rejectedDemo && item.id.endsWith('-demo') ? 'failed' : 'passed' })),
          reportArtifactId: report.id,
        }]);
      }
      if (stage === 8) {
        const submitted = data<{ accepted: boolean; issues?: string[] }>(turn);
        assert.equal(submitted.accepted, true, JSON.stringify(submitted));
        return completed(`模拟数据：独立评审${rejectedDemo ? '失败' : '通过'}，报告 ${reviewReports.get(task.id)}`);
      }
    }
    throw new Error(`unexpected scripted task ${task.role}/${task.phase}/${task.goal}`);
  };
}
