// History inspector (BUILD-SPEC-B §6.2, §7 row 22). With a selection: id, title, 下一步 card, G1–G5 track, per-seat
// model-minute bars and mini KPIs from GET /api/runs/:id/metrics (AbortController; the latest selection wins).
// Without one: the static 评审流程, 模型配置 and 本机环境 guide.
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { api } from '../../lib/api';
import { formatDate, phaseLabels, roleLabel } from '../../lib/labels';
import type { AppConfig, Effort, ModelRole, RunMetrics, RunSummary } from '../../lib/types';
import { Icon, SeatDot, Status, Tag } from '../../components/ui';
import { reducedMotion, tweenNumber } from '../../components/motion';
import { outcomeText, runState, waitingText } from './homeModel';
import { formatMinutes, gateCells, kpiParts, metricsStale, miniKpis, runKind, seatMinutes, type MetricsState, type SeatMinutes } from './historyModel';

const GATE_STEPS = [
  ['G1', '回答问题', '两位模型提出带选项的澄清问题，你回答或采用默认。'],
  ['G2', '确认框架', '查看规则结论、评分依据和分歧，确认候选与 MVP 范围。'],
  ['G3', '确认文档', '确认架构说明手册与开发文档，构建才会开始。'],
  ['G4', '验收 MVP', '以 Sol 的执行日志和你的人工结果为准接受或重试。'],
  ['G5', '确认 PRD', '依据真实结果撰写的 PRD 由你确认或修订。'],
] as const;
const ROLES: ModelRole[] = ['claude', 'astra', 'sol', 'grok'];
const ROLE_DUTY: Record<ModelRole, string> = { claude: '澄清 · 提案 · 评审 · 文档', astra: '澄清 · 提案 · 评审 · Ultra 裁决', sol: '构建最小 MVP', grok: '摘要 · 问题分组提示' };
const EFFORT: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
const seatName = (role: string) => (roleLabel as Record<string, string>)[role] ?? role;

/** A number that counts from the value it currently shows (§7 row 22: 800ms). Ticks only while a tween runs. */
export function CountUp({ value, format, animate }: { value: number; format(value: number): ReactNode; animate: boolean }) {
  const [shown, setShown] = useState(value);
  const painted = useRef(value);
  useEffect(() => {
    if (!animate) { painted.current = value; setShown(value); return; }
    return tweenNumber({ from: painted.current, to: value, duration: 800, onUpdate: next => { painted.current = next; setShown(next); } });
  }, [value, animate]);
  return <>{format(shown)}</>;
}

/** Per-seat model-minute bars. A seat with no known bucket shows `未知` and no bar (never a zero-width bar). */
export function SeatBars({ seats, unknownTotal, animate, stale = false, error = '' }: { seats: SeatMinutes[] | null; unknownTotal: number; animate: boolean; stale?: boolean; error?: string }) {
  const max = Math.max(0, ...(seats ?? []).filter(seat => seat.known).map(seat => seat.minutes));
  return <section className="hi-seats" aria-label="席位模型分钟" aria-busy={stale || undefined} data-stale={stale ? '' : undefined} data-animate={animate ? '' : undefined}>
    <div className="hi-sec-head"><h3>席位模型分钟</h3><small>{unknownTotal > 0 ? `程序时间戳 · 未知 ${unknownTotal} 项不按 0 计` : '程序时间戳'}</small></div>
    {error ? <p className="hi-bars-note"><b>—</b>指标读取失败：{error}</p>
      : !seats ? <p className="hi-bars-note" role="status">正在读取运行指标…</p>
        : !seats.length ? <p className="hi-bars-note">暂无席位用时记录</p>
          : <div className="hi-bars">{seats.map(seat => <div className="hi-bar" data-seat={seat.role} key={seat.role}>
            <span className="hi-bar-name"><SeatDot seat={seat.role} />{seatName(seat.role)}</span>
            {seat.known
              ? <><span className="hi-track" aria-hidden="true"><i style={{ transform: `scaleX(${max > 0 ? seat.minutes / max : 0})` }} /></span><span className="hi-bar-value mono"><CountUp value={seat.minutes} format={formatMinutes} animate={animate} /> 分</span></>
              : <span className="hi-bar-unknown">未知{seat.unknownCount ? ` · ${seat.unknownCount} 项缺少时间` : ''}</span>}
          </div>)}</div>}
  </section>;
}

function MiniKpis({ metrics, animate, stale }: { metrics: RunMetrics | null; animate: boolean; stale: boolean }) {
  return <div className="hi-kpis" aria-busy={stale || undefined} data-stale={stale ? '' : undefined}>{miniKpis(metrics).map(item => <div key={item.label}>
    <small>{item.label}</small>
    <b className="numeral">{typeof item.value === 'number' ? <CountUp value={item.value} format={value => { const [text, unit] = kpiParts(value, item.kind); return <>{text}<i>{unit}</i></>; }} animate={animate} /> : item.value}</b>
  </div>)}</div>;
}

function NextStep({ run }: { run: RunSummary }) {
  const state = runState(run);
  const href = `#/runs/${run.id}`;
  if (state === 'waiting') return <div className="gate-wrap hi-next-wrap"><div className="decision-card"><div className="decision-in">
    <div className="hi-next-row"><Status kind="you">等你决定 · {waitingText(run)}</Status><a className="btn gate outline sm" href={href}>前往处理 →</a></div>
    <p>运行停在关卡，需要你确认。确认后由服务端继续下一步。</p>
  </div></div></div>;
  if (state === 'blocked') return <div className="hi-next is-block">
    <div className="hi-next-row"><Status kind="block">已阻塞，等待你重试或继续</Status><a className="btn sm" href={href}>查看原因 →</a></div>
    <p>阶段：{phaseLabels[run.phase] ?? run.phase}。在运行详情中查看失败的任务，选择重试或继续。</p>
  </div>;
  if (state === 'active') {
    const tasks = run.activeTasks ?? [];
    return <div className="hi-next">
      <div className="hi-next-row"><Status kind="run">进行中 · {phaseLabels[run.phase] ?? run.phase}</Status></div>
      {tasks.length ? <ul className="hi-tasks">{tasks.map((task, index) => <li key={`${task.role}-${index}`} data-seat={task.role}><SeatDot seat={task.role} />{seatName(task.role)} · {phaseLabels[task.phase] ?? task.phase} · {task.status === 'queued' ? '排队中' : '进行中'}</li>)}</ul> : <p>正在准备下一步</p>}
    </div>;
  }
  return <div className="hi-next"><div className="hi-next-row"><Status kind={runKind(run)}>{outcomeText(run)}</Status></div></div>;
}

function RunDetail({ run, animate }: { run: RunSummary; animate: boolean }) {
  const [shown, setShown] = useState(run);
  const [swapping, setSwapping] = useState(false);
  const [metrics, setMetrics] = useState<MetricsState | null>(null);
  useEffect(() => {
    if (run.id === shown.id || !animate || reducedMotion()) { setShown(run); setSwapping(false); return; }
    setSwapping(true);
    const timer = window.setTimeout(() => { setShown(run); setSwapping(false); }, 160);
    return () => window.clearTimeout(timer);
  }, [run, animate]);
  // Keyed on id + updatedAt: 刷新 or a list refetch that brings a newer summary re-reads the metrics (latest wins).
  useEffect(() => {
    const controller = new AbortController();
    const version = { id: run.id, updatedAt: run.updatedAt };
    api.get<RunMetrics>(`/api/runs/${encodeURIComponent(run.id)}/metrics`, controller.signal)
      .then(data => { if (!controller.signal.aborted) setMetrics({ ...version, data }); })
      .catch(cause => { if (!controller.signal.aborted) setMetrics({ ...version, error: cause instanceof Error ? cause.message : '读取失败' }); });
    return () => controller.abort();
  }, [run.id, run.updatedAt]);
  const stale = metricsStale(metrics, run);
  const data = metrics?.data ?? null;
  const legacy = shown.mode === 'mock';
  return <div className="hi-body">
    <div className="hi-cap" data-swap={swapping ? '' : undefined}>
      <div className="hi-meta"><span className="mono">{shown.id}</span>{legacy ? <Tag tone="mock">模拟数据</Tag> : <Tag>真实运行</Tag>}<span className="mono hi-upd">更新于 {formatDate(shown.updatedAt)}</span></div>
      <h2>{shown.title}</h2>
      <NextStep run={shown} />
      <ol className="hi-gates" aria-label="关卡进度">{gateCells(shown).map(cell => <li key={cell.key} className={`is-${cell.state}${cell.kind === 'you' ? ' is-you' : ''}`}><b className="mono">{cell.key}</b><span>{cell.label}</span><Status kind={cell.kind}>{cell.word}</Status></li>)}</ol>
    </div>
    <SeatBars seats={data ? seatMinutes(data) : null} unknownTotal={data?.modelTime.total.unknownCount ?? 0} animate={animate} stale={stale && Boolean(metrics)} error={!stale ? metrics?.error : ''} />
    <MiniKpis metrics={metrics?.error && !stale ? null : data} animate={animate} stale={stale && Boolean(data)} />
    <a className="btn hi-open" href={`#/runs/${run.id}`}>打开运行详情 →</a>
  </div>;
}

function Guide({ config, configError, onRetryConfig }: { config: AppConfig | null; configError: boolean; onRetryConfig(): void }) {
  return <div className="hi-body">
    <section className="hi-guide" aria-labelledby="hi-flow"><h2 id="hi-flow">评审流程</h2>
      <ol className="hi-steps">{GATE_STEPS.map(([key, title, text]) => <li key={key}><b className="mono">{key}</b><div><span>{title}</span><small>{text}</small></div></li>)}</ol>
    </section>
    <section className="hi-guide" aria-labelledby="hi-models"><div className="hi-sec-head"><h2 id="hi-models">模型配置</h2><small>型号固定，不自动降级</small></div>
      {config ? <ul className="hi-models">{ROLES.flatMap(role => { const model = config.models[role]; return model ? [<li key={role} data-seat={role}><SeatDot seat={role} /><div><b>{roleLabel[role]}</b><small>{ROLE_DUTY[role]}</small><span className="mono">{model.model}</span></div><Tag>{EFFORT[model.effort] ?? model.effort}</Tag></li>] : []; })}</ul>
        : configError ? <div className="hi-config-error" role="alert"><span>模型配置暂不可用</span><button type="button" className="btn sm" onClick={onRetryConfig}>重试</button></div>
          : <p className="muted" role="status">正在读取配置…</p>}
      {config?.models.grok && !config.cursorCapabilities?.available && config.models.grok.adapter !== 'mock' ? <p className="help-note">Grok / Cursor：待验证 · {config.cursorCapabilities?.reason || '尚无受信任能力记录'}</p> : null}
      {config?.docWriter ? <p className="help-note">文档撰写者：{roleLabel[config.docWriter.role]} · {EFFORT[config.docWriter.effort] ?? config.docWriter.effort}（新建时可调整强度）</p> : null}
    </section>
    <section className="hi-guide" aria-labelledby="hi-env"><h2 id="hi-env">本机环境</h2>
      <p className="help-note">真实运行前，请确认 Claude Code 与 Codex CLI 已登录、Windows 沙箱与长路径设置符合要求。只读检查不消耗额度。</p>
      <a className="btn" href="#/environment"><Icon name="shield" size={15} />打开环境检查</a>
    </section>
  </div>;
}

export interface InspectorProps {
  run: RunSummary | null;
  config: AppConfig | null; configError: boolean; onRetryConfig(): void;
  /** True once the user changed the selection: bars, numbers and the caption animate only then (never on restore). */
  animate: boolean;
  /** Narrow windows: the inspector covers the queue; Esc or this button returns to the list. */
  onBack?: () => void;
  backRef?: Ref<HTMLButtonElement>;
  /** Narrow windows, just opened by a row click: the overlay lets the pointer through so the trailing click of a
   *  double-click still lands on the row (Enter or double-click opens the run, §6.2). */
  arming?: boolean;
}

export default function HistoryInspector({ run, config, configError, onRetryConfig, animate, onBack, backRef, arming = false }: InspectorProps) {
  return <aside className="hist-insp" aria-label="运行检视" data-open={run ? '' : undefined} data-arming={arming && run ? '' : undefined}>
    {onBack && run ? <button type="button" ref={backRef} className="btn ghost sm hi-back" onClick={onBack}><Icon name="chevron-left" size={14} />返回列表</button> : null}
    {run ? <RunDetail run={run} animate={animate} /> : <Guide config={config} configError={configError} onRetryConfig={onRetryConfig} />}
  </aside>;
}
