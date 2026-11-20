import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { seatHandlers } from '../../components/seatFocus';
import type { AgentTask, ChatRecord } from '../../lib/chat-api';
import { dimRules } from './mapFocus';
import MapStage, { type MapView } from './MapStage';
import { buildObservatory } from './observatoryModel';
import { ContextCard } from './ObservatoryParts';

const at = '2026-11-20T10:00:00Z';
const task = (id: string, role: string, parentTaskId?: string): AgentTask => ({
  id, role, parentTaskId, turnId: 't', goal: '目标', status: 'running', createdAt: at, updatedAt: at, mode: 'read', segment: 1, invocationIds: [], noProgressSegments: 0,
});
const chat: ChatRecord = {
  version: 1, id: 'map', title: '地图', createdAt: at, updatedAt: at, seq: 1, messageSeq: 1,
  turns: [{ id: 't', rootTaskId: 'root', status: 'running', createdAt: at }],
  tasks: [task('root', 'claude'), task('a', 'astra', 'root'), task('g', 'grok', 'root')],
  invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
  pipeline: { preset: 'flagship', stage: 'implementation', revision: 1, gates: { clarify: 'user', architecture: 'user', delivery: 'user' } },
};
const model = buildObservatory(chat, [], [], [], false);
const stage = (view: MapView) => renderToStaticMarkup(<MapStage model={model} chat={chat} variant="docked" view={view} demo={false} animateChanges={false} canFlow
  preset="global" onGateNode={vi.fn()} onFlip={vi.fn()} onTween={vi.fn()} />);
const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];

describe('map stage focus dimming (§5.3)', () => {
  it('emits the dimming rules in the 上下文 view, not only in 协作拓扑', () => {
    const context = styleOf(stage('context'));
    expect(context).toBeDefined();
    for (const seat of ['claude', 'astra', 'grok']) expect(context).toContain(`[data-focus-seat="${seat}"] .obs-world [data-rel]:not([data-rel~="${seat}"])`);
    expect(context).toContain('{--o-dim:.36}');
    expect(styleOf(stage('topology'))).toContain('[data-focus-seat="astra"]');
    expect(styleOf(stage('pipeline'))).toBeUndefined();
  });

  it('targets context cards through their data-rel, so the other cards drop to .36', () => {
    const role = model.roles.find(item => item.id === 'astra')!;
    const card = renderToStaticMarkup(<ContextCard role={role} box={{ id: 'astra', cx: 100, cy: 100, w: 180, h: 64 }} density="regular" related={['astra']} handlers={seatHandlers('astra')} />);
    expect(card).toContain('data-rel="astra"');
    expect(dimRules([])).toBe('');
    expect(dimRules(['a"b'])).toContain('[data-focus-seat="a\\"b"]');
  });
});
