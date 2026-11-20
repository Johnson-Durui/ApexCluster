import { describe, expect, it } from 'vitest';
import type { AgentTask, ChatRecord } from '../../lib/chat-api';
import { buildObservatory } from './observatoryModel';
import { pipelineGeometry } from './observatoryLayout';
import { pipelineSummary, StageCards, StageDetail, stageKind } from './ObservatoryPanels';
import { TaskMix } from './ObservatoryParts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const at = (second: number) => `2026-11-19T10:00:${String(second).padStart(2, '0')}Z`;
const task = (id: string, patch: Partial<AgentTask> = {}): AgentTask => ({
  id, role: 'claude', turnId: 'new', goal: '任务', status: 'running', createdAt: at(0), updatedAt: at(1),
  mode: 'read', segment: 1, invocationIds: [], noProgressSegments: 0, ...patch,
});
const chat = (patch: Partial<ChatRecord>): ChatRecord => ({
  version: 1, id: 'c', title: '任务', createdAt: at(0), updatedAt: at(2), seq: 1, messageSeq: 1,
  turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [], ...patch,
});
const pipeline = (stage: 'implementation' | 'gate-a', gate: 'user' | 'auto' = 'user') =>
  ({ preset: 'flagship', stage, revision: 1, gates: { clarify: 'user' as const, architecture: gate, delivery: 'user' as const } });

describe('pipeline summary', () => {
  it('never shows zero items for the user while the session waits on the user', () => {
    const summary = pipelineSummary(buildObservatory(chat({
      pipeline: pipeline('implementation'),
      tasks: [task('root', { status: 'waiting_children' }), task('ask', { parentTaskId: 'root', role: 'hydrogen', status: 'waiting_user' })],
      tickets: [{ id: 't', taskId: 'ask', invocationId: 'i', type: 'user', status: 'pending', createdAt: at(1) }],
    }), [], [], [], false));
    expect(summary.held).toBe(true);
    expect(summary.waiting).toBe(1);
    expect(summary.nextGate?.id).toBe('gate-b');
  });

  it('invents no current stage for a cancelled pipeline and names who is waiting', () => {
    const cancelled = pipelineSummary(buildObservatory(chat({ pipeline: { ...pipeline('implementation'), stage: 'cancelled' } }), [], [], [], false));
    expect(cancelled.current).toBeUndefined();
    expect(cancelled.nextGate).toBeUndefined();
    expect(cancelled.running).toBe(0);
  });

  it('counts a user gate as one item and nothing when the gate is automatic', () => {
    const gated = pipelineSummary(buildObservatory(chat({ pipeline: pipeline('gate-a') }), [], [], [], false));
    expect(gated).toMatchObject({ userGate: true, held: true, waiting: 1, running: 1 });
    const automatic = pipelineSummary(buildObservatory(chat({ pipeline: pipeline('gate-a', 'auto') }), [], [], [], false));
    expect(automatic).toMatchObject({ userGate: false, held: false, waiting: 0 });
  });
});

describe('stopped and terminated pipelines', () => {
  it('marks every remaining stage of a terminated pipeline as terminated, not waiting', () => {
    const model = buildObservatory(chat({ pipeline: { ...pipeline('implementation'), stage: 'cancelled' } }), [], [], [], false);
    expect(model.pipeline.stages.map(stage => stageKind(stage, false, model.pipeline.cancelled))).toEqual(Array(6).fill('stopped'));
  });

  it('does not count a failed or stopped stage as in progress or offer the next gate', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const summary = pipelineSummary(buildObservatory(chat({
        pipeline: pipeline('implementation'),
        turns: [{ id: 'new', rootTaskId: 'lead', status, createdAt: at(0) }],
        tasks: [task('lead', { role: 'sol', status })],
      }), [], [], [], false));
      expect(summary.running, status).toBe(0);
      expect(summary.nextGate, status).toBeUndefined();
    }
  });
});

describe('task mix', () => {
  it('counts a task with a pending user ticket once, under 等你, and not in its status bucket', () => {
    const tasks = [task('root', { status: 'waiting_children' }), task('child', { parentTaskId: 'root', role: 'sol', status: 'queued' })];
    const html = renderToStaticMarkup(createElement(TaskMix, { tasks, waitIds: ['root'] }));
    expect(html).toMatch(/data-kind="hold-user"><i aria-hidden="true"><\/i>等你 <b>1<\/b>/);
    expect(html).not.toContain('等子任务');
    expect(html).toMatch(/排队 <b>1<\/b>/);
  });
});

describe('stage details (阶段详情)', () => {
  const model = buildObservatory(chat({ pipeline: pipeline('implementation') }), [], [], [], false);
  const cards = (geometry: ReturnType<typeof pipelineGeometry>, density: 'tiny' | 'compact') =>
    renderToStaticMarkup(createElement(StageCards, { model, geometry, density, selected: 'gate-b', onSelect: () => undefined }));

  it('keeps every description and gate type reachable on a tiny vertical map and on short cards', () => {
    const tiny = cards(pipelineGeometry(6, { w: 520, h: 400 }, 'tiny'), 'tiny');
    const short = cards(pipelineGeometry(6, { w: 1100, h: 380 }, 'compact'), 'compact');
    for (const html of [tiny, short]) {
      expect(html).not.toContain('<p ');
      for (const stage of model.pipeline.stages) expect(html).toContain(stage.description);
      expect(html).toContain('title="决定是否接受最终交付。"');
      expect(html).toMatch(/<span class="sr-only"> · 人工关卡<\/span>/);
      expect(html).toMatch(/<span class="sr-only"> · 工作阶段<\/span>/);
    }
  });

  it('reads out the picked stage: 序号, 类型, description and both neighbours with their states', () => {
    const gateB = model.pipeline.stages.find(stage => stage.id === 'gate-b')!;
    const html = renderToStaticMarkup(createElement(StageDetail, { model, stage: gateB, onClose: () => undefined }));
    expect(html).toContain('aria-label="阶段详情"');
    expect(html).toContain('<code>05 / 06</code>');
    expect(html).toContain('人工关卡');
    expect(html).toContain('决定是否接受最终交付。');
    expect(html).toMatch(/上一阶段 独立验收 <span class="obs-chip" data-kind="idle">.*未开始<\/span>/);
    expect(html).toMatch(/下一阶段 完成 <span class="obs-chip" data-kind="idle">/);
    expect(html).toContain('aria-label="关闭阶段详情"');
    const first = renderToStaticMarkup(createElement(StageDetail, { model, stage: model.pipeline.stages[0], onClose: () => undefined }));
    expect(first).toContain('上一阶段 —');
    expect(first).toMatch(/下一阶段 关卡 A <span class="obs-chip" data-kind="done">/);
  });
});
