/** 有界真实返工验收驱动：显式注入一个已记录缺陷，随后只接受生产编排器的真实返工链。 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { AdapterResult, ModelAdapter, ModelTaskSpec } from '../../src/adapters/types.js';
import { loadConfig, type WorkbenchConfig } from '../../src/config.js';
import { smallMilestonePlan } from '../../src/core/context-budget.js';
import { CreateRunInputZ, G2InputZ, G4InputZ } from '../../src/core/schemas.js';
import type { Run } from '../../src/core/types.js';
import { shortHash } from '../../src/core/util.js';
import { EventBus } from '../../src/orchestrator/events.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { RunStore } from '../../src/orchestrator/store.js';
import { CHECKS, CHECKS_HASH, FIXTURE, fixtureEvidence, fixtureFilesIntact, prepareIndependentAudit } from './v05-live-acceptance.js';

export const REWORK_ROOT = path.resolve('work/v05-rework-desktop-20261026');
export const DEFECT_SOURCE = `export function sumIntegers(a, b) {
  if (!Number.isSafeInteger(a)) throw new RangeError('a must be a safe integer');
  if (!Number.isSafeInteger(b)) throw new RangeError('b must be a safe integer');
  const result = a + b;
  return result === 0 ? 0 : result;
}
`;

export interface DefectInjectionRecord {
  runId: string;
  taskId: string;
  buildRound: number;
  kind: 'deterministic_missing_result_overflow_check';
  beforeSourceHash: string;
  afterSourceHash: string;
  beforeCommit: string;
  afterCommit: string;
  checksHash: string;
  injectedAt: string;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function reworkConfig(): WorkbenchConfig {
  const config = loadConfig();
  config.dataDir = path.join(REWORK_ROOT, 'data');
  config.workspacesRoot = path.join(REWORK_ROOT, 'ws');
  config.evaluator.enabled = true;
  config.finalReview.enabled = true;
  config.evaluator.timeoutMinutes = 6;
  config.finalReview.timeoutMinutes = 5;
  config.contextBudget.enabled = true;
  config.build = { ...config.build, autoRework: true, maxRounds: 2, maxWriterSessions: 4, maxModelCalls: 10,
    maxActiveMinutes: 30, resumePolicy: 'budgeted', lightReworkEnabled: false };
  config.chores = { digest: false, qgroup: false };
  config.timeoutsMinutes.propose = 15;
  config.timeoutsMinutes.review = 15;
  config.limits.maxConcurrentModelTasks = 1;
  config.limits.maxConcurrentJobs = 1;
  return config;
}

export function reworkApproval() {
  return { fixtureHash: shortHash({ FIXTURE, CHECKS, DEFECT_SOURCE }), checksHash: CHECKS_HASH,
    defect: '首轮真实 Sol 成功退出后，由驱动提交“遗漏结果溢出检查”的确定性缺陷；不改模型输出或工具日志',
    expectedFlow: ['sol.build.r1', 'sol.final_verify.r1', 'astra.evaluate.r1.fail', 'sol.rework.r2', 'sol.final_verify.r2', 'astra.evaluate.r2.pass', 'claude.final_review'],
    models: { sol: ['gpt-6.1-sol', 'max'], astra: ['gpt-6-astra', 'max'], claudeFinal: ['claude-opus-5-5', 'xhigh'] },
    budget: { maxRounds: 2, maxWriterSessions: 4, maxModelCalls: 10, maxActiveMinutes: 30 },
    taskFailureRetries: false, authorizedEvaluationRetries: 1, g4: '保留待新授权' };
}

export function reworkInput() {
  return CreateRunInputZ.parse({
    title: '真实返工固定整数求和模块', mode: 'real', clarifyWith: 'skip', allowWebResearch: false,
    writeDocs: false, writePrd: false, designMode: 'single', riskLevel: 'low',
    evaluator: { enabled: true }, finalReview: { enabled: true }, contextBudget: { enabled: true },
    build: { autoRework: true },
    project: {
      prompt: `${FIXTURE.goal}\n这是隔离的真实返工验收。只提出一个最小 Node.js 原生 ES 模块方案，mvpPlan.workstreams 必须恰好一条，不得拆成零条或多条。固定验收命令：${FIXTURE.acceptance.map(item => item.command).join('；')}。构建前程序会提供检查文件，禁止修改或绕过检查。`,
      coreFlows: [FIXTURE.scopeIn[0]], existingStack: 'Node.js 原生 ES 模块，无外部依赖', deployment: 'Windows 本机',
      acceptance: FIXTURE.acceptance.map(item => `${item.id}: ${item.description}; ${item.command}; ${item.outputIncludes}`).join('\n'),
    },
    constraints: [
      { text: '仅限 Node.js 原生 ES 模块，一个 sumIntegers 函数、一个工作流，无依赖、网络、子代理或服务。', kind: 'must' },
      { text: '输入和结果必须是安全整数；非法输入及溢出抛 RangeError；不得修改固定验收脚本。', kind: 'must' },
    ],
  });
}

export function isFirstWritableBuild(spec: ModelTaskSpec): boolean {
  return isJobWorkspaceBuild(spec) && spec.sandbox === 'workspace_write' && spec.context.finalVerification !== true && spec.context.buildRound === 1;
}

export function isJobWorkspaceBuild(spec: ModelTaskSpec): boolean {
  if (spec.phase !== 'build' || !spec.gitRepo || !path.isAbsolute(spec.cwd)) return false;
  const relative = path.relative(path.join(REWORK_ROOT, 'ws'), path.resolve(spec.cwd));
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function writerProcessExitConfirmed(result: AdapterResult): boolean {
  return result.status === 'succeeded' && result.meta.processStarted === true && result.meta.exitCode === 0
    && !!result.meta.endedAt && !result.meta.terminationWarning;
}

export function selectedCandidateSmallPlanIssues(run: Pick<Run, 'candidates' | 'proposals'>, candidateId: string): string[] {
  const candidate = run.candidates.find(item => item.id === candidateId);
  if (!candidate) return ['所选候选不存在'];
  const proposal = run.proposals.find(item => item.id === candidate.representativeProposalId);
  if (!proposal) return ['所选候选缺少代表方案'];
  const count = proposal.mvpPlan.workstreams.length;
  const spec = { ...FIXTURE, candidateId, ref: `rework-${candidateId}`, comparisonQuestions: [] };
  const issues: string[] = [];
  if (count !== 1) issues.push(`代表方案必须恰好包含 1 个工作流，实际 ${count}`);
  if (spec.acceptance.length !== 3) issues.push(`固定验收必须恰好 3 项，实际 ${spec.acceptance.length}`);
  if (!smallMilestonePlan(spec, count)) issues.push('所选方案未命中程序 smallMilestonePlan，拒绝启动真实构建');
  return issues;
}

export function reworkG2Input(candidateId: string, fixtureHash: string) {
  return G2InputZ.parse({
    gate: 'G2_framework', action: 'validate', candidateIds: [candidateId],
    specs: [{ ...FIXTURE, candidateId }], efforts: { [candidateId]: 'max' },
    buildOverrides: { [candidateId]: { autoRework: true, maxRounds: 2, maxWriterSessions: 4, maxModelCalls: 10,
      maxActiveMinutes: 30, lightReworkEnabled: false } },
    reason: `隔离真实返工验收，G2 明确批准；fixture ${fixtureHash}`,
  });
}

export function reworkRetryEvaluationInput(jobId: string) {
  return G4InputZ.parse({ gate: 'G4_final', action: 'retry_evaluation', chosenCandidateId: null, jobId,
    manualResults: [], failureClassOverrides: {}, reason: '生产评审契约修复后，显式重试同一首轮独立评审；保留原始历史与共同预算' });
}

export function allowedReworkPhaseSequence(phases: string[]): boolean {
  const value = phases.join(',');
  return value === 'build,build,evaluate,build,build,evaluate,final_review'
    || value === 'build,build,evaluate,evaluate,build,build,evaluate,final_review';
}

export function retryEvaluationStateIssues(run: Run, candidateId: string): string[] {
  const issues: string[] = [];
  const job = run.jobs.find(item => item.batch === run.jobBatch && item.candidateId === candidateId);
  if (run.phase !== 'final_gate' || run.phaseStatus !== 'waiting_user') issues.push('运行必须停在 G4 等待用户');
  if (!job) return [...issues, '当前批次中找不到目标作业'];
  if (job.writeLock) issues.push('writer 写锁尚未释放');
  if (job.status !== 'inconclusive') issues.push(`首次评审停止状态应为 inconclusive，实际 ${job.status}`);
  if ((job.rounds?.length ?? 0) !== 1 || job.rounds?.[0]?.round !== 1 || job.rounds[0]?.outcome !== 'stopped') issues.push('必须是首轮评审已停止且尚未创建返工轮');
  const tasks = run.tasks.filter(task => task.jobId === job.id);
  if (tasks.some(task => ['queued', 'running'].includes(task.status))) issues.push('仍有运行或排队任务');
  if (tasks.map(task => task.phase).join(',') !== 'build,build,evaluate') issues.push('重试前任务序列必须恰好是 build,build,evaluate');
  if (tasks.some(task => task.status !== 'succeeded')) issues.push('重试前的三个真实任务必须均已成功退出');
  const usage = job.budget?.usage;
  const limits = job.budget?.limits;
  if (!limits || limits.maxRounds !== 2 || limits.maxWriterSessions !== 4 || limits.maxModelCalls !== 10 || limits.maxActiveMinutes !== 30) {
    issues.push('持久化共同预算上限必须精确为 2 rounds / 4 writers / 10 calls / 30 min');
  }
  if (!job.budget || !usage || usage.buildRounds !== 1 || usage.writerSessions !== 1 || usage.modelCalls !== 3 || usage.modelCalls > 10
    || usage.activeMs > 30 * 60_000) issues.push('重试前共同预算状态不符');
  if (job.rounds?.[0]?.verifiedDefectIds.length || job.rounds?.[0]?.reworkBrief.length) issues.push('当前停止原因必须是旧契约未绑定缺陷，不能已有可用返工证据');
  return issues;
}

export function preContractSnapshotIssues(runId: string, snapshotRoot = path.join(REWORK_ROOT, 'pre-contract-fix')): string[] {
  const issues: string[] = [];
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) return ['pre-contract-fix/manifest.json 缺失或不是普通文件'];
  let manifest: { runId?: string; evaluationTaskId?: string; files?: Array<{ path?: string; sha256?: string; length?: number }> };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest; }
  catch (error) { return [`pre-contract-fix/manifest.json 不是合法 JSON：${String(error)}`]; }
  if (manifest.runId !== runId) issues.push('pre-contract-fix manifest 未绑定当前运行');
  if (!manifest.evaluationTaskId?.trim()) issues.push('pre-contract-fix manifest 缺少首轮评审任务 ID');
  if (!Array.isArray(manifest.files) || !manifest.files.length) return [...issues, 'pre-contract-fix manifest 没有文件清单'];
  const root = path.resolve(snapshotRoot);
  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !item.path.trim() || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)
      || !Number.isSafeInteger(item.length) || item.length! < 0) { issues.push('pre-contract-fix manifest 含无效文件条目'); continue; }
    const normalized = path.normalize(item.path);
    const key = normalized.toLowerCase();
    if (seen.has(key)) { issues.push(`pre-contract-fix manifest 重复文件：${item.path}`); continue; }
    seen.add(key);
    const target = path.resolve(root, normalized);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) { issues.push(`pre-contract-fix 文件路径越界：${item.path}`); continue; }
    if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) { issues.push(`pre-contract-fix 文件缺失或不是普通文件：${item.path}`); continue; }
    const source = readFileSync(target);
    if (source.length !== item.length || sha256(source) !== item.sha256.toLowerCase()) issues.push(`pre-contract-fix 文件哈希或长度不匹配：${item.path}`);
  }
  const required = ['run.json', 'build-summary.json', 'evaluation-task/output.json', 'evaluation-task/tool-log.json', 'evaluation-task/meta.json']
    .map(value => path.normalize(value).toLowerCase());
  for (const file of required) if (!seen.has(file)) issues.push(`pre-contract-fix manifest 缺少必要证据：${file}`);
  return issues;
}

function git(cwd: string, args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'rework-acceptance', GIT_AUTHOR_EMAIL: 'rework@localhost',
    GIT_COMMITTER_NAME: 'rework-acceptance', GIT_COMMITTER_EMAIL: 'rework@localhost' };
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** 在真实首轮 Sol 已退出后注入并提交确定性缺陷；不修改模型结果或工具日志。 */
export function injectDeterministicDefect(spec: ModelTaskSpec, markerPath: string, now = () => new Date().toISOString()): DefectInjectionRecord {
  if (!isFirstWritableBuild(spec)) throw new Error('确定性缺陷只能注入首轮可写 build');
  if (existsSync(markerPath)) throw new Error('确定性缺陷已注入，拒绝重复执行');
  if (!fixtureFilesIntact(spec.cwd)) throw new Error('固定检查缺失或已变化，拒绝注入');
  const sourcePath = path.join(spec.cwd, 'sum.mjs');
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink()) throw new Error('首轮 Sol 未生成普通文件 sum.mjs');
  const before = readFileSync(sourcePath);
  git(spec.cwd, ['add', '-A']);
  git(spec.cwd, ['commit', '--allow-empty', '--no-gpg-sign', '-q', '-m', 'acceptance: freeze original writer output']);
  const beforeCommit = git(spec.cwd, ['rev-parse', 'HEAD']);
  writeFileSync(sourcePath, DEFECT_SOURCE, 'utf8');
  if (!fixtureFilesIntact(spec.cwd)) throw new Error('注入后固定检查发生变化');
  git(spec.cwd, ['add', '--', 'sum.mjs']);
  git(spec.cwd, ['commit', '--allow-empty', '--no-gpg-sign', '-q', '-m', 'acceptance: inject deterministic overflow defect']);
  const afterCommit = git(spec.cwd, ['rev-parse', 'HEAD']);
  const record: DefectInjectionRecord = {
    runId: spec.runId, taskId: spec.taskId, buildRound: 1, kind: 'deterministic_missing_result_overflow_check',
    beforeSourceHash: sha256(before), afterSourceHash: sha256(DEFECT_SOURCE), beforeCommit, afterCommit,
    checksHash: CHECKS_HASH, injectedAt: now(),
  };
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(record, null, 2), 'utf8');
  writeFileSync(path.join(spec.logDir, 'defect-injection.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function reworkAcceptanceIssues(run: Run, record: DefectInjectionRecord | null): string[] {
  const issues: string[] = [];
  const job = run.jobs.find(item => item.batch === run.jobBatch);
  if (!record || record.runId !== run.id) issues.push('缺少绑定当前运行的缺陷注入记录');
  if (!job) return [...issues, '缺少当前批次作业'];
  const rounds = job.rounds ?? [];
  if (rounds.length !== 2 || rounds[0]?.kind !== 'initial' || rounds[1]?.kind !== 'rework') issues.push('必须恰好完成 initial → rework 两轮');
  const first = rounds[0];
  const second = rounds[1];
  if (first?.verification?.verdict !== 'failed') issues.push('首轮真实核验必须失败');
  if (!first?.verifiedDefectIds.length || !first.reworkBrief.length || first.evaluation?.verdict !== 'fail') issues.push('首轮 Astra 必须产出可复现缺陷与返工说明');
  if (second?.verification?.verdict !== 'passed' || second.evaluation?.verdict !== 'pass') issues.push('返工轮必须通过程序核验与 Astra 评审');
  if (!job.finalReview || !['accept', 'accept_with_notes'].includes(job.finalReview.verdict)) issues.push('Claude 终审必须接受或带备注接受');
  const phases = run.tasks.filter(task => task.jobId === job.id).map(task => task.phase);
  if (!allowedReworkPhaseSequence(phases)) issues.push(`任务序列不符：${phases.join(' → ')}`);
  if (job.status !== 'passed' && job.status !== 'awaiting_manual') issues.push(`作业状态不符：${job.status}`);
  if (job.writeLock) issues.push('写锁尚未释放');
  if (run.tasks.some(task => task.jobId === job.id && ['queued', 'running'].includes(task.status))) issues.push('仍有运行或排队任务');
  if ((job.budget?.usage.buildRounds ?? 0) !== 2 || (job.budget?.usage.modelCalls ?? 0) > 10 || (job.budget?.usage.activeMs ?? 0) > 30 * 60_000) issues.push('共同预算记录不符');
  return issues;
}

function runtime() {
  const config = reworkConfig();
  const store = new RunStore(config.dataDir);
  const bus = new EventBus(store);
  const claude = new ClaudeCodeAdapter(config.adapters.claude);
  const codex = new CodexAdapter(config.adapters.codex);
  const adapter: ModelAdapter = {
    kind: 'codex',
    async run(spec, progress, signal): Promise<AdapterResult> {
      const fixtureMarker = path.join(REWORK_ROOT, `fixture-${shortHash(spec.cwd)}.json`);
      if (isFirstWritableBuild(spec) && !existsSync(fixtureMarker)) {
        if (Object.keys(CHECKS).some(name => existsSync(path.join(spec.cwd, name)))) throw new Error('固定检查在初始化前已存在');
        for (const [name, source] of Object.entries(CHECKS)) writeFileSync(path.join(spec.cwd, name), source, 'utf8');
        writeFileSync(fixtureMarker, JSON.stringify({ runId: spec.runId, cwd: spec.cwd, checksHash: CHECKS_HASH }, null, 2), 'utf8');
      }
      if (isJobWorkspaceBuild(spec) && (!existsSync(fixtureMarker) || !fixtureFilesIntact(spec.cwd))) throw new Error('固定验收脚本缺失或被修改');
      let result = await codex.run(spec, progress, signal);
      if (result.status === 'succeeded' && isFirstWritableBuild(spec)) {
        if (!writerProcessExitConfirmed(result)) result = { ...result, status: 'failed',
          failure: { kind: 'process_error', message: '首轮真实 writer 的进程退出未确认，拒绝注入缺陷' } };
        else {
          try { injectDeterministicDefect(spec, path.join(REWORK_ROOT, 'defect-injection.json')); }
          catch (error) { result = { ...result, status: 'failed', failure: { kind: 'process_error', message: String(error) } }; }
        }
      }
      if (isJobWorkspaceBuild(spec)) {
        const evidence = fixtureEvidence(spec.cwd, spec.runId);
        writeFileSync(path.join(spec.logDir, 'fixture-checks.json'), JSON.stringify({ ...evidence, taskId: spec.taskId,
          specRef: spec.context.spec?.ref, buildRound: spec.context.buildRound, finalVerification: spec.context.finalVerification === true,
          checkedAt: new Date().toISOString(), expectedChecksHash: CHECKS_HASH }, null, 2));
        if (evidence.observedChecksHash !== CHECKS_HASH || evidence.unexpectedEntries.length) result = { ...result, status: 'failed',
          failure: { kind: 'invalid_output', message: '固定检查被修改或出现范围外文件' } };
      }
      return result;
    },
  };
  const orch = new Orchestrator({ config, store, bus, adapterFor: role => role === 'claude' ? claude : adapter });
  return { config, store, bus, orch };
}

function assertRetryEvaluationEvidence(run: Run, candidateId: string): string {
  const issues = [...retryEvaluationStateIssues(run, candidateId), ...preContractSnapshotIssues(run.id)];
  const job = run.jobs.find(item => item.batch === run.jobBatch && item.candidateId === candidateId);
  const runRecord = readFileSync(path.join(REWORK_ROOT, 'run.json'), 'utf8');
  const frozen = JSON.parse(runRecord) as { runId?: string; fixtureHash?: string; checksHash?: string };
  if (frozen.runId !== run.id || frozen.fixtureHash !== shortHash({ FIXTURE, CHECKS, DEFECT_SOURCE }) || frozen.checksHash !== CHECKS_HASH) issues.push('固定运行记录、fixtureHash 或 checksHash 不匹配');
  const injectionPath = path.join(REWORK_ROOT, 'defect-injection.json');
  if (!existsSync(injectionPath) || !lstatSync(injectionPath).isFile() || lstatSync(injectionPath).isSymbolicLink()) issues.push('缺陷注入记录缺失或不是普通文件');
  else {
    const record = JSON.parse(readFileSync(injectionPath, 'utf8')) as DefectInjectionRecord;
    if (record.runId !== run.id || record.buildRound !== 1 || record.checksHash !== CHECKS_HASH || !job) issues.push('缺陷注入记录未绑定当前首轮作业');
    else {
      const evidence = fixtureEvidence(job.workspaceDir, run.id);
      if (!fixtureFilesIntact(job.workspaceDir) || evidence.observedChecksHash !== CHECKS_HASH || evidence.unexpectedEntries.length) issues.push('固定检查或工作区范围在重试前发生变化');
      try {
        const shown = spawnSync('git', ['show', `${validateCommit(record.afterCommit)}:sum.mjs`], { cwd: job.workspaceDir, encoding: 'utf8', windowsHide: true });
        if (shown.status !== 0) throw new Error(shown.stderr || shown.stdout);
        const injected = shown.stdout;
        if (sha256(injected) !== record.afterSourceHash || record.afterSourceHash !== sha256(DEFECT_SOURCE)) issues.push('注入 commit/hash 与受控缺陷不一致');
      } catch (error) { issues.push(`无法核对注入 commit：${String(error)}`); }
    }
  }
  if (issues.length) throw new Error(`不满足显式重试评审入口：${issues.join('；')}`);
  return job!.id;
}

function validateCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('commit 不是完整 SHA-1');
  return value;
}

function summarize(run: Run) {
  const recordPath = path.join(REWORK_ROOT, 'defect-injection.json');
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) as DefectInjectionRecord : null;
  return { id: run.id, phase: run.phase, phaseStatus: run.phaseStatus, blockedReason: run.blockedReason,
    issues: reworkAcceptanceIssues(run, record),
    candidates: run.candidates.map(candidate => ({ id: candidate.id, proposalId: candidate.representativeProposalId })),
    tasks: run.tasks.map(task => ({ id: task.id, role: task.role, phase: task.phase, status: task.status, buildRound: task.buildRound, failure: task.failure })),
    jobs: run.jobs.map(job => ({ id: job.id, candidateId: job.candidateId, status: job.status, rounds: job.rounds,
      finalReview: job.finalReview, writeLock: job.writeLock, budget: job.budget })), injection: record };
}

export async function main(args = process.argv.slice(2)) {
  const [action, runId, candidateId] = args.filter(arg => !arg.startsWith('--'));
  if (!['plan', 'design', 'build', 'retry-evaluation', 'audit'].includes(action ?? '')) throw new Error('用法：plan|design|build|retry-evaluation|audit [runId candidateId] [--yes] [--g2-approved|--g4-retry-approved]');
  if (args.some(arg => arg.startsWith('--') && !['--yes', '--g2-approved', '--g4-retry-approved'].includes(arg))) throw new Error('未知参数');
  const approval = reworkApproval();
  if (action === 'plan' || !args.includes('--yes')) { console.log(JSON.stringify(approval, null, 2)); return; }
  if (action === 'build' && (!args.includes('--g2-approved') || !runId || !candidateId)) throw new Error('构建需要明确 G2 批准及运行/候选 ID');
  if (action === 'retry-evaluation' && (!args.includes('--g4-retry-approved') || !runId || !candidateId)) throw new Error('重试独立评审需要明确 G4 重试批准及运行/候选 ID');
  mkdirSync(REWORK_ROOT, { recursive: true });
  if (action === 'audit') {
    if (!runId || !candidateId) throw new Error('audit 需要 runId 和 candidateId');
    const store = new RunStore(reworkConfig().dataDir);
    const run = store.load(runId);
    const recordPath = path.join(REWORK_ROOT, 'defect-injection.json');
    const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) as DefectInjectionRecord : null;
    const issues = run ? [...reworkAcceptanceIssues(run, record), ...preContractSnapshotIssues(run.id)] : ['运行不存在'];
    const job = run?.jobs.find(item => item.batch === run.jobBatch && item.candidateId === candidateId);
    if (!run || !job || issues.length) throw new Error(`返工链未满足审计入口：${issues.join('；')}`);
    console.log(JSON.stringify({ ...prepareIndependentAudit(job.workspaceDir, run.id, path.join(REWORK_ROOT, 'audits')), reworkEvidence: record }, null, 2));
    return;
  }
  const h = runtime();
  let run: Run;
  let unsubscribe: (() => void) | undefined;
  try {
    if (action === 'design') {
      const recordPath = path.join(REWORK_ROOT, 'run.json');
      if (existsSync(recordPath)) throw new Error('返工验收已有运行，拒绝追加或覆盖');
      run = h.orch.createRun(reworkInput());
      writeFileSync(recordPath, JSON.stringify({ ...approval, runId: run.id, createdAt: new Date().toISOString() }, null, 2));
    } else if (action === 'build') {
      run = h.orch.getRun(runId!);
      if (!run.evaluator?.enabled || !run.finalReview?.enabled || !run.build?.autoRework) throw new Error('运行未冻结真实返工所需开关');
      const planIssues = selectedCandidateSmallPlanIssues(run, candidateId!);
      if (planIssues.length) throw new Error(`所选候选不满足固定双会话返工计划：${planIssues.join('；')}`);
      h.orch.resolveGate(run.id, reworkG2Input(candidateId!, approval.fixtureHash));
    } else {
      const summaryPath = path.join(REWORK_ROOT, 'retry-evaluation-summary.json');
      if (existsSync(summaryPath)) throw new Error('该固定运行已有 retry-evaluation 汇总，拒绝重复派发');
      run = h.orch.getRun(runId!);
      const jobId = assertRetryEvaluationEvidence(run, candidateId!);
      h.orch.resolveGate(run.id, reworkRetryEvaluationInput(jobId));
    }
    console.log(JSON.stringify({ started: run.id, action }));
    unsubscribe = h.bus.subscribe(run.id, event => {
      if (['task.updated', 'gate.opened', 'job.updated'].includes(event.type)) {
        const payload = event.payload as Record<string, unknown>;
        console.log(JSON.stringify({ event: event.type, id: payload.id, phase: payload.phase, status: payload.status, failure: payload.failure }));
      }
    });
    await h.orch.idle();
    run = h.orch.getRun(run.id);
    const summary = summarize(run);
    writeFileSync(path.join(REWORK_ROOT, `${action}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    if (run.phaseStatus === 'blocked' || run.jobs.some(job => job.status === 'failed' || job.status === 'inconclusive')
      || ((action === 'build' || action === 'retry-evaluation') && summary.issues.length > 0)) process.exitCode = 1;
  } finally {
    unsubscribe?.();
    await h.orch.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
