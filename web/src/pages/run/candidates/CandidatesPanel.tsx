import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, EmptyState, Field, Modal, SectionTitle } from '../../../components/ui';
import { api } from '../../../lib/api';
import { roleLabel, statusLabel } from '../../../lib/labels';
import type { Candidate, CellResult, ConstraintResult, Proposal, Run, RunPanelProps } from '../../../lib/types';
import { scoreCellText, scoreKindMeta } from './scoreCell';
import { ConstraintVerdict, constraintLabel, IntervalChart, ScoreValue, scoreLabel } from './CompareCells';
import './candidates.css';

type Props = RunPanelProps & { view: 'proposals' | 'compare' };
type Detail = { kind: 'score'; cell: CellResult; title: string } | { kind: 'constraint'; cell: ConstraintResult; title: string };

const severityLabel = { high: '高', medium: '中', low: '低', critical: '严重', major: '主要', minor: '次要' } as const;
const constraintTone = (status: string) => status === 'pass' ? 'ok' : status === 'fail' ? 'bad' : status === 'disputed' ? 'warn' : '';
const evidenceKind = { doc: '文档', user_input: '用户输入', reasoning: '推理', experience: '经验', prototype: '原型' } as const;
type EvidenceItem = { kind: keyof typeof evidenceKind; ref: string | null; summary: string };

function EvidenceList({ evidence }: { evidence: EvidenceItem[] }) {
  return evidence.length ? <ul className="evidence-list">{evidence.map((item, index) => <li key={`${item.kind}-${item.ref ?? index}`}>
    <Badge>{evidenceKind[item.kind]}</Badge> {item.summary}{item.ref ? <span className="mono"> · {item.ref}</span> : null}
  </li>)}</ul> : <p className="muted">没有附带证据。</p>;
}

function MermaidDiagram({ runId, proposalId }: { runId: string; proposalId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState('loading');
    api.get<{ mermaid: string }>(`/api/runs/${runId}/diagram/${proposalId}`, controller.signal).then(async data => {
      if (!active) return;
      setSource(data.mermaid);
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, flowchart: { htmlLabels: false } });
      const renderId = `diagram-${runId}-${proposalId}`.replace(/[^A-Za-z0-9_-]/g, '-');
      const result = await mermaid.render(renderId, data.mermaid);
      if (!active || !host.current) return;
      host.current.innerHTML = result.svg;
      result.bindFunctions?.(host.current);
      setState('ready');
    }).catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState('error'); } });
    return () => { active = false; controller.abort(); };
  }, [proposalId, runId]);
  return <div className="diagram-wrap">
    {state === 'loading' ? <p role="status" className="muted">正在本机生成架构图…</p> : null}
    {state === 'error' ? <div className="alert warn">架构图无法渲染：{error || '未知错误'}。以下是服务端返回的 Mermaid 原文，未补写或修改内容。<pre>{source || '未取得图形数据'}</pre></div> : null}
    <div ref={host} className="diagram" aria-label="方案架构图" hidden={state !== 'ready'} />
  </div>;
}

function ProposalDetail({ proposal, runId }: { proposal: Proposal; runId: string }) {
  const [showDiagram, setShowDiagram] = useState(false);
  return <div className="proposal-detail">
    <p className="proposal-summary">{proposal.summary}</p>
    <div className="detail-grid">
      <div><h4>适用前提</h4><ul>{proposal.fitWhen.map(item => <li key={item}>{item}</li>)}</ul></div>
      <div><h4>不适合</h4><ul>{proposal.notFitWhen.map(item => <li key={item}>{item}</li>)}</ul></div>
    </div>
    <details open><summary>技术栈与模块</summary>
      <div className="table-scroll"><table><thead><tr><th>层</th><th>选择</th><th>原因</th></tr></thead><tbody>{proposal.stack.map(item => <tr key={`${item.layer}-${item.choice}`}><td>{item.layer}</td><td>{item.choice}</td><td>{item.reason}</td></tr>)}</tbody></table></div>
      <ul>{proposal.modules.map(module => <li key={module.id}><strong>{module.name}</strong>：{module.responsibility}{module.tech ? `（${module.tech}）` : ''}</li>)}</ul>
    </details>
    <details><summary>数据流与部署</summary><ol>{proposal.flows.map((flow, index) => <li key={`${flow.from}-${flow.to}-${index}`}>{flow.from} → {flow.to}：{flow.label}（{flow.kind}）</li>)}</ol><p><strong>数据模型：</strong>{proposal.dataModel}</p><p><strong>部署：</strong>{proposal.deployment}</p></details>
    <details><summary>取舍、风险与假设</summary>
      <h4>取舍</h4><ul>{proposal.tradeoffs.map((item, index) => <li key={index}><strong>收益：</strong>{item.gain}<br /><span className="muted">代价：{item.cost}</span></li>)}</ul>
      <h4>风险</h4><ul>{proposal.risks.map((risk, index) => <li key={index}><Badge tone={risk.severity === 'high' ? 'bad' : risk.severity === 'medium' ? 'warn' : ''}>{severityLabel[risk.severity]}</Badge> {risk.text}{risk.mitigation ? `；缓解：${risk.mitigation}` : ''}</li>)}</ul>
      <h4>假设</h4><ul>{proposal.assumptions.map((item, index) => <li key={index}>{item.questionId ? <button type="button" className="question-link" onClick={() => window.dispatchEvent(new CustomEvent('workbench:focus-question', { detail: item.questionId }))}>{item.questionId}</button> : null} {item.text}</li>)}</ul>
    </details>
    <details><summary>MVP 计划</summary><p>{proposal.mvpPlan.goal}</p><p><strong>预估：</strong>{proposal.mvpPlan.estimatedEffort}</p><ul>{proposal.mvpPlan.scopeIn.map(item => <li key={item}>{item}</li>)}</ul></details>
    <div className="btnbar"><button type="button" onClick={() => setShowDiagram(value => !value)} aria-expanded={showDiagram}>{showDiagram ? '收起架构图' : '查看架构图'}</button></div>
    {showDiagram ? <MermaidDiagram runId={runId} proposalId={proposal.id} /> : null}
  </div>;
}

function CandidateCard({ run, candidate, checked, onChecked }: { run: Run; candidate: Candidate; checked: boolean; onChecked: (value: boolean) => void }) {
  const proposals = candidate.memberProposalIds.map(id => run.proposals.find(proposal => proposal.id === id)).filter((item): item is Proposal => Boolean(item));
  const [proposalId, setProposalId] = useState(candidate.representativeProposalId);
  const proposal = proposals.find(item => item.id === proposalId) ?? proposals[0];
  const total = run.decision?.totals.find(item => item.candidateId === candidate.id);
  if (!proposal) return null;
  return <article className={`candidate-card origin-${candidate.origin}`}>
    <div className="candidate-heading">
      <label className="check-label"><input type="checkbox" checked={checked} onChange={event => onChecked(event.target.checked)} /> <span className="mono">{candidate.id}</span></label>
      <Badge tone={candidate.origin}>{roleLabel[candidate.origin]}</Badge>
      <Badge tone={total?.status === 'viable' ? 'ok' : total?.status === 'eliminated' ? 'bad' : 'warn'}>{total ? statusLabel(total.status) : '评审未完成'}</Badge>
      {run.mode === 'mock' ? <Badge tone="mock">模拟数据</Badge> : null}
    </div>
    <h3>{proposal.title}</h3>
    {candidate.invalidatedAssumptions.length ? <div className="alert bad">假设已被 {candidate.invalidatedAssumptions.join('、')} 的新回答推翻，需重新设计后恢复资格。</div> : null}
    {candidate.possibleDuplicateOf.length ? <div className="alert warn">一位评审认为它可能与 {candidate.possibleDuplicateOf.join('、')} 重复。当前仍是独立候选，可勾选后手动合并。</div> : null}
    {proposals.length > 1 ? <div className="member-tabs" aria-label={`${candidate.id} 合并成员`}>{proposals.map(item => <button type="button" key={item.id} aria-pressed={item.id === proposal.id} onClick={() => setProposalId(item.id)}>{roleLabel[item.author]} 原文</button>)}</div> : null}
    <ProposalDetail proposal={proposal} runId={run.id} />
  </article>;
}

function ProposalsView({ run, busy, act }: RunPanelProps) {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected(current => current.filter(id => run.candidates.some(candidate => candidate.id === id))), [run.candidates]);
  const canMerge = run.phase === 'framework_gate' && run.terminal === null && !busy;
  const merge = async () => {
    if (await act('merge', { candidateIds: selected })) setSelected([]);
  };
  const notes = run.modelNotes.filter(note => note.phase === 'propose' && (note.whyThisCount || note.rejectedAlternatives.length));
  return <>
    <section className="panel">
      <SectionTitle title="候选方案" eyebrow="独立提案与一致方案"><Badge>{run.candidates.length} 个候选</Badge></SectionTitle>
      {run.candidates.length === 1 ? <div className="alert ok">评审后只剩一个候选是正常结果，无需为了比较而补造方案。</div> : null}
      {run.proposals.length && !run.decision ? <div className="alert info">提案已到达，评审尚未完成；状态和对比矩阵仍是不完整数据。</div> : null}
      {run.candidates.length ? <div className="candidate-list">{run.candidates.map(candidate => <CandidateCard key={candidate.id} run={run} candidate={candidate} checked={selected.includes(candidate.id)} onChecked={value => setSelected(current => value ? [...new Set([...current, candidate.id])] : current.filter(id => id !== candidate.id))} />)}</div> : <EmptyState title={run.proposals.length ? '正在整理候选' : '方案尚未生成'}><p>两边完成独立提案和交叉评审后，候选会显示在这里。</p></EmptyState>}
      {run.candidates.length > 1 ? <div className="merge-bar"><span>已选择 {selected.length} 个候选。手动合并会保留所有成员原文。</span><button type="button" onClick={merge} disabled={!canMerge || selected.length < 2}>手动合并</button></div> : null}
    </section>
    {notes.length ? <section className="panel"><SectionTitle title="提案数量与放弃方向" eyebrow="模型原始说明" />
      <div className="note-grid">{notes.map(note => <article key={note.taskId} className={`model-note ${note.role}`}><Badge tone={note.role}>{roleLabel[note.role]}</Badge><p>{note.whyThisCount}</p>{note.rejectedAlternatives.length ? <ul>{note.rejectedAlternatives.map(item => <li key={item.title}><strong>{item.title}</strong>：{item.reason}</li>)}</ul> : <p className="muted">没有记录放弃方向。</p>}</article>)}</div>
    </section> : null}
  </>;
}

function DetailModal({ detail, run, disabled, onClose, act }: { detail: Detail; run: Run; disabled: boolean; onClose: () => void; act: RunPanelProps['act'] }) {
  const [value, setValue] = useState(detail.kind === 'score' ? String(detail.cell.point ?? 3) : detail.cell.status === 'fail' ? 'fail' : 'pass');
  const [reason, setReason] = useState('');
  const currentOverride = run.overrides.find(item => item.kind === detail.kind && item.candidateId === detail.cell.candidateId && (detail.kind === 'score' ? item.criterionId === detail.cell.criterionId : item.constraintId === detail.cell.constraintId));
  const submit = async (remove = false) => {
    const body = detail.kind === 'score'
      ? { kind: 'score', candidateId: detail.cell.candidateId, criterionId: detail.cell.criterionId, constraintId: null, value: remove ? null : Number(value), reason }
      : { kind: 'constraint', candidateId: detail.cell.candidateId, criterionId: null, constraintId: detail.cell.constraintId, value: remove ? null : value, reason };
    if (await act('overrides', body)) onClose();
  };
  const rawEvidence = detail.kind === 'constraint' ? run.judgments.flatMap(judgment => {
    const candidate = run.candidates.find(item => item.id === detail.cell.candidateId);
    if (!candidate?.memberProposalIds.includes(judgment.proposalId)) return [];
    const check = judgment.constraintChecks.find(item => item.constraintId === detail.cell.constraintId);
    return check ? [{ judge: judgment.judge, rationale: check.rationale, evidence: check.evidence }] : [];
  }) : [];
  return <Modal title={detail.title} onClose={onClose} className="compare-detail">
    {detail.kind === 'score' ? <>
      <p><Badge tone={scoreKindMeta[detail.cell.kind].tone}>{scoreKindMeta[detail.cell.kind].label}</Badge> {scoreCellText(detail.cell)}</p>
      {(['claude', 'astra'] as const).map(judge => <section className="judge-detail" key={judge}><h3><Badge tone={judge}>{roleLabel[judge]}</Badge> 理由</h3><ul>{(detail.cell.rationales[judge] ?? []).map((item, index) => <li key={index}>{item}</li>)}</ul><EvidenceList evidence={detail.cell.evidence[judge] ?? []} /></section>)}
    </> : <>
      <p>合成判定：<Badge tone={constraintTone(detail.cell.status)}>{statusLabel(detail.cell.status)}</Badge></p>
      {(['claude', 'astra'] as const).map(judge => {
        const raw = rawEvidence.filter(item => item.judge === judge);
        return <section className="judge-detail" key={judge}><h3><Badge tone={judge}>{roleLabel[judge]}</Badge>：{statusLabel(detail.cell.judgeStatuses[judge] ?? 'unknown')}</h3><ul>{(detail.cell.rationales[judge] ?? []).map((item, index) => <li key={index}>{item}</li>)}</ul>{raw.map((item, index) => <EvidenceList key={index} evidence={item.evidence} />)}</section>;
      })}
    </>}
    <hr />
    <Field label={detail.kind === 'score' ? '你的评分（0–5）' : '你的约束判定'}>
      {detail.kind === 'score' ? <select value={value} onChange={event => setValue(event.target.value)} disabled={disabled}>{[0, 1, 2, 3, 4, 5].map(score => <option key={score} value={score}>{score} 分</option>)}</select> : <select value={value} onChange={event => setValue(event.target.value)} disabled={disabled}><option value="pass">满足</option><option value="fail">不满足</option></select>}
    </Field>
    <Field label="覆盖理由（必填）" hint="理由会写入决策记录；撤销覆盖也必须说明原因。"><textarea value={reason} onChange={event => setReason(event.target.value)} disabled={disabled} /></Field>
    <div className="btnbar"><button className="primary" type="button" onClick={() => submit(false)} disabled={disabled || !reason.trim()}>保存覆盖</button>{currentOverride ? <button type="button" onClick={() => submit(true)} disabled={disabled || !reason.trim()}>撤销现有覆盖</button> : null}</div>
  </Modal>;
}

function CompareView(props: RunPanelProps) {
  const { run, busy, act } = props;
  const [detail, setDetail] = useState<Detail | null>(null);
  const decision = run.decision;
  const proposalsById = useMemo(() => new Map(run.proposals.map(proposal => [proposal.id, proposal])), [run.proposals]);
  const candidateName = (id: string) => {
    const candidate = run.candidates.find(item => item.id === id);
    return candidate ? proposalsById.get(candidate.representativeProposalId)?.title ?? id : id;
  };
  if (!decision) return <section className="panel"><EmptyState title="对比尚未生成"><p>交叉评审完成后，这里会显示硬约束、评分区间和双方依据。当前不补写缺失结果。</p></EmptyState></section>;
  const snapshot = run.snapshots.find(item => item.version === run.designSnapshotVersion) ?? run.snapshots.at(-1);
  const canOverride = run.phase === 'framework_gate' && run.terminal === null && !busy;
  return <div className="compare-stack">
    <section className="panel compare-panel"><SectionTitle title="硬约束矩阵" eyebrow="两位评审的独立判定"><span className="matrix-legend"><span className="st ok"><i aria-hidden="true">✓</i>一致满足</span><span className="st child"><i aria-hidden="true">‖</i>分歧交你确认</span><span className="st err"><i aria-hidden="true">✕</i>一致不满足</span></span></SectionTitle>
      {snapshot?.constraints.length ? <div className="table-scroll"><table className="matrix"><thead><tr><th>候选</th>{snapshot.constraints.map(item => <th key={item.id}>{item.id}<small>{item.text}</small></th>)}</tr></thead><tbody>{run.candidates.map(candidate => <tr key={candidate.id}><th>{candidate.id}<small>{candidateName(candidate.id)}</small></th>{snapshot.constraints.map(constraint => {
        const cell = decision.constraints.find(item => item.candidateId === candidate.id && item.constraintId === constraint.id);
        return <td key={constraint.id}>{cell ? <button type="button" className={`matrix-cell ${cell.status}${cell.source === 'user' ? ' user' : ''}`} aria-label={constraintLabel(cell, `${candidate.id} · ${constraint.id}`)} onClick={() => setDetail({ kind: 'constraint', cell, title: `${candidate.id} · ${constraint.id} 约束依据` })}><ConstraintVerdict cell={cell} /></button> : <span className="matrix-cell unknown">未评审</span>}</td>;
      })}</tr>)}</tbody></table></div> : <p className="muted">本轮没有硬约束。</p>}
    </section>
    <section className="panel compare-panel"><SectionTitle title="评分矩阵" eyebrow="Claude / Astra → 合成结果"><span className="muted matrix-note">只标出非一致的格子 · 点击格子查看依据</span></SectionTitle>
      <div className="table-scroll"><table className="matrix score-matrix"><thead><tr><th>候选</th>{run.criteria.map(item => <th key={item.id}>{item.name}<small>{Math.round(item.weight * 100)}%</small></th>)}</tr></thead><tbody>{run.candidates.map(candidate => <tr key={candidate.id}><th>{candidate.id}<small>{candidateName(candidate.id)}</small></th>{run.criteria.map(criterion => {
        const cell = decision.cells.find(item => item.candidateId === candidate.id && item.criterionId === criterion.id);
        return <td key={criterion.id}>{cell ? <button type="button" className={`matrix-cell score ${cell.kind}`} aria-label={scoreLabel(cell, `${candidate.id} · ${criterion.name}`)} onClick={() => setDetail({ kind: 'score', cell, title: `${candidate.id} · ${criterion.name} 评分依据` })}><ScoreValue cell={cell} /></button> : <span className="matrix-cell unknown">未知</span>}</td>;
      })}</tr>)}</tbody></table></div>
    </section>
    <section className="panel"><SectionTitle title="总分区间" eyebrow="区间越短，已知程度越高"><Badge>δ = {decision.params.tieMargin}</Badge></SectionTitle>
      <IntervalChart totals={decision.totals} delta={decision.params.tieMargin} name={candidateName} /><p className="help-note">浅色 δ 标尺表示默认平局宽度。区间重叠时，页面不会把中点顺序冒充成确定排名。</p>
    </section>
    <section className="panel split"><div><SectionTitle title="反对意见" eyebrow="评审原文" />{run.judgments.some(item => item.objections.length) ? <div className="objection-list">{run.judgments.flatMap(judgment => judgment.objections.map(objection => <article key={`${judgment.taskId}-${objection.id}`}><Badge tone={judgment.judge}>{roleLabel[judgment.judge]}</Badge> <Badge tone={objection.severity === 'critical' ? 'bad' : objection.severity === 'major' ? 'warn' : ''}>{severityLabel[objection.severity]}</Badge><p>{objection.text}</p>{objection.howToVerify ? <small>可验证方式：{objection.howToVerify}</small> : null}<EvidenceList evidence={objection.evidence} /></article>))}</div> : <p className="muted">没有记录反对意见。</p>}</div>
      <div><SectionTitle title="自评偏差提示" eyebrow="仅提示，不自动修正" />{decision.selfPreference.map(item => <article className="bias-row" key={item.judge}><Badge tone={item.judge}>{roleLabel[item.judge]}</Badge>{item.index === null ? <span className="muted">样本不足（{item.sampleSize}）</span> : <span>偏差指数 {item.index.toFixed(2)} · 样本 {item.sampleSize}{item.index >= .5 ? <Badge tone="warn">可能偏向自己的方案</Badge> : null}</span>}</article>)}</div>
    </section>
    {detail ? <DetailModal detail={detail} run={run} disabled={!canOverride} onClose={() => setDetail(null)} act={act} /> : null}
  </div>;
}

export default function CandidatesPanel(props: Props) {
  return props.view === 'proposals' ? <ProposalsView {...props} /> : <CompareView {...props} />;
}
