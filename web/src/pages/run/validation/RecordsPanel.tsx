import { useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, SectionTitle } from '../../../components/ui';
import { ReferenceDocumentList } from '../../../components/ReferenceDocumentList';
import { api } from '../../../lib/api';
import { duration, formatDate, phaseLabels, roleLabel, statusLabel } from '../../../lib/labels';
import type { RequirementSnapshot, RunMetrics, RunPanelProps } from '../../../lib/types';
import './records.css';

const evidenceLabels: Record<string, string> = { doc: '文档', user_input: '用户输入', reasoning: '推理', experience: '经验', prototype: '原型验证' };
const gateTitles: Record<string, string> = { G1_answers: 'G1 确认回答', G2_framework: 'G2 确认框架与 MVP 范围', G3_docs: 'G3 确认构建前文档', G4_final: 'G4 验收 MVP', G3_final: 'G4 验收 MVP', G5_prd: 'G5 确认 PRD' };
const metricStatusLabels: Record<string, string> = { succeeded: '成功', failed: '失败', cancelled: '取消', interrupted: '中断', running: '进行中', unknown: '未知' };
const metricKindLabels: Record<string, string> = { initial: '初次调用', repair: '结构修复', unknown: '调用类型未知' };
const firstRoundLabels: Record<string, string> = { passed: '通过', failed: '失败', inconclusive: '证据不足', awaiting_manual: '等待人工验收', mixed: '结果不一致' };

function minutes(value: number) { return `${value.toFixed(value >= 10 ? 1 : 2)} 分钟`; }
function durationMetric(metric: RunMetrics['modelTime']['total']) {
  if (metric.knownCount === 0 && metric.unknownCount > 0) return `未知（${metric.unknownCount} 项缺少时间）`;
  if (metric.knownCount === 0) return '无记录';
  return `${minutes(metric.minutes)}${metric.unknownCount ? `，另 ${metric.unknownCount} 项未知` : ''}`;
}

export function MetricsView({ metrics }: { metrics: RunMetrics }) {
  const firstRound = metrics.firstRoundVerification;
  return <div className="metrics-view">
    <p className="muted metrics-asof">统计截至 {formatDate(metrics.asOf)}；进行中的任务和关卡按此时间点计算。</p>
    <div className="metrics-summary">
      <dl><dt>总模型分钟</dt><dd>{durationMetric(metrics.modelTime.total)}</dd></dl>
      <dl><dt>墙钟时间</dt><dd>{metrics.wallClockMinutes === null ? '未知' : minutes(metrics.wallClockMinutes)}</dd></dl>
      <dl><dt>关卡等待</dt><dd>{durationMetric(metrics.gateWait.total)}</dd></dl>
      <dl><dt>澄清问题</dt><dd>{metrics.clarification.questionCount} 题 · {metrics.clarification.answerRate === null ? '作答率不适用' : `作答率 ${(metrics.clarification.answerRate * 100).toFixed(0)}%`}</dd></dl>
      <dl><dt>构建尝试</dt><dd>{metrics.buildAttempts} 次</dd></dl>
      <dl><dt>配额阻塞</dt><dd>{metrics.quotaBlocks} 次</dd></dl>
    </div>
    <div className="table-scroll metrics-table"><table><thead><tr><th>阶段 / 调用</th><th>角色</th><th>状态</th><th>模型分钟</th></tr></thead><tbody>{metrics.modelTime.buckets.map((bucket) => <tr key={`${bucket.phase}-${bucket.role}-${bucket.kind}-${bucket.status}`}><td>{phaseLabels[bucket.phase] ?? bucket.phase}<small>{metricKindLabels[bucket.kind] ?? bucket.kind}</small></td><td>{roleLabel[bucket.role]}</td><td>{metricStatusLabels[bucket.status] ?? bucket.status}</td><td>{durationMetric(bucket)}</td></tr>)}</tbody></table>{metrics.modelTime.buckets.length ? null : <p className="muted metrics-empty">没有可分组的阶段、角色和状态记录；总模型时间可能仍因旧任务时间缺失而未知。</p>}</div>
    <div className="metrics-detail">
      <div><b>首轮核验</b>{firstRound ? <><p>{firstRoundLabels[firstRound.conclusion] ?? firstRound.conclusion}</p><ul>{firstRound.jobs.map((job) => <li key={job.jobId}><code>{job.jobId}</code> · {firstRoundLabels[job.verdict] ?? job.verdict}</li>)}</ul></> : <p className="muted">首轮核验数据未知；旧记录没有可核对的轮次结构。</p>}</div>
      <div><b>构建与评审轮次</b>{metrics.buildRounds === null ? <p className="muted">轮次数据尚未记录，不能从构建尝试数反推。</p> : <p>{metrics.buildRounds} 轮</p>}{metrics.reviewSequence === null ? <small className="muted">评审顺序未知。</small> : metrics.reviewSequence.length ? <ol>{metrics.reviewSequence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol> : <small className="muted">没有评审记录。</small>}</div>
    </div>
  </div>;
}

type Diff<T> =
  | { kind: 'added'; current: T }
  | { kind: 'modified'; before: T; current: T }
  | { kind: 'removed'; before: T };

function diffById<T extends { id: string }>(current: T[], previous: T[] | undefined): Diff<T>[] {
  const before = new Map((previous ?? []).map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  const changes: Diff<T>[] = [];
  for (const item of current) {
    const old = before.get(item.id);
    if (!old) changes.push({ kind: 'added', current: item });
    else if (JSON.stringify(old) !== JSON.stringify(item)) changes.push({ kind: 'modified', before: old, current: item });
  }
  for (const item of previous ?? []) if (!after.has(item.id)) changes.push({ kind: 'removed', before: item });
  return changes;
}

function DiffList<T extends { id: string }>({ label, tone, changes, describe }: { label: string; tone?: string; changes: Diff<T>[]; describe: (item: T) => string }) {
  return <>{changes.map((change) => {
    const item = change.kind === 'removed' ? change.before : change.current;
    return <li key={`${label}-${item.id}-${change.kind}`}><Badge tone={tone}>{label} {item.id}</Badge>{change.kind === 'added' ? <><b>新增</b> {describe(change.current)}</> : change.kind === 'removed' ? <><b>删除</b> {describe(change.before)}</> : <><b>修改</b><span>{describe(change.before)} <strong>→</strong> {describe(change.current)}</span></>}</li>;
  })}</>;
}

function SnapshotDiff({ snapshot, previous }: { snapshot: RequirementSnapshot; previous?: RequirementSnapshot }) {
  const facts = diffById(snapshot.facts, previous?.facts);
  const assumptions = diffById(snapshot.assumptions, previous?.assumptions);
  const openItems = diffById(snapshot.openItems, previous?.openItems);
  const constraints = diffById(snapshot.constraints, previous?.constraints);
  const describeStatement = (item: RequirementSnapshot['facts'][number]) => `${item.text}（来源：${item.source}）`;
  const describeConstraint = (item: RequirementSnapshot['constraints'][number]) => `${item.kind === 'must' ? '必须' : '禁止'}：${item.text}`;
  const referencesChanged = JSON.stringify([snapshot.project.referenceDocuments ?? [], snapshot.project.referenceArchives ?? []]) !== JSON.stringify([previous?.project.referenceDocuments ?? [], previous?.project.referenceArchives ?? []]);
  const changeCount = facts.length + assumptions.length + openItems.length + constraints.length + Number(referencesChanged);
  return <details className="snapshot-card" open={!previous}><summary><span><b>v{snapshot.version}</b> · {snapshot.reason}</span><code>{snapshot.ref}</code></summary><div>
    <div className="snapshot-meta"><span>{formatDate(snapshot.createdAt)}</span><span>事实 {snapshot.facts.length}</span><span>假设 {snapshot.assumptions.length}</span><span>约束 {snapshot.constraints.length}</span><span>待确认 {snapshot.openItems.length}</span></div>
    {previous ? <div className="snapshot-diff"><b>相对 v{previous.version} 的变化（{changeCount} 项）</b>{!changeCount ? <p className="muted">结构化条目没有变化。</p> : <ul><DiffList label="约束" tone="bad" changes={constraints} describe={describeConstraint} /><DiffList label="事实" tone="ok" changes={facts} describe={describeStatement} /><DiffList label="假设" tone="warn" changes={assumptions} describe={describeStatement} /><DiffList label="待确认" changes={openItems} describe={describeStatement} />{referencesChanged && <li>参考资料已更新：当前 {snapshot.project.referenceDocuments?.length ?? 0} 份文档、{snapshot.project.referenceArchives?.length ?? 0} 个 ZIP。</li>}</ul>}</div> : <p>{snapshot.project.prompt}</p>}
    <ReferenceDocumentList documents={snapshot.project.referenceDocuments} archives={snapshot.project.referenceArchives} />
  </div></details>;
}

export default function RecordsPanel({ run }: RunPanelProps) {
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [metricsError, setMetricsError] = useState('');
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsRetry, setMetricsRetry] = useState(0);
  const snapshots = [...run.snapshots].sort((a, b) => a.version - b.version);
  const adjudications = run.adjudications ?? [];
  const proposalById = useMemo(() => new Map(run.proposals.map((proposal) => [proposal.id, proposal])), [run.proposals]);
  const resolvedGates = run.gates.filter((gate) => gate.resolvedAt);
  useEffect(() => {
    const controller = new AbortController();
    setMetricsLoading(true); setMetricsError('');
    api.get<RunMetrics>(`/api/runs/${encodeURIComponent(run.id)}/metrics`, controller.signal)
      .then((value) => { setMetrics(value); setMetricsLoading(false); })
      .catch((cause) => { if (!controller.signal.aborted) { setMetrics(null); setMetricsError(cause instanceof Error ? cause.message : '读取运行度量失败'); setMetricsLoading(false); } });
    return () => controller.abort();
  }, [run.id, run.updatedAt, metricsRetry]);
  const metricsPanel = <section className="panel">
    <SectionTitle title="运行度量" eyebrow="程序时间戳与冻结记录"><Badge>{metricsLoading ? '读取中' : metricsError ? '读取失败' : '已更新'}</Badge></SectionTitle>
    {metricsLoading ? <p className="muted" role="status">正在读取运行度量…</p> : metricsError ? <div className="alert bad" role="alert"><b>运行度量读取失败</b><p>{metricsError}</p><button type="button" onClick={() => setMetricsRetry((value) => value + 1)}>重试</button></div> : metrics ? <MetricsView metrics={metrics} /> : <p className="muted">运行度量未知。</p>}
  </section>;
  const sessions = run.jobs.flatMap(job => job.rounds?.flatMap(round => round.context?.sessions ?? []) ?? []);
  const knownContext = sessions.filter(session => session.context.usageSemantics === 'per_turn_context' && session.context.contextTokensPeak !== null);
  const contextPanel = <section className="panel"><SectionTitle title="上下文健康" eyebrow="实际观测与估算分开"><Badge tone={sessions.length && knownContext.length === sessions.length ? 'ok' : 'warn'}>{!sessions.length ? 'unknown' : `${knownContext.length} / ${sessions.length} 已知`}</Badge></SectionTitle>{!sessions.length ? <p className="muted">unknown：旧记录或未启用上下文会话；缺失字段不按 0 计算。</p> : <ul>{sessions.map(session => <li key={session.id}><code>{session.id}</code> · {session.context.usageSemantics === 'per_turn_context' && session.context.contextTokensPeak !== null ? `实际峰值 ${session.context.contextTokensPeak.toLocaleString()} tokens` : '实际上下文 unknown'}{session.material ? ` · 材料估算 ${session.material.estimatedTokens.toLocaleString()} tokens` : ''}</li>)}</ul>}</section>;
  if (!run.snapshots.length && !run.tasks.length) return <div className="records-stack"><section className="panel"><EmptyState title="记录尚未形成"><p>工作台会在流程推进时保存需求快照、任务元数据和关卡决定。</p></EmptyState></section>{metricsPanel}</div>;
  return <div className="records-stack">
    <section className="panel">
      <SectionTitle title="需求快照与差异" eyebrow="可追溯输入"><Badge>{snapshots.length} 个版本</Badge></SectionTitle>
      <div className="snapshot-list">{snapshots.map((snapshot, index) => <SnapshotDiff key={snapshot.ref} snapshot={snapshot} previous={snapshots[index - 1]}/>)}</div>
    </section>
    <section className="panel">
      <SectionTitle title="任务与执行元数据" eyebrow="请求型号与执行端报告"><Badge>{run.tasks.length} 个任务</Badge></SectionTitle>
      <div className="table-scroll"><table><thead><tr><th>任务</th><th>角色 / 阶段</th><th>请求</th><th>执行端报告</th><th>确认状态</th><th>输入版本</th><th>结果</th><th>用时</th></tr></thead><tbody>{run.tasks.map((task) => { const configured = run.models[task.role]; return <tr key={task.id}><td><code>{task.id}</code>{task.simulated ? <Badge tone="mock">模拟</Badge> : null}</td><td>{roleLabel[task.role]}<small>{phaseLabels[task.phase] ?? task.phase}</small></td><td><code>{task.meta?.requestedModel ?? configured?.model ?? '未记录'}</code><small>{task.meta?.requestedEffort ?? configured?.effort ?? '未记录'}</small></td><td><code>{task.meta?.reportedModels.join(', ') || '未报告'}</code><small>{task.meta?.reportedModelSource ?? '—'}</small></td><td><Badge tone={task.meta?.modelConfirmed ? 'ok' : 'warn'}>{task.meta?.modelConfirmed ? '型号已确认' : '型号未确认'}</Badge><small>{task.meta?.effortConfirmed ? '强度已确认' : '强度未确认'}</small></td><td><code>{task.inputRef ?? '—'}</code></td><td>{statusLabel(task.status)}<small>{statusLabel(task.outputValidity)}</small>{task.acceptedDespiteMismatch ? <Badge tone="warn">已接受型号不符</Badge> : null}</td><td>{task.meta ? duration(task.meta.durationMs) : '—'}</td></tr>; })}</tbody></table></div>
    </section>
    {metricsPanel}
    {contextPanel}
    <section className="panel">
      <SectionTitle title="复核日志" eyebrow="分歧如何变化"><Badge>{run.recheckLog.length} 条</Badge></SectionTitle>
      {run.recheckLog.length ? <div className="table-scroll"><table><thead><tr><th>批次</th><th>复核方</th><th>条目</th><th>候选</th><th>复核前</th><th>复核后</th><th>变化</th><th>理由</th></tr></thead><tbody>{run.recheckLog.map((entry, index) => <tr key={`${entry.batch}-${entry.judge}-${entry.itemId}-${index}`}><td>{entry.batch}</td><td><Badge tone={entry.judge}>{roleLabel[entry.judge]}</Badge></td><td>{entry.itemId}</td><td>{entry.candidateId}</td><td>{String(entry.before ?? '未知')}</td><td>{String(entry.after ?? '未知')}</td><td><Badge tone={entry.changed ? 'info' : ''}>{entry.changed ? '已调整' : '维持原判'}</Badge></td><td>{entry.rationale}</td></tr>)}</tbody></table></div> : <p className="muted">本轮没有执行双方独立复核。</p>}
      <div className="alert info records-d8"><b>D8 说明：</b>双方复核与 Astra Ultra 裁决分开记录。Ultra 的“已解决”只表示已形成建议，不表示原型已验证通过。</div>
    </section>
    <section className="panel">
      <SectionTitle title="Astra Ultra 裁决记录" eyebrow="建议、依据与过期状态"><Badge>{adjudications.length} 个批次</Badge></SectionTitle>
      {adjudications.length ? <div className="adjudication-history">{adjudications.map((record) => <details key={`${record.designRound}-${record.batch}-${record.requestedAt}`} open={record === adjudications.at(-1)} className={record.staleReason ? 'stale' : ''}><summary><span>设计第 {record.designRound} 轮 · 裁决第 {record.batch} 批</span><span>{record.report?.recommendation.candidateId ? `建议 ${record.report.recommendation.candidateId}` : record.report ? '建议待定' : '未完成'}{record.staleReason ? ' · 已过期' : ''}</span></summary><div>
        <dl className="adjudication-record-meta"><dt>需求快照</dt><dd><code>{record.snapshotRef}</code></dd><dt>决策时点</dt><dd>{formatDate(record.decisionComputedAt)}</dd><dt>裁决任务</dt><dd><code>{record.taskId ?? '尚未创建'}</code></dd><dt>候选</dt><dd>{record.candidateIds.join('、') || '无'}</dd></dl>
        {record.staleReason ? <div className="alert bad"><b>建议已过期，不可作为当前建议。</b><br />{record.staleReason}</div> : null}
        {record.report ? <><div className="record-recommendation"><b>{record.report.recommendation.candidateId ? `建议 ${record.report.recommendation.candidateId}` : '待定 · 暂不推荐候选'}</b><p>{record.report.recommendation.rationale}</p></div><div className="record-adjudication-items">{record.report.items.map((item) => <article key={item.itemId}><div><Badge tone={item.verdict === 'resolved' ? 'ok' : 'warn'}>{item.itemId} · {item.verdict === 'resolved' ? '已形成建议（未验证）' : '仍未决'}</Badge></div><p>{item.rationale}</p>{item.evidence.length ? <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.kind}-${evidence.ref ?? index}`}><b>{evidence.ref ?? evidenceLabels[evidence.kind] ?? '证据'}</b> <span>{evidenceLabels[evidence.kind] ?? '证据'}</span> · {evidence.summary}</li>)}</ul> : null}<small>后续验证：{item.verification ?? '未提供'}</small></article>)}</div></> : <p className="muted">裁决任务尚未产生报告。</p>}
      </div></details>)}</div> : <p className="muted">这个运行没有触发 Astra Ultra 裁决。旧运行可以继续查看，无需迁移。</p>}
    </section>
    <section className="panel">
      <SectionTitle title="关卡决定" eyebrow="由你确认的状态转换"><Badge>{resolvedGates.length} 个已提交</Badge></SectionTitle>
      {run.gates.length ? <div className="gate-timeline">{run.gates.map((gate) => <article key={`${gate.id}-${gate.openedAt}`}><div><Badge tone={gate.resolvedAt ? 'ok' : 'info'}>{gate.id}</Badge><b>{gateTitles[gate.id] ?? gate.id}</b></div><dl><dt>打开</dt><dd>{formatDate(gate.openedAt)}</dd><dt>提交</dt><dd>{gate.resolvedAt ? formatDate(gate.resolvedAt) : '等待确认'}</dd></dl>{gate.resolution ? <details><summary>查看原始决定</summary><pre>{JSON.stringify(gate.resolution, null, 2)}</pre></details> : null}</article>)}</div> : <p className="muted">还没有打开过关卡。</p>}
      {run.archivedRounds.length ? <details className="archived-rounds"><summary>历史设计轮次（{run.archivedRounds.length}）</summary><ul>{run.archivedRounds.map((round) => <li key={round.round}>第 {round.round} 轮 · 快照 v{round.snapshotVersion} · {round.candidates.map((candidate) => proposalById.get(candidate.representativeProposalId)?.title ?? candidate.id).join('、')}</li>)}</ul></details> : null}
    </section>
    <section className="panel export-panel"><div><div className="eyebrow">便于评审与归档</div><h2>导出完整决策记录</h2><p className="muted">Markdown 文件包含输入快照、候选、评分依据、关卡决定和验证结果。</p></div><a className="button primary" href={`/api/runs/${run.id}/export`} download={`decision-${run.id}.md`}>下载 Markdown 记录</a></section>
  </div>;
}
