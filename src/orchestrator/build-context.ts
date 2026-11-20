import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod/v4';
import type { ModelTaskSpec } from '../adapters/types.js';
import { renderProposalCard } from '../core/anonymize.js';
import {
  PlanOutputZ,
  FINAL_VERIFICATION_RESERVE_MINUTES,
  buildDispatchMaterial,
  decideResume,
  deriveMilestoneStatus,
  renderHandoff,
  smallMilestonePlan,
  unknownContext,
  validateMilestonePlan,
  type MilestonePlan,
} from '../core/context-budget.js';
import { remainingActiveMs } from '../core/job-budget.js';
import { SessionBuildReportOutputZ } from '../core/schemas.js';
import { toStrictJsonSchema } from '../core/strict-json-schema.js';
import type { BuildRound, BuildSession, MvpSpec, Run, TaskRecord, ValidationJob } from '../core/types.js';
import { canonicalJson, sha256 } from '../core/util.js';
import { validateOutput, type ValidationResult } from '../core/validate.js';
import { renderTemplate, schemaBlock } from '../prompts/render.js';
import { RunStore, writeFileAtomicSync } from './store.js';

type SessionBuildReport = z.infer<typeof SessionBuildReportOutputZ>;

export interface BuildSessionChoice {
  kind: 'init' | 'milestone';
  milestoneIds: string[];
  finalVerification: boolean;
}

export type NextBuildSessionResult = BuildSessionChoice | { stopReason: string } | null;

/** 一个逻辑里程碑任务可含结构修复进程；两次 CLI 调用均计会话上限。 */
export function contextInvocationCount(run: Run, round: BuildRound): number {
  return (round.context?.sessions ?? []).reduce((sum, session) => sum + Math.max(1,
    run.tasks.find(task => task.id === session.taskId)?.executionCalls?.length ?? session.invocations?.length ?? 0), 0);
}

function now(): string {
  return new Date().toISOString();
}

function designSnapshot(run: Run) {
  const version = run.designSnapshotVersion ?? run.currentSnapshotVersion;
  const snapshot = run.snapshots.find(item => item.version === version);
  if (!snapshot) throw new Error(`找不到设计快照 v${version}`);
  return snapshot;
}

function contextOptions(run: Run) {
  if (!run.contextBudget?.enabled) throw new Error('上下文治理未启用');
  return run.contextBudget;
}

function budgetRemaining(job: ValidationJob): { calls: number; activeMs: number } {
  if (!job.budget) return { calls: 0, activeMs: 0 };
  const calls = Math.max(0, job.budget.limits.maxModelCalls - job.budget.usage.modelCalls - new Set(job.budget.reservedCalls).size);
  return { calls, activeMs: remainingActiveMs(job.budget, now()) };
}

function roundBuildActiveMs(job: ValidationJob, round: BuildRound): number {
  if (!job.budget || !round.context) return 0;
  const taskIds = new Set(round.context.sessions.map(session => session.taskId).filter(Boolean));
  return job.budget.calls
    .filter(call => taskIds.has(call.taskId))
    .reduce((total, call) => total + (call.activeMs ?? 0), 0);
}

function sessionBuildActiveMs(job: ValidationJob, session: BuildSession): number {
  if (!job.budget || !session.taskId) return 0;
  return job.budget.calls
    .filter(call => call.taskId === session.taskId)
    .reduce((total, call) => total + (call.activeMs ?? 0), 0);
}

function roundTimeboxRemainingMs(job: ValidationJob, round: BuildRound): number {
  return Math.max(0, job.spec.timeboxMinutes * 60_000 - roundBuildActiveMs(job, round));
}

const finalVerificationReserveMs = FINAL_VERIFICATION_RESERVE_MINUTES * 60_000;

/** 每次 initial/repair CLI 调用开始前重新计算，避免 repair 复用首次调用的旧 timeout。 */
export function contextInvocationTimeout(
  _run: Run,
  job: ValidationJob,
  round: BuildRound,
  session: BuildSession,
  requestedTimeoutMs: number,
): number {
  const remaining = roundTimeboxRemainingMs(job, round);
  const usable = session.finalVerification ? remaining : remaining - finalVerificationReserveMs;
  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) throw new Error('请求的会话 timeout 无效');
  const sessionRemaining = requestedTimeoutMs - sessionBuildActiveMs(job, session);
  if (usable <= 0) {
    throw new Error(session.finalVerification
      ? `规格主动时间盒已耗尽（${job.spec.timeboxMinutes} 分钟）`
      : `仅剩最终整轮验收预留时间（${FINAL_VERIFICATION_RESERVE_MINUTES} 分钟），不能继续非最终会话`);
  }
  if (sessionRemaining <= 0) throw new Error('当前会话主动运行时间已耗尽');
  return Math.min(sessionRemaining, usable);
}

function roundContextDir(store: RunStore, run: Run, job: ValidationJob, round: BuildRound): string {
  if (!/^[a-z0-9.-]+$/i.test(job.id)) throw new Error(`非法作业编号 ${job.id}`);
  const dir = path.join(store.runDir(run.id), 'runcontexts', job.id, `r${round.round}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function planText(plan: MilestonePlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function frozenPlan(round: BuildRound): MilestonePlan {
  const context = round.context;
  if (!context?.plan || !context.planHash) throw new Error('里程碑计划尚未冻结');
  if (!existsSync(context.planPath)) throw new Error('PLAN.json 缺失，计划证据无效');
  const raw = readFileSync(context.planPath, 'utf8');
  if (sha256(raw) !== context.planHash) throw new Error('PLAN.json 与冻结哈希不一致，疑似被篡改');
  let disk: unknown;
  try { disk = JSON.parse(raw); }
  catch { throw new Error('PLAN.json 不是合法 JSON'); }
  const parsed = PlanOutputZ.safeParse(disk);
  if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(context.plan)) {
    throw new Error('PLAN.json 原文与内存冻结计划不一致');
  }
  return context.plan;
}

function freezePlan(run: Run, job: ValidationJob, round: BuildRound, store: RunStore, plan: MilestonePlan): void {
  const context = round.context;
  if (!context) throw new Error('构建轮次上下文尚未初始化');
  if (context.plan && canonicalJson(context.plan) !== canonicalJson(plan)) throw new Error('冻结计划不能被模型覆盖');
  const text = planText(plan);
  writeFileAtomicSync(context.planPath, text);
  context.plan = structuredClone(plan);
  context.planHash = sha256(text);
  context.states = plan.milestones.map(item => ({ id: item.id, status: 'pending', attempts: 0, verifiedAtCommit: null }));
  context.dispatchBlocked = null;
  store.save(run);
}

export function initializeRoundContext(
  run: Run,
  job: ValidationJob,
  round: BuildRound,
  store: RunStore,
  workstreamCount: number,
): NonNullable<BuildRound['context']> {
  if (round.context) {
    if (round.context.plan) frozenPlan(round);
    return round.context;
  }
  const dir = roundContextDir(store, run, job, round);
  round.context = { plan: null, planHash: null, planPath: path.join(dir, 'PLAN.json'), states: [], sessions: [], dispatchBlocked: null };
  const plan = smallMilestonePlan(job.spec, workstreamCount);
  if (plan) {
    const remaining = budgetRemaining(job);
    const errors = validateMilestonePlan(plan, {
      spec: job.spec, workspaceDir: job.workspaceDir, options: contextOptions(run),
      remainingCalls: remaining.calls, remainingActiveMs: remaining.activeMs,
    });
    if (errors.length) throw new Error(`程序生成的小任务计划无效：${errors.join('；')}`);
    freezePlan(run, job, round, store, plan);
  } else {
    store.save(run);
  }
  return round.context;
}

function taskLevelStop(run: Run, session: BuildSession): string | null {
  const task = run.tasks.find(item => item.id === session.taskId);
  if (!task) return session.taskId ? '构建会话没有对应任务记录' : null;
  if (task.status === 'queued' || task.status === 'running') return '当前构建会话尚未完成';
  if (task.status !== 'succeeded') return `任务级故障 ${task.failure?.kind ?? task.status} 不自动续接`;
  return null;
}

export function nextBuildSession(run: Run, job: ValidationJob, round: BuildRound): NextBuildSessionResult {
  const context = round.context;
  if (!context) return { stopReason: '构建轮次上下文尚未初始化' };
  if (context.dispatchBlocked) return { stopReason: context.dispatchBlocked };

  const last = context.sessions.at(-1);
  if (last) {
    const stopped = taskLevelStop(run, last);
    if (stopped) return { stopReason: stopped };
    if (last.outcome === 'pending') return { stopReason: '当前构建会话尚未结算' };
    if (last.outcome === 'stopped') return { stopReason: '上一构建会话已停止' };
    if (last.finalVerification) return last.outcome === 'passed' || last.outcome === 'awaiting_manual'
      ? null : { stopReason: '最终整轮验收未通过，不能复用以前里程碑证据' };
    if (last.outcome === 'failed' && job.failureClass && job.failureClass !== 'implementation_defect') {
      return { stopReason: `失败归类为 ${job.failureClass}，没有实现缺陷证据，不自动继续里程碑` };
    }
  }
  if (roundTimeboxRemainingMs(job, round) <= 0) return { stopReason: `规格主动时间盒已耗尽（${job.spec.timeboxMinutes} 分钟）` };
  const sessionCap = (context.plan?.milestones.length ?? 0) + 3;
  if (contextInvocationCount(run, round) >= sessionCap) return { stopReason: `轮次会话上限已耗尽（${sessionCap}，含结构修复调用）` };
  if (job.budget?.calls.some(call => call.state === 'unknown')) {
    return { stopReason: '存在启动或结束状态未知的模型调用，确认前不能继续派发' };
  }
  const remaining = budgetRemaining(job);
  if (remaining.calls < 1) return { stopReason: '作业模型调用预算已耗尽' };
  if (remaining.activeMs <= 0) return { stopReason: '作业主动运行时间预算已耗尽' };

  if (!context.plan) {
    if (roundTimeboxRemainingMs(job, round) <= finalVerificationReserveMs) {
      return { stopReason: `仅剩最终整轮验收预留时间（${FINAL_VERIFICATION_RESERVE_MINUTES} 分钟），不能派发 init` };
    }
    if (context.sessions.some(item => item.kind === 'init')) return { stopReason: 'init 未生成合法冻结计划' };
    return { kind: 'init', milestoneIds: [], finalVerification: false };
  }
  frozenPlan(round);

  const complete = context.states.every(state => state.status === 'passed' || state.status === 'awaiting_manual');
  if (complete) {
    if (context.sessions.some(item => item.finalVerification)) return { stopReason: '最终整轮验收已经派发但尚未形成可接受结论' };
    return { kind: 'milestone', milestoneIds: context.plan.milestones.map(item => item.id), finalVerification: true };
  }
  if (roundTimeboxRemainingMs(job, round) <= finalVerificationReserveMs) {
    return { stopReason: `仅剩最终整轮验收预留时间（${FINAL_VERIFICATION_RESERVE_MINUTES} 分钟），不能继续里程碑` };
  }

  for (const milestone of context.plan.milestones) {
    const state = context.states.find(item => item.id === milestone.id);
    if (!state || state.status === 'passed' || state.status === 'awaiting_manual' || state.status === 'running') continue;
    const dependenciesReady = milestone.dependsOn.every(id => {
      const dependency = context.states.find(item => item.id === id);
      return dependency?.status === 'passed' || dependency?.status === 'awaiting_manual';
    });
    if (!dependenciesReady) continue;
    if (state.attempts >= 3) return { stopReason: `里程碑 ${milestone.id} 连续 3 个会话未完成` };
    return { kind: 'milestone', milestoneIds: [milestone.id], finalVerification: false };
  }
  return { stopReason: '没有满足依赖且可继续的里程碑' };
}

export function appendBuildSession(
  run: Run,
  _job: ValidationJob,
  round: BuildRound,
  choice: BuildSessionChoice,
  taskId = '',
): BuildSession {
  const context = round.context;
  if (!context) throw new Error('构建轮次上下文尚未初始化');
  if (contextInvocationCount(run, round) >= (context.plan?.milestones.length ?? 0) + 3) throw new Error('轮次会话上限已耗尽');
  if (choice.kind === 'milestone') {
    const plan = frozenPlan(round);
    const known = new Set(plan.milestones.map(item => item.id));
    if (!choice.milestoneIds.length || choice.milestoneIds.some(id => !known.has(id))) throw new Error('会话引用了未知里程碑');
    for (const id of choice.milestoneIds) {
      const state = context.states.find(item => item.id === id)!;
      if (!choice.finalVerification) {
        state.attempts += 1;
        state.status = 'running';
      }
    }
  } else if (choice.milestoneIds.length || choice.finalVerification) {
    throw new Error('init 会话不能绑定里程碑或最终验收');
  }
  const id = `bs-r${round.round}-${context.sessions.length + 1}`;
  const session: BuildSession = {
    id, kind: choice.kind, milestoneIds: [...choice.milestoneIds], finalVerification: choice.finalVerification,
    taskId, startCommit: round.workspaceCommit, endCommit: null, threadId: null, resumedFrom: null,
    resumeReason: '尚未计算续接门禁', handoffPath: null, verification: null, outcome: 'pending',
    context: unknownContext(), startedAt: null, endedAt: null,
  };
  context.sessions.push(session);
  return session;
}

export function sessionSpec(job: ValidationJob, session: BuildSession): MvpSpec {
  if (session.kind === 'init' || session.finalVerification) return structuredClone(job.spec);
  const contextRound = job.rounds?.find(round => round.context?.sessions.some(item => item.id === session.id));
  const plan = contextRound?.context?.plan;
  if (!plan) throw new Error('会话所属计划不存在');
  const ids = new Set(session.milestoneIds.flatMap(id => plan.milestones.find(item => item.id === id)?.acceptanceIds ?? []));
  return { ...structuredClone(job.spec), acceptance: job.spec.acceptance.filter(item => ids.has(item.id)) };
}

function pinnedMaterial(run: Run, job: ValidationJob): string {
  const snapshot = designSnapshot(run);
  const proposal = run.proposals.find(item => item.id === job.proposalId);
  if (!proposal) throw new Error(`找不到作业 ${job.id} 的冻结框架`);
  return JSON.stringify({
    fullMvpSpec: job.spec,
    constraints: snapshot.constraints,
    framework: renderProposalCard(proposal, job.candidateId),
  }, null, 2);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeWorkspaceRead(workspaceDir: string, file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const root = realpathSync(workspaceDir);
    const actual = realpathSync(file);
    if (!isWithin(root, actual)) return null;
    return readFileSync(actual, 'utf8');
  }
  catch { return null; }
}

function loadBuildTemplate(name: 'build-init' | 'build-milestone'): string {
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
}

function renderInitPrompt(specRef: string, maxMinutes: number, material: string, outputSchema: ModelTaskSpec['outputSchema']): string {
  return renderTemplate(loadBuildTemplate('build-init'), {
    specRef, milestoneMaxMinutes: String(maxMinutes), material, schemaBlock: schemaBlock(outputSchema),
  });
}

function renderMilestonePrompt(pinnedOriginal: string, currentMilestone: string, handoff: string, outputSchema: ModelTaskSpec['outputSchema']): string {
  return renderTemplate(loadBuildTemplate('build-milestone'), {
    pinnedOriginal, currentMilestone, handoff, schemaBlock: schemaBlock(outputSchema),
  });
}

export function prepareContextSpec(
  run: Run,
  job: ValidationJob,
  round: BuildRound,
  session: BuildSession,
  baseSpec: ModelTaskSpec,
  store: RunStore,
): ModelTaskSpec {
  const options = contextOptions(run);
  const context = round.context;
  if (!context) throw new Error('构建轮次上下文尚未初始化');
  const task = run.tasks.find(item => item.id === baseSpec.taskId);
  if (!task || task.buildSessionId !== session.id || task.buildKind !== session.kind) throw new Error('任务与构建会话身份不一致');
  session.taskId = task.id;
  const runFile = path.join(store.runDir(run.id), 'run.json');
  const remaining = budgetRemaining(job);
  const roundTimeboxMs = roundTimeboxRemainingMs(job, round);
  if (roundTimeboxMs <= 0) {
    context.dispatchBlocked = `dispatchBlocked：规格主动时间盒已耗尽（${job.spec.timeboxMinutes} 分钟）`;
    store.save(run);
    throw new Error(context.dispatchBlocked);
  }
  const fullPinned = pinnedMaterial(run, job);
  const plan = session.kind === 'init' ? null : frozenPlan(round);
  const current = plan?.milestones.filter(item => session.milestoneIds.includes(item.id)) ?? [];

  const previousSessions = context.sessions.filter(item => item.id !== session.id);
  const oldReports = previousSessions.flatMap(item => {
    if (!item.taskId) return [];
    const content = store.readTaskFile(run.id, item.taskId, 'output.json');
    return content ? [{ id: `旧会话报告 ${item.id}`, sourcePath: path.join(store.taskDir(run.id, item.taskId), 'output.json'), content }] : [];
  });
  const rawCommands = previousSessions.flatMap(item => {
    if (!item.taskId) return [];
    const content = store.readTaskFile(run.id, item.taskId, 'tool-log.json');
    return content ? [{ id: `旧会话命令日志 ${item.id}`, sourcePath: path.join(store.taskDir(run.id, item.taskId), 'tool-log.json'), content }] : [];
  });
  const progressPath = path.join(job.workspaceDir, 'PROGRESS.md');
  const progress = session.finalVerification ? null : safeWorkspaceRead(job.workspaceDir, progressPath);
  const progressLines = progress?.split(/\r?\n/).length ?? 0;
  const progressReference = progress && progressLines > 200
    ? `PROGRESS.md 共 ${progressLines} 行，超过建议上限；未内联或截断，请按需只读 ${progressPath}`
    : progress;
  const handoff = renderHandoff({
    specRef: job.spec.ref, workspaceCommit: round.workspaceCommit,
    milestone: { id: session.finalVerification ? 'FINAL' : current.map(item => item.id).join('+') || 'INIT',
      title: session.finalVerification ? '最终整轮验收' : current.map(item => item.title).join('；') || '初始化计划',
      acceptanceIds: session.finalVerification ? job.spec.acceptance.map(item => item.id) : current.flatMap(item => item.acceptanceIds) },
    pinnedConstraints: designSnapshot(run).constraints.map(item => ({ id: item.id, text: item.text, sourcePath: `${runFile}#snapshots/${designSnapshot(run).ref}` })),
    programFacts: [
      `计划路径：${context.planPath}`,
      `计划哈希：${context.planHash ?? '尚未生成'}`,
      `当前代码锚点：${round.workspaceCommit ?? '未知'}`,
      ...(current.length ? [
        `当前里程碑计划估算：${current.reduce((total, milestone) => total + milestone.minutes, 0)} 分钟`,
        `单会话硬上限：${options.milestoneMaxMinutes} 分钟；计划估算不提前截断会话`,
      ] : []),
      ...context.states.map(item => `${item.id}=${item.status} attempts=${item.attempts}`),
    ],
    verification: round.verification?.items.map(item => `${item.criterionId}=${item.status}`) ?? [],
    defects: round.verifiedDefectIds.map(id => ({ id, text: '程序核对过的可复现缺陷', source: `round:${round.round}` })),
    modelNotes: progressReference ? { author: '当前写者', sourcePath: progressPath, content: progressReference } : null,
  });
  const handoffPath = store.writeTaskFile(run.id, task.id, 'HANDOFF.md', handoff.content);
  session.handoffPath = handoffPath;
  const effectiveSpec = sessionSpec(job, session);
  const outputSchema = toStrictJsonSchema(session.kind === 'init' ? PlanOutputZ : SessionBuildReportOutputZ);
  let protocol = session.kind === 'init'
    ? renderInitPrompt(job.spec.ref, options.milestoneMaxMinutes, '派发依据见本提示词的原文、HANDOFF、当前会话与预算区段。', outputSchema)
    : renderMilestonePrompt(
      '原文钉死块见本提示词的“原文钉死块”区段。',
      `当前里程碑与有效子规格见“当前会话”区段：${JSON.stringify({ milestones: current, effectiveSpec })}`,
      '完整程序交接见本提示词的“程序 HANDOFF”区段。',
      outputSchema,
    );
  if (session.finalVerification) {
    protocol += '\n\n## 最终整轮验收（程序强制）\n只读运行完整 MVP 规格中的全部命令型验收项；不得修改源码、测试、配置或 PROGRESS.md。以前里程碑的通过不能复用，必须以本会话真实命令事件重新证明。';
  }
  protocol += `\n\n## 主动时间盒保留\n程序为最终整轮验收硬保留 ${FINAL_VERIFICATION_RESERVE_MINUTES} 分钟；init 和普通里程碑不得消耗该预留。`;

  // baseSpec.prompt 由主编排器生成，其中的长期事实在上下文模式下必须以受控原文重新注入，
  // 不能因为替换提示词或裁剪旧会话材料而丢掉 G3、预检、附件或显式返工意见。
  const devGuidePath = path.join(job.workspaceDir, 'DEV_GUIDE.md');
  const preflightPath = path.join(job.workspaceDir, 'PREFLIGHT.md');
  const devGuide = safeWorkspaceRead(job.workspaceDir, devGuidePath);
  const preflight = safeWorkspaceRead(job.workspaceDir, preflightPath);
  const snapshot = designSnapshot(run);
  const referenceDocuments = snapshot.project.referenceDocuments ?? [];
  const referenceArchives = snapshot.project.referenceArchives ?? [];
  const roundIndex = job.rounds?.findIndex(item => item === round) ?? -1;
  const previousReworkBrief = roundIndex > 0 ? job.rounds?.[roundIndex - 1]?.reworkBrief ?? [] : [];
  const approvedRequired = [
    ...(devGuide ? [{ id: 'G3 已确认 DEV_GUIDE', sourcePath: devGuidePath, content: devGuide }] : []),
    ...(preflight ? [{ id: '程序预检 PREFLIGHT', sourcePath: preflightPath, content: preflight }] : []),
    ...(previousReworkBrief.length ? [{
      id: '程序核对后的返工简报', sourcePath: `${runFile}#jobs/${job.id}/rounds/${Math.max(0, roundIndex - 1)}/reworkBrief`,
      content: JSON.stringify(previousReworkBrief, null, 2),
    }] : []),
    ...(round.finalReviewInstructions?.notes.length ? [{
      id: '用户显式采用的终审返工意见', sourcePath: `${runFile}#jobs/${job.id}/rounds/${round.round}/finalReviewInstructions`,
      content: JSON.stringify(round.finalReviewInstructions, null, 2),
    }] : []),
    ...referenceDocuments.map((document, index) => ({
      id: `用户参考文档 ${index + 1}：${document.name}`,
      sourcePath: `${runFile}#snapshots/${snapshot.ref}/project/referenceDocuments/${index}`,
      content: document.content,
    })),
    ...(referenceArchives.length ? [{
      id: '用户参考附件入口与清单',
      sourcePath: baseSpec.referenceDirectory ?? path.join(baseSpec.cwd, '.workbench-references'),
      content: JSON.stringify({ referenceDirectory: baseSpec.referenceDirectory ?? null, archives: referenceArchives }, null, 2),
    }] : []),
  ];

  const material = buildDispatchMaterial({
    pinnedOriginal: [{ id: '原文钉死块', sourcePath: `${runFile}#jobs/${job.id}/spec+snapshots+proposals`, content: fullPinned }],
    required: [
      { id: '当前任务协议与输出格式', sourcePath: session.kind === 'init' ? 'prompts/build-init.md' : 'prompts/build-milestone.md', content: protocol },
      { id: '程序 HANDOFF', sourcePath: handoffPath, content: handoff.content },
      { id: '剩余预算', sourcePath: `${runFile}#jobs/${job.id}/budget`, content: JSON.stringify({
        remainingCalls: remaining.calls, remainingActiveMs: remaining.activeMs, roundTimeboxRemainingMs: roundTimeboxMs,
        finalVerificationReserveMinutes: FINAL_VERIFICATION_RESERVE_MINUTES,
        currentSessionUsableMs: session.finalVerification ? roundTimeboxMs : Math.max(0, roundTimeboxMs - finalVerificationReserveMs),
      }) },
      ...approvedRequired,
    ],
    current: [{ id: '当前会话', sourcePath: `${runFile}#jobs/${job.id}/rounds/${round.round}/context/sessions/${session.id}`, content: JSON.stringify({ session: { id: session.id, kind: session.kind, finalVerification: session.finalVerification }, milestones: current }, null, 2) }],
    rawCommandExcerpts: rawCommands,
    oldReports,
    oldDocuments: [],
    digestCommands: [],
    options,
    contextWindow: options.contextWindows[baseSpec.model] ?? null,
  });
  session.material = {
    estimatedTokens: material.estimatedTokens, targetTokens: material.targetTokens,
    estimateReference: material.estimateReference, omitted: material.omitted,
  };
  if (material.blocked) {
    context.dispatchBlocked = `dispatchBlocked：派发材料估算 ${material.estimatedTokens} tokens，超过目标 ${material.targetTokens}`;
    store.save(run);
    throw new Error(context.dispatchBlocked);
  }
  context.dispatchBlocked = null;

  const previous = previousSessions.at(-1);
  const resume = previous
    ? decideResume(options, previous.context, {
      policy: run.build?.resumePolicy ?? 'never', threadId: previous.threadId,
      remainingCalls: remaining.calls, remainingActiveMs: remaining.activeMs,
      promptEstimateTokens: material.estimatedTokens,
    })
    : { resumeSessionId: null, reason: '首个会话使用新线程' };
  session.resumedFrom = resume.resumeSessionId ? previous?.id ?? null : null;
  session.resumeReason = resume.reason;
  const prompt = material.text;
  const sessionMinutes = options.milestoneMaxMinutes;
  const timeoutMs = contextInvocationTimeout(run, job, round, session, Math.min(baseSpec.timeoutMs, sessionMinutes * 60_000));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    context.dispatchBlocked = 'dispatchBlocked：当前会话没有可用的主动运行时间';
    store.save(run);
    throw new Error(context.dispatchBlocked);
  }
  store.writeTaskFile(run.id, task.id, 'prompt.md', prompt);
  store.save(run);
  return {
    ...baseSpec,
    prompt,
    outputSchema,
    cwd: job.workspaceDir,
    referenceDirectory: session.kind === 'init' || session.finalVerification ? job.workspaceDir : baseSpec.referenceDirectory,
    sandbox: session.kind === 'init' || session.finalVerification ? 'read_only' : 'workspace_write',
    allowNetwork: session.kind === 'milestone' && !session.finalVerification && job.spec.allowNetwork,
    allowWeb: false,
    timeoutMs,
    resumeSessionId: resume.resumeSessionId,
    context: { ...baseSpec.context, spec: effectiveSpec, buildRound: round.round },
  };
}

function validationErrors(error: z.ZodError): string[] {
  return error.issues.map(issue => `结构错误 ${issue.path.join('.') || '(根)'}：${issue.message}`).slice(0, 30);
}

export function validateContextOutput(
  run: Run,
  job: ValidationJob,
  round: BuildRound,
  task: TaskRecord,
  raw: unknown,
): ValidationResult<unknown> | null {
  if (!task.buildKind) return null;
  const session = round.context?.sessions.find(item => item.id === task.buildSessionId);
  if (!session) return { ok: false, value: null, errors: ['任务引用的构建会话不存在'], warnings: [] };
  if (task.buildKind === 'init') {
    const parsed = PlanOutputZ.safeParse(raw);
    if (!parsed.success) return { ok: false, value: null, errors: validationErrors(parsed.error), warnings: [] };
    const remaining = budgetRemaining(job);
    const errors = validateMilestonePlan(parsed.data, {
      spec: job.spec, workspaceDir: job.workspaceDir, options: contextOptions(run),
      remainingCalls: remaining.calls, remainingActiveMs: Math.min(remaining.activeMs, roundTimeboxRemainingMs(job, round)),
    });
    return { ok: errors.length === 0, value: errors.length ? null : parsed.data, errors, warnings: [] };
  }
  const parsed = SessionBuildReportOutputZ.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, errors: validationErrors(parsed.error), warnings: [] };
  const effective = sessionSpec(job, session);
  const base = validateOutput('build', raw, {
    specRef: job.spec.ref,
    acceptanceIds: effective.acceptance.map(item => item.id),
    hypothesisIds: job.spec.hypotheses.map(item => item.id),
    maxQuestions: 12,
  });
  const errors = [...base.errors];
  const expectedMilestones = new Set(session.milestoneIds);
  const reported = parsed.data.milestoneResults.map(item => item.milestoneId);
  if (new Set(reported).size !== reported.length) errors.push('milestoneResults 不能重复');
  for (const id of reported) if (!expectedMilestones.has(id)) errors.push(`milestoneResults 引用了非当前里程碑 ${id}`);
  for (const id of expectedMilestones) if (!reported.includes(id)) errors.push(`milestoneResults 缺少当前里程碑 ${id}`);
  const acceptance = parsed.data.acceptanceResults.map(item => item.criterionId);
  if (new Set(acceptance).size !== acceptance.length) errors.push('acceptanceResults 不能重复');
  for (const id of acceptance) if (!effective.acceptance.some(item => item.id === id)) errors.push(`acceptanceResults 引用了非当前验收项 ${id}`);
  return { ok: errors.length === 0, value: errors.length ? null : parsed.data, errors, warnings: base.warnings };
}

export function applyContextOutput(
  run: Run,
  job: ValidationJob,
  round: BuildRound,
  task: TaskRecord,
  value: unknown,
  store: RunStore,
): boolean {
  if (task.buildKind !== 'init') return false;
  const session = round.context?.sessions.find(item => item.id === task.buildSessionId);
  if (!session) throw new Error('init 任务引用的构建会话不存在');
  const checked = validateContextOutput(run, job, round, task, value);
  if (!checked?.ok || !checked.value) throw new Error(`init 计划无效：${checked?.errors.join('；') ?? '未知错误'}`);
  freezePlan(run, job, round, store, checked.value as MilestonePlan);
  session.outcome = 'passed';
  return true;
}

function isTaskLevelFailure(task: TaskRecord): boolean {
  return task.status !== 'succeeded' || !!task.failure;
}

export function completeBuildSession(
  _run: Run,
  job: ValidationJob,
  round: BuildRound,
  task: TaskRecord,
): BuildSession {
  const context = round.context;
  const session = context?.sessions.find(item => item.id === task.buildSessionId);
  if (!context || !session) throw new Error('任务引用的构建会话不存在');
  session.taskId = task.id;
  session.startedAt = task.startedAt;
  session.endedAt = task.endedAt ?? now();
  session.startCommit ??= round.baselineCommit;
  session.endCommit = round.workspaceCommit;
  const initial = session.invocations?.find(call => call.kind === 'initial');
  session.threadId = initial?.threadId ?? task.meta?.sessionId ?? null;
  session.context = initial?.context ?? unknownContext(task.meta?.usage ?? null);

  if (session.kind === 'init') {
    session.outcome = isTaskLevelFailure(task) ? 'stopped' : context.plan ? 'passed' : 'stopped';
    return session;
  }
  session.verification = job.verification ? structuredClone(job.verification) : null;
  if (isTaskLevelFailure(task)) {
    session.outcome = 'stopped';
    for (const id of session.milestoneIds) {
      const state = context.states.find(item => item.id === id);
      if (state?.status === 'running') state.status = 'failed';
    }
    return session;
  }
  const verification = session.verification;
  const plan = frozenPlan(round);
  for (const id of session.milestoneIds) {
    const milestone = plan.milestones.find(item => item.id === id)!;
    const state = context.states.find(item => item.id === id)!;
    state.status = deriveMilestoneStatus(milestone.acceptanceIds, verification);
    if (state.status !== 'pending') state.verifiedAtCommit = round.workspaceCommit;
  }
  if (session.finalVerification) {
    for (const milestone of plan.milestones) {
      const state = context.states.find(item => item.id === milestone.id)!;
      state.status = deriveMilestoneStatus(milestone.acceptanceIds, verification);
      state.verifiedAtCommit = state.status === 'pending' ? null : round.workspaceCommit;
    }
  }
  const states = session.milestoneIds.map(id => context.states.find(item => item.id === id)!.status);
  session.outcome = states.some(status => status === 'failed') ? 'failed'
    : states.some(status => status === 'pending' || status === 'running') ? 'failed'
      : states.some(status => status === 'awaiting_manual') ? 'awaiting_manual' : 'passed';
  return session;
}

export type { SessionBuildReport };
