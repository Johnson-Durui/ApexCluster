import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, EmptyState, Field, Icon, Modal, SectionTitle } from '../../../components/ui';
import { api } from '../../../lib/api';
import { outcomeLabels } from '../../../lib/labels';
import type { AdjudicationRecord, AppConfig, G2Input, Run, RunPanelProps, TaskRecord } from '../../../lib/types';
import { lightReworkG2BlockReason, nextAcceptanceId, validateBuildOverrides, validateG2Specs, type G2BuildOverride, type G2Spec } from './g2Validation';
import './decision.css';

type Defaults = { candidateId: string; spec: G2Spec; effort: { effort: 'max' | 'ultra'; reason: string } };
type ConfirmAction = 'redesign' | 'override' | 'stop' | null;

const basisLabels: Record<string, string> = { clear: '明确领先', preference: '按已确认偏好', tiebreak: '第二平局规则', only_viable: '唯一可行' };
const evidenceLabels: Record<string, string> = { doc: '文档', user_input: '用户输入', reasoning: '推理', experience: '经验', prototype: '原型验证' };
const lines = (value: string) => value.split(/\r?\n/);
const text = (value: string[]) => value.join('\n');

function adjudicationTask(run: Run, record: AdjudicationRecord): TaskRecord | undefined {
  const scope = `r${record.designRound}-adjudicate-${record.batch}`;
  return [...run.tasks].reverse().find((task) => task.phase === 'adjudicate' && task.scope === scope)
    ?? run.tasks.find((task) => task.id === record.taskId);
}

function adjudicationState(run: Run, record: AdjudicationRecord) {
  if (record.report) return { label: record.staleReason ? '已形成建议 · 已过期' : '已形成建议', detail: null, tone: record.staleReason ? 'bad' : 'ok' };
  const task = adjudicationTask(run, record);
  if (run.terminal === 'cancelled') return { label: '已取消', detail: '运行已取消，裁决未完成且没有合法结果。', tone: 'warn' };
  if (record.staleReason) return { label: '未完成 · 已过期', detail: '该批裁决在产生合法结果前已过期。', tone: 'bad' };
  if (task?.status === 'queued' || task?.status === 'running') return { label: '进行中', detail: '完成前不会生成候选建议。', tone: 'info' };
  if (task?.status === 'cancelled') return { label: '已取消', detail: '裁决任务已取消，没有合法结果。', tone: 'warn' };
  if (task && ['failed', 'timed_out', 'interrupted'].includes(task.status)) {
    return run.phase === 'adjudicate' && run.phaseStatus === 'blocked'
      ? { label: '已阻塞', detail: '裁决任务已阻塞，尚无合法结果。可从顶部重试失败的任务。', tone: 'bad' }
      : { label: '未完成', detail: '裁决任务未完成，没有合法结果。', tone: 'warn' };
  }
  if (task?.status === 'succeeded') return { label: '暂无合法结果', detail: '任务已结束，但没有可发布的合法裁决结果。', tone: 'bad' };
  if (run.phase === 'adjudicate' && run.phaseStatus === 'running') return { label: '准备中', detail: 'Astra Ultra 将读取双方方案、复核理由与现有证据。', tone: 'info' };
  return { label: '未完成', detail: '该批裁决没有合法结果。', tone: 'warn' };
}

export default function DecisionPanel({ run, busy, act }: RunPanelProps) {
  const [defaults, setDefaults] = useState<Defaults[]>([]);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [specs, setSpecs] = useState<G2Spec[]>([]);
  const [efforts, setEfforts] = useState<Record<string, 'max' | 'ultra'>>({});
  const [buildOverrides, setBuildOverrides] = useState<Record<string, G2BuildOverride>>({});
  const [recheckIds, setRecheckIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [architectReason, setArchitectReason] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [cursorWriteCapability, setCursorWriteCapability] = useState<AppConfig['cursorWriteCapabilities'] | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const initializedRound = useRef<number | null>(null);
  const confirmBack = useRef<HTMLButtonElement>(null);
  const overrideField = useRef<HTMLTextAreaElement>(null);
  const decision = run.decision;
  const adjudication = run.adjudications?.at(-1);
  const adjudicationStatus = adjudication ? adjudicationState(run, adjudication) : null;
  // open: the gate waits on you (drives the sticky bar, so a busy POST never makes it jump); canAct also needs !busy.
  const open = run.phase === 'framework_gate' && run.phaseStatus === 'waiting_user' && run.terminal === null;
  const canAct = run.phase === 'framework_gate' && run.phaseStatus === 'waiting_user' && !busy;

  useEffect(() => {
    if (run.phase !== 'framework_gate') return;
    setDefaultsLoaded(false);
    const controller = new AbortController();
    api.get<Defaults[]>(`/api/runs/${run.id}/g2-defaults`, controller.signal).then((items) => {
      const eligible = items.filter((item) => decision?.totals.find((total) => total.candidateId === item.candidateId)?.status !== 'eliminated');
      const eligibleIds = new Set(eligible.map((item) => item.candidateId));
      const reset = initializedRound.current !== run.designRound;
      setDefaults(eligible);
      const suggested = decision?.suggestedValidation.candidateIds.filter((id) => eligible.some((item) => item.candidateId === id)).slice(0, 3) ?? [];
      const suggestedSelection = suggested.length ? suggested : eligible.slice(0, 1).map((item) => item.candidateId);
      if (reset) {
        setSpecs(eligible.map((item) => item.spec));
        setEfforts({});
        setBuildOverrides({});
        setSelected(suggestedSelection);
        setRecheckIds(decision?.keyUncertainties.filter((item) => item.isKey && item.kind !== 'assumption').map((item) => item.id) ?? []);
      } else {
        setSpecs((current) => eligible.map((item) => current.find((spec) => spec.candidateId === item.candidateId) ?? item.spec));
        setEfforts((current) => Object.fromEntries(Object.entries(current).filter(([candidateId]) => eligibleIds.has(candidateId))));
        setBuildOverrides((current) => Object.fromEntries(Object.entries(current).filter(([candidateId]) => eligibleIds.has(candidateId))));
        setSelected((current) => {
          const retained = current.filter((candidateId) => eligibleIds.has(candidateId)).slice(0, 3);
          return retained.length ? retained : suggestedSelection;
        });
        const validRecheckIds = new Set(decision?.keyUncertainties.filter((item) => item.kind !== 'assumption').map((item) => item.id) ?? []);
        setRecheckIds((current) => current.filter((id) => validRecheckIds.has(id)));
      }
      initializedRound.current = run.designRound;
      setLoadError('');
      setDefaultsLoaded(true);
    }).catch((error: Error) => { if (error.name !== 'AbortError') { setLoadError(error.message); setDefaultsLoaded(true); } });
    return () => controller.abort();
  }, [run.id, run.phase, decision?.computedAt]);

  useEffect(() => {
    if (run.phase !== 'framework_gate' || run.mode === 'mock') return;
    const controller = new AbortController();
    api.get<AppConfig>('/api/config', controller.signal)
      .then((config) => setCursorWriteCapability(config.cursorWriteCapabilities ?? { available: false, reason: '服务端未返回 Cursor WSL 写入能力' }))
      .catch((error: Error) => { if (error.name !== 'AbortError') setCursorWriteCapability({ available: false, reason: `能力状态读取失败：${error.message}` }); });
    return () => controller.abort();
  }, [run.id, run.phase, run.mode]);

  const proposals = useMemo(() => new Map(run.proposals.map((proposal) => [proposal.id, proposal])), [run.proposals]);
  const candidateName = (candidateId: string) => {
    const candidate = run.candidates.find((item) => item.id === candidateId);
    return `${candidateId} · ${proposals.get(candidate?.representativeProposalId ?? '')?.title ?? '候选方案'}`;
  };
  const adjudicationCandidateName = (record: AdjudicationRecord, candidateId: string) => {
    if (record.designRound === run.designRound && !record.staleReason) return candidateName(candidateId);
    const archived = run.archivedRounds.find((round) => round.round === record.designRound);
    const candidate = archived?.candidates.find((item) => item.id === candidateId);
    const title = proposals.get(candidate?.representativeProposalId ?? '')?.title;
    // 同轮手动合并也会重排 C 编号；过期记录缺少原候选映射时，不借用当前标题。
    return title ? `${candidateId} · ${title}（设计第 ${record.designRound} 轮）` : `${candidateId} · 裁决时的候选（设计第 ${record.designRound} 轮）`;
  };
  const updateSpec = (candidateId: string, update: Partial<G2Spec>) => setSpecs((current) => current.map((spec) => spec.candidateId === candidateId ? { ...spec, ...update } : spec));
  const updateBuild = (candidateId: string, update: Partial<G2BuildOverride>) => setBuildOverrides((current) => ({ ...current, [candidateId]: { ...(current[candidateId] ?? {}), ...update } }));
  const toggleCandidate = (candidateId: string) => setSelected((current) => current.includes(candidateId) ? current.filter((id) => id !== candidateId) : current.length < 3 ? [...current, candidateId] : current);
  const selectedSpecs = selected.map((id) => specs.find((spec) => spec.candidateId === id)).filter((spec): spec is G2Spec => Boolean(spec));
  const lightReworkContext = {
    configuredEnabled: run.build?.lightReworkEnabled === true && Number.isInteger(run.build.lightReworkMinutes),
    exactModel: run.models.grok?.model === 'grok-4.7-high-fast' && run.models.grok.effort === 'high',
    evaluatorEnabled: run.evaluator?.enabled === true,
    contextBudgetEnabled: run.contextBudget?.enabled === true,
    capabilityAvailable: run.mode === 'mock' || cursorWriteCapability?.available === true,
    capabilityReason: run.mode === 'mock' ? undefined : cursorWriteCapability?.reason ?? '正在读取 Cursor WSL 写入能力',
  };
  const lightReworkBlocked = lightReworkG2BlockReason(lightReworkContext);

  const submitValidate = async () => {
    if (!decision) return;
    const eliminated = selected.filter((id) => decision.totals.find((total) => total.candidateId === id)?.status === 'eliminated');
    const errors = [...validateG2Specs(selected, selectedSpecs), ...validateBuildOverrides(selected, buildOverrides, lightReworkContext), ...eliminated.map((id) => `候选 ${id} 已被淘汰，不能进入验证`)];
    setFormErrors(errors);
    if (errors.length) return;
    const normalizedSpecs = selectedSpecs.map((spec) => ({ ...spec, scopeIn: spec.scopeIn.map((item) => item.trim()).filter(Boolean), scopeOut: spec.scopeOut.map((item) => item.trim()).filter(Boolean), acceptance: spec.acceptance.map((item) => ({ ...item, id: item.id.trim() })) }));
    const effortOverrides: G2Input['efforts'] = {};
    for (const id of selected) if (efforts[id]) effortOverrides[id] = efforts[id];
    const supportsLightRework = Boolean(run.build && Object.prototype.hasOwnProperty.call(run.build, 'lightReworkEnabled') && Object.prototype.hasOwnProperty.call(run.build, 'lightReworkMinutes'));
    const selectedOverrides = Object.fromEntries(selected.filter((id) => buildOverrides[id]).map((id) => {
      const value = { ...buildOverrides[id] };
      if (!supportsLightRework) { delete value.lightReworkEnabled; delete value.lightReworkMinutes; }
      return [id, value];
    }));
    const body: G2Input = { gate: 'G2_framework', action: 'validate', candidateIds: selected, specs: normalizedSpecs, efforts: effortOverrides, buildOverrides: selectedOverrides, recheckItemIds: [], reason: reason.trim() || null };
    await act('/gates', body);
  };
  const submitRecheck = () => act('/gates', { gate: 'G2_framework', action: 'recheck', candidateIds: [], specs: [], efforts: {}, recheckItemIds: recheckIds, reason: reason.trim() || null } satisfies G2Input);
  const submitConfirmed = async () => {
    if (!confirmAction) return;
    if (confirmAction === 'override' && !architectReason.trim()) return;
    const action = confirmAction === 'override' ? 'redesign' : confirmAction;
    await act('/gates', { gate: 'G2_framework', action, architectOverride: confirmAction === 'override' ? { from: 'claude', to: 'astra', reason: architectReason.trim() } : undefined, candidateIds: [], specs: [], efforts: {}, recheckItemIds: [], reason: reason.trim() || null } satisfies G2Input);
    setConfirmAction(null);
  };
  const escalateDual = () => act('/gates', { gate: 'G2_framework', action: 'escalate_dual', candidateIds: [], specs: [], efforts: {}, recheckItemIds: [], reason: reason.trim() || null } satisfies G2Input);

  if (!decision) return <section className="panel"><EmptyState title="决策报告尚未生成"><p>完成双方评审后，这里会展示结论、关键分歧和 G2 操作。</p></EmptyState></section>;
  return <div className="decision-stack">
    <div className={adjudication || run.phase === 'adjudicate' ? 'decision-top split-view' : 'decision-top'}>
    <div className="decision-col">
    <section className="panel decision-hero">
      <SectionTitle title={outcomeLabels[decision.outcome] ?? decision.outcome} eyebrow="当前结论"><Badge tone={decision.conditional ? 'warn' : 'ok'}>{decision.conditional ? '附带未决约束' : '基于现有证据'}</Badge></SectionTitle>
      {run.designResolution ? <div className="alert info"><b>{run.designResolution.mode === 'dual' ? '双架构师设计' : '单架构师设计'}</b><p>{run.designResolution.reasons.join('；')}</p>{run.designResolution.architectOverride ? <small>Astra 本轮为显式覆盖的非主导者方案：{run.designResolution.architectOverride.reason}</small> : null}</div> : <div className="help-note">旧运行未记录设计模式；不据此推断为降级。</div>}
      {run.designResolution?.mode === 'dual' && decision.judges.length < 2 ? <div className="alert bad"><b>双架构师流程执行不完整</b><p>当前只有 {decision.judges.length} 位合法评审；这是执行缺失，不等同于显式 single 模式。</p></div> : null}
      <div className="decision-lead"><div className="decision-mark" aria-hidden="true"><Icon name="flag" size={22} /></div><div><strong>{decision.winnerId ? candidateName(decision.winnerId) : '当前没有可直接确认的单一候选'}</strong><span>依据：{decision.basis ? basisLabels[decision.basis] : '需补充证据'} · {decision.judges.length} 位评审结果</span></div></div>
      <div className="decision-explanation" aria-label="决策解释">{decision.explanation.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      <div className="alert info d8-note"><b>D8 流程：</b>复核所选分歧会先让 Claude 与 Astra 独立重判；若仍有会影响结论的关键评分格或约束，且没有被推翻的假设，将最多追加一次 Astra Ultra 裁决，然后回到 G2。裁决只提供建议，不改写当前规则分数，不代表已验证。</div>
    </section>

    <section className="panel">
      <SectionTitle title="关键不确定项" eyebrow="按影响排序"><Badge>{decision.keyUncertainties.length} 项</Badge></SectionTitle>
      {decision.keyUncertainties.length ? <div className="uncertainty-list">{decision.keyUncertainties.map((item) => <label key={item.id} className={`uncertainty-item ${item.isKey ? 'key' : ''}`}>
        <input type="checkbox" disabled={item.kind === 'assumption'} checked={recheckIds.includes(item.id)} onChange={() => setRecheckIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}/>
        <Badge tone={item.isKey ? 'bad' : 'warn'}>{item.id}</Badge><span><b>{candidateName(item.candidateId)}</b><small>{item.description}</small></span><span className="impact">{item.kind === 'assumption' ? '需重新设计' : item.isKey ? '关键' : `影响 ${Number.isFinite(item.impact) ? item.impact.toFixed(2) : '高'}`}</span>
      </label>)}</div> : <p className="muted">没有会改变当前结论的未决项。</p>}
      <p className="help-note">被推翻的假设不能通过复核修正，需要选择“重新设计”并生成新快照。复核后若仍有关键评分格或约束，工作台最多追加一次 Astra Ultra 裁决。</p>
    </section>
    </div>

    {run.phase === 'adjudicate' || adjudication ? <section className="panel adjudication-panel">
      <SectionTitle title="Astra Ultra 裁决建议" eyebrow="复核后的关键分歧">{run.mode === 'mock' ? <Badge tone="mock">模拟数据</Badge> : <Badge tone="astra">Ultra</Badge>}</SectionTitle>
      {!adjudication ? <div className="adjudication-pending" role="status"><b>正在准备裁决记录</b><p>Astra Ultra 将读取双方方案、复核理由与现有证据。完成后你仍在 G2 作最终确认。</p></div> : <>
        <div className="adjudication-meta"><span>第 {adjudication.batch} 批</span><span>设计第 {adjudication.designRound} 轮</span><code>{adjudication.snapshotRef}</code>{adjudicationStatus ? <Badge tone={adjudicationStatus.tone}>{adjudicationStatus.label}</Badge> : null}</div>
        {adjudication.staleReason ? <div className="alert bad" role="alert"><b>建议已过期，不可作为当前建议。</b><br />{adjudication.staleReason}</div> : null}
        {adjudication.report ? <>
          <div className="adjudication-recommendation"><div><span>裁决建议</span><strong>{adjudication.report.recommendation.candidateId ? adjudicationCandidateName(adjudication, adjudication.report.recommendation.candidateId) : '待定 · 暂不推荐候选'}</strong></div><p>{adjudication.report.recommendation.rationale}</p></div>
          <p className="help-note">这项建议不会自动勾选候选、不改动上方分数，也不会启动 Sol。</p>
          <div className="adjudication-items">{adjudication.report.items.map((item) => <article key={item.itemId}><div><Badge tone={item.verdict === 'resolved' ? 'info' : 'warn'}>{item.itemId}</Badge><Badge tone={item.verdict === 'resolved' ? 'ok' : 'warn'}>{item.verdict === 'resolved' ? '已形成裁决建议 · 未验证' : '仍未决'}</Badge></div><p>{item.rationale}</p>{item.evidence.length ? <ul className="evidence-list">{item.evidence.map((evidence, index) => <li key={`${evidence.kind}-${evidence.ref ?? index}`}><b>{evidenceLabels[evidence.kind] ?? '证据'}</b><small>{evidence.ref ?? '无单独引用'}</small><span>{evidence.summary}</span></li>)}</ul> : <p className="muted">没有附加证据。</p>}<div className="verification-next"><b>后续验证</b><span>{item.verification ?? '尚无可执行的验证方案'}</span></div></article>)}</div>
          {adjudication.report.risks.length ? <div className="adjudication-followup"><b>保留风险</b><ul>{adjudication.report.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></div> : null}
          {adjudication.report.questions.length ? <div className="adjudication-followup"><b>裁决新增问题</b><ul>{adjudication.report.questions.map((question) => <li key={question.localId}>{question.text}<small>{question.whyItMatters}</small></li>)}</ul></div> : null}
        </> : <div className={`adjudication-pending ${adjudicationStatus?.tone ?? ''}`} role="status"><b>Astra Ultra 裁决{adjudicationStatus?.label ?? '未完成'}</b><p>{adjudicationStatus?.detail ?? '尚无合法结果。'}</p></div>}
      </>}
    </section> : null}
    </div>


    <section className={`gate-section gate-wrap${open ? '' : ' is-readonly'}`} aria-label="G2 确认框架与 MVP 范围"><div className="decision-card"><div className="decision-in">
      <SectionTitle title="确认框架与 MVP 范围" eyebrow="G2 · 由你决定"><Badge tone={canAct ? 'info' : ''}>{canAct ? '等待确认' : '当前只读'}</Badge></SectionTitle>
      {loadError ? <div className="alert bad">预填规格读取失败：{loadError}</div> : null}
      <div className="candidate-picker" aria-label="选择验证候选">{run.candidates.map((candidate) => {
        const total = decision.totals.find((item) => item.candidateId === candidate.id);
        const disabled = total?.status === 'eliminated';
        return <label key={candidate.id} className={selected.includes(candidate.id) ? 'selected' : ''}><input type="checkbox" checked={selected.includes(candidate.id)} disabled={!canAct || disabled || (!selected.includes(candidate.id) && selected.length >= 3)} onChange={() => toggleCandidate(candidate.id)}/><span><b>{candidateName(candidate.id)}</b><small>{disabled ? '违反硬约束，不能进入验证' : `${total?.lo.toFixed(2) ?? '—'}–${total?.hi.toFixed(2) ?? '—'} 分`}</small></span></label>;
      })}</div>
      {selectedSpecs.map((spec) => {
        const defaultItem = defaults.find((item) => item.candidateId === spec.candidateId);
        return <details className="spec-editor" key={spec.candidateId} open><summary>{candidateName(spec.candidateId)} · MVP 规格</summary><div className="spec-body">
          <Field label="目标"><textarea value={spec.goal} onChange={(event) => updateSpec(spec.candidateId, { goal: event.target.value })}/></Field>
          <div className="form-grid"><Field label="范围内" hint="每行一项"><textarea value={text(spec.scopeIn)} onChange={(event) => updateSpec(spec.candidateId, { scopeIn: lines(event.target.value) })}/></Field><Field label="范围外" hint="每行一项"><textarea value={text(spec.scopeOut)} onChange={(event) => updateSpec(spec.candidateId, { scopeOut: lines(event.target.value) })}/></Field></div>
          <div className="field"><span>验收项</span><div className="acceptance-list">{spec.acceptance.map((criterion, index) => <div className="acceptance-row" key={index}>
            <input aria-label="验收项编号" value={criterion.id} onChange={(event) => updateSpec(spec.candidateId, { acceptance: spec.acceptance.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })}/>
            <select aria-label="验收类型" value={criterion.kind} onChange={(event) => updateSpec(spec.candidateId, { acceptance: spec.acceptance.map((item, i) => i === index ? { ...item, kind: event.target.value as 'command' | 'manual', command: event.target.value === 'manual' ? null : item.command } : item) })}><option value="command">命令核验</option><option value="manual">人工确认</option></select>
            <input aria-label="验收说明" value={criterion.description} placeholder="验收说明" onChange={(event) => updateSpec(spec.candidateId, { acceptance: spec.acceptance.map((item, i) => i === index ? { ...item, description: event.target.value } : item) })}/>
            {criterion.kind === 'command' ? <input className="mono" aria-label="PowerShell 命令" value={criterion.command ?? ''} placeholder="例如 npm test" onChange={(event) => updateSpec(spec.candidateId, { acceptance: spec.acceptance.map((item, i) => i === index ? { ...item, command: event.target.value } : item) })}/> : <span className="manual-hint">在 G3 由你确认</span>}
            <button className="danger" aria-label={`删除 ${criterion.id}`} onClick={() => updateSpec(spec.candidateId, { acceptance: spec.acceptance.filter((_, i) => i !== index) })}>删除</button>
          </div>)}</div><button onClick={() => updateSpec(spec.candidateId, { acceptance: [...spec.acceptance, { id: nextAcceptanceId(spec.acceptance), description: '', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null }] })}>＋ 添加验收项</button><small className="muted">命令型必须填写可在 Windows PowerShell 中执行的命令；人工型留到 G3 确认。</small></div>
          <div className="form-grid"><Field label="时间上限（分钟）"><input type="number" min={10} max={600} value={spec.timeboxMinutes} onChange={(event) => updateSpec(spec.candidateId, { timeboxMinutes: Number(event.target.value) })}/></Field><Field label="Sol 强度"><select value={efforts[spec.candidateId] ?? defaultItem?.effort.effort ?? 'max'} onChange={(event) => setEfforts((current) => { const next = { ...current }; const value = event.target.value as 'max' | 'ultra'; if (value === defaultItem?.effort.effort) delete next[spec.candidateId]; else next[spec.candidateId] = value; return next; })}><option value="max">Max</option><option value="ultra">Ultra</option></select><small className="muted">建议：{defaultItem?.effort.reason ?? '按工作流依赖关系选择'}</small></Field></div>
          {run.build ? <div className="build-budget-editor"><div className="build-budget-head"><b>返工与共同预算</b><small>在 G2 为该候选冻结；手动重试不会清零历史用量。</small></div><label className="check-label"><input type="checkbox" checked={buildOverrides[spec.candidateId]?.autoRework ?? run.build.autoRework} onChange={(event) => updateBuild(spec.candidateId, { autoRework: event.target.checked })}/>仅按已核验实现缺陷自动返工</label><label className="check-label"><input type="checkbox" checked={Boolean(buildOverrides[spec.candidateId]?.lightReworkEnabled)} disabled={lightReworkBlocked !== null} onChange={(event) => updateBuild(spec.candidateId, { lightReworkEnabled: event.target.checked, lightReworkMinutes: buildOverrides[spec.candidateId]?.lightReworkMinutes ?? run.build?.lightReworkMinutes ?? 5 })}/>本候选明确允许一次 Grok High 轻量返工</label><small className={lightReworkBlocked ? 'bad-text' : 'muted'}>{lightReworkBlocked ?? '仅接受当前 minor implementation_defect，且最多涉及 5 个不同安全文件；Astra 在 Windows 独立副本执行验收，提交时服务端会再次核验能力与完整预算。'}</small><div className="form-grid budget-fields">
            <Field label="构建轮数"><input type="number" min={1} max={4} value={buildOverrides[spec.candidateId]?.maxRounds ?? run.build.maxRounds} onChange={(event) => updateBuild(spec.candidateId, { maxRounds: Number(event.target.value) })}/></Field>
            <Field label="写者会话"><input type="number" min={1} max={100} value={buildOverrides[spec.candidateId]?.maxWriterSessions ?? run.build.maxWriterSessions} onChange={(event) => updateBuild(spec.candidateId, { maxWriterSessions: Number(event.target.value) })}/></Field>
            <Field label="模型调用"><input type="number" min={1} max={200} value={buildOverrides[spec.candidateId]?.maxModelCalls ?? run.build.maxModelCalls} onChange={(event) => updateBuild(spec.candidateId, { maxModelCalls: Number(event.target.value) })}/></Field>
            <Field label="主动分钟"><input type="number" min={1} max={1440} value={buildOverrides[spec.candidateId]?.maxActiveMinutes ?? run.build.maxActiveMinutes} onChange={(event) => updateBuild(spec.candidateId, { maxActiveMinutes: Number(event.target.value) })}/></Field>
            {buildOverrides[spec.candidateId]?.lightReworkEnabled ? <Field label="Grok 轻量返工分钟"><input type="number" min={1} max={15} value={buildOverrides[spec.candidateId]?.lightReworkMinutes ?? run.build.lightReworkMinutes ?? 5} onChange={(event) => updateBuild(spec.candidateId, { lightReworkMinutes: Number(event.target.value) })}/><small>会在启动前冻结允许文件、源提交、tree、能力指纹和评审预算。</small></Field> : null}
          </div></div> : <div className="help-note">该运行没有 T7 构建预算字段；保持原作业流程，不补开返工或评审。</div>}
          <label className="check-label"><input type="checkbox" checked={spec.allowNetwork} onChange={(event) => updateSpec(spec.candidateId, { allowNetwork: event.target.checked })}/>允许 Sol 在沙箱内联网安装依赖</label>
        </div></details>;
      })}
      <Field label="决定说明（可选）"><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="记录改选候选、接受风险或停止的原因"/></Field>
      {formErrors.length ? <div role="alert" className="alert bad"><b>请先修正规格：</b><ul>{formErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
      <div className={`btnbar gate-actions${open ? ' is-sticky' : ''}`}><button className="gate" disabled={!canAct || !defaultsLoaded || Boolean(loadError) || selected.length < 1} onClick={submitValidate}>确认框架并进入 MVP 验证</button><button disabled={!canAct || decision.judges.length < 2 || !recheckIds.length} onClick={submitRecheck}>复核所选分歧（{recheckIds.length}）· 必要时 Ultra 裁决</button>{run.designResolution?.mode === 'single' ? <><button disabled={!canAct} onClick={() => void escalateDual()}>升级为双架构师并新开一轮</button><button disabled={!canAct} onClick={() => { setArchitectReason(''); setConfirmAction('override'); }}>改由 Astra 设计新一轮</button></> : null}<button disabled={!canAct} onClick={() => setConfirmAction('redesign')}>重新设计</button><button className="danger ghost" disabled={!canAct} onClick={() => setConfirmAction('stop')}>停止并保存记录</button></div>
    </div></div></section>
    {confirmAction ? <Modal title={confirmAction === 'redesign' ? '确认重新设计' : confirmAction === 'override' ? '确认单架构师覆盖' : '确认停止运行'} size="sm" initialFocus={confirmAction === 'override' ? overrideField : confirmBack} onClose={() => setConfirmAction(null)}><p>{confirmAction === 'redesign' ? '新的回答会并入需求快照，当前轮次保留为只读记录，然后重新生成方案。' : confirmAction === 'override' ? '这会显式把下一轮单架构师从 Claude 改为 Astra，并标记为非主导者方案；任务失败不会自动触发这种替换。' : '运行将结束，不会创建 MVP 作业；现有决策记录仍可导出。'}</p>{confirmAction === 'override' ? <Field label="覆盖原因（必填）"><textarea ref={overrideField} value={architectReason} onChange={event => setArchitectReason(event.target.value)} /></Field> : null}<div className="btnbar end"><button ref={confirmBack} onClick={() => setConfirmAction(null)}>返回</button><button className={confirmAction === 'stop' ? 'danger' : 'primary'} disabled={busy || (confirmAction === 'override' && !architectReason.trim())} onClick={submitConfirmed}>确认{confirmAction === 'redesign' ? '重新设计' : confirmAction === 'override' ? '覆盖并新开一轮' : '停止'}</button></div></Modal> : null}
  </div>;
}
