import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { Run } from '../../../lib/types';
import { liveRun } from '../live/testFixtures';
import RunRail from './RunRail';

/** Model ids that do not name their seat: the row must still say which seat runs which model. */
const run = liveRun([], {
  questions: [], candidates: [], snapshots: [], criteria: [], clarifyWith: 'both', allowWebResearch: false,
  models: {
    claude: { role: 'claude', adapter: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
    astra: { role: 'astra', adapter: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.1-terra', effort: 'max' },
  } as Run['models'],
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('上下文栏 · 运行配置', () => {
  test('每一行用可见文字写出席位，不只靠席位颜色或 title 提示', () => {
    const html = renderToStaticMarkup(<RunRail run={run} collapsed={false} onNavigate={vi.fn()} onOpenGate={vi.fn()} />);
    const list = html.split('<ul class="rail-models">')[1]?.split('</ul>')[0] ?? '';
    const rows = list.split('</li>').filter(Boolean);
    expect(rows.map(text)).toEqual(['Claude claude-opus-5-5 max', 'Astra gpt-6-luna xhigh', 'Sol gpt-6.1-terra max']);
    for (const row of rows) expect(row).toMatch(/<b class="rail-seat">(Claude|Astra|Sol)<\/b>/);
  });
});
