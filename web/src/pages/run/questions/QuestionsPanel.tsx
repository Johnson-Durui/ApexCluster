import { useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, Icon } from '../../../components/ui';
import { roleLabel } from '../../../lib/labels';
import type { Question, RunPanelProps } from '../../../lib/types';
import { nextOptionSelection, questionMatchesFilter, questionStatusText, type QuestionFilter } from './questionState';
import './questions.css';

const topicNames: Record<string, string> = {
  goal_scope: '目标与范围', core_flow: '核心流程', users_scale: '用户与规模', data: '数据与存储',
  integration: '外部集成', deployment: '部署与运行环境', security: '安全与权限', performance: '性能',
  budget_timeline: '预算与时间', team_skills: '团队与技能', ux: '交互体验', other: '其他',
};
const topicOrder = Object.keys(topicNames);
const priorityLabels = { blocking: '阻塞', important: '重要', optional: '可选' } as const;
const filters: [QuestionFilter, string][] = [['all', '全部'], ['open', '未回答'], ['blocking', '阻塞'], ['claude', 'Claude'], ['astra', 'Astra'], ['sol', 'Sol']];
const priorityRank = { blocking: 0, important: 1, optional: 2 } as const;
const statusRank = { open: 0, unsure: 1, skipped: 2, answered: 3 } as const;
export function rankQuestionsForDisplay(questions: readonly Question[]): Question[] {
  return questions.map((question, index) => ({ question, index })).sort((a, b) => priorityRank[a.question.priority] - priorityRank[b.question.priority]
    || statusRank[a.question.status] - statusRank[b.question.status]
    || (Number(a.question.id.replace(/^Q/, '')) || Number.MAX_SAFE_INTEGER) - (Number(b.question.id.replace(/^Q/, '')) || Number.MAX_SAFE_INTEGER)
    || a.index - b.index).map(item => item.question);
}

function QuestionCard({ question, disabled, onAnswer }: {
  question: Question;
  disabled: boolean;
  onAnswer: (question: Question, body: unknown) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string[]>(question.answer?.optionIds ?? []);
  const [otherText, setOtherText] = useState(question.answer?.otherText ?? '');
  const [showOther, setShowOther] = useState(Boolean(question.answer?.otherText));
  useEffect(() => {
    setSelected(question.answer?.optionIds ?? []);
    setOtherText(question.answer?.otherText ?? '');
    setShowOther(Boolean(question.answer?.otherText));
  }, [question.id, question.status, question.answer?.answeredAt]);
  const laterQuestion = question.phase !== 'clarify' && question.status === 'open';
  const canSave = selected.length > 0 || otherText.trim().length > 0;
  const submitAnswer = () => onAnswer(question, { status: 'answered', optionIds: selected, otherText: otherText.trim() || null, note: null });

  return <article id={`question-${question.id}`} tabIndex={-1} className={`question-card ${question.status !== 'open' ? 'resolved' : ''} ${question.priority}`}>
    <div className="question-meta">
      <span className={`mtag ${question.askedBy}`} aria-hidden="true">{question.askedBy === 'claude' ? 'C' : question.askedBy === 'astra' ? 'A' : 'S'}</span>
      <b>{roleLabel[question.askedBy]}</b>
      <span className="mono muted">{question.id}</span>
      <Badge tone={question.priority === 'blocking' ? 'bad' : question.priority === 'important' ? 'warn' : ''}>{priorityLabels[question.priority]}</Badge>
      <Badge>{question.multiSelect ? '可多选' : '单选'}</Badge>
      {laterQuestion ? <Badge tone="gate-soft">新</Badge> : null}
      <span className={`question-state ${question.status}`}>{questionStatusText(question)}</span>
    </div>
    <h3>{question.text}</h3>
    <p className="question-why">为什么重要：{question.whyItMatters}</p>
    <div className="option-list" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={`${question.id} 的选项`}>
      {question.options.map(option => {
        const checked = selected.includes(option.id);
        return <label key={option.id} className={`option-card ${checked ? 'selected' : ''}`}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`question-${question.id}`} checked={checked} disabled={disabled} onChange={() => {
            if (!question.multiSelect) { setShowOther(false); setOtherText(''); }
            setSelected(current => nextOptionSelection(current, option.id, question.multiSelect));
          }} />
          <span className="option-check" aria-hidden="true">{checked ? <Icon name="check" size={12} /> : null}</span>
          <span><strong>{option.label}</strong><small>{option.implication}</small></span>
        </label>;
      })}
      <button type="button" className={`option-card ${showOther ? 'selected' : ''}`} aria-pressed={showOther} disabled={disabled} onClick={() => setShowOther(value => {
        if (value) setOtherText('');
        else if (!question.multiSelect) setSelected([]);
        return !value;
      })}>
        <span className="option-check" aria-hidden="true">{showOther ? <Icon name="check" size={12} /> : null}</span><span><strong>其他</strong><small>用自己的情况补充回答</small></span>
      </button>
    </div>
    {showOther ? <label className="other-answer"><span>其他回答</span><textarea value={otherText} onChange={event => setOtherText(event.target.value)} placeholder="请写明具体情况" disabled={disabled} /></label> : null}
    <div className="question-foot">
      <div className="default-assumption"><b>默认假设：</b>{question.defaultAssumption}</div>
      <div className="question-actions">
        <button type="button" onClick={() => onAnswer(question, { status: 'unsure', optionIds: [], otherText: null, note: null })} disabled={disabled}>暂不确定</button>
        <button type="button" onClick={() => onAnswer(question, { status: 'skipped', optionIds: [], otherText: null, note: null })} disabled={disabled}>采用默认</button>
        <button type="button" className="primary" onClick={submitAnswer} disabled={disabled || !canSave}>保存回答</button>
      </div>
    </div>
  </article>;
}

type Props = RunPanelProps & { focusQuestionId?: string | null; onFocusHandled?: () => void };

export default function QuestionsPanel({ run, busy, act, focusQuestionId, onFocusHandled }: Props) {
  const [filter, setFilter] = useState<QuestionFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const openCount = run.questions.filter(question => question.status === 'open').length;
  const laterQuestions = run.questions.filter(question => question.phase !== 'clarify' && question.status === 'open');
  const invalidated = run.candidates.filter(candidate => candidate.invalidatedAssumptions.length > 0);
  const canAnswer = run.terminal === null && !busy && !bulkRunning;
  useEffect(() => {
    if (!focusQuestionId) return;
    setFilter('all');
    setExpanded(true);
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`question-${focusQuestionId}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus({ preventScroll: true });
      onFocusHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusQuestionId, onFocusHandled]);
  const filteredRanked = useMemo(() => rankQuestionsForDisplay(run.questions.filter(question => questionMatchesFilter(question, filter))), [filter, run.questions]);
  const displayed = expanded ? filteredRanked : filteredRanked.slice(0, 12);
  const grouped = useMemo(() => topicOrder.map(topic => ({
    topic,
    questions: displayed.filter(question => question.topic === topic),
  })).filter(group => group.questions.length > 0), [displayed]);
  const answer = (question: Question, body: unknown) => act(`questions/${question.id}/answer`, body);
  const applyDefaults = async () => {
    setBulkRunning(true);
    try {
      for (const question of run.questions.filter(item => item.status === 'open')) {
        const ok = await act(`questions/${question.id}/answer`, { status: 'skipped', optionIds: [], otherText: null, note: null });
        if (!ok) break;
      }
    } finally {
      setBulkRunning(false);
    }
  };
  const submitG1 = () => act('gates', { gate: 'G1_answers', action: 'submit' });
  const byModel = (role: string) => run.questions.filter(question => question.askedBy === role).length;

  return <section className="questions-panel" aria-labelledby="questions-title">
    <header className="questions-head">
      <div>
        <div className="eyebrow">G1 · 澄清输入</div>
        <h2 id="questions-title">需要你回答的问题</h2>
        <p className="muted">共 {run.questions.length} 题 · 未回答 {openCount} · Claude 提出 {byModel('claude')} · Astra 提出 {byModel('astra')}</p>
      </div>
      <div className="questions-tools">
        <div className="question-filters" role="group" aria-label="问题筛选">
          {filters.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <button type="button" onClick={applyDefaults} disabled={!canAnswer || openCount === 0}>{bulkRunning ? '正在采用默认…' : '未回答的全部采用默认'}</button>
      </div>
    </header>
    {laterQuestions.length ? <div className="alert info" role="status">新增 {laterQuestions.length} 个后续问题。回答会更新决策输入，不会自动重跑已经生成的方案。</div> : null}
    {run.questionGroups?.status === 'ready' && run.questionGroups.output ? <div className="alert info" role="status"><b>Grok 分组提示 · 仅用于浏览</b><p>快照 <code>{run.questionGroups.output.snapshotRef}</code>。全部 {run.questions.length} 个原问题仍分别保存、回答和提交。</p><ul>{run.questionGroups.output.groups.map(group => <li key={group.label}>{group.label}：{group.questionIds.join('、')}</li>)}</ul></div> : run.chores?.qgroup ? <div className="help-note">Grok 分组提示：{run.questionGroups?.reason || '尚未生成；不影响原问题与答案。'}</div> : null}
    {invalidated.length ? <div className="alert bad"><strong>回答已推翻方案假设。</strong> {invalidated.map(candidate => `${candidate.id}（${candidate.invalidatedAssumptions.join('、')}）`).join('；')} 已失去偏好资格。请在框架关卡检查后选择“重新设计”。</div> : null}
    {grouped.length ? <div className="topic-list">{grouped.map(group => <section key={group.topic} className="question-topic" aria-label={topicNames[group.topic]}>
      <div className="topic-heading"><h3>{topicNames[group.topic]}</h3><span>{group.questions.length} 题</span></div>
      <div className="topic-questions">{group.questions.map(question => <QuestionCard key={question.id} question={question} disabled={!canAnswer} onAnswer={answer} />)}</div>
    </section>)}</div> : <div className="panel"><EmptyState title={run.questions.length ? '当前筛选没有问题' : run.phase === 'clarify' || run.phase === 'intake' ? '问题正在生成' : '暂无澄清问题'} icon="message"><p>{run.questions.length ? '切换筛选条件查看其他问题。' : run.phase === 'clarify' || run.phase === 'intake' ? '所选模型完成后，问题会自动出现在这里。' : run.phase === 'answering' ? '模型没有提出补充问题，可以直接提交并开始设计。' : '后续阶段新增的问题会显示在这里。'}</p></EmptyState></div>}
    {filteredRanked.length > 12 ? <button type="button" className="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? '收起其余问题' : `展开其余 ${filteredRanked.length - 12} 题`}</button> : null}
    {run.phase === 'answering' && !run.terminal ? <div className="g1-submit gate-wrap"><div className="decision-card"><div className="decision-in">
      <div><span className="g1-key">G1 · 由你决定</span><strong>准备开始独立设计</strong><small>提交后，仍未回答的 {openCount} 题会采用各自默认假设；之后改答若推翻方案假设，会提示重新设计。</small></div>
      <button type="button" className="gate" onClick={submitG1} disabled={!canAnswer}>提交并开始设计（未回答的 {openCount} 题将采用默认）</button>
    </div></div></div> : null}
  </section>;
}
