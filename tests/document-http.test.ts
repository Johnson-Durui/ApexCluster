import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { HandbookOutput } from '../src/core/schemas.js';
import { createApp } from '../src/server/app.js';
import { makeHarness } from './helpers.js';

async function start() {
  const h = makeHarness({ delayMs: 0 });
  const token = 'd'.repeat(64);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  h.config.port = port;
  const app = createApp({ config: h.config, orchestrator: h.orch, bus: h.bus, token, staticDir: path.join(h.dir, 'no-web'), allowMockRuns: true });
  const server: Server = createServer((request, response) => void app(request, response));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { h, token, port, server };
}

function req(port: number, method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path: url,
      headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-workbench-token': token } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

async function waitFor(port: number, id: string, predicate: (run: any) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = (await req(port, 'GET', `/api/runs/${id}`)).json();
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待文档流程超时');
}

const createBody = {
  title: '文档接口测试',
  mode: 'mock',
  mockScenario: 'preference',
  project: { prompt: '本地记账', coreFlows: ['记一笔'] },
  constraints: [
    { text: '必须在 Windows 本机运行', kind: 'must' },
    { text: '必须通过浏览器访问', kind: 'must' },
  ],
};

async function createDocs(port: number, token: string) {
  const created = await req(port, 'POST', '/api/runs', createBody, token);
  assert.equal(created.status, 201, created.text);
  const id = created.json().id as string;
  let run = await waitFor(port, id, (value) => value.phase === 'answering');
  assert.equal((await req(port, 'POST', `/api/runs/${id}/gates`, { gate: 'G1_answers', action: 'submit' }, token)).status, 200);
  run = await waitFor(port, id, (value) => value.phase === 'framework_gate');
  const defaults = (await req(port, 'GET', `/api/runs/${id}/g2-defaults`)).json();
  const winner = defaults.find((item: any) => item.candidateId === run.decision.winnerId);
  assert.equal((await req(port, 'POST', `/api/runs/${id}/gates`, { gate: 'G2_framework', action: 'validate', candidateIds: [winner.candidateId], specs: [winner.spec] }, token)).status, 200);
  run = await waitFor(port, id, (value) => value.phase === 'docs_gate');
  return { id, run };
}

test('文档预览与 HTML 下载转义不可信文字，并发送无外联 CSP', async () => {
  const { h, token, port, server } = await start();
  try {
    const { id } = await createDocs(port, token);
    const run = h.orch.getRun(id);
    const handbook = run.docs.versions.find((version) => version.kind === 'handbook')!;
    (handbook.content as HandbookOutput).summary.problem.text = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    h.store.save(run);

    for (const suffix of ['render', 'download?format=html']) {
      const response = await req(port, 'GET', `/api/runs/${id}/docs/handbook/1/${suffix}`);
      assert.equal(response.status, 200);
      assert.match(String(response.headers['content-type']), /text\/html/);
      assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
      assert.ok(response.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.equal(response.text.includes('<script>'), false);
      assert.equal(response.text.includes('<img src=x'), false);
      assert.equal(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(response.text), false);
    }
  } finally {
    server.close();
  }
});

test('文档 HTTP 路由严格限制 kind、version、路径层级与下载格式', async () => {
  const { token, port, server } = await start();
  try {
    const { id } = await createDocs(port, token);
    const cases: [string, number][] = [
      [`/api/runs/${id}/docs/notes/1`, 404],
      [`/api/runs/${id}/docs/handbook/latest`, 404],
      [`/api/runs/${id}/docs/handbook/1/extra`, 404],
      [`/api/runs/${id}/docs/handbook/1/download?format=docx`, 400],
    ];
    for (const [url, expected] of cases) assert.equal((await req(port, 'GET', url)).status, expected, url);
  } finally {
    server.close();
  }
});

test('文档列表和 Markdown 下载公开稳定版本元数据与安全文件名', async () => {
  const { token, port, server } = await start();
  try {
    const { id } = await createDocs(port, token);
    const docs = await req(port, 'GET', `/api/runs/${id}/docs`);
    assert.equal(docs.status, 200);
    assert.equal(docs.json().writeDocs, true);
    assert.deepEqual(docs.json().current, { handbook: 1, devdoc: 1, prd: null });

    const download = await req(port, 'GET', `/api/runs/${id}/docs/devdoc/1/download?format=md`);
    assert.equal(download.status, 200);
    assert.match(String(download.headers['content-type']), /text\/markdown/);
    assert.match(String(download.headers['content-disposition']), /^attachment; filename="devdoc-v1\.md"; filename\*=UTF-8''/);
    assert.ok(download.text.startsWith('# 开发文档（给 AI）'));
  } finally {
    server.close();
  }
});
