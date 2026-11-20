// 运行状态 (#env-runtime) and 文档 Docker 服务 (#env-docworker). ServiceStatusList is also the read-only list in the
// chat inspector's 设置 tab, so it carries no form state.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ChatSettings, ExecCapability, ServiceCapability } from '../../../lib/chat-api';
import ExecCapabilityNotice from '../ExecCapabilityNotice';

export const stateLabels: Record<ServiceCapability['state'], string> = {
  disabled: '已停用', unconfigured: '未配置', unavailable: '不可用', unhealthy: '异常', drifted: '配置漂移', ready: '已就绪', degraded: '降级运行',
};
/** Glyph per state (the word is always shown next to it; colour comes from the li state class). */
const stateGlyphs: Record<ServiceCapability['state'], string> = {
  disabled: '○', unconfigured: '○', unavailable: '⊘', unhealthy: '✕', drifted: '✕', ready: '✓', degraded: '‖',
};

export function ServiceStatusList({ services }: { services: ServiceCapability[] }) {
  return services.length ? <ul className="service-status-list">{services.map(service => <li key={service.id} className={`state-${service.state}`}>
    <span className="service-state-mark" aria-hidden="true">{stateGlyphs[service.state]}</span><div><b>{service.name}</b><small>{stateLabels[service.state]}{service.reason ? ` · ${service.reason}` : ''}</small>{service.tools.length ? <span>{service.tools.length} 个工具</span> : null}</div>
  </li>)}</ul> : <p className="muted">服务状态尚未返回；不能据此认定能力已就绪。</p>;
}

export function RuntimeSection({ exec, services, loading, saving, dirty, onReload, headingRef }: {
  exec?: ExecCapability;
  services: ServiceCapability[];
  loading: boolean;
  saving: boolean;
  /** Unsaved changes. 重载状态 asks inline before it overwrites them. */
  dirty: number;
  onReload(): void;
  /** The 运行状态 heading (focusable with tabIndex -1), shared so the panel can move focus to it. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  // The confirm only stands while there is something to lose. Once the changes are saved or discarded it closes for
  // good, so a later edit never reopens it (or pulls focus) on its own.
  if (confirming && dirty === 0) setConfirming(false);
  const asking = confirming && dirty > 0;
  const trigger = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  /** Set by the 重载状态 click: focus moves into the confirm only when the user opened it. */
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!asking || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    back.current?.focus();
  }, [asking]);
  const open = () => {
    if (dirty === 0) { onReload(); return; }
    focusOnOpen.current = true;
    setConfirming(true);
  };
  // Both answers unmount the focused button, so focus moves first: 返回 goes back to the trigger; 丢弃更改并重载
  // goes to the heading, because the trigger is disabled while the reload runs.
  const cancel = () => { setConfirming(false); trigger.current?.focus(); };
  const confirm = () => { setConfirming(false); heading.current?.focus(); onReload(); };
  return <section className="panel settings-card settings-status" id="env-runtime" aria-labelledby="service-status-heading">
    <div className="settings-section-title">
      <div><h2 id="service-status-heading" ref={heading} tabIndex={-1}>运行状态</h2><p>只有“已就绪”表示当前可用；未配置、漂移或降级不会被当作完整能力。</p></div>
      <button type="button" className="button compact" ref={trigger} disabled={loading || saving} aria-expanded={dirty > 0 ? asking : undefined}
        onClick={open}>{loading ? '重载中…' : '重载状态'}</button>
    </div>
    {asking ? <div className="settings-inline-confirm" role="group" aria-label="确认重载状态">
      <p>重新读取会用服务端配置覆盖表单，并丢弃 {dirty} 项未保存更改。</p>
      <button type="button" className="button compact danger" onClick={confirm}>丢弃更改并重载</button>
      <button type="button" className="button compact" ref={back} onClick={cancel}>返回</button>
    </div> : null}
    <ExecCapabilityNotice capability={exec} />
    <ServiceStatusList services={services} />
  </section>;
}

export function DocWorkerSection({ settings, onChange }: { settings: ChatSettings; onChange(update: (current: ChatSettings) => ChatSettings): void }) {
  const worker = settings.documentWorker;
  return <section className="panel settings-card" id="env-docworker" aria-labelledby="env-docworker-heading">
    <div className="settings-section-title">
      <div><h2 id="env-docworker-heading">文档 Docker 服务</h2><p>仅允许本机 HTTP 地址。</p></div>
      <label className="settings-switch"><input type="checkbox" checked={worker.enabled} onChange={event => { const enabled = event.target.checked; onChange(current => ({ ...current, documentWorker: { ...current.documentWorker, enabled } })); }} />启用</label>
    </div>
    <label className="settings-field settings-url">本地 URL<input className="mono" value={worker.url} onChange={event => { const url = event.target.value; onChange(current => ({ ...current, documentWorker: { ...current.documentWorker, url } })); }} placeholder="http://127.0.0.1:18781" /></label>
  </section>;
}
