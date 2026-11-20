import { describe, expect, test } from 'vitest';
import { downloadUrl, renderUrl, selectedDocVersion } from './DocumentsPanel';

describe('文档 API 路由', () => {
  test('预览和下载始终指向所选文档版本', () => {
    expect(renderUrl('r demo', 'handbook', 2)).toBe('/api/runs/r%20demo/docs/handbook/2/render');
    expect(downloadUrl('r demo', 'prd', 3, 'html')).toBe('/api/runs/r%20demo/docs/prd/3/download?format=html');
    expect(downloadUrl('r demo', 'devdoc', 4, 'md')).toBe('/api/runs/r%20demo/docs/devdoc/4/download?format=md');
  });

  test('修订产生新当前版本时，未手动查看历史会自动预览新版本', () => {
    const first = { current: { handbook: 1, devdoc: null, prd: null }, versions: [{ kind: 'handbook' as const, version: 1 }] };
    const revised = { current: { handbook: 2, devdoc: null, prd: null }, versions: [...first.versions, { kind: 'handbook' as const, version: 2 }] };
    expect(selectedDocVersion(first, 'handbook')).toBe(1);
    expect(selectedDocVersion(revised, 'handbook')).toBe(2);
    expect(selectedDocVersion(revised, 'handbook', 1)).toBe(1);
  });
});
