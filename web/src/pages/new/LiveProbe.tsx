// 选择性真实探测 (BUILD-SPEC-B §6.4): an --err-line outlined zone. Targets + acknowledgement + a danger button that
// opens the confirm sheet. Results stay under `上次真实探测 · HH:mm` until a new paid probe runs.
import { duration, roleLabel } from '../../lib/labels';
import { STATUS_GLYPH } from '../../components/ui';
import { hhmm, levelKind, liveLevel, PROBE_TARGETS, type LiveResult } from './environmentModel';

const sourceLabels: Record<string, string> = { server_usage: '服务端用量', cli_config: 'CLI 配置摘要', init_event: '初始化事件' };
const probeStatusLabels: Record<string, string> = { succeeded: '请求执行完成', failed: '请求执行失败', cancelled: '请求已取消', timed_out: '请求已超时', interrupted: '请求已中断' };

export interface LiveProbeProps {
  selected: string[]; onSelected(next: string[]): void;
  confirmed: boolean; onConfirmed(value: boolean): void;
  disabled: boolean; running: number | null; onRun(): void;
  last: { at: string; results: LiveResult[] } | null;
}

function LiveResults({ results }: { results: LiveResult[] }) {
  return <ul className="finding-list live-results">{results.map((item, index) => {
    const level = liveLevel(item);
    const kind = levelKind[level];
    return <li className={`finding ${level}`} key={`${item.role}-${item.effort}-${index}`} data-seat={item.role}>
      <span className={`finding-glyph st ${kind}`} aria-hidden="true"><i>{STATUS_GLYPH[kind]}</i></span>
      <div><strong>{roleLabel[item.role]} · {probeStatusLabels[item.status] ?? item.status}</strong><small>{item.outputValid ? '结构化输出合法' : '结构化输出未通过校验'}{item.failure ? ` · ${item.failure.message}` : ''}</small>
        <dl className="kv"><dt>请求型号 / 强度</dt><dd className="mono">{item.meta.requestedModel || item.model} / {item.meta.requestedEffort || item.effort}</dd><dt>报告型号 / 来源</dt><dd>{item.meta.reportedModels.join(', ') || '未确认'} / {item.meta.reportedModelSource ? sourceLabels[item.meta.reportedModelSource] ?? item.meta.reportedModelSource : '来源未确认'}</dd><dt>确认状态</dt><dd>{item.meta.modelConfirmed ? '型号已确认' : '型号未确认'} · {item.meta.effortConfirmed ? '强度已确认' : '强度未确认'}</dd><dt>用时</dt><dd>{duration(item.meta.durationMs)}</dd></dl>
      </div>
    </li>;
  })}</ul>;
}

export function LiveProbe({ selected, onSelected, confirmed, onConfirmed, disabled, running, onRun, last }: LiveProbeProps) {
  return <section className="panel live-probe" id="env-live" aria-labelledby="live-title">
    <div className="env-ptitle"><span className="eyebrow">会消耗订阅额度</span><h2 id="live-title">选择性真实探测</h2></div>
    <div className="alert warn"><strong>这不是普通环境检查。</strong> 真实探测会向所选模型发出最小请求，用来验证型号、强度、结构化输出和元数据，会消耗订阅额度。</div>
    <div className="target-grid">{PROBE_TARGETS.map(item => <label className={`target${selected.includes(item.id) ? ' active' : ''}`} data-seat={item.role} key={item.id}>
      <input type="checkbox" checked={selected.includes(item.id)} disabled={running !== null} onChange={event => onSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
      <span><strong>{item.label}</strong><small>只调用这一个目标</small></span>
    </label>)}</div>
    <div className="live-actions">
      <label className="check-label"><input type="checkbox" checked={confirmed} disabled={running !== null} onChange={event => onConfirmed(event.target.checked)} />我明确知道这些请求会消耗订阅额度</label>
      <button type="button" className="btn danger" onClick={onRun} disabled={disabled || !confirmed || !selected.length}>运行所选真实探测</button>
    </div>
    {running !== null ? <p className="live-running" role="status">正在运行 {running} 个真实探测… 完成前不会再次发出请求。</p> : null}
    {last ? <div className="live-last"><h3>上次真实探测 · {hhmm(last.at)}</h3>{last.results.length ? <LiveResults results={last.results} /> : <p className="muted">本次没有返回探测结果。</p>}</div> : null}
  </section>;
}
