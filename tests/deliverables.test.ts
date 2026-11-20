import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { parseReferenceArchive } from '../src/core/reference-documents.js';
import { GateInputZ } from '../src/core/schemas.js';
import { createApp } from '../src/server/app.js';
import { deliveryArchive, listDeliverables, openArtifact } from '../src/server/deliverables.js';
import { makeHarness, runInput } from './helpers.js';

async function builtFixture(docs = false) {
  const h = makeHarness();
  const created = h.orch.createRun(runInput('preference', { writeDocs: docs }));
  await h.orch.idle();
  h.orch.resolveGate(created.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  const candidate = h.orch.frameworkGateDefaults(created.id)[0]!;
  h.orch.resolveGate(created.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [candidate.candidateId], specs: [candidate.spec] }));
  await h.orch.idle();
  if (docs) {
    h.orch.resolveGate(created.id, GateInputZ.parse({ gate: 'G3_docs', action: 'approve' }));
    await h.orch.idle();
  }
  const run = h.orch.getRun(created.id);
  const job = run.jobs[0]!;
  const put = (name: string, data: string | Buffer) => {
    const file = path.join(job.workspaceDir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data);
  };
  put('README.md', '# 使用说明\n先进入模拟练习。');
  put('src/小车.py', 'print("模拟")');
  put('docs/使用说明 #1.md', '松手停车。');
  put('empty.txt', '');
  const binary = Buffer.alloc(256 * 1024);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
  put('dist/小车-Setup.exe', binary);
  for (const name of ['.git/config', '.venv/private.txt', 'node_modules/module.js', 'work/pip-cache/download.body', 'src/__pycache__/a.pyc', '.workbench-references/archive.zip', '.env', '.env.production', '.codex/auth.json']) put(name, 'SECRET');
  put('.env.example', 'PORT=8765');
  return { h, run, job, put, binary };
}

test('交付下载：真实磁盘文件、中文名称、二进制和完整 ZIP（含正式文档、失败证据）', async () => {
  const { h, run, job, binary } = await builtFixture(true);
  job.status = 'failed';
  h.store.save(run);
  const app = createApp({ config: h.config, orchestrator: h.orch, bus: h.bus, token: 'a'.repeat(64), staticDir: path.join(h.dir, 'no-web') });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  h.config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${h.config.port}/api/runs/${run.id}`;
  try {
    const manifest = await (await fetch(`${base}/deliverables`)).json() as { jobs: Awaited<ReturnType<typeof listDeliverables>>[] };
    const inventory = manifest.jobs[0]!;
    assert.equal(inventory.available, true);
    assert.equal(inventory.incomplete, false);
    assert.ok(inventory.files.some(file => file.path === 'docs/使用说明 #1.md'));
    assert.ok(inventory.files.some(file => file.path === '.env.example'));
    assert.equal(inventory.files.some(file => /SECRET|node_modules|pip-cache|\.venv|__pycache__|\.workbench|\.env\.production|\.codex/.test(file.path)), false);
    const fileResponse = await fetch(`${base}/jobs/${job.id}/artifact?path=${encodeURIComponent('dist/小车-Setup.exe')}`);
    assert.equal(fileResponse.status, 200);
    assert.equal(fileResponse.headers.get('content-type'), 'application/octet-stream');
    assert.match(fileResponse.headers.get('content-disposition')!, /filename\*=UTF-8''dist|filename\*=UTF-8''%E5/);
    assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), binary);
    const response = await fetch(`${base}/jobs/${job.id}/archive`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.length, Number(response.headers.get('content-length')));
    const parsed = parseReferenceArchive('交付.zip', zip);
    assert.deepEqual(parsed.notes, []);
    const files = new Map(parsed.files.map(file => [file.name, file.bytes]));
    assert.deepEqual(files.get('workspace/dist/小车-Setup.exe'), binary);
    assert.equal(files.get('workspace/empty.txt')!.length, 0);
    assert.equal(files.get('workspace/docs/使用说明 #1.md')!.toString(), '松手停车。');
    assert.equal(files.has('workspace/.env'), false);
    assert.match(files.get('交付说明.md')!.toString(), /模拟数据/);
    assert.match(files.get('交付说明.md')!.toString(), /failed/);
    assert.equal(JSON.parse(files.get('交付记录/validation.json')!.toString()).job.status, 'failed');
    assert.ok(files.has('交付记录/decision.md'));
    for (const version of run.docs.versions) {
      const official = await fetch(`${base}/docs/${version.kind}/${version.version}/download?format=md`);
      assert.equal(files.get(`项目文档/${version.kind}-v${version.version}.md`)!.toString(), await official.text());
      assert.match(files.get(`项目文档/${version.kind}-v${version.version}.html`)!.toString(), /<!doctype html>/i);
    }
    for (const relative of ['../secret.txt', '..\\secret.txt', '/etc/passwd', 'C:/Windows/win.ini', 'README.md:secret', '.env', '.git/config', 'docs/../README.md', 'README.md.']) {
      assert.equal((await fetch(`${base}/jobs/${job.id}/artifact?path=${encodeURIComponent(relative)}`)).status, 400, relative);
    }
    assert.equal((await fetch(`${base}/jobs/other-job/artifact?path=README.md`)).status, 404);
    assert.equal((await fetch(`${base}/jobs/${job.id}/artifact?path=missing.txt`)).status, 404);
    assert.equal((await fetch(`${base}/jobs/${job.id}/artifact?path=docs`)).status, 403);
    assert.equal((await fetch(`${base}/deliverables`, { headers: { origin: 'https://evil.example' } })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('交付文件边界：拒绝链接和跨工作区路径，丢失工作区明确返回不可用', async () => {
  const { h, job } = await builtFixture();
  const outside = path.join(h.dir, 'outside');
  mkdirSync(outside); writeFileSync(path.join(outside, 'secret.txt'), 'do not export');
  symlinkSync(outside, path.join(job.workspaceDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  linkSync(path.join(outside, 'secret.txt'), path.join(job.workspaceDir, 'hardlink.txt'));
  const inventory = await listDeliverables(job);
  assert.equal(inventory.files.some(file => /linked|hardlink/.test(file.path)), false);
  assert.match(inventory.warnings.join(''), /跳过 2/);
  await assert.rejects(openArtifact(job, 'linked/secret.txt'), /链接|联接/);
  await assert.rejects(openArtifact(job, 'hardlink.txt'), /普通文件/);
  const missing = await listDeliverables({ ...job, workspaceDir: path.join(h.dir, 'missing', job.runId, job.id) });
  assert.equal(missing.available, false);
  assert.equal(missing.files.length, 0);
  const invalid = await listDeliverables({ ...job, workspaceDir: outside });
  assert.equal(invalid.available, false);
  assert.match(invalid.warnings.join(''), /路径无效/);
});

test('交付包：构建未结束和读取期间文件变化均拒绝生成成功包', async () => {
  const { h, run, job } = await builtFixture();
  await assert.rejects(deliveryArchive(run, { ...job, status: 'running' }, h.config.targetPlatform), /仍在构建/);
  const archive = await deliveryArchive(run, job, h.config.targetPlatform);
  await archive.stream.next(); // Header only: no file has been opened yet.
  appendFileSync(path.join(job.workspaceDir, '.env.example'), '\nCHANGED=1');
  await assert.rejects(async () => { for await (const _chunk of archive.stream) { /* consume */ } }, /文件发生变化/);
});

test('Windows：8.3 短目录名不能绕过虚拟环境排除规则', { skip: process.platform !== 'win32' }, async context => {
  const { job } = await builtFixture();
  if (!existsSync(path.join(job.workspaceDir, 'VENV~1', 'private.txt'))) return context.skip('此卷未启用 8.3 短文件名。');
  await assert.rejects(openArtifact(job, 'VENV~1/private.txt'), /私密配置|文件路径无效/);
});
