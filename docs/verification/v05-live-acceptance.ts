/** 有界 H5/H6 实验驱动。设计和构建分开；G2 需明确批准，G4 永不自动接受。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { ModelAdapter } from '../../src/adapters/types.js';
import { loadConfig, type WorkbenchConfig } from '../../src/config.js';
import { CreateRunInputZ, G2InputZ } from '../../src/core/schemas.js';
import type { Run } from '../../src/core/types.js';
import { shortHash } from '../../src/core/util.js';
import { EventBus } from '../../src/orchestrator/events.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { RunStore } from '../../src/orchestrator/store.js';

export const EXPERIMENT_ROOT = path.resolve('work/v05-acceptance-20261026');
export type Arm = 'off' | 'evaluate' | 'both';
export const CHECKS: Record<string, string> = {
  'check-normal.mjs': "import assert from 'node:assert/strict';\nimport { sumIntegers } from './sum.mjs';\nassert.equal(sumIntegers(2, 3), 5);\nassert.equal(sumIntegers(-9, 4), -5);\nconsole.log('NORMAL_OK');\n",
  'check-boundary.mjs': "import assert from 'node:assert/strict';\nimport { sumIntegers } from './sum.mjs';\nassert.equal(sumIntegers(0, 0), 0);\nassert.equal(sumIntegers(Number.MAX_SAFE_INTEGER, 0), Number.MAX_SAFE_INTEGER);\nassert.equal(sumIntegers(Number.MIN_SAFE_INTEGER, 0), Number.MIN_SAFE_INTEGER);\nconsole.log('BOUNDARY_OK');\n",
  'check-invalid.mjs': "import assert from 'node:assert/strict';\nimport { sumIntegers } from './sum.mjs';\nfor (const args of [[1.5, 2], ['1', 2], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER, 1], [Number.MIN_SAFE_INTEGER, -1]]) assert.throws(() => sumIntegers(...args), RangeError);\nconsole.log('INVALID_OK');\n",
};
export const CHECKS_HASH = createHash('sha256').update(JSON.stringify(CHECKS)).digest('hex');
export const FIXTURE = {
  goal: '实现无依赖 ES 模块 sum.mjs，导出 sumIntegers(a,b)：两个输入及结果都必须是 JavaScript 安全整数，否则抛 RangeError。',
  scopeIn: ['一个工作流：调用 sumIntegers 并返回整数结果或抛 RangeError', '正常、零、边界、非法输入与溢出；固定三份验收脚本不得修改'],
  scopeOut: ['界面、服务器、数据库、网络、包安装、子代理', '新增 API 或更改验收脚本、自动接受 G4'],
  acceptance: [
    { id: 'AC1', description: '正负安全整数求和', kind: 'command' as const, command: 'node check-normal.mjs', expectExitCode: 0, outputIncludes: 'NORMAL_OK' },
    { id: 'AC2', description: '零和安全整数上下界', kind: 'command' as const, command: 'node check-boundary.mjs', expectExitCode: 0, outputIncludes: 'BOUNDARY_OK' },
    { id: 'AC3', description: '非整数、非数字、无穷及溢出抛 RangeError', kind: 'command' as const, command: 'node check-invalid.mjs', expectExitCode: 0, outputIncludes: 'INVALID_OK' },
  ],
  hypotheses: [], timeboxMinutes: 15, allowNetwork: false,
};

export function experimentConfig(arm: Arm): WorkbenchConfig {
  const config = loadConfig();
  config.dataDir = path.join(EXPERIMENT_ROOT, 'data');
  config.workspacesRoot = path.join(EXPERIMENT_ROOT, 'ws');
  config.evaluator.enabled = arm !== 'off';
  config.finalReview.enabled = arm === 'both';
  config.evaluator.timeoutMinutes = 5;
  config.finalReview.timeoutMinutes = 5;
  config.contextBudget.enabled = true;
  config.build = { ...config.build, autoRework: false, maxRounds: 2, maxWriterSessions: 6, maxModelCalls: 10, maxActiveMinutes: 30, resumePolicy: 'budgeted', lightReworkEnabled: false };
  config.chores = { digest: false, qgroup: false };
  config.timeoutsMinutes.propose = 15;
  config.timeoutsMinutes.review = 15;
  config.limits.maxConcurrentModelTasks = 1;
  config.limits.maxConcurrentJobs = 1;
  return config;
}

export function experimentInput(arm: Arm) {
  return CreateRunInputZ.parse({
    title: 'H5/H6 固定整数求和模块', mode: 'real', clarifyWith: 'skip', allowWebResearch: false,
    writeDocs: false, writePrd: false, designMode: 'single', riskLevel: 'low',
    evaluator: { enabled: arm !== 'off' }, finalReview: { enabled: arm === 'both' },
    contextBudget: { enabled: true },
    project: {
      prompt: `${FIXTURE.goal}\n这是 H5/H6 固定实验，用户已经限定 Node.js 原生 ES 模块、一个函数与一个工作流。只需提出一个最小方案，不引入 UI、服务、依赖或其他功能。固定三条验收命令：${FIXTURE.acceptance.map(item => item.command).join('；')}。构建前程序会提供检查文件，禁止修改或绕过检查。`,
      coreFlows: [FIXTURE.scopeIn[0]], existingStack: 'Node.js 原生 ES 模块，无外部依赖', deployment: 'Windows 本机',
      acceptance: FIXTURE.acceptance.map(item => `${item.id}: ${item.description}; ${item.command}; ${item.outputIncludes}`).join('\n'),
    },
    constraints: [
      { text: '仅限 Node.js 原生 ES 模块，一个 sumIntegers 函数、一个工作流，无任何外部依赖、网络、子代理或服务。', kind: 'must' },
      { text: '输入和结果都必须是安全整数；非法输入及溢出一律抛 RangeError；不得修改程序提供的三份验收脚本。', kind: 'must' },
    ],
  });
}

export function fixtureFilesIntact(cwd: string): boolean {
  return Object.entries(CHECKS).every(([name, source]) => {
    const file = path.join(cwd, name);
    return existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && readFileSync(file, 'utf8') === source;
  });
}

export function fixtureEvidence(cwd: string, runId: string) {
  const files: Record<string, string | null> = {};
  for (const name of Object.keys(CHECKS)) {
    const file = path.join(cwd, name);
    files[name] = existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() ? readFileSync(file, 'utf8') : null;
  }
  const allowed = new Set([...Object.keys(CHECKS), 'sum.mjs', 'README.md', 'AGENTS.md', 'DEV_GUIDE.md', 'MVP_SPEC.md',
    'PREFLIGHT.md', 'PLAN.json', 'HANDOFF.md', 'PROGRESS.md', '.gitignore', 'REWORK_BRIEF.md', 'ROUND_DIGEST.md']);
  const unexpectedEntries = readdirSync(cwd, { withFileTypes: true }).filter(entry =>
    entry.isSymbolicLink() || (entry.name === '.git' ? !entry.isDirectory() : !entry.isFile() || !allowed.has(entry.name)),
  ).map(entry => entry.name);
  return { runId, observedChecksHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), unexpectedEntries };
}

/** 只准备写者工作区之外的可信检查副本，不执行生成代码、不生成通过结论。 */
export function prepareIndependentAudit(cwd: string, runId: string, auditRoot: string) {
  const sourcePath = path.join(cwd, 'sum.mjs');
  if (!lstatSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink()) throw new Error('最终源码必须是普通文件');
  const relative = path.relative(path.resolve(cwd), path.resolve(auditRoot));
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('独立审计目录必须位于写者工作区之外');
  const source = readFileSync(sourcePath);
  mkdirSync(auditRoot, { recursive: true });
  const auditDir = mkdtempSync(path.join(auditRoot, 'fixed-'));
  writeFileSync(path.join(auditDir, 'sum.mjs'), source);
  for (const [name, contents] of Object.entries(CHECKS)) writeFileSync(path.join(auditDir, name), contents, 'utf8');
  const manifest = { runId, auditDir, sourcePath, sourceHash: createHash('sha256').update(source).digest('hex'), checksHash: CHECKS_HASH,
    independentVerification: null, instructions: '先审阅最终 sum.mjs，再由独立沙箱执行三份可信检查，记录实际退出码和输出；不能复用写者工具日志。' };
  writeFileSync(path.join(auditDir, 'audit-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function runtime(arm: Arm) {
  const config = experimentConfig(arm);
  const store = new RunStore(config.dataDir);
  const bus = new EventBus(store);
  const claude = new ClaudeCodeAdapter(config.adapters.claude);
  const codex = new CodexAdapter(config.adapters.codex);
  const adapter: ModelAdapter = {
    kind: 'codex',
    async run(spec, progress, signal) {
      const firstBuild = spec.phase === 'build' && spec.sandbox === 'workspace_write' && !spec.context.finalVerification;
      const fixtureMarker = path.join(EXPERIMENT_ROOT, `fixture-${shortHash(spec.cwd)}.json`);
      if (firstBuild && !existsSync(fixtureMarker)) {
        if (Object.keys(CHECKS).some(name => existsSync(path.join(spec.cwd, name)))) throw new Error('固定检查文件在初始化前已存在，拒绝覆盖');
        for (const [name, source] of Object.entries(CHECKS)) writeFileSync(path.join(spec.cwd, name), source, 'utf8');
        writeFileSync(fixtureMarker, JSON.stringify({ runId: spec.runId, cwd: spec.cwd, checksHash: CHECKS_HASH, specRef: spec.context.spec?.ref }), 'utf8');
      }
      if (spec.phase === 'build' && (!existsSync(fixtureMarker) || !fixtureFilesIntact(spec.cwd))) throw new Error('固定验收脚本缺失或被修改，拒绝继续实验');
      const result = await codex.run(spec, progress, signal);
      if (spec.phase === 'build') {
        const evidence = fixtureEvidence(spec.cwd, spec.runId);
        writeFileSync(path.join(spec.logDir, 'fixture-checks.json'), JSON.stringify({ ...evidence, taskId: spec.taskId, specRef: spec.context.spec?.ref,
          finalVerification: spec.context.finalVerification === true, checkedAt: new Date().toISOString(), expectedChecksHash: CHECKS_HASH }, null, 2));
        if (evidence.observedChecksHash !== CHECKS_HASH || evidence.unexpectedEntries.length) return { ...result, status: 'failed', failure: { kind: 'invalid_output', message: '固定验收脚本被修改或出现范围外文件，实验无效' } };
      }
      return result;
    },
  };
  const orch = new Orchestrator({ config, store, bus, adapterFor: role => role === 'claude' ? claude : adapter });
  return { config, store, bus, orch };
}

function summarize(run: Run) {
  return { id: run.id, phase: run.phase, status: run.phaseStatus, blockedReason: run.blockedReason,
    candidates: run.candidates.map(candidate => ({ id: candidate.id, proposal: run.proposals.find(proposal => proposal.id === candidate.representativeProposalId) })),
    tasks: run.tasks.map(task => ({ id: task.id, role: task.role, phase: task.phase, status: task.status, valid: task.outputValidity, failure: task.failure })),
    jobs: run.jobs.map(job => ({ id: job.id, status: job.status, verification: job.verification, finalReview: job.finalReview, budget: job.budget })) };
}

export async function main(args = process.argv.slice(2)) {
  const [action, armText, runId, candidateId] = args.filter(arg => !arg.startsWith('--'));
  if (!['plan', 'design', 'build', 'audit'].includes(action ?? '') || !['off', 'evaluate', 'both'].includes(armText ?? '')) throw new Error('用法：plan|design|build|audit off|evaluate|both [runId candidateId] [--yes] [--g2-approved]');
  if (args.some(arg => arg.startsWith('--') && !['--yes', '--g2-approved'].includes(arg))) throw new Error('未知参数');
  const arm = armText as Arm;
  const approval = { fixtureHash: shortHash({ FIXTURE, CHECKS }), checksHash: CHECKS_HASH, arm, fixture: FIXTURE, modelCallsPerJob: 10,
    maxActiveMinutes: 30, g4: '保留待用户决定', taskRetries: false, automaticRework: false, structuralRepairPerTask: 1,
    designCallsMaximum: 4, designTaskTimeoutMinutes: 15, batch: '2026-10-26',
    structuralRepairNote: '设计和评审也可能各有一次结构修复；作业内结构修复计入作业共同预算' };
  if (action === 'audit') {
    if (!runId || !candidateId) throw new Error('audit 需要 runId 和 candidateId');
    const store = new RunStore(experimentConfig(arm).dataDir);
    const run = store.load(runId);
    const job = run?.jobs.find(item => item.batch === run.jobBatch && item.candidateId === candidateId);
    if (!run || !job || job.writeLock || run.tasks.some(task => task.jobId === job.id && (task.status === 'running' || task.status === 'queued'))) throw new Error('作业不存在或写者尚未确认退出');
    console.log(JSON.stringify(prepareIndependentAudit(job.workspaceDir, run.id, path.join(EXPERIMENT_ROOT, 'audits')), null, 2));
    return;
  }
  if (action === 'plan' || !args.includes('--yes')) { console.log(JSON.stringify(approval, null, 2)); return; }
  if (action === 'build' && (!args.includes('--g2-approved') || !runId || !candidateId)) throw new Error('构建需要明确的 G2 批准以及运行/候选 ID');
  mkdirSync(EXPERIMENT_ROOT, { recursive: true });
  const h = runtime(arm);
  let run: Run;
  let unsubscribe: (() => void) | undefined;
  try {
    if (action === 'design') {
      const recordPath = path.join(EXPERIMENT_ROOT, `${arm}-run.json`);
      if (existsSync(recordPath)) throw new Error('该实验组已有运行；拒绝自动追加样本或覆盖证据');
      run = h.orch.createRun(experimentInput(arm));
      writeFileSync(recordPath, JSON.stringify({ ...approval, runId: run.id, createdAt: new Date().toISOString() }, null, 2));
    } else {
      run = h.orch.getRun(runId!);
      if (run.evaluator?.enabled !== (arm !== 'off') || run.finalReview?.enabled !== (arm === 'both')) throw new Error('实验组与冻结开关不符');
      h.orch.resolveGate(run.id, G2InputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [candidateId!],
        specs: [{ ...FIXTURE, candidateId: candidateId! }], efforts: { [candidateId!]: 'max' },
        reason: `H5/H6 固定小规格实验，G2 明确批准；fixture ${approval.fixtureHash}` }));
    }
    console.log(JSON.stringify({ started: run.id, action, arm }));
    unsubscribe = h.bus.subscribe(run.id, event => {
      if (['task.updated', 'gate.opened', 'job.updated'].includes(event.type)) {
        const payload = event.payload as Record<string, unknown>;
        console.log(JSON.stringify({ event: event.type, id: payload.id, phase: payload.phase, status: payload.status, failure: payload.failure }));
      }
    });
    await h.orch.idle();
    run = h.orch.getRun(run.id);
    const summary = summarize(run);
    writeFileSync(path.join(EXPERIMENT_ROOT, `${arm}-${action}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    if (run.phaseStatus === 'blocked' || run.jobs.some(job => job.status === 'failed' || job.status === 'inconclusive')) process.exitCode = 1;
  } finally {
    unsubscribe?.();
    await h.orch.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
