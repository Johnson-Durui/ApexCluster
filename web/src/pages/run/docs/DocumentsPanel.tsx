import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../../../lib/api';
import { Badge, EmptyState, Field, SectionTitle } from '../../../components/ui';
import { formatDate, roleLabel } from '../../../lib/labels';
import type { DocKind, RunPanelProps } from '../../../lib/types';
import { validateG3, validateG5, type DocGateAction, type PrdGateAction } from './docGateValidation';
import './documents.css';

type Conclusion = '通过' | '补充后通过';
type ChecklistItem = { ok: boolean; text: string; note: string };
type TraceItem = {
  requirementId: string; requirementName: string; decision: string; featureIds: string[]; acIds: string[];
  mvpItems: { specRef: string; specAcceptanceId: string; acId: string; exec: { status: string; evidence: string; state: string } }[];
};
type DocSummary = {
  kind: DocKind; version: number; batch: number; docRef: string; reason: 'initial' | 'revision' | 'new_basis';
  status: 'draft' | 'approved' | 'superseded'; statusLabel: string; createdAt: string; taskId: string | null;
  warnings: string[]; approval: null | { reviewers: string | null; conclusion: Conclusion; note: string | null }; approvedAt: string | null;
  checklist: ChecklistItem[] | null;
};
type DocOverview = {
  writeDocs: boolean; writePrd: boolean; docWriter: { role: 'claude' | 'astra' | 'sol'; model: string; effort: string };
  docWriters?: Record<DocKind, { role: 'claude' | 'astra' | 'sol'; model: string; effort: string }>;
  batch: number; missing: DocKind[]; requests: { kind: DocKind; reason: string; abandoned: boolean }[];
  current: Record<DocKind, number | null>; versions: DocSummary[];
};
type DocDetail = DocSummary & { traceability: TraceItem[] | null; checklist: ChecklistItem[] | null };

const docs: Record<DocKind, { title: string; audience: string; timing: string; waiting: string }> = {
  handbook: { title: '架构说明手册', audience: '给老板 / 用户方', timing: 'MVP 前', waiting: '将在 G2 确认框架后撰写' },
  devdoc: { title: '开发文档', audience: '给 AI', timing: 'MVP 前', waiting: '将在 G2 确认框架后撰写' },
  prd: { title: '产品需求文档（PRD）', audience: '给老板 / 用户方', timing: 'MVP 后', waiting: '将在 G4 接受 MVP 后撰写' },
};
const kinds: DocKind[] = ['handbook', 'devdoc', 'prd'];
const reasonLabels = { initial: '首次撰写', revision: '按意见修订', new_basis: '框架或范围变更后重写' };

export default function DocumentsPanel({ run, busy, act }: RunPanelProps) {
  const tabsId = useId();
  const [kind, setKind] = useState<DocKind>('handbook');
  const [overview, setOverview] = useState<DocOverview | null>(null);
  const [selected, setSelected] = useState<Partial<Record<DocKind, number>>>({});
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewers, setReviewers] = useState('');
  const [conclusion, setConclusion] = useState<Conclusion>('通过');
  const [reason, setReason] = useState('');
  const [handbookNotes, setHandbookNotes] = useState('');
  const [devdocNotes, setDevdocNotes] = useState('');
  const [prdNotes, setPrdNotes] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.get<DocOverview>(`/api/runs/${encodeURIComponent(run.id)}/docs`, controller.signal)
      .then(data => {
        setOverview(data);
        setError('');
      })
      .catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : '读取文档列表失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [run.id, run.updatedAt]);

  useEffect(() => {
    if (run.phase === 'prd_writing' || run.phase === 'prd_gate') setKind('prd');
  }, [run.phase]);

  const version = selectedDocVersion(overview, kind, selected[kind]);
  const currentDetail = detail?.kind === kind && detail.version === version ? detail : null;
  useEffect(() => {
    setDetail(null);
    if (!version) { setDetail(null); return; }
    const controller = new AbortController();
    api.get<DocDetail>(`/api/runs/${encodeURIComponent(run.id)}/docs/${kind}/${version}`, controller.signal)
      .then(data => { setDetail(data); setError(''); })
      .catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : '读取文档详情失败'); });
    return () => controller.abort();
  }, [kind, run.id, version]);

  const versions = useMemo(() => overview?.versions.filter(item => item.kind === kind).toReversed() ?? [], [kind, overview]);
  const gate = [...run.gates].reverse().find(item => !item.resolvedAt && (item.id === 'G3_docs' || item.id === 'G5_prd'));
  const gateContext = gate?.context ?? {};
  const revisionFailed = Array.isArray(gateContext.revisionFailed) ? gateContext.revisionFailed.map(String) : [];
  const missing = new Set([...(overview?.missing ?? []), ...(Array.isArray(gateContext.missing) ? gateContext.missing.map(String) as DocKind[] : [])]);
  const available = kind === 'prd' ? overview?.writePrd !== false : overview?.writeDocs !== false;
  const writer = overview?.docWriters?.[kind] ?? run.docWriters?.[kind] ?? overview?.docWriter ?? run.docWriter;
  // G3 / G5 accept a decision only while the run waits on you; otherwise the section is read-only (static bar).
  const gateOpen = run.phaseStatus === 'waiting_user' && run.terminal === null;

  const submitG3 = async (action: DocGateAction) => {
    const message = validateG3({ action, conclusion, reason, handbookNotes, devdocNotes });
    if (message) { setError(message); return; }
    setError('');
    const succeeded = await act('/gates', { gate: 'G3_docs', action, reviewers: reviewers.trim() || null, conclusion, handbookNotes: handbookNotes.trim() || null, devdocNotes: devdocNotes.trim() || null, reason: reason.trim() || null });
    if (succeeded && action === 'revise') setSelected(current => ({ ...current, ...(handbookNotes.trim() ? { handbook: undefined } : {}), ...(devdocNotes.trim() ? { devdoc: undefined } : {}) }));
  };
  const submitG5 = async (action: PrdGateAction) => {
    const message = validateG5({ action, conclusion, reason, prdNotes });
    if (message) { setError(message); return; }
    setError('');
    const succeeded = await act('/gates', { gate: 'G5_prd', action, reviewers: reviewers.trim() || null, conclusion, prdNotes: prdNotes.trim() || null, reason: reason.trim() || null });
    if (succeeded && action === 'revise') setSelected(current => ({ ...current, prd: undefined }));
  };

  return <div className="documents-stack">
    <section className="panel documents-panel">
      <SectionTitle eyebrow="可追溯文档" title="项目文档">
        {writer ? <Badge tone={writer.role}>{roleLabel[writer.role]} · {writer.model} · {writer.effort}</Badge> : null}
      </SectionTitle>
      <div className="doc-kind-tabs" role="tablist" aria-label="项目文档类型" onKeyDown={event => {
        const index = kinds.indexOf(kind);
        const next = event.key === 'ArrowRight' ? (index + 1) % kinds.length : event.key === 'ArrowLeft' ? (index + kinds.length - 1) % kinds.length : event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); setKind(kinds[next]!); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus(); }
      }}>
        {kinds.map(item => <button key={item} id={`${tabsId}-${item}`} role="tab" tabIndex={kind === item ? 0 : -1} aria-selected={kind === item} aria-controls={`${tabsId}-panel`} onClick={() => setKind(item)}>
          <b>{docs[item].title}</b><small>{docs[item].audience} · {docs[item].timing}</small>
        </button>)}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${kind}`}>
      {error ? <div className="alert bad" role="alert">{error}</div> : null}
      {revisionFailed.includes(kind) ? <div className="alert bad" role="alert"><b>最近一次修订失败</b><br/>继续展示上一份有效版本；你可以修改意见后再次提交。</div> : null}
      {missing.has(kind) ? <div className="alert warn" role="alert"><b>{docs[kind].title}缺失</b><br/>撰写任务未产生合法版本。当前关卡可以要求重写，或按服务端允许的路径继续。</div> : null}
      {version && overview?.current[kind] && version !== overview.current[kind] ? <div className="alert warn" role="status"><b>正在查看历史版本 v{version}</b><br/>当前待确认版本是 v{overview.current[kind]}；G3 / G5 的确认操作始终作用于当前版本。</div> : null}
      {!available ? <EmptyState title={`${docs[kind].title}已在新建运行时关闭`}><p>这个选择已经冻结，当前运行不会生成该文档。</p></EmptyState> : loading ? <p className="loading" role="status">正在读取文档版本…</p> : !versions.length ? <EmptyState title="文档尚未生成"><p>{docs[kind].waiting}</p></EmptyState> : <div className="doc-workspace">
        <aside className="doc-history" aria-label={`${docs[kind].title}版本历史`}>
          <h3>版本历史</h3>
          {versions.map(item => <button key={item.version} className={version === item.version ? 'active' : ''} aria-pressed={version === item.version} onClick={() => setSelected(current => ({ ...current, [kind]: item.version === overview?.current[kind] ? undefined : item.version }))}>
            <span><b>v{item.version}</b><Badge tone={item.status === 'approved' ? 'ok' : item.status === 'draft' ? 'warn' : ''}>{item.statusLabel}</Badge></span>
            <small>{reasonLabels[item.reason]} · {formatDate(item.createdAt)}</small>
            <small>{item.warnings.length} 条程序提示{item.approval ? ` · ${item.approval.reviewers || '未填写评审人'}（${item.approval.conclusion}）` : ' · 待评审'}</small>
          </button>)}
        </aside>
        <div className="doc-main">
          <div className="doc-toolbar">
            <div><b>{docs[kind].title} v{version}</b><small>{currentDetail?.docRef ?? '正在读取详情…'}</small></div>
            <div className="btnbar">
              <a className="button" href={downloadUrl(run.id, kind, version!, 'html')}>下载 HTML</a>
              <a className="button" href={downloadUrl(run.id, kind, version!, 'md')}>下载 Markdown</a>
            </div>
          </div>
          {!currentDetail ? <p role="status">正在读取文档详情…</p> : currentDetail.warnings.length ? <details className="doc-warnings" open><summary>程序检查提示 · {currentDetail.warnings.length} 条</summary><ul>{currentDetail.warnings.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></details> : <div className="alert ok">程序检查没有给出额外提示。</div>}
          <iframe className="doc-preview" title={`${docs[kind].title} v${version} 预览`} sandbox="" src={renderUrl(run.id, kind, version!)} />
        </div>
        {kind === 'prd' && currentDetail ? <PrdEvidence detail={currentDetail}/> : null}
      </div>}
      </div>
    </section>
    {run.phase === 'docs_gate' ? <Gate3 open={gateOpen} busy={busy} reviewers={reviewers} setReviewers={setReviewers} conclusion={conclusion} setConclusion={setConclusion} reason={reason} setReason={setReason} handbookNotes={handbookNotes} setHandbookNotes={setHandbookNotes} devdocNotes={devdocNotes} setDevdocNotes={setDevdocNotes} submit={submitG3}/> : null}
    {run.phase === 'prd_gate' ? <Gate5 open={gateOpen} busy={busy} reviewers={reviewers} setReviewers={setReviewers} conclusion={conclusion} setConclusion={setConclusion} reason={reason} setReason={setReason} prdNotes={prdNotes} setPrdNotes={setPrdNotes} submit={submitG5}/> : null}
  </div>;
}

function Gate3(props: { open: boolean; busy: boolean; reviewers: string; setReviewers: (v: string) => void; conclusion: Conclusion; setConclusion: (v: Conclusion) => void; reason: string; setReason: (v: string) => void; handbookNotes: string; setHandbookNotes: (v: string) => void; devdocNotes: string; setDevdocNotes: (v: string) => void; submit: (action: DocGateAction) => Promise<void> }) {
  const locked = props.busy || !props.open;
  return <section className={`doc-gate gate-section gate-wrap${props.open ? '' : ' is-readonly'}`} aria-label="G3 确认构建前文档"><div className="decision-card"><div className="decision-in"><SectionTitle eyebrow="G3 · 由你决定" title="确认构建前文档"><Badge tone="info">{props.open ? '等待确认' : '当前只读'}</Badge></SectionTitle>
    <div className="form-grid"><Field label="评审人及角色" hint="例如：王总（老板）；李经理（用户方）"><input value={props.reviewers} onChange={event => props.setReviewers(event.target.value)}/></Field><Field label="评审结论"><select value={props.conclusion} onChange={event => props.setConclusion(event.target.value as Conclusion)}><option>通过</option><option>补充后通过</option></select></Field></div>
    <Field label="需补充内容" hint="选择“补充后通过”时必填"><textarea value={props.reason} onChange={event => props.setReason(event.target.value)}/></Field>
    <div className="form-grid"><Field label="架构说明手册修订意见"><textarea value={props.handbookNotes} onChange={event => props.setHandbookNotes(event.target.value)} placeholder="仅修订时填写"/></Field><Field label="开发文档修订意见"><textarea value={props.devdocNotes} onChange={event => props.setDevdocNotes(event.target.value)} placeholder="仅修订时填写"/></Field></div>
    <p className="help-note">确认后，开发文档会写进 Sol 的工作区并作为构建参考；MVP 规格与已确认框架的优先级更高。</p>
    <div className={`btnbar gate-actions${props.open ? ' is-sticky' : ''}`}><button className="gate" disabled={locked} onClick={() => void props.submit('approve')}>确认文档并开始构建</button><button disabled={locked} onClick={() => void props.submit('revise')}>按意见修订</button><button disabled={locked} onClick={() => void props.submit('back_to_framework')}>回到框架确认</button><button className="danger ghost" disabled={locked} onClick={() => void props.submit('stop')}>停止并保存记录</button></div>
  </div></div></section>;
}

function Gate5(props: { open: boolean; busy: boolean; reviewers: string; setReviewers: (v: string) => void; conclusion: Conclusion; setConclusion: (v: Conclusion) => void; reason: string; setReason: (v: string) => void; prdNotes: string; setPrdNotes: (v: string) => void; submit: (action: PrdGateAction) => Promise<void> }) {
  const locked = props.busy || !props.open;
  return <section className={`doc-gate gate-section gate-wrap${props.open ? '' : ' is-readonly'}`} aria-label="G5 确认产品需求文档"><div className="decision-card"><div className="decision-in"><SectionTitle eyebrow="G5 · 由你决定" title="确认产品需求文档"><Badge tone="info">{props.open ? '等待确认' : '当前只读'}</Badge></SectionTitle>
    <div className="form-grid"><Field label="评审人及角色"><input value={props.reviewers} onChange={event => props.setReviewers(event.target.value)}/></Field><Field label="评审结论"><select value={props.conclusion} onChange={event => props.setConclusion(event.target.value as Conclusion)}><option>通过</option><option>补充后通过</option></select></Field></div>
    <Field label="需补充内容" hint="选择“补充后通过”时必填"><textarea value={props.reason} onChange={event => props.setReason(event.target.value)}/></Field>
    <Field label="PRD 修订意见"><textarea value={props.prdNotes} onChange={event => props.setPrdNotes(event.target.value)} placeholder="需要修订时填写"/></Field>
    <div className={`btnbar gate-actions${props.open ? ' is-sticky' : ''}`}><button className="gate" disabled={locked} onClick={() => void props.submit('approve')}>确认 PRD</button><button disabled={locked} onClick={() => void props.submit('revise')}>按意见修订</button><button className="danger ghost" disabled={locked} onClick={() => void props.submit('stop')}>停止，保留草稿</button></div>
  </div></div></section>;
}

function PrdEvidence({ detail }: { detail: DocDetail }) {
  return <aside className="prd-evidence"><section><h3>评审前检查</h3>{detail.checklist?.map((item, index) => <div className={`check-item ${item.ok ? 'ok' : 'warn'}`} key={`${index}-${item.text}`}><b>{item.ok ? '✓' : '!'}</b><span>{item.text}<small>{item.note}</small></span></div>)}</section><section><h3>需求追踪矩阵</h3>{detail.traceability?.map(item => <details key={item.requirementId}><summary>{item.requirementId} · {item.requirementName}</summary><dl><dt>范围</dt><dd>{item.decision}</dd><dt>功能</dt><dd>{item.featureIds.join('、') || '—'}</dd><dt>验收</dt><dd>{item.acIds.join('、') || '—'}</dd><dt>MVP 结果</dt><dd>{item.mvpItems.map(value => `${value.specAcceptanceId}：${value.exec.status}`).join('；') || '本期未验证'}</dd></dl></details>)}</section></aside>;
}

export function renderUrl(runId: string, kind: DocKind, version: number) { return `/api/runs/${encodeURIComponent(runId)}/docs/${kind}/${version}/render`; }
export function downloadUrl(runId: string, kind: DocKind, version: number, format: 'html' | 'md') { return `/api/runs/${encodeURIComponent(runId)}/docs/${kind}/${version}/download?format=${format}`; }
export function selectedDocVersion(overview: { current: Record<DocKind, number | null>; versions: { kind: DocKind; version: number }[] } | null, kind: DocKind, manual?: number) {
  return manual ?? overview?.current[kind] ?? overview?.versions.filter(item => item.kind === kind).at(-1)?.version;
}
