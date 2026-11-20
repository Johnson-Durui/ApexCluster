// The map pane (BUILD-SPEC-B §5): the 架构视图 at working size (docked) or maximised in place (full). It renders the
// `rail` and `dock` slots verbatim, outside `.observatory`, and reports whether a 协作详情 dock fits (onDockFit). The
// dock sizes itself (its own row splitter, WP3) and the stage takes the rest. It never reads ChatPage state except
// through props (workspaceContracts.ChatMapProps).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CameraPreset } from './mapCamera';
import MapHead, { MAP_PANEL_ID, mapTabId } from './MapHead';
import MapStage, { waitingSeats, type MapView } from './MapStage';
import type { ChatMapProps } from './workspaceContracts';
import './observatory.css';

const HEAD_H = 40;
const STAGE_MIN = 330;
const DOCK_MIN = 150;

/** Room left for a dock under the stage: deckH − 40 − railH − 330 (fits when ≥ 150). */
export const dockRoom = (deckH: number, railH: number) => deckH - HEAD_H - railH - STAGE_MIN;

/** `initialView` is an optional extra beyond the frozen contract (the dev preview opens a given tab). */
export default function ChatMap({ model, chat, variant, demo, animateChanges, canFlow, welcome, rail, dock, dockOpen, onDockFit, onToggleMax, onCollapse, onGateNode, initialView = 'topology' }: ChatMapProps & { initialView?: MapView }) {
  const [view, setView] = useState<MapView>(initialView);
  const [presetState, setPreset] = useState<CameraPreset>('global');
  const [flipping, setFlipping] = useState(false);
  const tweening = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const full = variant === 'full';
  const preset: CameraPreset = full ? presetState : 'global';
  useEffect(() => { if (!full) setPreset('global'); }, [full]);

  // deckH / railH: one observer on the pane and the rail row; onDockFit only fires when its answer changes.
  const fit = useRef(onDockFit);
  fit.current = onDockFit;
  const reported = useRef('');
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const measure = () => {
      const next = { deckH: section.clientHeight, railH: railRef.current?.offsetHeight ?? 0 };
      const fits = dockRoom(next.deckH, next.railH) >= DOCK_MIN;
      const key = fits + '|' + next.deckH;
      if (next.deckH > 0 && key !== reported.current) { reported.current = key; fit.current(fits, next.deckH); }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [Boolean(rail)]);

  const showDock = Boolean(dock) && dockOpen;

  const onFlip = useCallback((active: boolean) => setFlipping(active), []);
  const onTween = useCallback((active: boolean) => { tweening.current = active; }, []);
  // Maximise is ignored while a camera move is in flight (§5.2).
  const toggleMax = () => { if (!tweening.current) onToggleMax(); };
  const waiting = useMemo(() => waitingSeats(model), [model]);
  const presetDisabled = (item: CameraPreset) => flipping || (item === 'waiting' && !waiting.length) || (item === 'lead' && !model.roles.length);

  return <section ref={sectionRef} className="chat-map" data-variant={variant} data-dock={showDock || undefined} aria-label="任务地图">
    <MapHead view={view} onView={setView} variant={variant} preset={preset} onPreset={setPreset} presetDisabled={presetDisabled}
      onCollapse={onCollapse} onToggleMax={toggleMax} />
    {rail ? <div className="map-rail" ref={railRef}>{rail}</div> : null}
    <div className="observatory" role="tabpanel" id={MAP_PANEL_ID} aria-labelledby={mapTabId(view)}>
      <MapStage model={model} chat={chat} variant={variant} view={view} demo={demo} animateChanges={animateChanges} canFlow={canFlow}
        welcome={welcome} preset={preset} onGateNode={onGateNode} onFlip={onFlip} onTween={onTween} />
    </div>
    {showDock ? <div className="map-dock">{dock}</div> : null}
  </section>;
}
