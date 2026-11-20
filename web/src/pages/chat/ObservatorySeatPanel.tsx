// 席位 panel for the 协作详情 inspector (BUILD-SPEC-B §4.9, §5.1): the focused seat, else the root lead. Georgia name,
// role, status, effort meter, model, a context bar (接近软限制 from the latest hand-over) and upstream / downstream.
// The inspector renders the pin note and 最近协作动态 around it. Styles live in observatory.css under `.seat-panel`.
import type { CSSProperties } from 'react';
import type { Observatory } from './observatoryModel';
import { CHIP_WORDS, Chip, EffortMeter, effortLabel, effortSource, formatTokens, roleKind } from './ObservatoryParts';
import { contextUsage } from './observatoryScene';
import { seatInk } from './observatoryTheme';
import type { SeatPanelProps } from './workspaceContracts';
import './observatory.css';

const ROTATION_LABELS: Record<string, string> = { soft: '接近软限制', hard: '达到硬限制', yield: '主动交接', wait: '等待外部结果', time: '窗口时限', actions: '工具动作上限', crash: '异常恢复' };

function names(model: Observatory, ids: string[]) {
  return ids.map(id => model.roles.find(role => role.id === id)?.label ?? id);
}

export function SeatPanel({ model, seat }: SeatPanelProps) {
  const role = model.roles.find(item => item.id === seat) ?? model.roles.find(item => item.id === model.rootRole) ?? model.roles[0];
  if (!role) return <section className="seat-panel" aria-label="席位"><p className="seat-panel-empty">当前没有可查看的席位记录。</p></section>;
  const root = role.id === model.rootRole;
  const userGate = model.pipeline.gateMode === 'user';
  const kind = root && userGate ? 'hold-user' : roleKind(role);
  const word = root && userGate ? '等你决定' : CHIP_WORDS[kind];
  const parents = names(model, model.links.filter(link => link.to === role.id).map(link => link.from));
  const children = names(model, model.links.filter(link => link.from === role.id).map(link => link.to));
  const usage = contextUsage(role);
  const known = usage.fraction != null;
  const rotation = usage.rotation ? ROTATION_LABELS[usage.rotation] ?? '已交接' : undefined;
  const done = role.tasks.filter(task => task.status === 'completed').length;
  const ink = { '--ink-s': seatInk(role.id), '--node-color': seatInk(role.id) } as CSSProperties;
  return <section className="seat-panel" aria-label={'席位 · ' + role.label} style={ink}>
    <div className="seat-panel-head">
      <i className="seat-panel-dot" aria-hidden="true" />
      <h3>{role.label}</h3>
      {root ? <span className="tag">主控</span> : null}
      <Chip kind={kind}>{word}</Chip>
    </div>
    <p className="seat-panel-role">{role.description}</p>
    <dl className="seat-panel-kv">
      <dt>思考档位</dt>
      <dd><span className="seat-panel-effort"><EffortMeter effort={role.effort} large /><b>{effortLabel(role.effort)}</b>
        <span className="seat-panel-source" data-kind={role.effort?.source ?? 'unknown'}>{effortSource(role.effort)}</span></span></dd>
      <dt>调用模型</dt>
      <dd>{role.model ? <><code>{role.model}</code> <span className="seat-panel-source" data-kind={role.modelSource}>{role.modelSource === 'recorded' ? '调用记录' : '席位配置'}</span></>
        : <span className="seat-panel-muted">未报告</span>}</dd>
      <dt>上下文</dt>
      <dd>
        <span className="seat-panel-usage" data-unknown={!known || undefined}>
          <span className="seat-panel-bar" aria-hidden="true"><i style={{ width: Math.min(100, usage.fraction ?? 0) + '%' }} /></span>
          <code>{known ? formatTokens(usage.used, false) + ' / ' + formatTokens(usage.hard, false) + ' · ' + usage.fraction + '%' : '上下文占用未知 · 尚无调用报告'}</code>
        </span>
        {rotation ? <span className="tag wait">{rotation}</span> : null}
      </dd>
      <dt>本轮任务</dt>
      <dd><code>{done} / {role.tasks.length}</code></dd>
      <dt>上游</dt>
      <dd>{parents.length ? parents.join('、') : root ? '—（根任务）' : '—'}</dd>
      <dt>下游</dt>
      <dd>{children.length ? children.length + ' · ' + children.join('、') : '—'}</dd>
    </dl>
  </section>;
}
