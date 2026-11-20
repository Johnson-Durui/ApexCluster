import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { Badge, EmptyState, Icon, SectionTitle } from '../../../components/ui';
import { formatDate, phaseLabels, statusLabel } from '../../../lib/labels';
import type { DocKind, Run, RunPanelProps, ValidationJob } from '../../../lib/types';
import './deliverables.css';

export interface DeliveryJobFiles {
  jobId: string;
  workspaceDir: string;
  available: boolean;
  incomplete?: boolean;
  files: { path: string; size: number }[];
  warnings: string[];
}

export interface DeliverablesResponse { jobs: DeliveryJobFiles[]; generatedAt: string }
type Props = RunPanelProps & { onOpenRecords?: () => void };
type ViewProps = { run: Run; data: DeliverablesResponse; selectedJobId: string | null; onSelectJob: (id: string) => void; onOpenRecords?: () => void };

const activeStatuses = new Set(['queued', 'preparing', 'running', 'verifying', 'evaluating', 'final_review']);
const docLabels: Record<DocKind, string> = { handbook: '架构说明手册', devdoc: '开发文档', prd: '产品需求文档（PRD）' };
const docKinds: DocKind[] = ['handbook', 'devdoc', 'prd'];

export default function DeliveryPanel({ run, onOpenRecords }: Props) {
  const [data, setData] = useState<DeliverablesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    api.get<DeliverablesResponse>(`/api/runs/${encodeURIComponent(run.id)}/deliverables`, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setData(value); setError(''); } })
      .catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : '读取交付成果失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return controller;
  };
  useEffect(() => { const controller = load(); return () => controller.abort(); }, [run.id, run.updatedAt]);

  if (loading && !data) return <section className="panel"><p className="loading" role="status">正在整理交付成果…</p></section>;
  if (error && !data) return <section className="panel"><div className="alert bad" role="alert"><b>交付成果读取失败</b><p>{error}</p><button type="button" onClick={load}><Icon name="refresh" />重试</button></div></section>;
  return <>
    {error ? <div className="alert warn" role="alert">刷新失败，当前显示上一次结果：{error}</div> : null}
    <DeliverablesView run={run} data={data ?? { jobs: [], generatedAt: run.updatedAt }} selectedJobId={selectedJobId} onSelectJob={setSelectedJobId} onOpenRecords={onOpenRecords} onRefresh={load} refreshing={loading} />
  </>;
}

export function DeliverablesView({ run, data, selectedJobId, onSelectJob, onOpenRecords, onRefresh, refreshing = false }: ViewProps & { onRefresh?: () => void; refreshing?: boolean }) {
  const [query, setQuery] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const jobs = useMemo(() => [...run.jobs].sort((a, b) => b.batch - a.batch || b.createdAt.localeCompare(a.createdAt)), [run.jobs]);
  const defaultJob = jobs.find(job => job.candidateId === run.finalChoice?.candidateId) ?? jobs[0] ?? null;
  const selected = jobs.find(job => job.id === selectedJobId) ?? defaultJob;
  const files = selected ? data.jobs.find(item => item.jobId === selected.id) : undefined;
  const proposalTitle = selected ? run.proposals.find(proposal => proposal.id === selected.proposalId)?.title : undefined;
  const copyWorkspace = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setCopyMessage('工作区路径已复制'); }
    catch { setCopyMessage('复制失败，请手动选择路径'); }
  };

  return <div className="delivery-stack">
    <section className="panel delivery-overview">
      <SectionTitle eyebrow={`生成清单于 ${formatDate(data.generatedAt)}`} title="交付成果">
        <div className="row"><Badge tone={run.mode === 'mock' ? 'mock' : 'real'}>{run.mode === 'mock' ? '模拟数据' : '真实运行'}</Badge>{run.terminal ? <Badge>{run.terminal === 'done' ? '运行已结束' : '运行已取消'}</Badge> : <Badge tone="info">{phaseLabels[run.phase] ?? run.phase}</Badge>}{onRefresh ? <button type="button" className="compact" disabled={refreshing} onClick={onRefresh}><Icon name="refresh" size={14} />{refreshing ? '刷新中…' : '刷新文件清单'}</button> : null}</div>
      </SectionTitle>
      <p className="delivery-intro">这里汇总所有历史 MVP 作业。文件清单只说明服务端确认文件存在；是否通过验收请看每个作业的真实验证状态。</p>
      {jobs.length ? <div className="delivery-job-tabs" role="tablist" aria-label="MVP 作业">
        {jobs.map(job => <button key={job.id} type="button" role="tab" aria-selected={job.id === selected?.id} onClick={() => onSelectJob(job.id)}>
          <span><b>第 {job.batch} 批 · {job.candidateId}</b>{run.finalChoice?.candidateId === job.candidateId && job.batch === run.jobBatch ? <Badge tone="ok">最终选择</Badge> : null}</span>
          <small>{job.id} · {statusLabel(job.status)}</small>
        </button>)}</div> : <EmptyState title="本次运行没有创建 MVP 作业" icon="box"><p>{run.terminal === 'cancelled' ? '运行已取消，取消前尚未产生可交付工作区。正式项目文档与决策记录仍列在下方。' : '尚未进入 MVP 构建，因此没有工作区文件或源码整包。正式项目文档与决策记录仍列在下方。'}</p></EmptyState>}
    </section>
    {selected ? <JobDelivery runId={run.id} job={selected} proposalTitle={proposalTitle} files={files} query={query} setQuery={setQuery} copyMessage={copyMessage} copyWorkspace={copyWorkspace} /> : null}
    <ProjectDocuments run={run} />
    <section className="panel delivery-records"><div><h2>决策记录</h2><p>方案评审、框架决定、验收选择和停止原因单独保存在决策记录中。</p></div><div className="row">{onOpenRecords ? <button type="button" onClick={onOpenRecords}><Icon name="list" />查看决策记录</button> : null}<a className="button" href={`/api/runs/${encodeURIComponent(run.id)}/export`} download={`decision-${run.id}.md`}><Icon name="download" />下载决策记录</a></div></section>
  </div>;
}

function JobDelivery({ runId, job, proposalTitle, files, query, setQuery, copyMessage, copyWorkspace }: { runId: string; job: ValidationJob; proposalTitle?: string; files?: DeliveryJobFiles; query: string; setQuery: (value: string) => void; copyMessage: string; copyWorkspace: (path: string) => Promise<void> }) {
  const available = files?.available ?? false;
  const incomplete = files?.incomplete === true;
  const filtered = (files?.files ?? []).filter(file => file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const products = filtered.filter(file => fileKind(file.path) === 'product');
  const materials = filtered.filter(file => fileKind(file.path) === 'material');
  const otherFiles = filtered.filter(file => fileKind(file.path) === 'other');
  const verificationTone = job.verification?.verdict === 'passed' ? 'ok' : job.verification?.verdict === 'failed' ? 'bad' : 'warn';
  return <section className="panel delivery-job">
    <SectionTitle eyebrow={`第 ${job.batch} 批 · ${job.id}`} title={proposalTitle ? `${job.candidateId} · ${proposalTitle}` : `${job.candidateId} · MVP 交付`}>
      <div className="row"><Badge tone={job.status === 'passed' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}>{statusLabel(job.status)}</Badge><Badge tone={verificationTone}>核验：{statusLabel(job.verification?.verdict ?? 'not_observed')}</Badge></div>
    </SectionTitle>
    <details className="delivery-goal"><summary>查看本次构建目标</summary><p>{job.spec.goal}</p></details>
    <dl className="delivery-meta"><dt>工作区</dt><dd><code>{files?.workspaceDir || job.workspaceDir}</code><button type="button" className="compact ghost" onClick={() => void copyWorkspace(files?.workspaceDir || job.workspaceDir)}><Icon name="copy" size={14} />复制</button></dd><dt>规格</dt><dd><code>{job.spec.ref}</code></dd><dt>作业状态</dt><dd>{statusLabel(job.status)}；该状态不会因下载整包而改变。</dd></dl>
    {copyMessage ? <div className="alert info" role="status">{copyMessage}</div> : null}
    {!available ? <><div className="alert bad" role="alert"><b>源码工作区不可用</b><p>目录不存在或当前无法读取，因此不能下载单文件或工作区整包。作业记录和验证结论仍保留。</p></div>{files?.warnings.map((warning, index) => <div className="alert warn" key={`${index}-${warning}`}>{warning}</div>)}</> : <>
      <div className="archive-callout"><div><b>工作区整包</b><p>包含现有源码、成品、资料、程序生成记录、报告和正式项目文档；排除虚拟环境、依赖缓存、.git 与上传副本。整包只是现有结果，不代表验收通过。</p></div>{activeStatuses.has(job.status) ? <button type="button" disabled title="作业仍在写入工作区，完成后才能打包"><Icon name="download" />作业完成后可打包</button> : incomplete ? <button type="button" disabled title="文件扫描不完整，不能生成可靠整包"><Icon name="alert" />扫描不完整</button> : <a className="button primary" href={archiveUrl(runId, job.id)} download><Icon name="download" />下载工作区整包</a>}</div>
      {activeStatuses.has(job.status) ? <div className="alert info" role="status">作业仍在运行或核验，工作区可能继续变化，暂不提供整包下载。</div> : null}
      {incomplete ? <div className="alert bad" role="alert"><b>文件扫描不完整，整包下载已禁用</b><p>部分目录或文件无法读取。请根据下方原因处理后刷新文件清单。</p></div> : null}
      {files?.warnings.map((warning, index) => <div className="alert warn" key={`${index}-${warning}`}>{warning}</div>)}
      <label className="delivery-filter"><span><Icon name="search" size={15} />过滤文件名</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="例如 .exe、README 或 docs/" /></label>
      {!files?.files.length ? <EmptyState title="工作区当前没有可下载文件" icon="file"><p>目录存在，但扫描时没有找到符合交付范围的文件。</p></EmptyState> : !filtered.length ? <EmptyState title="没有匹配的文件" icon="search"><p>换一个文件名或扩展名再试。</p></EmptyState> : <div className="delivery-files"><FileGroup title="可直接使用的成品" note="安装包、ZIP/压缩包、校验和，以及 dist、output、build 根目录中的文件。" files={products} runId={runId} jobId={job.id} /><FileGroup title="关键资料" note="README、MVP_SPEC、DEV_GUIDE 和 docs/ 文档。" files={materials} runId={runId} jobId={job.id} /><details className="file-group other-files" open={Boolean(query.trim())}><summary>其他源码与内部运行库 · {otherFiles.length} 个文件</summary><p>源代码、依赖运行库和其他内部文件默认收起，也会完整包含在工作区整包中。</p><FileTable files={otherFiles} runId={runId} jobId={job.id} /></details></div>}
    </>}
    <RunInstructions job={job} />
  </section>;
}

function FileGroup({ title, note, files, runId, jobId }: { title: string; note: string; files: { path: string; size: number }[]; runId: string; jobId: string }) {
  return <section className="file-group"><div className="file-group-head"><div><h3>{title}</h3><p>{note}</p></div><Badge>{files.length} 个文件</Badge></div>{files.length ? <FileTable files={files} runId={runId} jobId={jobId} /> : <p className="muted">没有此类文件。</p>}</section>;
}

function FileTable({ files, runId, jobId }: { files: { path: string; size: number }[]; runId: string; jobId: string }) {
  return files.length ? <div className="table-scroll"><table><thead><tr><th>文件</th><th>大小</th><th>下载</th></tr></thead><tbody>{files.map(file => <tr key={file.path}><td><code>{file.path}</code></td><td className="num">{formatBytes(file.size)}</td><td><a className="button compact" href={artifactUrl(runId, jobId, file.path)} download><Icon name="download" size={14} />下载</a></td></tr>)}</tbody></table></div> : <p className="muted">没有此类文件。</p>;
}

function RunInstructions({ job }: { job: ValidationJob }) {
  const report = job.report;
  return <section className="delivery-report"><h3>运行与交付说明</h3>{report ? <div className="delivery-report-grid"><div><b>摘要</b><p>{report.summary}</p></div><CommandList title="准备" lines={report.howToRun.setup} /><CommandList title="运行" lines={report.howToRun.run} /><CommandList title="测试" lines={report.howToRun.test} /><div><b>待解决问题</b>{report.openIssues.length ? <ul>{report.openIssues.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="muted">无</p>}</div></div> : <p className="muted">Sol 报告尚未生成，因此暂无 setup、run、test 与待解决问题说明。</p>}</section>;
}

function CommandList({ title, lines }: { title: string; lines: string[] }) {
  return <div><b>{title}</b>{lines.length ? <ol>{lines.map((line, index) => <li key={`${index}-${line}`}><code>{line}</code></li>)}</ol> : <p className="muted">无</p>}</div>;
}

function ProjectDocuments({ run }: { run: Run }) {
  return <section className="panel delivery-docs"><SectionTitle eyebrow="独立正式文档" title="项目文档版本" />
    {run.writeDocs === false ? <div className="alert info"><b>构建前正式文档已关闭</b><p>这只表示本运行不会生成架构说明手册和开发文档；工作区中已有的 README、说明文件和其他资料仍在上方文件清单与整包中。</p></div> : null}
    {run.writePrd === false ? <div className="alert info"><b>PRD 撰写已关闭</b><p>工作区资料仍可下载，不等于资料不存在。</p></div> : null}
    <div className="doc-delivery-list">{docKinds.map(kind => {
      const versions = run.docs.versions.filter(item => item.kind === kind).toReversed();
      return <section key={kind}><h3>{docLabels[kind]}</h3>{versions.length ? <ul>{versions.map(version => <li key={version.version}><div><b>v{version.version}</b><Badge tone={version.status === 'approved' ? 'ok' : version.status === 'draft' ? 'warn' : ''}>{version.status === 'approved' ? '已确认' : version.status === 'draft' ? '草稿' : '历史版本'}</Badge><small>{formatDate(version.createdAt)}</small></div><div className="row"><a className="button compact" href={docDownloadUrl(run.id, kind, version.version, 'md')} download>Markdown</a><a className="button compact" href={docDownloadUrl(run.id, kind, version.version, 'html')} download>HTML</a></div></li>)}</ul> : <p className="muted">{kind === 'prd' ? (run.writePrd === false ? '本运行已关闭 PRD。' : '尚无 PRD 版本。') : (run.writeDocs === false ? '本运行已关闭构建前正式文档。' : '尚无文档版本。')}</p>}</section>;
    })}</div>
  </section>;
}

export function artifactUrl(runId: string, jobId: string, path: string) { return `/api/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/artifact?path=${encodeURIComponent(path)}`; }
export function archiveUrl(runId: string, jobId: string) { return `/api/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/archive`; }
export function docDownloadUrl(runId: string, kind: DocKind, version: number, format: 'md' | 'html') { return `/api/runs/${encodeURIComponent(runId)}/docs/${kind}/${version}/download?format=${format}`; }
export function fileKind(path: string): 'product' | 'material' | 'other' {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  const name = parts.at(-1) ?? '';
  const root = parts[0]?.toLowerCase();
  const rootProjectDoc = parts.length === 1 && /^(?:readme(?:\..+)?|mvp_spec(?:\..+)?|dev_guide(?:\..+)?|agents(?:\..+)?)$/i.test(name);
  if (rootProjectDoc || root === 'docs') return 'material';
  if (parts.some(part => part.toLowerCase() === '_internal')) return 'other';
  const directBuildFile = parts.length === 2 && (root === 'dist' || root === 'output' || root === 'build');
  const rootPackage = parts.length === 1 && /\.(?:exe|msi|zip|7z|tar|gz|dmg|appimage|apk)$/i.test(name);
  if (directBuildFile || rootPackage || /^sha256sums(?:\.txt)?$/i.test(name)) return 'product';
  return 'other';
}
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
