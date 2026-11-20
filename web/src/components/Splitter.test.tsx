import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Splitter, { clampSplit, readSplit, splitterKey } from './Splitter';

const state = { value: 600, min: 400, max: 900, step: 24 };

describe('splitter', () => {
  it('moves by step, Shift ×4, jumps with Home/End and resets on Enter', () => {
    expect(splitterKey('ArrowRight', false, state, 'vertical')).toBe(624);
    expect(splitterKey('ArrowLeft', false, state, 'vertical')).toBe(576);
    expect(splitterKey('ArrowRight', true, state, 'vertical')).toBe(696);
    expect(splitterKey('Home', false, state, 'vertical')).toBe(400);
    expect(splitterKey('End', false, state, 'vertical')).toBe(900);
    expect(splitterKey('Enter', false, state, 'vertical')).toBe('reset');
    expect(splitterKey('ArrowDown', false, state, 'vertical')).toBeNull();
    expect(splitterKey('ArrowDown', false, state, 'horizontal')).toBe(624);
    expect(splitterKey('ArrowUp', true, state, 'horizontal')).toBe(504);
  });

  it('clamps to the computed range, including a minimum above the maximum', () => {
    expect(splitterKey('ArrowLeft', true, { ...state, value: 410 }, 'vertical')).toBe(400);
    expect(splitterKey('ArrowRight', false, { ...state, value: 890 }, 'vertical')).toBe(900);
    expect(clampSplit(50, 60, 40)).toBe(50);
    expect(clampSplit(10, 60, 40)).toBe(40);
  });

  it('is a focusable separator (not a button) with its value range exposed', () => {
    const html = renderToStaticMarkup(<Splitter orientation="vertical" value={44.4} min={33} max={62} step={2} label="调整聊天与任务地图宽度" valueText="聊天宽度 44%" controls="chat-thread" onChange={vi.fn()} />);
    expect(html.startsWith('<div role="separator" tabindex="0"')).toBe(true);
    expect(html).not.toContain('<button');
    for (const part of ['aria-orientation="vertical"', 'aria-label="调整聊天与任务地图宽度"', 'aria-controls="chat-thread"', 'aria-valuenow="44"', 'aria-valuemin="33"', 'aria-valuemax="62"', 'aria-valuetext="聊天宽度 44%"']) expect(html).toContain(part);
  });

  it('falls back when storage is missing or throws', () => {
    expect(readSplit('dmw:deck:thread-w:v1', 0.44)).toBe(0.44);
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('denied'); } } });
    try { expect(readSplit('dmw:deck:thread-w:v1', 0.5)).toBe(0.5); }
    finally { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original }); }
  });
});
