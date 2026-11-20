import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('服务重启后刷新已失效令牌，拒绝的请求不算已执行', async () => {
  const responses = [new Response('{"token":"old"}'), new Response('{"error":"token"}', { status: 403 }), new Response('{"token":"new"}'), new Response('{"ok":true}')];
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift())); vi.stubGlobal('fetch', fetch);
  const { api } = await import('./api');
  expect(await api.post('/api/action', { action: 'submit' })).toEqual({ ok: true });
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/session', '/api/action', '/api/session', '/api/action']);
  expect(fetch.mock.calls[3][1].headers['x-workbench-token']).toBe('new');
});
it('不重试可能已经执行的网络或服务端错误', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"token":"token"}')).mockResolvedValueOnce(new Response('{"error":"failure"}', { status: 500 })); vi.stubGlobal('fetch', fetch);
  const { api } = await import('./api');
  await expect(api.post('/api/action')).rejects.toThrow('failure');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('把 ZIP 原始文件直接上传并在令牌失效后只刷新一次', async () => {
  const responses = [new Response('{"token":"old"}'), new Response('{"error":"token"}', { status: 403 }), new Response('{"token":"new"}'), new Response('{"archives":[]}')];
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./api');
  const file = new File(['zip bytes'], '项目 资料.zip', { type: 'application/zip' });

  expect(await api.upload('/api/reference-archives/import', file)).toEqual({ archives: [] });
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/session', '/api/reference-archives/import', '/api/session', '/api/reference-archives/import']);
  const request = fetch.mock.calls[3][1];
  expect(request.body).toBe(file);
  expect(request.headers).toEqual({
    'Content-Type': 'application/octet-stream',
    'X-Reference-Name': encodeURIComponent(file.name),
    'X-Workbench-Token': 'new',
  });
});
