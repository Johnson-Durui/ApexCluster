// DEV-only route #/dev/inspector?tab=&placement=dock|column&state=running|gate|done|demo|empty[&pin=astra][&collapsed=1]
// renders 协作详情 inside a stand-in workspace frame, so the inspector can be checked without the chat page.
// #/dev/inspector?view=settings renders the Environment settings panel (live sandbox API, nothing is saved by itself).
import { useEffect, useMemo, useRef, useState } from 'react';
import { SeatFocusProvider, seatHandlers, useSeatFocus } from '../../components/seatFocus';
import ChatInspector, { INSPECTOR_TABS } from '../../pages/chat/ChatInspector';
import SettingsPanel from '../../pages/chat/SettingsPanel';
import { DEFAULT_INSPECTOR_TAB, type InspectorPlacement, type InspectorTab } from '../../pages/chat/workspaceContracts';
import { INSPECTOR_STATES, inspectorFixture, type InspectorState } from './fixtures';
import './preview.css';

function PinOnMount({ seat }: { seat: string | null }) {
  const { pin } = useSeatFocus();
  useEffect(() => { if (seat) pin(seat); }, []);
  return null;
}

const SETTINGS_SECTIONS = [
  ['env-runtime', '运行状态'], ['env-api', 'API 名册与预设'], ['env-docworker', '文档 Docker 服务'], ['env-mcp', 'MCP 服务'],
  ['env-skills', 'Skill 来源'], ['env-media', '多模态服务'], ['env-advanced', '高级 JSON 配置'],
] as const;

function SettingsPreview() {
  const [dirty, setDirty] = useState(0);
  return <div className="insp-preview-settings">
    <nav aria-label="设置章节（预览）">
      <p className="muted">开发预览 · 环境与连接设置</p>
      {SETTINGS_SECTIONS.map(([id, label]) => <button key={id} type="button" className="btn-reset" onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}>{label}</button>)}
      <p className="mono">{dirty ? `${dirty} 项未保存更改` : '没有未保存的更改'}</p>
    </nav>
    <div className="insp-preview-settings-main"><SettingsPanel onDirtyChange={setDirty} /></div>
  </div>;
}

export default function InspectorPreview() {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  if (query.get('view') === 'settings') return <SettingsPreview />;
  return <InspectorFrame query={query} />;
}

function InspectorFrame({ query }: { query: URLSearchParams }) {
  const state: InspectorState = INSPECTOR_STATES.find(item => item === query.get('state')) ?? 'running';
  const placement: InspectorPlacement = query.get('placement') === 'column' ? 'column' : 'dock';
  const [tab, setTab] = useState<InspectorTab>(INSPECTOR_TABS.find(item => item.id === query.get('tab'))?.id ?? DEFAULT_INSPECTOR_TAB);
  const [open, setOpen] = useState(query.get('closed') !== '1');
  const [collapsed, setCollapsed] = useState(query.get('collapsed') === '1');
  const sample = useMemo(() => inspectorFixture(state), [state]);
  const work = useRef<HTMLElement>(null);
  const inspector = open ? <ChatInspector chat={sample.chat} streams={sample.streams} tools={sample.tools} rotations={sample.rotations}
    capabilities={sample.capabilities} globalCapabilities={sample.globalCapabilities} model={sample.model} fixedDemo={sample.fixedDemo}
    tab={tab} onTab={setTab} placement={placement} collapsed={collapsed} onCollapse={setCollapsed} onClose={() => setOpen(false)} /> : null;
  return <section ref={work} className="chat-work insp-preview" data-placement={placement} aria-label="协作详情预览">
    <SeatFocusProvider target={work}>
      <PinOnMount seat={query.get('pin')} />
      <div className="insp-preview-thread">
        <p className="muted">开发预览 · 协作详情 · 样例数据，不连接服务器、不调用模型</p>
        <h2>{sample.chat.title}</h2>
        <div className="insp-preview-row">
          <button type="button" className="btn ghost" aria-expanded={open} aria-controls="chat-inspector" onClick={() => setOpen(value => !value)}>协作详情</button>
          {INSPECTOR_STATES.map(item => <a key={item} className="btn sm" aria-current={item === state ? 'page' : undefined} href={`#/dev/inspector?state=${item}&placement=${placement}&tab=${tab}`}>{item}</a>)}
        </div>
        <p className="muted">placement={placement} · tab={tab}{collapsed ? ' · collapsed' : ''}</p>
      </div>
      <div className="insp-preview-map">
        <div className="insp-preview-head">任务地图（预览占位）</div>
        {sample.chat.pipeline ? <div className="insp-preview-rail">流水线 · {sample.chat.pipeline.preset} · {sample.chat.pipeline.stage}</div> : null}
        <div className="insp-preview-stage">
          {sample.model.roles.map(role => <button key={role.id} type="button" className="btn sm" {...seatHandlers(role.id)}><span className="seat-dot" aria-hidden="true" />{role.label}</button>)}
        </div>
        {placement === 'dock' ? inspector : null}
      </div>
      {placement === 'column' ? inspector : null}
    </SeatFocusProvider>
  </section>;
}
