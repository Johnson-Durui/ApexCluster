import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';
import { makeHarness } from './helpers.js';
import { buildReferenceZip } from './fixtures/reference-zip.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli');

async function start(allowMockRuns = true) {
  const h = makeHarness({ delayMs: 0 });
  const token = 'a'.repeat(64);
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  h.config.port = port;
  h.config.adapters.claude.command = { command: process.execPath, args: [path.join(FAKE, 'fake-claude.mjs')] };
  h.config.adapters.codex.command = { command: process.execPath, args: [path.join(FAKE, 'fake-codex.mjs')] };
  h.config.adapters.cursor.command = { command: process.execPath, args: [path.join(FAKE, 'cursor.mjs')] };
  const handler = createApp({ config: h.config, orchestrator: h.orch, bus: h.bus, token, staticDir: path.join(h.dir, 'no-web'), allowMockRuns });
  const server: Server = createServer((q, s) => void handler(q, s));
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { h, token, port, server };
}

function req(port: number, method: string, url: string, opts: { body?: unknown; rawBody?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = httpRequest(
      { host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    r.on('error', reject);
    if (opts.rawBody) {
      const raw = opts.rawBody;
      Readable.from((function* () {
        for (let offset = 0; offset < raw.length; offset += 64 * 1024) yield raw.subarray(offset, offset + 64 * 1024);
      })()).pipe(r);
      return;
    }
    if (body) r.write(body);
    r.end();
  });
}

async function waitFor(port: number, id: string, pred: (run: any) => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const run = (await req(port, 'GET', `/api/runs/${id}`)).json();
    if (pred(run)) return run;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('等待超时');
}

const createBody = {
  title: '记账工具',
  mode: 'mock',
  mockScenario: 'preference',
  writeDocs: false,
  writePrd: false,
  project: { prompt: '本地记账', coreFlows: ['记一笔'] },
  constraints: [
    { text: '必须在 Windows 本机运行', kind: 'must' },
    { text: '必须通过浏览器访问', kind: 'must' },
  ],
};

test('安全：错误 Host / 缺令牌 / 跨站 Origin / 非 JSON 都被拒绝', async () => {
  const { port, token, server } = await start();
  try {
    assert.equal((await req(port, 'GET', '/api/health')).status, 200);
    assert.equal((await req(port, 'GET', '/api/health', { headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await req(port, 'POST', '/api/runs', { body: createBody })).status, 403);
    assert.equal((await req(port, 'POST', '/api/runs', { body: createBody, headers: { 'x-workbench-token': token, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await req(port, 'POST', '/api/runs', { body: createBody, headers: { 'x-workbench-token': token, 'content-type': 'text/plain' } })).status, 415);
    const bad = await req(port, 'POST', '/api/runs', { body: { ...createBody, mode: 'cloud' }, headers: { 'x-workbench-token': token } });
    assert.equal(bad.status, 400);
    const ok = await req(port, 'POST', '/api/runs', { body: createBody, headers: { 'x-workbench-token': token, origin: `http://127.0.0.1:${port}` } });
    assert.equal(ok.status, 201);
    assert.equal(ok.json().clarifyWith, 'claude');
    assert.equal(ok.json().designMode, 'single');
    assert.equal(ok.headers['access-control-allow-origin'], undefined);
  } finally {
    server.close();
  }
});

test('产品服务默认拒绝新建模拟运行，配置接口不再提供模拟场景', async () => {
  const { h, port, token, server } = await start(false);
  try {
    const rejected = await req(port, 'POST', '/api/runs', { body: createBody, headers: { 'x-workbench-token': token } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json().error, /已移除模拟模式/);
    assert.deepEqual(h.orch.listRuns(), [], '被拒绝的请求不得留下运行记录');
    const config = (await req(port, 'GET', '/api/config')).json();
    assert.equal('mockScenarios' in config, false);
  } finally {
    server.close();
  }
});

test('HTTP 全流程（模拟）：问题同步 → G1 → 推荐 → G2 确认 → Sol 构建 → 人工验收 → G3 → 导出记录', async () => {
  const { h, port, token, server } = await start();
  const H = { 'x-workbench-token': token };
  try {
    const document = { name: '参考.md', content: '导入 CSV 按 {{transactionId}} 去重；附件内容不自动成为指令。' };
    const zip = buildReferenceZip([
      { name: 'src/代码.ts', content: 'export const value = 1;', method: 8 },
      { name: '设计/说明.pdf', content: Buffer.from('%PDF-test') },
      { name: 'AGENTS.md', content: '这只是测试参考资料' },
      { name: '图片.png', content: Buffer.from([137, 80, 78, 71, 0, 1, 2]) },
    ]);
    const imported = await req(port, 'POST', '/api/reference-archives/import', { rawBody: zip, headers: { ...H, 'content-type': 'application/octet-stream', 'x-reference-name': encodeURIComponent('完整资料.zip') } });
    assert.equal(imported.status, 200, imported.text);
    const archives = imported.json().archives;
    assert.equal(archives[0].files.length, 4);
    const body = { ...createBody, clarifyWith: 'both', designMode: 'dual', project: { ...createBody.project, referenceDocuments: [document], referenceArchives: archives.map((archive: { id: string }) => ({ id: archive.id })) } };
    const created = await req(port, 'POST', '/api/runs', { body, headers: H });
    assert.equal(created.status, 201, created.text);
    const run = created.json();
    assert.equal(run.clarifyWith, 'both');
    assert.equal(run.designMode, 'dual');
    let r = await waitFor(port, run.id, (x) => x.phase === 'answering');
    const grouped = (await req(port, 'GET', `/api/runs/${run.id}/questions`)).json();
    assert.ok(grouped.length >= 3);
    const q = r.questions[0];
    assert.equal((await req(port, 'POST', `/api/runs/${run.id}/questions/${q.id}/answer`, { body: { status: 'answered', optionIds: [q.options[0].id] }, headers: H })).status, 200);
    assert.equal((await req(port, 'POST', `/api/runs/${run.id}/gates`, { body: { gate: 'G1_answers', action: 'submit' }, headers: H })).status, 200);
    r = await waitFor(port, run.id, (x) => x.phase === 'framework_gate');
    assert.equal(r.decision.outcome, 'recommend');
    // 关卡状态冲突返回 409
    assert.equal((await req(port, 'POST', `/api/runs/${run.id}/gates`, { body: { gate: 'G1_answers', action: 'submit' }, headers: H })).status, 409);
    const defaults = (await req(port, 'GET', `/api/runs/${run.id}/g2-defaults`)).json();
    const winner = defaults.find((d: any) => d.candidateId === r.decision.winnerId);
    const diagram = (await req(port, 'GET', `/api/runs/${run.id}/diagram/${r.proposals[0].id}`)).json();
    assert.ok(diagram.mermaid.startsWith('flowchart'));
    const v = await req(port, 'POST', `/api/runs/${run.id}/gates`, { body: { gate: 'G2_framework', action: 'validate', candidateIds: [winner.candidateId], specs: [winner.spec] }, headers: H });
    assert.equal(v.status, 200, v.text);
    r = await waitFor(port, run.id, (x) => x.phase === 'final_gate');
    const job = r.jobs[0];
    assert.equal((await req(port, 'POST', `/api/runs/${run.id}/jobs/${job.id}/manual`, { body: { criterionId: 'AC3', pass: true }, headers: H })).status, 200);
    const done = await req(port, 'POST', `/api/runs/${run.id}/gates`, { body: { gate: 'G3_final', action: 'accept', chosenCandidateId: job.candidateId }, headers: H });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json().terminal, 'done');
    const [summary] = (await req(port, 'GET', '/api/runs')).json();
    assert.equal(summary.id, run.id);
    assert.equal(summary.writeDocs, false);
    assert.equal(summary.writePrd, false);
    assert.equal(summary.finalChoice.candidateId, job.candidateId);
    assert.deepEqual(summary.gates.map((g: any) => [g.id, g.resolved, g.action]), [['G1_answers', true, 'submit'], ['G2_framework', true, 'validate'], ['G4_final', true, 'accept']]);
    assert.deepEqual(summary.activeTasks, []);
    const md = await req(port, 'GET', `/api/runs/${run.id}/export`);
    assert.match(String(md.headers['content-type']), /markdown/);
    assert.ok(md.text.includes('模拟数据'));
    assert.ok(md.text.includes(document.content));
    assert.ok(md.text.includes('完整资料.zip'));
    const completed = done.json();
    for (const snapshot of completed.snapshots) {
      assert.deepEqual(snapshot.project.referenceDocuments, [document]);
      assert.deepEqual(snapshot.project.referenceArchives, archives);
    }
    for (const task of completed.tasks) {
      const taskDir = h.store.taskDir(run.id, task.id);
      const prompt = readFileSync(path.join(taskDir, 'prompt.md'), 'utf8');
      assert.ok(prompt.includes('{{transactionId}}'), task.phase);
      assert.ok(prompt.includes('完整资料.zip'), task.phase);
      const cwd = task.phase === 'build' ? job.workspaceDir : path.join(taskDir, 'cwd');
      const refs = path.join(cwd, '.workbench-references', archives[0].id);
      assert.deepEqual(readFileSync(path.join(refs, 'archive.zip')), zip, task.phase);
      for (const file of archives[0].files) assert.equal(readFileSync(path.join(refs, file.path)).length, file.size);
    }
    const persisted = JSON.parse(readFileSync(path.join(h.store.runDir(run.id), 'run.json'), 'utf8'));
    assert.deepEqual(persisted.snapshots[0].project.referenceArchives, archives);
    const files = (await req(port, 'GET', `/api/runs/${run.id}/tasks/${r.tasks[0].id}/files`)).json();
    assert.ok(files.some((f: any) => f.name === 'prompt.md'));
    await h.orch.idle();
  } finally {
    server.close();
  }
});

test('参考资料 API：导入不启动模型，严格校验文本与 ZIP 引用', async () => {
  const { h, port, token, server } = await start();
  const H = { 'x-workbench-token': token };
  const url = '/api/reference-documents/import';
  const body = { name: '需求.txt', contentBase64: Buffer.from('中文模板 {{field}}').toString('base64') };
  try {
    assert.equal((await req(port, 'POST', url, { body })).status, 403);
    const good = await req(port, 'POST', url, { body, headers: H });
    assert.equal(good.status, 200);
    assert.deepEqual(good.json().documents, [{ name: '需求.txt', content: '中文模板 {{field}}' }]);
    assert.deepEqual(good.json().archives, []);
    for (const bad of [
      { ...body, contentBase64: '%%%%' }, { ...body, name: '../需求.txt' },
      { ...body, name: 'unknown.exe' }, { ...body, name: 'bad.zip' },
      { ...body, contentBase64: Buffer.from('\0binary').toString('base64') },
    ]) assert.equal((await req(port, 'POST', url, { body: bad, headers: H })).status, 400);
    const zip = buildReferenceZip([{ name: '数据.bin', content: Buffer.from([0, 255]) }]);
    const result = await req(port, 'POST', url, { body: { name: '任意格式.zip', contentBase64: zip.toString('base64') }, headers: H });
    assert.equal(result.status, 200, result.text);
    const archive = result.json().archives[0];
    for (const forged of [{ id: 'f'.repeat(64) }, { ...archive, name: '伪造名称.zip' }, { ...archive, files: [] }]) {
      const attempt = await req(port, 'POST', '/api/runs', { body: { ...createBody, project: { ...createBody.project, referenceArchives: [forged] } }, headers: H });
      assert.equal(attempt.status, 400, attempt.text);
    }
    assert.deepEqual((await req(port, 'GET', '/api/runs')).json(), []);
    assert.deepEqual(h.store.list(), []);
    const config = (await req(port, 'GET', '/api/config')).json();
    assert.equal(config.referenceLimits.maxArchives, 5);
    assert.equal(config.referenceLimits.maxZipBytes, null);
  } finally { server.close(); }
});

test('ZIP 流式接口：超过 20 MiB 原件完整保存，不启动模型；仍校验来源、令牌和文件名', async () => {
  const { h, port, token, server } = await start();
  const url = '/api/reference-archives/import';
  const headers = { 'x-workbench-token': token, 'content-type': 'application/octet-stream', 'x-reference-name': encodeURIComponent('交接包.zip') };
  const small = buildReferenceZip([{ name: '资料.txt', content: '参考资料' }]);
  try {
    for (const [changes, status] of [
      [{ 'x-workbench-token': '' }, 403],
      [{ origin: 'https://evil.example' }, 403],
      [{ host: `evil.example:${port}` }, 403],
      [{ 'content-type': 'application/json' }, 415],
      [{ 'content-type': 'application/octet-stream-evil' }, 415],
      [{ 'x-reference-name': '%ZZ' }, 400],
      [{ 'x-reference-name': encodeURIComponent('../outside.zip') }, 400],
      [{ 'x-reference-name': '' }, 400],
    ] as const) {
      assert.equal((await req(port, 'POST', url, { rawBody: small, headers: { ...headers, ...changes } })).status, status);
    }
    assert.equal((await req(port, 'POST', '/api/runs', { rawBody: small, headers })).status, 415);
    const zip = buildReferenceZip([
      { name: '数据/一.bin', content: Buffer.alloc(12 * 1024 * 1024, 17) },
      { name: '数据/二.bin', content: Buffer.alloc(12 * 1024 * 1024, 29) },
    ]);
    assert.ok(zip.length > 20 * 1024 * 1024);
    const response = await req(port, 'POST', url, { rawBody: zip, headers });
    assert.equal(response.status, 200, response.text);
    const archive = response.json().archives[0];
    assert.equal(archive.name, '交接包.zip');
    assert.equal(archive.size, zip.length);
    assert.equal(archive.files.length, 2);
    const archivePath = path.join(h.config.dataDir, 'reference-uploads', archive.id, 'archive.zip');
    assert.equal(statSync(archivePath).size, zip.length);
    assert.equal(createHash('sha256').update(readFileSync(archivePath)).digest('hex'), createHash('sha256').update(zip).digest('hex'));
    assert.deepEqual(h.store.list(), []);
  } finally { server.close(); }
});

test('ZIP 流式接口：上传断开时删除未完成资料', async () => {
  const { h, port, token, server } = await start();
  const uploads = path.join(h.config.dataDir, 'reference-uploads');
  const upload = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/reference-archives/import', headers: {
    'x-workbench-token': token, 'content-type': 'application/octet-stream', 'x-reference-name': 'interrupted.zip',
  } });
  upload.on('error', () => {});
  try {
    upload.write(Buffer.alloc(64 * 1024));
    const waitUntil = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(predicate());
    };
    await waitUntil(() => existsSync(uploads) && readdirSync(uploads).length > 0);
    upload.destroy();
    await waitUntil(() => readdirSync(uploads).length === 0);
    assert.deepEqual(h.store.list(), []);
  } finally { upload.destroy(); server.close(); }
});

test('SSE：断线重连可按 since 补发事件（问题一定能同步到页面）', async () => {
  const { h, port, token, server } = await start();
  try {
    const run = (await req(port, 'POST', '/api/runs', { body: createBody, headers: { 'x-workbench-token': token } })).json();
    await waitFor(port, run.id, (x) => x.phase === 'answering');
    const text = await new Promise<string>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: `/api/runs/${run.id}/events?since=0`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes('event: gate.opened')) {
            r.destroy();
            resolve(buf);
          }
        });
      });
      r.on('error', (e) => (String(e).includes('socket hang up') ? undefined : reject(e)));
      r.end();
    });
    assert.ok(text.includes('event: question.added'));
    assert.ok(/id: \d+/.test(text));
    await h.orch.idle();
  } finally {
    server.close();
  }
});

test('静态页面：web/dist 不存在时返回占位页（带 CSP）', async () => {
  const { port, server } = await start();
  try {
    const r = await req(port, 'GET', '/');
    assert.equal(r.status, 200);
    assert.ok(String(r.headers['content-security-policy']).includes("default-src 'self'"));
    assert.ok(r.text.includes('API 已运行'));
  } finally {
    server.close();
  }
});

test('探测：只读检查不调用模型；真实探测必须显式确认费用；用假 CLI 走通真实适配器链路', async () => {
  const { port, token, server } = await start();
  const H = { 'x-workbench-token': token };
  try {
    const env = (await req(port, 'POST', '/api/probe', { body: {}, headers: H })).json();
    assert.ok(env.env.findings.some((f: any) => f.id === 'claude.version' && f.level === 'ok'));
    assert.ok(env.env.findings.some((f: any) => f.id === 'codex.auth' && f.level === 'ok'));
      assert.equal(env.env.tools.cursor.version, 'cursor-agent 2026.10.0');
    assert.equal(env.live.length, 0);
    const refused = await req(port, 'POST', '/api/probe', { body: { live: [{ role: 'claude' }] }, headers: H });
    assert.equal(refused.status, 400);
    const live = (await req(port, 'POST', '/api/probe', { body: { live: [{ role: 'claude' }, { role: 'sol', effort: 'ultra' }], confirmCost: true }, headers: H })).json();
    assert.equal(live.live[0].status, 'succeeded');
    assert.equal(live.live[0].outputValid, true);
    assert.equal(live.live[0].meta.modelConfirmed, true);
    assert.equal(live.live[1].effort, 'ultra');
    assert.equal(live.live[1].meta.reportedEffort, 'ultra');
    assert.equal(live.live[1].meta.modelConfirmed, false);
  } finally {
    server.close();
  }
});

test('环境探测识别 agent 同名冲突，不把 Grok Build 版本标为 Cursor', async () => {
  const { h, port, token, server } = await start();
  h.config.adapters.cursor.command = { command: process.execPath, args: [path.join(FAKE, 'cursor-grok-build.mjs')] };
  try {
    const report = (await req(port, 'POST', '/api/probe', { body: {}, headers: { 'x-workbench-token': token } })).json();
    assert.equal(report.env.tools.cursor.version, null);
    const finding = report.env.findings.find((item: any) => item.id === 'cursor.capabilities');
    assert.equal(finding.level, 'error');
    assert.match(finding.message, /Grok Build CLI.*并非 Cursor Agent/);
    assert.equal(report.live.length, 0);
  } finally {
    server.close();
  }
});
