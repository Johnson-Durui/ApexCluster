// Map pane head (BUILD-SPEC-B §5.2): the 架构视图模式 tablist, a description hint, camera presets (full only),
// 收起任务地图 (docked only) and ⤢. Tabs use a roving tabindex; ←/→/Home/End move focus and selection together.
import { useRef, type KeyboardEvent } from 'react';
import { Icon } from '../../components/ui';
import { PRESETS, type CameraPreset } from './mapCamera';
import type { MapView } from './MapStage';
import type { MapVariant } from './workspaceContracts';

export const MAP_VIEWS: Array<{ id: MapView; title: string; description: string }> = [
  { id: 'topology', title: '协作拓扑', description: '追踪多 Agent 的分派与回传，比较每个席位的思考档位。' },
  { id: 'pipeline', title: '决策管道', description: '沿流水线查看架构、实现、独立验收与人工关卡。' },
  { id: 'context', title: '上下文', description: '查看各席位最近调用的上下文窗口与交接记录。' },
];
export const mapTabId = (view: MapView) => 'map-tab-' + view;
export const MAP_PANEL_ID = 'map-panel';

export default function MapHead({ view, onView, variant, preset, onPreset, presetDisabled, onCollapse, onToggleMax }: {
  view: MapView; onView(view: MapView): void; variant: MapVariant;
  preset: CameraPreset; onPreset(preset: CameraPreset): void; presetDisabled(preset: CameraPreset): boolean;
  onCollapse(): void; onToggleMax(): void;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = MAP_VIEWS.find(item => item.id === view) ?? MAP_VIEWS[0];
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = MAP_VIEWS.findIndex(item => item.id === view);
    const next = event.key === 'ArrowRight' ? (index + 1) % MAP_VIEWS.length : event.key === 'ArrowLeft' ? (index + MAP_VIEWS.length - 1) % MAP_VIEWS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? MAP_VIEWS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onView(MAP_VIEWS[next].id);
    tabs.current[next]?.focus();
  };
  const full = variant === 'full';
  return <div className="map-head">
    <div className="map-tabs" role="tablist" aria-label="架构视图模式" onKeyDown={onKey}>
      {MAP_VIEWS.map((item, index) => <button type="button" role="tab" key={item.id} id={mapTabId(item.id)} className="btn-reset"
        ref={element => { tabs.current[index] = element; }} aria-selected={item.id === view} aria-controls={MAP_PANEL_ID}
        tabIndex={item.id === view ? 0 : -1} onClick={() => onView(item.id)}>
        <span className="map-tab-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{item.title}
      </button>)}
    </div>
    <p className="map-hint">{current.description}</p>
    <div className="map-head-tools">
      {full ? <div className="map-camera" role="group" aria-label="镜头">
        {PRESETS.map(item => <button type="button" key={item.id} className="btn-reset" aria-pressed={preset === item.id}
          disabled={view !== 'topology' || presetDisabled(item.id)} onClick={() => onPreset(item.id)}>{item.label}</button>)}
      </div> : <button type="button" className="map-icon btn-reset" aria-label="收起任务地图" title="收起任务地图" onClick={onCollapse}>
        <Icon name="panel-right" size={15} />
      </button>}
      <button type="button" className="map-icon btn-reset" aria-label={full ? '还原任务地图' : '最大化任务地图'} title={full ? '还原任务地图' : '最大化任务地图'}
        aria-keyshortcuts="Alt+A" onClick={onToggleMax}>
        <Icon name={full ? 'minimize' : 'maximize'} size={15} />
      </button>
    </div>
  </div>;
}
