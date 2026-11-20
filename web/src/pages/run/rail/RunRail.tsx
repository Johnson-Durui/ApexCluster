import { Badge, Icon } from '../../../components/ui';
import { duration, formatDate, phaseLabels, roleLabel } from '../../../lib/labels';
import { useNow } from '../../../lib/useNow';
import type { ModelRole, Run } from '../../../lib/types';
import { elapsedMs } from '../header/ModelStatusStrip';
import { FOCUS_QUESTION_EVENT, OPEN_SNAPSHOT_EVENT, type RunTab } from '../tabs';
import './rail.css';

const gateInfo: Record<string, { key: string; title: string; text: string; tab: RunTab; cta: string }> = {
  answering: { key: 'G1', title: '回答澄清问题', text: '回答或采用默认后提交，两位模型才会开始独立提案。', tab: 'questions', cta: '前往回答' },
  framework_gate: { key: 'G2', title: '确认框架与 MVP 范围', text: '查看规则结论、分歧和裁决建议，选择要构建的候选并确认 MVP 规格。', tab: 'decision', cta: '前往决策' },
  docs_gate: { key: 'G3', title: '确认手册与开发文档', text: '确认后开发文档写入 Sol 工作区，构建才会开始。', tab: 'documents', cta: '前往文档' },
  final_gate: { key: 'G4', title: '验收 MVP', text: '以执行日志和你的人工验收为准：接受、重试作业或回到 G2。', tab: 'validation', cta: '前往验收' },
  prd_gate: { key: 'G5', title: '确认 PRD', text: '确认、按意见修订，或保留草稿结束运行。', tab: 'documents', cta: '前往 PRD' },
};
const clarifyLabels: Record<string, string> = { both: '两边都提问', claude: '只用 Claude', astra: '只用 Astra', skip: '跳过澄清' };
const roles: ModelRole[] = ['claude', 'astra', 'sol', 'grok'];

export default function RunRail({ run, collapsed, onNavigate, onOpenGate }: { run: Run; collapsed: boolean; onNavigate: (tab: RunTab) => void; onOpenGate: (tab: RunTab) => void }) {
  return <aside id="run-context" className="run-rail" aria-label="运行上下文" hidden={collapsed}>
    <NextAction run={run} visible={!collapsed} onNavigate={onNavigate} onOpenGate={onOpenGate} />
    <QuestionSummary run={run} onNavigate={onNavigate} />
    <SnapshotSummary run={run} />
    <RunSettings run={run} />
  </aside>;
}

/** 下一步: gate → decision card with a .gate.outline jump; blocked → --err rule; running → live task rows; ended. */
function NextAction({ run, visible, onNavigate, onOpenGate }: { run: Run; visible: boolean; onNavigate: (tab: RunTab) => void; onOpenGate: (tab: RunTab) => void }) {
  const active = run.tasks.filter(task => task.status === 'running' || task.status === 'queued');
  // Leaf clock: ticks once per second only while the rail is shown and a task runs.
  const now = useNow(visible && !run.terminal && active.some(task => task.status === 'running'));
  if (run.terminal) {
    const choice = run.finalChoice;
    return <section className="rail-card" aria-labelledby="rail-next">
      <div className="rail-head"><h2 id="rail-next">{run.terminal === 'done' ? '运行已结束' : '运行已取消'}</h2><Badge tone={run.terminal === 'done' ? 'ok' : ''}>{run.terminal === 'done' ? '已结束' : '已取消'}</Badge></div>
      {run.terminal === 'done' ? <p>{choice?.candidateId ? <>最终选择 <b>{choice.candidateId}</b>{choice.reason ? `：${choice.reason}` : '。'}</> : choice?.reason ?? '没有选定候选。'}</p> : <p>运行在“{phaseLabels[run.phase] ?? run.phase}”阶段被取消，已有记录仍可查看。</p>}
      <a className="button compact rail-cta" href={`/api/runs/${encodeURIComponent(run.id)}/export`} download={`decision-${run.id}.md`}><Icon name="download" size={14} />下载决策记录</a>
    </section>;
  }
  const gate = run.phaseStatus === 'waiting_user' ? gateInfo[run.phase] : undefined;
  if (gate) return <div className="gate-wrap rail-next">
    <section className="rail-card is-gate decision-card" aria-labelledby="rail-next"><div className="decision-in">
      <span className="st you rail-key"><i aria-hidden="true">◆</i>{gate.key} · 由你决定</span>
      <h2 id="rail-next">{gate.title}</h2>
      <p>{gate.text}</p>
      <button type="button" className="gate outline" onClick={() => onOpenGate(gate.tab)}>{gate.cta}<Icon name="arrow-right" size={14} /></button>
    </div></section>
  </div>;
  if (run.phaseStatus === 'blocked') return <section className="rail-card bad" aria-labelledby="rail-next">
    <div className="rail-head"><span className="st block"><i aria-hidden="true">⊘</i></span><h2 id="rail-next">运行已阻塞</h2></div>
    <p className="rail-clamp">{run.blockedReason || '当前阶段有任务未能完成。'}</p>
    <button type="button" className="ghost compact rail-link" onClick={() => onNavigate('live')}>查看失败的任务<Icon name="arrow-right" size={14} /></button>
  </section>;
  return <section className="rail-card running" aria-labelledby="rail-next">
    <div className="rail-head">{active.length ? <span className="rail-live" aria-hidden="true" /> : null}<h2 id="rail-next"><span aria-hidden="true">▶ </span>正在进行 · {phaseLabels[run.phase] ?? run.phase}</h2></div>
    {active.length ? <ul className="rail-tasks">{active.map(task => {
      const elapsed = elapsedMs(task, now);
      return <li key={task.id} data-seat={task.role}><span className="seat-dot" aria-hidden="true" /><span>{task.phase === 'adjudicate' ? 'Astra Ultra' : roleLabel[task.role]} · {phaseLabels[task.phase] ?? task.phase}</span><span className="mono muted">{task.status === 'queued' ? '排队中' : elapsed !== null ? duration(elapsed) : ''}</span></li>;
    })}</ul> : <p>正在准备下一步任务。</p>}
    <button type="button" className="ghost compact rail-link" onClick={() => onNavigate('live')}>查看执行过程<Icon name="arrow-right" size={14} /></button>
  </section>;
}

function QuestionSummary({ run, onNavigate }: { run: Run; onNavigate: (tab: RunTab) => void }) {
  const open = run.questions.filter(question => question.status === 'open');
  const later = open.filter(question => question.phase !== 'clarify');
  const invalidated = run.candidates.filter(candidate => candidate.invalidatedAssumptions.length > 0);
  const focus = (id: string) => window.dispatchEvent(new CustomEvent(FOCUS_QUESTION_EVENT, { detail: id }));
  return <section className="rail-card" aria-labelledby="rail-questions">
    <div className="rail-head"><h2 id="rail-questions">澄清问题</h2><Badge tone={open.length ? (run.terminal ? '' : 'gate-soft') : 'ok'}>{open.length ? `${open.length} 题未回答` : `共 ${run.questions.length} 题 · 已处理`}</Badge></div>
    {later.length ? <p className="rail-note">新增 {later.length} 个后续问题。回答会更新决策输入，不会自动重跑已生成的方案。</p> : null}
    {invalidated.length ? <div className="alert bad">回答已推翻 {invalidated.map(candidate => candidate.id).join('、')} 的方案假设，需在 G2 选择“重新设计”后恢复资格。</div> : null}
    {open.length ? <ul className="rail-questions">{open.slice(0, 5).map(question => <li key={question.id}><button type="button" onClick={() => focus(question.id)}>
      <span className="mono">{question.id}</span><span className="rail-q-text">{question.text}</span>{question.phase !== 'clarify' ? <Badge tone="gate-soft">新</Badge> : null}
    </button></li>)}</ul> : run.questions.length ? <p className="muted">全部问题已回答或采用默认。</p> : <p className="muted">{run.phase === 'clarify' || run.phase === 'intake' ? '模型完成后问题会出现在这里。' : '本运行没有澄清问题。'}</p>}
    <button type="button" className="ghost compact rail-link" onClick={() => onNavigate('questions')}>查看全部问题<Icon name="arrow-right" size={14} /></button>
  </section>;
}

function SnapshotSummary({ run }: { run: Run }) {
  const snapshot = run.snapshots.find(item => item.version === run.currentSnapshotVersion) ?? run.snapshots.at(-1);
  if (!snapshot) return null;
  const references = (snapshot.project.referenceDocuments?.length ?? 0) + (snapshot.project.referenceArchives?.length ?? 0);
  return <section className="rail-card" aria-labelledby="rail-snapshot">
    <div className="rail-head"><h2 id="rail-snapshot">需求快照 v{snapshot.version}</h2><span className="mono muted">{snapshot.ref}</span></div>
    <dl className="rail-counts"><div><dt>事实</dt><dd>{snapshot.facts.length}</dd></div><div><dt>假设</dt><dd>{snapshot.assumptions.length}</dd></div><div><dt>待确认</dt><dd>{snapshot.openItems.length}</dd></div><div><dt>参考资料</dt><dd>{references}</dd></div></dl>
    {snapshot.constraints.length ? <ul className="rail-constraints">{snapshot.constraints.map(item => <li key={item.id}><span className={`badge ${item.kind === 'must' ? 'info' : 'warn'}`}>{item.id} {item.kind === 'must' ? '必须' : '禁止'}</span><span>{item.text}</span></li>)}</ul> : <p className="muted">未设置硬约束。</p>}
    <button type="button" className="ghost compact rail-link" onClick={() => window.dispatchEvent(new Event(OPEN_SNAPSHOT_EVENT))}>查看完整快照<Icon name="arrow-right" size={14} /></button>
  </section>;
}

function RunSettings({ run }: { run: Run }) {
  return <section className="rail-card" aria-labelledby="rail-settings">
    <div className="rail-head"><h2 id="rail-settings">运行配置</h2><span className="muted">创建时冻结</span></div>
    {/* Seat dot + seat name + frozen model id: the seat is a visible word, never the dot colour alone. */}
    <ul className="rail-models">{roles.flatMap(role => { const model = run.models[role]; return model ? [<li key={role} data-seat={role}><span className="seat-dot" aria-hidden="true" /><b className="rail-seat">{roleLabel[role]}</b><span className="mono" title={model.model}>{model.model}</span><span className="tag">{model.effort}</span></li>] : []; })}</ul>
    <dl className="rail-kv">
      <dt>澄清提问</dt><dd>{clarifyLabels[run.clarifyWith] ?? run.clarifyWith}</dd>
      <dt>设计联网</dt><dd>{run.allowWebResearch ? '允许' : '不允许'}</dd>
      <dt>构建前文档</dt><dd>{run.writeDocs === false ? '已关闭' : '开启'}</dd>
      <dt>PRD</dt><dd>{run.writePrd === false ? '已关闭' : '开启'}</dd>
      {run.docWriter ? <><dt>文档撰写者</dt><dd className="mono">{run.docWriter.model} · {run.docWriter.effort}</dd></> : null}
      <dt>评分权重</dt><dd>{run.criteria.length ? run.criteria.map(item => `${item.name} ${Math.round(item.weight * 100)}%`).join('、') : '—'}</dd>
      {run.criteriaLockedAt ? <><dt>权重锁定</dt><dd>{formatDate(run.criteriaLockedAt)}</dd></> : null}
    </dl>
  </section>;
}
