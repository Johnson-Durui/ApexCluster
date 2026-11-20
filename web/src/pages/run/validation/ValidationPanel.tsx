import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, EmptyState, Field, Modal, SectionTitle } from '../../../components/ui';
import { formatDate, statusLabel } from '../../../lib/labels';
import type { BuildRound, FailureClass, G4Input, RunPanelProps, ValidationJob } from '../../../lib/types';
import './validation.css';

type ManualDraft = { pass: boolean | null; note: string };
type ConfirmAction = 'accept' | 'retry_job' | 'rework_job' | 'light_rework_job' | 'rework_with_final_review' | 'retry_evaluation' | 'retry_final_review' | 'ignore_preflight' | 'checkpoint_job' | 'validate_more' | 'stop' | null;
const failureLabels: Record<FailureClass, string> = { none: '无', implementation_defect: '实现缺陷', environment_issue: '环境问题', experiment_design: '试验设计不足', architecture_mismatch: '架构不满足要求' };
const activeStatuses = new Set(['queued', 'preparing', 'running', 'verifying', 'evaluating', 'final_review']);
const preflightStatus = { ok: ['通过', 'ok'], missing: ['缺失', 'bad'], warn: ['警告', 'warn'] } as const;
export function contextUsageText(context: { usageSemantics: string; contextTokensPeak: number | null; contextRatioPeak: number | null }): string {
  const observed = context;
  return observed.usageSemantics === 'per_turn_context' && observed.contextTokensPeak !== null
    ? `${observed.contextTokensPeak.toLocaleString()} tokens${observed.contextRatioPeak !== null ? ` · ${Math.round(observed.contextRatioPeak * 100)}%` : ''}`
    : 'unknown（没有受信任的逐轮上下文观测）';
}

export function sessionInvocationSummary(session: { invocations?: { kind: 'initial' | 'repair' }[] }): string {
  if (!session.invocations) return 'CLI 调用 unknown（旧记录未保存调用明细）';
  const initial = session.invocations.filter(invocation => invocation.kind === 'initial').length;
  const repairs = session.invocations.length - initial;
  return `${session.invocations.length} 次 CLI 调用 · initial ${initial} · 结构修复 ${repairs}`;
}

function reportLines(values: string[]) { return values.length ? <ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul> : <span className="muted">无</span>; }
function devGuideLabel(run: RunPanelProps['run'], job: ValidationJob) {
  if (job.devGuideVersion) return `v${job.devGuideVersion} · 已写入 DEV_GUIDE.md`;
  if (!run.writeDocs) return '新建运行时已关闭构建前文档';
  if (run.docs.missing.includes('devdoc')) return '开发文档缺失，作业将仅按 MVP 规格和框架构建';
  if (run.phase === 'docs' || run.phase === 'docs_gate') return '尚未开始，G3 确认后使用开发文档';
  if (job.status === 'queued' || job.status === 'preparing') return '将在作业准备时写入已确认的开发文档';
  return '本次构建未记录开发文档版本';
}

export function ignorePreflightDisabled(reason: string, busy: boolean) { return busy || reason.trim().length === 0; }
export function isBudgetExhausted(job: ValidationJob) { return Boolean(job.budget?.exhaustedReason); }
export function hasVerifiedReworkDefects(job: ValidationJob) { return Boolean(job.rounds?.at(-1)?.verifiedDefectIds.length); }
export function safeLightReworkLocation(location: string): string | null {
  const trimmed = location.trim();
  if (!trimmed || trimmed.includes('\0') || /^[A-Za-z]:/.test(trimmed) || /^[\\/~]/.test(trimmed)) return null;
  const withoutLine = trimmed.replace(/:\d+(?::\d+)?$/, '');
  if (!withoutLine || withoutLine.includes(':')) return null;
  const segments = withoutLine.replace(/\\/g, '/').split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}
export function lightReworkBlockReason(run: Pick<RunPanelProps['run'], 'evaluator' | 'contextBudget'>, job: ValidationJob): string | null {
  if (!job.lightRework?.enabled) return '本作业未在 G2 明确启用 Grok 轻量返工';
  if (!job.lightRework.capabilityRef) return '没有冻结 Cursor WSL 写入能力指纹';
  if (!run.evaluator?.enabled) return '本运行未启用 Astra 独立评审';
  if (run.contextBudget?.enabled) return '与 T12 构建上下文会话预算不能同时开启';
  if (job.rounds?.some(round => round.writer === 'grok')) return '本作业已经使用过一次 Grok 轻量返工';
  if (job.writeLock) return '前一任务的进程树退出尚未确认';
  const round = job.rounds?.at(-1);
  if (!round) return '当前作业没有构建轮次';
  if (round.staleReason) return '当前代码证据已过期';
  if (!round.workspaceCommit || !round.treeHash) return '当前轮没有可绑定的提交与 tree 锚点';
  if (!round.reviewIntegrity?.ok || round.reviewIntegrity.errors.length) return '当前 Astra 独立评审副本未通过完整性检查';
  if (!round.evaluation) return '当前轮没有合法 Astra 独立评审结果';
  if (round.evaluation.specRef !== job.spec.ref || round.evaluation.round !== round.round || round.evaluation.workspaceCommit !== round.workspaceCommit) return 'Astra 缺陷未绑定当前规格、轮次和提交';
  const defects = round.evaluation.defects;
  if (!defects.length) return '当前没有可进入轻量返工的缺陷';
  if (defects.some(defect => defect.severity !== 'minor')) return '只允许 minor 缺陷进入轻量返工';
  if (defects.some(defect => defect.failureClass !== 'implementation_defect')) return '只允许 implementation_defect 进入轻量返工';
  if (defects.some(defect => !defect.fix.trim())) return '每个缺陷必须有非空修复说明';
  const files = defects.map(defect => safeLightReworkLocation(defect.location));
  if (files.some(file => file === null)) return '每个缺陷必须有安全的任务相对文件位置';
  if (new Set((files as string[]).map(file => file.toLowerCase())).size > 5) return '轻量返工最多涉及 5 个不同文件';
  const verified = new Set(round.verifiedDefectIds);
  if (verified.size !== round.verifiedDefectIds.length || verified.size !== defects.length || defects.some(defect => !verified.has(defect.id))) return '缺陷必须与程序核验的当前 verifiedDefectIds 精确一致';
  if (job.budget?.exhaustedReason) return job.budget.exhaustedReason;
  return null;
}
export function finalReviewReworkBlockReason(run: Pick<RunPanelProps['run'], 'finalReview'>, job: ValidationJob): string | null {
  if (!run.finalReview?.enabled) return '本运行未启用 Claude 终审';
  if (!job.finalReview) return '没有可采用的当前终审意见';
  const notes = [...job.finalReview.reworkNotes, ...job.finalReview.findings.map(finding => finding.text)].filter(note => note.trim());
  if (!notes.length) return '当前终审没有具体返工意见';
  const round = job.rounds?.at(-1);
  if (!round) return '当前作业没有构建轮次';
  if (round.staleReason) return '当前代码证据已过期';
  if (job.writeLock) return '前一任务的进程树退出尚未确认';
  if (job.finalReview.specRef !== job.spec.ref || !job.finalReview.roundsReviewed.includes(round.round)
    || job.finalReview.workspaceCommit !== round.workspaceCommit) return '终审意见未绑定当前规格和最新构建轮次';
  const budget = job.budget;
  if (!budget) return '作业没有 T7 预算快照';
  if (budget.calls.some(call => call.state === 'unknown' || call.state === 'started')) return '存在尚未结算或状态未知的模型调用';
  if (budget.exhaustedReason) return budget.exhaustedReason;
  const callsInUse = budget.usage.modelCalls + new Set(budget.reservedCalls).size;
  if (callsInUse + 2 > budget.limits.maxModelCalls) return '模型调用预算不足，无法同时保留一次终审调用';
  const writersInUse = budget.usage.writerSessions + new Set(budget.reservedWriterSessions).size;
  if (writersInUse + 1 > budget.limits.maxWriterSessions) return '写者会话预算已耗尽';
  if (budget.usage.buildRounds + 1 > budget.limits.maxRounds) return '构建轮次预算已耗尽';
  if (budget.usage.activeMs >= budget.limits.maxActiveMinutes * 60_000) return '主动运行时间预算已耗尽';
  return null;
}

export function RoundEvidence({ round }: { round: BuildRound }) {
  const verification = round.verification;
  const evaluation = round.evaluation;
  const writerLabel = round.writer === 'grok' ? round.lightRework ? 'Grok · High · WSL 隔离写入 + Windows Astra 独立验证' : 'Grok · 轻量返工元数据缺失' : round.writer === 'sol' ? 'Sol' : round.writer;
  return <article className="round-card">
    <header><div><b>第 {round.round} 轮 · {{ initial: '初次构建', rework: '按缺陷返工', retry: '手动重试' }[round.kind]}</b><small>{writerLabel} · {round.workspaceCommit ? `提交 ${round.workspaceCommit.slice(0, 12)}` : '未形成提交'}</small></div><Badge tone={round.outcome === 'passed' ? 'ok' : round.outcome === 'rework' || round.outcome === 'exhausted' ? 'bad' : 'warn'}>{statusLabel(round.outcome)}</Badge></header>
    {round.staleReason ? <div className="alert bad"><b>证据已过期</b><br />{round.staleReason}</div> : null}
    {round.writer === 'grok' && !round.lightRework ? <div className="alert bad"><b>Grok 轮次元数据异常</b><p>缺少冻结的允许文件、WSL 能力与预算信息，不能声称该轮经过受控 WSL 轻量返工。</p></div> : null}
    {round.reviewIntegrity && !round.reviewIntegrity.ok ? <div className="alert bad"><b>独立评审副本异常</b>{reportLines(round.reviewIntegrity.errors)}</div> : null}
    <div className="round-columns"><section><b>写者报告</b><p>{round.report?.summary ?? '本轮没有合法写者报告。'}</p>{round.report?.deviations.length ? <ul>{round.report.deviations.map(item => <li key={item}>{item}</li>)}</ul> : null}</section><section><b>程序核验 · 实际工具日志</b><p>{verification ? `${statusLabel(verification.verdict)} · ${verification.items.length} 项` : '本轮未记录核验报告'}</p>{verification ? <small>证据来源：任务 <code>{verification.taskId ?? 'unknown'}</code> · 日志序列 <code>{verification.logRange ? `${verification.logRange.from}–${verification.logRange.to}` : 'unknown'}</code></small> : null}{verification?.items.length ? <ul>{verification.items.map(item => <li key={item.criterionId}><code>{item.criterionId}</code> {statusLabel(item.status)}{item.note ? `：${item.note}` : ''}</li>)}</ul> : null}</section><section><b>Astra 评审结论（模型自报）</b><p>{evaluation ? `${statusLabel(evaluation.verdict)} · ${evaluation.defects.length} 个缺陷` : round.evaluateTaskId ? '评审任务未产生合法报告' : '本轮未启用独立评审'}</p>{evaluation?.acceptance.length ? <><small>以下 acceptance/evidence 不是通过证据；通过状态只取左侧实际工具日志。</small><ul>{evaluation.acceptance.map(item => <li key={item.criterionId}><code>{item.criterionId}</code> {statusLabel(item.status)}：{item.evidence}</li>)}</ul></> : null}</section></div>
    <p className="round-code-state">代码状态：<code>{round.workspaceCommit ?? '无提交'}</code> · tree <code>{round.treeHash ?? '未记录'}</code>{round.reviewWorkspace ? ` · 评审副本 ${round.reviewWorkspace}` : ''}</p>
    {round.lightRework ? <details className="round-context" open><summary>Grok 轻量返工冻结边界</summary><p>时间冻结：Grok {round.lightRework.minutes} 分钟 · Astra {round.lightRework.evaluateMinutes} 分钟 · Claude {round.lightRework.finalMinutes} 分钟</p><p>能力指纹 <code>{round.lightRework.capabilityRef}</code> · 源提交 <code>{round.lightRework.sourceCommit}</code> · tree <code>{round.lightRework.sourceTreeHash}</code></p><p>允许文件（{round.lightRework.allowedFiles.length} / 5）：</p>{reportLines(round.lightRework.allowedFiles)}<small>Astra 预留任务 <code>{round.lightRework.reservedEvaluateTaskId}</code>{round.lightRework.reservedFinalTaskId ? <> · Claude 终审预留 <code>{round.lightRework.reservedFinalTaskId}</code></> : ' · 未启用 Claude 终审'}</small></details> : null}
    {round.context ? <details className="round-context" open><summary>里程碑与上下文 · {round.context.sessions.length} 个逻辑会话 · {round.context.sessions.every(session => session.invocations !== undefined) ? `${round.context.sessions.reduce((sum, session) => sum + (session.invocations?.length ?? 0), 0)} 次 CLI 调用` : 'CLI 调用 unknown'}</summary>
      {round.context.dispatchBlocked ? <div className="alert bad"><b>派发已阻塞</b><p>{round.context.dispatchBlocked}</p></div> : null}
      <p><b>PLAN 入口：</b> <code>{round.context.planPath || '未记录'}</code>{round.context.planHash ? <> · hash <code>{round.context.planHash}</code></> : null}</p>
      {round.context.states.length ? <div className="row">{round.context.states.map(state => <Badge key={state.id} tone={state.status === 'passed' ? 'ok' : state.status === 'failed' ? 'bad' : 'info'}>{state.id} · {statusLabel(state.status)} · 尝试 {state.attempts}</Badge>)}</div> : <p className="muted">没有里程碑状态记录。</p>}
      <div className="session-list">{round.context.sessions.map(session => <article key={session.id}><div className="row"><b>{session.kind === 'init' ? '初始化逻辑会话' : `里程碑 ${session.milestoneIds.join('、') || '未标记'} · 逻辑会话`}</b><Badge tone={session.outcome === 'passed' ? 'ok' : session.outcome === 'failed' ? 'bad' : 'warn'}>{statusLabel(session.outcome)}</Badge></div><p>{session.resumedFrom ? `续接 ${session.resumedFrom}` : '新线程'} · {session.resumeReason}</p><dl><dt>逻辑会话上下文</dt><dd>{contextUsageText(session.context)}</dd>{session.material ? <><dt>材料估算</dt><dd>约 {session.material.estimatedTokens.toLocaleString()} / 目标 {session.material.targetTokens.toLocaleString()} tokens · {session.material.estimateReference}</dd></> : null}<dt>HANDOFF 入口</dt><dd><code>{session.handoffPath ?? '未生成'}</code></dd></dl><div><b>{sessionInvocationSummary(session)}</b>{session.invocations ? <ul>{session.invocations.map(invocation => <li key={invocation.id}><Badge tone={invocation.kind === 'repair' ? 'warn' : 'info'}>{invocation.kind === 'initial' ? 'initial' : '结构修复'}</Badge> <code>{invocation.id}</code> · 线程 <code>{invocation.threadId ?? 'unknown'}</code> · {invocation.processStarted === null ? '进程状态 unknown' : invocation.processStarted ? '进程已启动' : '进程未启动'} · {statusLabel(invocation.status)} · 上下文 {contextUsageText(invocation.context)}</li>)}</ul> : <p className="muted">不能从逻辑会话数量推断 CLI 调用数，也不把缺失明细记为 0。</p>}</div>{session.material?.omitted.length ? <small>省略材料：{session.material.omitted.map(item => `${item.id}（${item.reason}）`).join('；')}</small> : null}</article>)}</div>
    </details> : null}
    {evaluation?.defects.length ? <details open><summary>缺陷明细（{evaluation.defects.length}）</summary><div className="defect-list">{evaluation.defects.map(defect => <article key={defect.id}><div><Badge tone={round.verifiedDefectIds.includes(defect.id) ? 'bad' : 'warn'}>{defect.id}</Badge><Badge>{defect.severity}</Badge>{round.verifiedDefectIds.includes(defect.id) ? <Badge tone="ok">程序已核验</Badge> : <Badge>未进入返工依据</Badge>}</div><b>{defect.location}</b><p>{defect.evidence}</p><small>复现：<code>{defect.reproduction.command}</code> · 修法：{defect.fix}</small></article>)}</div></details> : null}
    {round.stoppedReason ? <p className="help-note">本轮停止：{round.stoppedReason}</p> : null}
  </article>;
}

function DigestFacts({ job }: { job: ValidationJob }) {
  if (!job.digest) return null;
  if (job.digest.status !== 'ready' || !job.digest.output) return <section className="digest-facts"><div><b>Grok 构建摘要</b><Badge tone="warn">{job.digest.status === 'pending' ? '生成中' : '已跳过'}</Badge></div><p>{job.digest.reason || '没有合法摘要输出。'}</p><small>摘要不能替代程序核验。</small></section>;
  return <section className="digest-facts"><div><b>Grok 构建摘要</b><Badge tone="info">带来源锚点</Badge></div><p><code>{job.digest.output.specRef ?? 'spec unknown'}</code> · commit <code>{job.digest.output.workspaceCommit ?? 'unknown'}</code></p>{job.digest.output.entries.length ? <ul>{job.digest.output.entries.map((entry, index) => <li key={`${entry.sourceId}-${index}`}><b>{entry.text}</b><small>来源 {entry.sourceId}：“{entry.quote}”</small></li>)}</ul> : <p className="muted">摘要没有条目。</p>}<small>这是 Grok 导航摘要，不能代替程序核验、独立评审或终审。</small></section>;
}

export function BudgetFacts({ job }: { job: ValidationJob }) {
  if (!job.budget) return <section className="budget-facts"><div><b>作业共同预算</b><Badge>旧作业</Badge></div><p className="muted">此作业没有 T7 预算快照，不把缺失字段当作零用量。</p></section>;
  const { limits, usage } = job.budget;
  return <section className="budget-facts"><div><b>作业共同预算</b><Badge tone={job.budget.exhaustedReason ? 'bad' : 'info'}>{job.budget.exhaustedReason ? '已耗尽' : '计费中'}</Badge></div><dl><div><dt>构建轮数</dt><dd>{usage.buildRounds} / {limits.maxRounds}</dd></div><div><dt>写者会话</dt><dd>{usage.writerSessions} / {limits.maxWriterSessions}</dd></div><div><dt>模型调用</dt><dd>{usage.modelCalls} / {limits.maxModelCalls}</dd></div><div><dt>模型主动时间</dt><dd>{Math.round(usage.activeMs / 60000)} / {limits.maxActiveMinutes} 分钟</dd></div><div><dt>已预留</dt><dd>{job.budget.reservedCalls.length} 调用 · {job.budget.reservedWriterSessions.length} 写者会话</dd></div></dl>{job.budget.exhaustedReason ? <div className="alert bad"><b>不能继续重试或返工</b><br />{job.budget.exhaustedReason}。需回到 G2 明确新建下一批作业，当前历史不会清零。</div> : null}</section>;
}

export function FinalReviewFacts({ run, job }: { run: RunPanelProps['run']; job: ValidationJob }) {
  if (!run.finalReview) return <section className="final-review-facts"><div><b>Claude 终审</b><Badge>旧运行未配置</Badge></div></section>;
  if (!run.finalReview.enabled) return <section className="final-review-facts"><div><b>Claude 终审</b><Badge>创建时关闭</Badge></div></section>;
  if (job.status === 'final_review' && !job.finalReview) return <section className="final-review-facts"><div><b>Claude 只读终审</b><Badge tone="info">进行中</Badge></div><p>正在审查绑定的代码与核验材料，完成前不会生成 G4 结论。</p></section>;
  if (job.finalReview) return <section className="final-review-facts"><div><b>Claude 只读终审</b><Badge tone={job.finalReview.verdict === 'reject' ? 'bad' : 'ok'}>{statusLabel(job.finalReview.verdict)}</Badge></div><p>{job.finalReview.summary}</p><small>覆盖轮次：{job.finalReview.roundsReviewed.join('、') || '未记录'} · 框架一致性：{job.finalReview.frameworkCompliance}{job.finalReviewHistory?.length ? ` · 历史尝试 ${job.finalReviewHistory.length} 次` : ''}</small>{job.finalReview.findings.length ? <ul>{job.finalReview.findings.map((finding, index) => <li key={`${finding.round}-${index}`}>第 {finding.round} 轮 · {finding.severity}：{finding.text}{finding.defectIds.length ? `（${finding.defectIds.join('、')}）` : ''}</li>)}</ul> : null}</section>;
  return <section className="final-review-facts"><div><b>Claude 只读终审</b><Badge tone="bad">缺失</Badge></div><p>{job.finalReviewMissingReason ?? '启用了终审，但没有合法终审报告。'}</p></section>;
}

function PreflightReportTable({ report }: { report: NonNullable<ValidationJob['preflight']> }) {
  return <div className="table-scroll"><table><thead><tr><th>检查</th><th>结果</th><th>说明</th></tr></thead><tbody>{report.items.map((item, index) => <tr key={`${item.check}-${index}`}><td>{item.check}</td><td><Badge tone={preflightStatus[item.status][1]}>{preflightStatus[item.status][0]}</Badge></td><td>{item.detail}</td></tr>)}</tbody></table></div>;
}

function PreflightHistory({ job }: { job: ValidationJob }) {
  const reports = job.preflightHistory ?? [];
  const audits = job.preflightAudit ?? [];
  if (!reports.length && !audits.length) return null;
  return <details className="preflight-history"><summary>预检历史与忽略记录（{reports.length} 份报告 · {audits.length} 条忽略）</summary><div>
    {reports.map((report, index) => <article key={`report-${report.checkedAt}-${index}`}><div className="preflight-history-head"><b>历史报告 {index + 1}</b><span>{formatDate(report.checkedAt)}</span><Badge tone={report.ok ? 'ok' : 'bad'}>{report.ok ? '通过' : '未通过'}</Badge></div><PreflightReportTable report={report} /></article>)}
    {audits.map((audit, index) => <article key={`audit-${audit.report.checkedAt}-${audit.ignoredAt}-${index}`}><div className="preflight-history-head"><b>忽略记录 {index + 1}</b><span>报告 {formatDate(audit.report.checkedAt)} · 忽略 {formatDate(audit.ignoredAt)}</span></div><p>{audit.reason}</p><PreflightReportTable report={audit.report} /></article>)}
  </div></details>;
}

export function PreflightFacts({ run, job, checking }: { run: RunPanelProps['run']; job: ValidationJob; checking: boolean }) {
  if (run.preflight?.enabled === false) return <section className="preflight-facts"><div className="preflight-head"><b>环境预检</b><Badge>创建时关闭</Badge></div><p className="muted">本次运行创建时已关闭固定命令环境预检。</p></section>;
  if (run.preflight === undefined) return <section className="preflight-facts"><div className="preflight-head"><b>环境预检</b><Badge>旧记录</Badge></div><p className="muted">此运行创建时没有预检能力，不提供重查或忽略操作。</p></section>;
  if (job.preflight === undefined) return <section className="preflight-facts"><div className="preflight-head"><b>环境预检</b><Badge>旧作业</Badge></div><p className="muted">此作业没有预检字段，不提供重查或忽略操作。</p></section>;
  if (checking) return <section className="preflight-facts"><div className="preflight-head"><b>环境预检</b><Badge tone="info">正在预检</Badge></div><p>正在执行工作台定义的固定检查命令，尚未调用 Sol。</p><PreflightHistory job={job} /></section>;
  if (job.preflight === null) return <section className="preflight-facts"><div className="preflight-head"><b>环境预检</b><Badge tone="warn">尚未检查</Badge></div><p className="muted">预检已启用，但还没有检查报告。</p><PreflightHistory job={job} /></section>;
  const report = job.preflight;
  return <section className="preflight-facts"><div className="preflight-head"><div><b>环境预检</b><small>{formatDate(report.checkedAt)}{job.preflightHistory?.length ? ` · 历史报告 ${job.preflightHistory.length} 份` : ''}</small></div><Badge tone={report.ok ? 'ok' : 'bad'}>{report.ok ? '通过' : '未通过'}</Badge></div>
    <PreflightReportTable report={report} />
    {job.preflightOverride ? <div className="alert warn preflight-override"><b>已忽略此版预检并继续</b><p>{job.preflightOverride.reason}</p><small>忽略报告：{formatDate(job.preflightOverride.checkedAt)} · 提交：{formatDate(job.preflightOverride.at)}</small></div> : null}
    <PreflightHistory job={job} />
  </section>;
}

export default function ValidationPanel({ run, busy, progress, act, error }: RunPanelProps) {
  const [manual, setManual] = useState<Record<string, ManualDraft>>({});
  const [failureOverrides, setFailureOverrides] = useState<Record<string, FailureClass>>({});
  const [chosenCandidateId, setChosenCandidateId] = useState<string | null>(null);
  const [targetJobId, setTargetJobId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [preflightReason, setPreflightReason] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [submitError, setSubmitError] = useState('');
  useEffect(() => { if (error) setSubmitError(error); }, [error]);
  const currentJobs = useMemo(() => run.jobs.filter((job) => job.batch === run.jobBatch), [run.jobs, run.jobBatch]);
  const hasActiveJob = currentJobs.some((job) => activeStatuses.has(job.status));
  const canResolve = run.phase === 'final_gate' && run.phaseStatus === 'waiting_user' && !busy && !hasActiveJob;
  const gateOpen = run.phase === 'final_gate' && run.phaseStatus === 'waiting_user' && run.terminal === null && !hasActiveJob;
  const confirmBack = useRef<HTMLButtonElement>(null); const preflightField = useRef<HTMLTextAreaElement>(null);
  const proposals = useMemo(() => new Map(run.proposals.map((proposal) => [proposal.id, proposal])), [run.proposals]);

  const manualResults = currentJobs.flatMap((job) => job.spec.acceptance.filter((item) => item.kind === 'manual').flatMap((item) => {
    const draft = manual[`${job.id}|${item.id}`];
    return draft?.pass === null || draft?.pass === undefined ? [] : [{ jobId: job.id, criterionId: item.id, pass: draft.pass, note: draft.note.trim() || null }];
  }));
  const currentJobIds = new Set(currentJobs.map((job) => job.id));
  const overrides = Object.fromEntries(Object.entries(failureOverrides).filter(([jobId]) => currentJobIds.has(jobId)));

  const candidateTitle = (job: ValidationJob) => `${job.candidateId} · ${proposals.get(job.proposalId)?.title ?? '候选方案'}`;
  const willPassAfterSubmit = (job: ValidationJob) => job.spec.acceptance.every((criterion) => {
    const verified = job.verification?.items.find((item) => item.criterionId === criterion.id);
    if (criterion.kind === 'command') return verified?.status === 'verified_pass';
    const draft = manual[`${job.id}|${criterion.id}`];
    const previous = [...job.manualResults].reverse().find((item) => item.criterionId === criterion.id);
    return draft?.pass ?? previous?.pass ?? false;
  });
  const submit = async () => {
    if (!confirmAction) return;
    const reject = (message: string) => { setSubmitError(message); };
    if (confirmAction === 'checkpoint_job') {
      const job = targetJobId ? currentJobs.find(item => item.id === targetJobId) : undefined;
      if (!job || !job.rounds?.at(-1)) { reject('当前作业没有可保留的构建轮次。'); return; }
      if (activeStatuses.has(job.status)) { reject('作业仍在进行，完成后才能保留当前代码。'); return; }
      if (job.writeLock) { reject('前一任务的进程树退出尚未确认，暂时不能保留代码。'); return; }
      const succeeded = await act(`/jobs/${targetJobId}/checkpoint`, { reason: '用户明确保留当前生成代码，原验收证据不沿用' });
      if (!succeeded) { if (!error) setSubmitError('提交未成功，运行状态未改变。'); return; }
      setSubmitError(''); setConfirmAction(null); return;
    }
    const jobActions = new Set(['retry_job', 'rework_job', 'light_rework_job', 'rework_with_final_review', 'retry_evaluation', 'retry_final_review', 'ignore_preflight']);
    const body: G4Input = { gate: 'G4_final', action: confirmAction, chosenCandidateId: confirmAction === 'accept' ? chosenCandidateId : null, jobId: jobActions.has(confirmAction) ? targetJobId : null, manualResults: confirmAction === 'accept' ? manualResults : [], failureClassOverrides: overrides, reason: confirmAction === 'ignore_preflight' ? preflightReason.trim() || null : reason.trim() || null };
    if (confirmAction === 'accept') {
      const job = currentJobs.find((item) => item.candidateId === chosenCandidateId);
      const finalReviewNeedsReason = Boolean(run.finalReview?.enabled && (!job?.finalReview || job.finalReview.verdict === 'reject'));
      if (!job) { reject('所选候选已不在当前 G4 批次，请刷新状态后重新选择。'); return; }
      if ((!willPassAfterSubmit(job) || finalReviewNeedsReason) && !reason.trim()) { reject('当前验收未完全通过或终审缺失/拒绝，请填写验收说明后再确认。'); return; }
    }
    if (confirmAction === 'rework_job' && (!targetJobId || !currentJobs.find(job => job.id === targetJobId) || !hasVerifiedReworkDefects(currentJobs.find(job => job.id === targetJobId)!))) { reject('当前没有可核验的实现缺陷，不能发起返工。'); return; }
    if (confirmAction === 'light_rework_job') {
      const job = currentJobs.find(item => item.id === targetJobId);
      if (!job) { reject('目标作业已不在当前 G4 批次，请刷新状态。'); return; }
      const blocked = lightReworkBlockReason(run, job); if (blocked) { reject(`不能执行 Grok 轻量返工：${blocked}`); return; }
    }
    if (confirmAction === 'rework_with_final_review') {
      const job = currentJobs.find(item => item.id === targetJobId);
      if (!job) { reject('目标作业已不在当前 G4 批次，请刷新状态。'); return; }
      const blocked = finalReviewReworkBlockReason(run, job); if (blocked) { reject(`不能按终审意见返工：${blocked}`); return; }
    }
    if (confirmAction === 'ignore_preflight' && ignorePreflightDisabled(preflightReason, busy)) { reject('忽略预检并继续构建必须填写理由。'); return; }
    const succeeded = await act('/gates', body);
    if (!succeeded) { if (!error) setSubmitError('提交未成功，运行状态未改变；请查看页面顶部错误并刷新状态。'); return; }
    setSubmitError('');
    if (confirmAction === 'retry_job' && targetJobId) {
      const prefix = `${targetJobId}|`;
      setManual((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix))));
    }
    if (confirmAction === 'ignore_preflight') setPreflightReason('');
    setConfirmAction(null);
  };
  const copyWorkspace = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setCopyMessage('工作区路径已复制'); }
    catch { setCopyMessage('复制失败，请手动选择路径'); }
  };

  if (!run.jobs.length) return <section className="panel"><EmptyState title="还没有 MVP 作业"><p>先在“框架决策”中确认候选与 MVP 范围，Sol 作业才会在 G2 之后创建。</p></EmptyState></section>;
  return <div className="validation-stack">
    <section className="panel">
      <SectionTitle title="MVP 验证作业" eyebrow={`第 ${run.jobBatch} 批`}><Badge tone={run.mode === 'mock' ? 'mock' : 'sol'}>{run.mode === 'mock' ? '模拟作业' : 'Sol 作业'}</Badge></SectionTitle>
      {copyMessage ? <div role="status" className="alert info">{copyMessage}</div> : null}
      <div className="job-list">{currentJobs.map((job) => {
        const taskProgress = job.taskIds.flatMap((taskId) => progress[taskId] ?? []);
        const mismatches = job.verification?.selfReportMismatches ?? [];
        const hasActiveBuildTask = job.taskIds.some((taskId) => run.tasks.some((task) => task.id === taskId && task.phase === 'build' && (task.status === 'queued' || task.status === 'running')));
        const checkingPreflight = job.status === 'preparing' && !hasActiveBuildTask && job.preflight !== undefined && run.preflight?.enabled === true;
        const canUsePreflightActions = canResolve && job.preflight !== undefined && run.preflight?.enabled === true;
        const exhausted = isBudgetExhausted(job);
        const verifiedDefects = hasVerifiedReworkDefects(job);
        const finalReviewReworkBlocked = finalReviewReworkBlockReason(run, job);
        const lightReworkBlocked = lightReworkBlockReason(run, job);
        const latestWriter = job.rounds?.at(-1)?.writer;
        const writerName = latestWriter === 'grok' ? 'Grok · High' : 'Sol';
        return <article className="job-card" key={job.id}>
          <div className="job-head"><div><span className="mono">{job.id}</span><h3>{candidateTitle(job)}</h3></div><div className="row"><Badge tone={checkingPreflight ? '' : latestWriter === 'grok' ? 'grok' : 'sol'}>{checkingPreflight ? '固定命令预检' : latestWriter === 'grok' ? writerName : `Sol · ${job.effort === 'ultra' ? 'Ultra' : 'Max'}`}</Badge><Badge tone={job.status === 'passed' ? 'ok' : job.status === 'failed' ? 'bad' : activeStatuses.has(job.status) ? 'info' : 'warn'}>{checkingPreflight ? '正在预检' : statusLabel(job.status)}</Badge></div></div>
          <div className="job-body"><div className="job-main">
          <div className="table-scroll"><table><thead><tr><th>验收项</th><th>核验状态</th><th>匹配命令</th><th>退出码 / 输出</th></tr></thead><tbody>{job.spec.acceptance.map((criterion) => {
            const verified = job.verification?.items.find((item) => item.criterionId === criterion.id);
            const previous = [...job.manualResults].reverse().find((item) => item.criterionId === criterion.id);
            const key = `${job.id}|${criterion.id}`; const draft = manual[key] ?? { pass: previous?.pass ?? null, note: previous?.note ?? '' };
            return <tr key={criterion.id}><td><b>{criterion.id}</b> {criterion.description}<small>{criterion.kind === 'command' ? '命令核验' : '人工确认'}</small></td><td><Badge tone={verified?.status === 'verified_pass' || verified?.status === 'user_pass' ? 'ok' : verified?.status === 'verified_fail' || verified?.status === 'user_fail' ? 'bad' : 'warn'}>{statusLabel(verified?.status ?? (criterion.kind === 'manual' ? 'awaiting_user' : 'not_observed'))}</Badge>{criterion.kind === 'manual' && canResolve ? <div className="manual-controls"><div className="row"><button className={draft.pass === true ? 'primary' : ''} onClick={() => setManual((current) => ({ ...current, [key]: { ...draft, pass: true } }))}>通过</button><button className={draft.pass === false ? 'danger' : ''} onClick={() => setManual((current) => ({ ...current, [key]: { ...draft, pass: false } }))}>不通过</button></div><input aria-label={`${criterion.id} 人工验收备注`} value={draft.note} placeholder="备注（可选）" onChange={(event) => setManual((current) => ({ ...current, [key]: { ...draft, note: event.target.value } }))}/></div> : null}</td><td><code>{verified?.matchedCommand ?? criterion.command ?? '—'}</code></td><td>{verified?.exitCode ?? '—'}<small>{verified?.outputExcerpt ?? verified?.note ?? ''}</small></td></tr>;
          })}</tbody></table></div>
          {mismatches.length ? <div role="alert" className="alert bad mismatch"><b>写者自报与执行日志不符</b><ul>{mismatches.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
          {job.rounds ? <details className="round-history" open><summary>构建、核验与独立评审轮次（{job.rounds.length}）</summary><div>{job.rounds.map(round => <RoundEvidence key={round.round} round={round} />)}</div></details> : <div className="help-note">旧作业没有轮次记录，保留原核验界面。</div>}
          <details className="report" open><summary>{writerName} 报告（自报，仅供参考；验收以执行日志为准）</summary>{job.report ? <div className="report-grid"><div><b>摘要</b><p>{job.report.summary}</p></div><div><b>如何运行</b>{reportLines([...job.report.howToRun.setup, ...job.report.howToRun.run, ...job.report.howToRun.test])}</div><div><b>偏离确认框架</b>{reportLines(job.report.deviations)}</div><div><b>待解决问题</b>{reportLines(job.report.openIssues)}</div></div> : <p className="muted">报告尚未生成。</p>}</details>
          </div><div className="job-side">
          <PreflightFacts run={run} job={job} checking={checkingPreflight} />
          <DigestFacts job={job} />
          <BudgetFacts job={job} />
          <FinalReviewFacts run={run} job={job} />
          <dl className="job-meta"><dt>工作区</dt><dd><code>{job.workspaceDir}</code> <button className="ghost compact" onClick={() => void copyWorkspace(job.workspaceDir)}>复制</button></dd><dt>规格</dt><dd><code>{job.spec.ref}</code></dd><dt>开发文档</dt><dd>{devGuideLabel(run, job)}</dd><dt>强度理由</dt><dd>{job.effortReason}</dd></dl>
          <div className="job-log"><div className="job-log-head">实时进度{taskProgress.length ? `（${taskProgress.length} 条）` : ''}</div>{taskProgress.length ? <div className="log">{taskProgress.map((item) => `[${new Date(item.at).toLocaleTimeString('zh-CN')}] ${item.text}`).join('\n')}</div> : <div className="help-note">{checkingPreflight ? '固定命令环境预检正在运行，尚未调用写者。' : activeStatuses.has(job.status) ? `等待 ${writerName} 输出实时进度…` : '本作业没有可用的实时进度记录。'}</div>}</div>
          <Field label="失败分类" hint={job.failureClassSource === 'sol' ? '当前为 Sol 自报，可在 G4 提交时修正。' : job.failureClassSource === 'grok' ? '当前为 Grok 自报，可在 G4 提交时修正。' : job.failureClassSource === 'user' ? '已由你修正。' : job.failureClassSource === 'preflight' ? '由固定命令环境预检判定，可修复环境后重查。' : '未分类。'}><select disabled={!canResolve} value={failureOverrides[job.id] ?? job.failureClass ?? 'none'} onChange={(event) => setFailureOverrides((current) => ({ ...current, [job.id]: event.target.value as FailureClass }))}>{Object.entries(failureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          {canResolve && !activeStatuses.has(job.status) ? <div className="job-actions"><div className="btnbar preflight-actions">{job.rounds?.at(-1) && !job.writeLock ? <button onClick={() => { setTargetJobId(job.id); setConfirmAction('checkpoint_job'); }}>保留当前代码</button> : null}{canUsePreflightActions ? <button onClick={() => void act(`/jobs/${job.id}/preflight`, {})}>重跑预检（不构建）</button> : null}{canUsePreflightActions && job.preflight && !job.preflight.ok ? <button className="gate" disabled={exhausted} onClick={() => { setTargetJobId(job.id); setPreflightReason(''); setConfirmAction('ignore_preflight'); }}>忽略预检并继续构建</button> : null}<button disabled={exhausted} onClick={() => { setTargetJobId(job.id); setConfirmAction('retry_job'); }}>手动重试整个作业</button></div>
          {job.rounds ? <><div className="btnbar review-actions"><button className="gate" disabled={exhausted || !verifiedDefects} title={!verifiedDefects ? '只有程序核对的实现缺陷才能驱动返工' : undefined} onClick={() => { setTargetJobId(job.id); setConfirmAction('rework_job'); }}>按已核验缺陷返工</button><button disabled={Boolean(lightReworkBlocked)} title={lightReworkBlocked ?? undefined} onClick={() => { setTargetJobId(job.id); setConfirmAction('light_rework_job'); }}>Grok 轻量返工</button>{run.finalReview?.enabled ? <button disabled={Boolean(finalReviewReworkBlocked)} title={finalReviewReworkBlocked ?? undefined} onClick={() => { setTargetJobId(job.id); setConfirmAction('rework_with_final_review'); }}>按当前终审意见返工</button> : null}{run.evaluator?.enabled && job.rounds.at(-1)?.evaluation == null ? <button disabled={exhausted} onClick={() => { setTargetJobId(job.id); setConfirmAction('retry_evaluation'); }}>仅重试独立评审</button> : null}{run.finalReview?.enabled && (!job.finalReview || job.finalReview.verdict === 'reject') ? <button disabled={exhausted} onClick={() => { setTargetJobId(job.id); setConfirmAction('retry_final_review'); }}>仅重试 Claude 终审</button> : null}</div>{lightReworkBlocked ? <p className="help-note">Grok 轻量返工不可用：{lightReworkBlocked}。普通手动重试仍由 Sol 执行；服务端会在提交时重新核验全部条件。</p> : <p className="help-note">前端初步检查通过：最多一次，只改不超过 5 个允许文件；提交后服务端仍会检查安全路径、能力漂移及完整调用与主动时间预算。Windows Astra 在独立副本运行命令，程序以实际工具日志核验。</p>}</> : null}</div> : null}
          </div></div>
        </article>;
      })}</div>
    </section>
    <section className={`final-gate gate-section gate-wrap${gateOpen ? '' : ' is-readonly'}`} aria-label="G4 最终验收"><div className="decision-card"><div className="decision-in">
      <SectionTitle title="最终验收" eyebrow="G4 · 由你决定"><Badge tone={canResolve ? 'info' : ''}>{canResolve ? '等待确认' : '当前只读'}</Badge></SectionTitle>
      {hasActiveJob ? <div className="alert info" role="status">当前批次仍有作业在预检、构建或核验。完成前不能接受候选、返回 G2 或提交停止；仍可使用全局取消。</div> : null}
      <div className="choice-grid">{currentJobs.map((job) => { const projectedPass = willPassAfterSubmit(job); const finalProblem = run.finalReview?.enabled && (!job.finalReview || job.finalReview.verdict === 'reject'); return <label key={job.id} className={chosenCandidateId === job.candidateId ? 'selected' : ''}><input type="radio" name="chosen-candidate" checked={chosenCandidateId === job.candidateId} disabled={!canResolve} onChange={() => setChosenCandidateId(job.candidateId)}/><span><b>{candidateTitle(job)}</b><small>{projectedPass && !finalProblem ? '提交当前人工结果后可通过' : `${finalProblem ? '终审缺失或拒绝' : statusLabel(job.status)} · 接受时必须说明理由`}</small></span></label>; })}</div>
      <Field label="验收说明"><textarea value={reason} disabled={!canResolve} onChange={(event) => setReason(event.target.value)} placeholder="未通过仍要接受时，此项必填；也可记录停止原因"/></Field>
      <div className={`btnbar gate-actions${gateOpen ? ' is-sticky' : ''}`}><button className="gate" disabled={!canResolve || !chosenCandidateId || (() => { const job = currentJobs.find((item) => item.candidateId === chosenCandidateId); const finalProblem = run.finalReview?.enabled && (!job?.finalReview || job.finalReview.verdict === 'reject'); return !job || ((!willPassAfterSubmit(job) || finalProblem) && !reason.trim()); })()} onClick={() => setConfirmAction('accept')}>{run.writePrd === false ? '接受所选候选并结束' : '接受所选候选并撰写 PRD'}</button><button disabled={!canResolve} onClick={() => setConfirmAction('validate_more')}>回到 G2 新建验证批次</button><button className="danger ghost" disabled={!canResolve} onClick={() => setConfirmAction('stop')}>停止并保存记录</button></div>
    </div></div></section>
    {confirmAction ? <Modal title={{ accept: '确认最终选择', retry_job: '确认手动重试作业', rework_job: '确认按缺陷返工', light_rework_job: '确认 Grok 轻量返工', rework_with_final_review: '确认按终审意见返工', retry_evaluation: '确认重试独立评审', retry_final_review: '确认重试 Claude 终审', ignore_preflight: '忽略预检并继续构建', checkpoint_job: '确认保留当前代码', validate_more: '返回框架确认', stop: '确认停止运行' }[confirmAction]} size="sm" initialFocus={confirmAction === 'ignore_preflight' ? preflightField : confirmBack} onClose={() => setConfirmAction(null)}><p>{confirmAction === 'checkpoint_job' ? '保存当前代码检查点；原超时与历史保留，旧验收和评审证据失效。仍需手动确认未通过候选，不自动写 PRD。' : confirmAction === 'accept' ? (run.writePrd ? '确认后会依据所选 MVP 的真实结果撰写 PRD，并进入 G5 等待确认。若终审缺失或拒绝，必须在验收说明中记录理由。' : '确认后运行结束，所选候选会写入最终决策记录。') : confirmAction === 'retry_job' ? '这是由 Sol 执行的手动失败重试，不使用评审缺陷作为返工指令，并继续消耗当前作业预算。' : confirmAction === 'rework_job' ? '只有程序核对过的实现缺陷会写入返工指令；该轮会继续消耗当前作业共同预算。' : confirmAction === 'light_rework_job' ? '这是一项独立动作，不会替换普通 Sol 重试。前端只做初步检查；提交后服务端会重新确认当前 minor 实现缺陷只涉及不超过 5 个安全文件，并检查能力漂移及完整调用和主动时间预算，再冻结 Grok 写者、Astra 独立评审及已启用的 Claude 终审预算。Grok 在 WSL 中只改允许文件，验收命令仅由 Windows Astra 独立副本执行。' : confirmAction === 'rework_with_final_review' ? 'Claude 终审意见是只读评审建议，不是程序复现证据。确认后会将当前有效终审的具体意见作为下一轮写者说明。' : confirmAction === 'retry_evaluation' ? '只重试当前最新轮的 Astra 独立评审，不清零轮次和历史用量。' : confirmAction === 'retry_final_review' ? '只重试 Claude 只读终审，不将 Claude 变成写者。' : confirmAction === 'ignore_preflight' ? '此操作会记录忽略理由，并立即开始 Sol 调用。理由会保留在作业记录中。' : confirmAction === 'validate_more' ? '当前批次和预算历史保留在记录中，新批次将在 G2 重新冻结预算。' : '运行将结束，现有验证证据仍会保存在决策记录中。'}{submitError ? <div role="alert" className="alert bad">{submitError}</div> : null}</p>{confirmAction === 'ignore_preflight' ? <Field label="忽略理由（必填）"><textarea ref={preflightField} value={preflightReason} onChange={(event) => setPreflightReason(event.target.value)} placeholder="说明为什么确认可以在当前环境继续构建" /></Field> : null}<div className="btnbar end"><button ref={confirmBack} onClick={() => setConfirmAction(null)}>返回</button><button className={confirmAction === 'stop' ? 'danger' : 'primary'} disabled={confirmAction === 'ignore_preflight' ? ignorePreflightDisabled(preflightReason, busy) : busy} onClick={() => void submit()}>确认</button></div></Modal> : null}
  </div>;
}
