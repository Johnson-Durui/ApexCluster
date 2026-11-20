// 环境与连接 (#/environment, BUILD-SPEC-B §6.4): head + KPI strip, then a section nav (status glyphs, scroll-spy) beside
// one scrolling column: 检查结果 · 命令行工具 · <SettingsPanel/> (WP3) · 选择性真实探测. The free read-only check runs on
// open; 重新读取检查 never wipes the last paid probe's results. A failed paid probe reports in the probe zone, not in the
// column-top alert several screens up, because its form resets either way.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../lib/api';
import { chatApi, type ChatCapabilities } from '../../lib/chat-api';
import { formatDate } from '../../lib/labels';
import { EmptyState, Icon, Modal, STATUS_GLYPH, type StatusKind } from '../../components/ui';
import { Crumb } from '../../components/shell/TopBar';
import { StatusCell, StatusCells, TopBarActions, TopBarTitle } from '../../components/shell/ShellSlots';
import SettingsPanel from '../chat/SettingsPanel';
import { SectionNav, type NavItem } from './SectionNav';
import { LiveProbe } from './LiveProbe';
import { apiKind, findingCounts, findingsKind, hhmm, levelKind, levelText, liveKind, platformParts, PROBE_TARGETS, servicesKind, toolsKind, type LiveResult, type LiveTarget, type ProbeReport, type ProbeResponse } from './environmentModel';
import './environment.css';

/** The paid-probe failure line shown right under the probe zone (the selection has already been cleared). */
export const liveProbeFailure = (cause: unknown) => `真实探测未完成：${cause instanceof Error && cause.message ? cause.message : '请求失败'}`;

export function LiveProbeError({ message, alertRef }: { message: string; alertRef?: RefObject<HTMLDivElement | null> }) {
  return <div className="alert bad live-error" role="alert" ref={alertRef}>
    <strong>{message}</strong>
    <p>所选目标和额度确认已清除；如需重试，请重新选择并确认。</p>
  </div>;
}

function Kpi({ value, word, kind, caption, tone }: { value: string; word: string; kind?: StatusKind; caption: string; tone?: 'wait' | 'err' }) {
  return <div className={`kpi${tone ? ` is-${tone}` : ''}`}>
    <b className="kpi-num numeral">{value}</b>
    <span className={`kpi-word${kind ? ` st ${kind}` : ''}`}>{kind ? <i aria-hidden="true">{STATUS_GLYPH[kind]}</i> : null}{word}</span>
    <small>{caption}</small>
  </div>;
}

export default function EnvironmentPage() {
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [last, setLast] = useState<{ at: string; results: LiveResult[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'check' | 'live' | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [liveError, setLiveError] = useState('');
  const liveAlert = useRef<HTMLDivElement>(null);
  const [pendingLive, setPendingLive] = useState<LiveTarget[] | null>(null);
  const [capabilities, setCapabilities] = useState<ChatCapabilities | null>(null);
  const [dirty, setDirty] = useState(0);

  const readOnlyProbe = useCallback(async () => {
    setBusy('check'); setError('');
    try { setReport((await api.post<ProbeResponse>('/api/probe', { live: [], confirmCost: false })).env); }
    catch (e) { setError(e instanceof Error ? e.message : '环境检查失败'); }
    finally { setBusy(null); }
  }, []);
  useEffect(() => { void readOnlyProbe(); }, [readOnlyProbe]);
  useEffect(() => {
    let controller = new AbortController();
    const load = () => { controller.abort(); controller = new AbortController(); const signal = controller.signal; chatApi.capabilities(signal).then(value => { if (!signal.aborted) setCapabilities(value); }).catch(() => undefined); };
    load();
    window.addEventListener('workbench:capabilities-changed', load);
    return () => { controller.abort(); window.removeEventListener('workbench:capabilities-changed', load); };
  }, []);

  const runLive = () => {
    if (busy || !confirmed || !selected.length) return;
    setPendingLive(PROBE_TARGETS.filter(item => selected.includes(item.id)).map(({ role, effort }) => ({ role, effort })));
  };
  const confirmLive = async () => {
    if (busy || !pendingLive?.length) return;
    const live = pendingLive;
    setPendingLive(null);
    setBusy('live'); setRunning(live.length); setLiveError('');
    try {
      const response = await api.post<ProbeResponse>('/api/probe', { live, confirmCost: true });
      setReport(response.env); setError('');
      setLast({ at: response.env.at ?? new Date().toISOString(), results: response.live });
    } catch (e) { setLiveError(liveProbeFailure(e)); }
    finally { setBusy(null); setRunning(null); setSelected([]); setConfirmed(false); }   // cost safety: a paid probe never re-arms itself
  };

  // The probe zone sits at the end of a long column; bring the failure into view next to it.
  useEffect(() => { if (liveError) liveAlert.current?.scrollIntoView({ block: 'nearest' }); }, [liveError]);

  const counts = report ? findingCounts(report.findings) : null;
  const platform = report ? platformParts(report.platform) : null;
  const navItems: NavItem[] = [
    { id: 'env-findings', label: '检查结果', group: '检查', status: findingsKind(report) },
    { id: 'env-tools', label: '命令行工具', status: toolsKind(report) },
    { id: 'env-runtime', label: '运行状态', group: '设置', status: servicesKind(capabilities?.services), statusWord: servicesKind(capabilities?.services) === 'idle' ? '未配置' : undefined },
    { id: 'env-api', label: 'API 名册与预设', status: apiKind(capabilities?.apiConfiguration), statusWord: apiKind(capabilities?.apiConfiguration) === 'idle' ? '未配置' : undefined },
    { id: 'env-docworker', label: '文档 Docker 服务' },
    { id: 'env-mcp', label: 'MCP 服务' },
    { id: 'env-skills', label: 'Skill 来源' },
    { id: 'env-media', label: '多模态服务' },
    { id: 'env-advanced', label: '高级 JSON 配置' },
    { id: 'env-live', label: '选择性真实探测', group: '会消耗额度', status: liveError ? 'err' : liveKind(last?.results) },
  ];
  return <div className="env-page">
    <TopBarTitle><Crumb current="环境与连接" /></TopBarTitle>
    <TopBarActions><button type="button" className="btn ghost" onClick={() => void readOnlyProbe()} disabled={busy !== null}><Icon name="refresh" size={15} />{busy ? '检查中…' : '重新读取检查'}</button></TopBarActions>
    <StatusCells>
      <StatusCell>{busy === 'check' ? '正在检查…' : report ? `检查于 ${hhmm(report.at)}` : '尚未完成检查'}</StatusCell>
      {dirty ? <StatusCell>{dirty} 项未保存更改</StatusCell> : null}
    </StatusCells>

    <header className="env-head">
      <div className="env-title"><h1>环境与连接</h1><p>本机检查 · 全局设置 · 真实探测</p></div>
      <section className="kpis" aria-label="检查概况">
        <Kpi value={platform?.name ?? '—'} word={platform?.release ? `平台 · ${platform.release}` : '平台'} caption={`Node.js ${report?.node ?? '—'}`} />
        <Kpi value={counts ? String(counts.ok).padStart(2, '0') : '—'} word="正常" kind="ok" caption="检查项" />
        <Kpi value={counts ? String(counts.warn).padStart(2, '0') : '—'} word="需注意" kind="child" tone={counts?.warn ? 'wait' : undefined} caption="不阻止使用，但建议处理" />
        <Kpi value={counts ? String(counts.error).padStart(2, '0') : '—'} word="有问题" kind="err" tone={counts?.error ? 'err' : undefined} caption={report ? `检查时间 ${formatDate(report.at)}` : '尚未完成检查'} />
      </section>
    </header>

    <div className="env-grid">
      <div className="env-nav"><SectionNav label="设置章节" items={navItems} /></div>
      <div className="env-main">
        {error ? <div className="alert bad env-alert" role="alert"><span>{error}</span><button type="button" className="btn sm" disabled={busy !== null} onClick={() => void readOnlyProbe()}>重新读取检查</button></div> : null}
        <section className="panel" id="env-findings" aria-labelledby="findings-title">
          <div className="env-ptitle"><span className="eyebrow">免费 · 只读</span><h2 id="findings-title">检查结果</h2></div>
          <p className="env-lead">页面打开时只运行本机读取检查，不调用任何模型，也不消耗额度。</p>
          <div className="alert info">工作台通过 <strong>Claude Code 命令行</strong>调用 Claude。Claude 桌面应用已登录不代表命令行已经就绪，请以这里的 Claude Code 登录检查为准。</div>
          {!report ? <EmptyState title={busy ? '正在读取环境…' : '暂无检查结果'} icon="shield" role={busy ? 'status' : undefined} /> : <ul className="finding-list">{report.findings.map(item => <li className={`finding ${item.level}`} key={item.id}>
            <span className={`finding-glyph st ${levelKind[item.level]}`} aria-hidden="true"><i>{STATUS_GLYPH[levelKind[item.level]]}</i></span>
            <div><strong>{item.message}</strong>{item.detail ? <small>{item.detail}</small> : null}</div>
            <span className={`finding-level st ${levelKind[item.level]}`}>{levelText[item.level]}</span>
          </li>)}</ul>}
        </section>
        <section className="panel" id="env-tools" aria-labelledby="tools-title">
          <div className="env-ptitle"><h2 id="tools-title">命令行工具</h2></div>
          {report ? <div className="table-scroll"><table className="env-tools"><thead><tr><th>工具</th><th>版本</th><th>路径</th><th>调用方式</th></tr></thead><tbody>{Object.entries(report.tools).map(([name, tool]) => <tr key={name}><td><b>{name}</b></td><td className="mono">{tool.version ?? '未读取'}</td><td className="mono">{tool.path ?? '未安装'}</td><td>{tool.via ?? '—'}</td></tr>)}</tbody></table></div> : <p className="muted env-empty">检查完成后显示。</p>}
        </section>
        <section className="env-settings" aria-labelledby="settings-title">
          <h2 id="settings-title" className="sr-only">全局设置</h2>
          <SettingsPanel onDirtyChange={setDirty} />
        </section>
        <LiveProbe selected={selected} onSelected={setSelected} confirmed={confirmed} onConfirmed={setConfirmed} disabled={busy !== null || Boolean(pendingLive)} running={running} onRun={runLive} last={last} />
        {liveError ? <LiveProbeError message={liveError} alertRef={liveAlert} /> : null}
      </div>
    </div>
    {pendingLive ? <ProbeSheet count={pendingLive.length} busy={busy !== null} onBack={() => setPendingLive(null)} onConfirm={() => void confirmLive()} /> : null}
  </div>;
}

function ProbeSheet({ count, busy, onBack, onConfirm }: { count: number; busy: boolean; onBack(): void; onConfirm(): void }) {
  const back = useRef<HTMLButtonElement>(null);
  return <Modal title="确认运行真实探测" size="sm" initialFocus={back} onClose={onBack}
    footer={<><button ref={back} type="button" className="btn" onClick={onBack}>返回</button><button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>确认并运行</button></>}>
    <p>将真实调用 {count} 个模型目标，会消耗订阅额度。确认继续？</p>
  </Modal>;
}
