// Runs the map's one-shot motions (BUILD-SPEC-B §5.4, §7 rows 1, 2, 6, 9) on real store transitions only. The diff is
// keyed by model identity, so a StrictMode double-invoked effect never plays a packet twice; snapshot and initial loads
// (`animateChanges` false) only move the baseline. Every WAAPI animation is cancelled after it ends (animateOnce).
import { useEffect, useRef, type RefObject } from 'react';
import { animateOnce } from '../../components/motion';
import type { GraphicHandle } from './ObservatoryGraphic';
import { diffObservatory, NO_MOTION, planPackets } from './mapMotion';
import type { TopologyScene } from './MapTopology';
import type { Observatory } from './observatoryModel';

const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const EASE_SETTLE = 'cubic-bezier(.22,1,.36,1)';
const EASE_IO = 'cubic-bezier(.65,0,.35,1)';
const E1 = '0 1px 2px rgba(41,53,83,.07),0 10px 22px -12px rgba(41,53,83,.30)';
const E2 = 'inset 0 1px 0 rgba(255,255,255,.95),0 2px 4px rgba(41,53,83,.08),0 18px 34px -14px rgba(41,53,83,.36)';

function card(scope: HTMLElement | null, seat: string) {
  return [...scope?.querySelectorAll<HTMLElement>('.obs-world .obs-node[data-seat]') ?? []].find(element => element.dataset.seat === seat) ?? null;
}

/** §7 row 2: the seat card lands when its packet arrives: ring 0 → 100 %, lift −2 px with --e2, status roll. */
function land(element: HTMLElement | null, delay: number) {
  if (!element) return;
  animateOnce(element, [{ translate: '0 0', boxShadow: E1 }, { translate: '0 -2px', boxShadow: E2 }], { delay, duration: 240, easing: EASE_OUT });
  animateOnce(element.querySelector('.obs-node-ring'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { delay, duration: 240, easing: EASE_OUT });
  animateOnce(element.querySelector('.obs-node-st > .obs-chip'), [{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { delay, duration: 180, easing: EASE_SETTLE });
}

export function useMapMotion({ model, animateChanges, scope, graphic, topology }: {
  model: Observatory; animateChanges: boolean; scope: RefObject<HTMLElement | null>; graphic: RefObject<GraphicHandle | null>; topology: TopologyScene;
}) {
  const previous = useRef<Observatory | undefined>(undefined);
  const latestTopology = useRef(topology);
  latestTopology.current = topology;
  useEffect(() => {
    const before = previous.current;
    previous.current = model;
    if (!animateChanges || !before || before === model) return;
    const diff = diffObservatory(before, model);
    if (diff === NO_MOTION) return;
    const element = scope.current;
    const scene = latestTopology.current;
    const lengths = new Map(scene.routes.map(route => [scene.links[route.link]?.key ?? '', route.len]));
    const landings = graphic.current?.launch(planPackets(diff.dispatches, key => lengths.get(key))) ?? new Map<string, number>();
    for (const [key, at] of landings) land(card(element, key.slice(key.indexOf('>') + 1)), at);
    // §7 row 6: the lead counter's completed digits roll in.
    if (diff.returned) animateOnce(element?.querySelector('.obs-counter > b'), [{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 180, easing: EASE_SETTLE });
    // §7 row 9: the decision travels 你 → lead along the hairline.
    if (diff.gatePassed) {
      const line = element?.querySelector<HTMLElement>('.obs-you-line');
      const length = line?.clientWidth ?? 0;
      if (length > 8) animateOnce(line?.querySelector('.obs-you-packet'), [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${length}px)`, opacity: 1 }], { duration: 420, easing: EASE_IO });
    }
  }, [model, animateChanges, scope, graphic]);
}
