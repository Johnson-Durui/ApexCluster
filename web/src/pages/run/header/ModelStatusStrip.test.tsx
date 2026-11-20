import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { liveRun } from '../live/testFixtures';
import ModelStatusStrip from './ModelStatusStrip';

test('旧记录没有 Grok 配置时状态栏仍可渲染', () => {
  const html = renderToStaticMarkup(<ModelStatusStrip run={liveRun([])} now={Date.now()} />);
  expect(html).toContain('Claude');
  expect(html).toContain('Astra');
  expect(html).toContain('Sol');
  expect(html).not.toContain('Grok');
});
