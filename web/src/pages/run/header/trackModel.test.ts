import { describe, expect, test } from 'vitest';
import { buildTrack, type TrackGate, type TrackInput, type TrackSegment } from './trackModel';

const base: TrackInput = { phase: 'answering', phaseStatus: 'waiting_user', terminal: null, writeDocs: true, writePrd: true, gates: [] };
const gates = (input: TrackInput) => Object.fromEntries(buildTrack(input).filter((item): item is TrackGate => item.kind === 'gate').map(item => [item.key, item.state]));
const segment = (input: TrackInput, key: string) => buildTrack(input).find((item): item is TrackSegment => item.kind === 'segment' && item.key === key)!;

describe('关卡进度条', () => {
  test('等待 G1 时：录入段完成，G1 等你决定，其余未开始', () => {
    expect(gates(base)).toEqual({ G1: 'now', G2: 'todo', G3: 'todo', G4: 'todo', G5: 'todo' });
    expect(segment(base, 'intake').state).toBe('done');
    expect(segment(base, 'design').state).toBe('todo');
  });

  test('复核与 Ultra 裁决记在 G2 之前，G2 仍未完成', () => {
    const input: TrackInput = { ...base, phase: 'adjudicate', phaseStatus: 'running', gates: [{ id: 'G1_answers', resolved: true, action: 'submit' }, { id: 'G2_framework', resolved: true, action: 'recheck' }] };
    expect(gates(input)).toMatchObject({ G1: 'done', G2: 'todo' });
    const design = segment(input, 'design');
    expect(design.state).toBe('now');
    expect(design.fill).toBe(1);
    expect(design.loop.find(step => step.phase === 'adjudicate')?.state).toBe('now');
    expect(design.loop.find(step => step.phase === 'recheck')?.state).toBe('todo');
  });

  test('阻塞时当前段标红，后面的关卡仍未开始', () => {
    const input: TrackInput = { ...base, phase: 'validate', phaseStatus: 'blocked' };
    expect(segment(input, 'build').state).toBe('blocked');
    expect(gates(input)).toMatchObject({ G2: 'done', G3: 'done', G4: 'todo' });
  });

  test('关闭的文档步骤显示已关闭，不算未完成', () => {
    const input: TrackInput = { ...base, phase: 'final_gate', writeDocs: false, writePrd: false };
    expect(gates(input)).toEqual({ G1: 'done', G2: 'done', G3: 'off', G4: 'now', G5: 'off' });
    expect(segment(input, 'docs').state).toBe('off');
  });

  test('在 G2 停止的已结束运行不会显示为全部完成', () => {
    const input: TrackInput = { phase: 'done', phaseStatus: 'completed', terminal: 'done', writeDocs: false, writePrd: false, gates: [{ id: 'G1_answers', resolved: true, action: 'submit' }, { id: 'G2_framework', resolved: true, action: 'stop' }] };
    expect(gates(input)).toEqual({ G1: 'done', G2: 'stopped', G3: 'off', G4: 'todo', G5: 'off' });
    expect(segment(input, 'end').state).toBe('todo');
  });

  test('正常结束：旧记录的 G3_final 按 G4 处理，结束段完成', () => {
    const input: TrackInput = { phase: 'done', phaseStatus: 'completed', terminal: 'done', writeDocs: false, writePrd: false, gates: [{ id: 'G1_answers', resolved: true, action: 'submit' }, { id: 'G2_framework', resolved: true, action: 'validate' }, { id: 'G3_final', resolved: true, action: 'accept' }] };
    expect(gates(input)).toEqual({ G1: 'done', G2: 'done', G3: 'off', G4: 'done', G5: 'off' });
    expect(segment(input, 'end').state).toBe('done');
  });

  test('取消的运行在当时所处的关卡显示“在此停止”', () => {
    const input: TrackInput = { ...base, phaseStatus: 'completed', terminal: 'cancelled' };
    expect(gates(input)).toMatchObject({ G1: 'stopped', G2: 'todo' });
  });
});
