import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DocumentProvider, documentWorkerIdentity } from '../src/chat/document-provider.js';
import { ChatStore } from '../src/chat/store.js';
import { SessionFiles } from '../src/chat/session-files.js';
import type { CapabilityCall } from '../src/chat/capability-contract.js';
import { ExtensionHost } from '../src/chat/extensions/index.js';

test('document host passes bound bytes, verifies all output hashes and retries only reads', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'document-provider-')); const store = new ChatStore(root), files = new SessionFiles(store), chat = store.create();
  const input = files.upload(chat, { name: '资料.txt', base64: Buffer.from('中文来源').toString('base64'), clientUploadId: 'u' }); files.bind(chat, [input.id], 'm');
  let attempts = 0, wrongHash = false, drift = false, empty = false; const payloads: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type','application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok', version: '1', implementationSha256: drift ? 'old' : documentWorkerIdentity() })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); payloads.push(body);
    if (body.operation === 'read' && attempts++ === 0) { res.writeHead(429, { 'retry-after': '0' }); res.end(JSON.stringify({ error: { message: 'busy' } })); return; }
    if (empty) { res.end(JSON.stringify({ files: [] })); return; }
    const bytes = Buffer.from('真实文档'); const format = body.formats?.[0] ?? 'md'; res.end(JSON.stringify(body.operation === 'read' ? { files: [], text: '[资料.txt document 1]中文来源', metadata: { documents: [] } } : { files: [{ name: `结果.${format}`, mime: 'application/octet-stream', base64: bytes.toString('base64'), sha256: wrongHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') }] }));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); const port = (server.address() as { port: number }).port;
  const provider = new DocumentProvider(files, () => ({ enabled:true,url:`http://127.0.0.1:${port}` })); const call = { chat, task: { id: 't' }, invocation: { id: 'i' }, toolCallId: 'i:1', signal: new AbortController().signal } as CapabilityCall;
  try {
    assert.equal((await provider.status()).state,'ready');
    const read = await provider.call('document_read',{fileId:input.id},call); assert.match(read.text,/中文来源/); assert.equal(attempts,2);
    assert.equal(JSON.stringify(payloads).includes('dataRoot'),false); assert.ok(JSON.stringify(payloads).includes(input.name));
    const create = await provider.call('document_create',{formats:['md'],document:{title:'标题',blocks:[{type:'paragraph',text:'内容'}]}},call); assert.equal(Buffer.from(create.files![0]!.bytes).toString(),'真实文档');
    await provider.call('document_create',{formats:['pptx'],document:{title:'主题',theme:{background:'102030',text:'E0E6EE',accent:'36C2B4',font:'Noto Sans CJK SC'}}},call);
    assert.deepEqual((payloads.at(-1) as { document: { theme: unknown } }).document.theme,{background:'102030',text:'E0E6EE',accent:'36C2B4',font:'Noto Sans CJK SC'});
    await assert.rejects(provider.call('document_create',{formats:['md'],document:{title:'x',theme:{accent:'36C2B4'}}},call),/仅用于 PPTX/);
    await assert.rejects(provider.call('document_create',{formats:['pptx'],document:{title:'x',theme:{accent:'#36C2B4'}}},call));
    await assert.rejects(provider.call('document_create',{formats:['pptx'],document:{title:'x',theme:{font:'..\\font.ttf'}}},call));
    await assert.rejects(provider.call('document_create',{formats:['pptx'],document:{title:'x',theme:{unknown:'value'}}},call));
    wrongHash = true; await assert.rejects(provider.call('document_create',{formats:['md'],document:{title:'x'}},call),/哈希不一致/); assert.equal(chat.attachments!.length,1);
    wrongHash = false; empty = true; await assert.rejects(provider.call('document_create',{formats:['md'],document:{title:'x'}},call),/未生成任何文件/);
    drift = true; assert.equal((await provider.status()).state,'drifted'); await assert.rejects(provider.call('document_read',{fileId:input.id},call),/不一致/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); rmSync(root,{recursive:true,force:true}); }
});

test('production Pillow decoder accepts generated unknown MIME and rejects corrupt or mismatched images', { skip: process.env.DOCUMENT_WORKER_VERIFY !== '1' }, async () => {
  // Only the model endpoint is a fixture: the image crosses the production ExtensionHost → Docker decoder contract.
  const root = mkdtempSync(path.join(tmpdir(), 'document-image-contract-'));
  const store = new ChatStore(root), files = new SessionFiles(store), chat = store.create();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const provider = new DocumentProvider(files, () => ({ enabled: true, url: process.env.DOCUMENT_WORKER_BASE_URL ?? 'http://127.0.0.1:18781' }));
  const uploaded = files.upload(chat, { name: '参考.png', base64: png.toString('base64'), clientUploadId: 'image' }); files.bind(chat, [uploaded.id], 'm');
  const saved = process.env.DMW_IMAGE_CONTRACT_KEY; process.env.DMW_IMAGE_CONTRACT_KEY = 'local-fixture-only';
  let corrupt = false, editedReference = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/edit') editedReference = Buffer.concat(chunks).includes(png);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/vision') { res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture vision response; not a semantic image evaluation.' } }] })); return; }
    res.end(JSON.stringify({ data: [{ b64_json: (corrupt ? png.subarray(0, 32) : png).toString('base64') }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const host = new ExtensionHost({ configFile: path.join(root, 'services.json'), readFile: (value, id) => files.read(value, id), listFiles: value => files.list(value), inspectImage: (input, signal) => provider.inspectImage(input, signal) });
  try {
    assert.equal((await provider.status()).state, 'ready');
    assert.deepEqual(await provider.inspectImage({ name: 'generated', mime: 'application/octet-stream', bytes: png }, new AbortController().signal), { mime: 'image/png', width: 1, height: 1 });
    await assert.rejects(provider.inspectImage({ name: 'bad.jpg', mime: 'image/jpeg', bytes: png }, new AbortController().signal), /回执不匹配/);
    await host.configure({ version: 1, media: { vision: { enabled:true,allowPaidCalls:true,endpoint:`http://127.0.0.1:${port}/vision`,model:'deterministic-fixture',apiKeyEnv:'DMW_IMAGE_CONTRACT_KEY' }, image: { enabled: true, allowPaidCalls: true, endpoint: `http://127.0.0.1:${port}/image`, editEndpoint: `http://127.0.0.1:${port}/edit`, model: 'deterministic-fixture', apiKeyEnv: 'DMW_IMAGE_CONTRACT_KEY' } } });
    const call = { chat, task: { id: 'task', turnId: 'turn', role: 'claude', mode: 'read', status: 'running' }, invocation: { id: 'inv' }, toolCallId: 'image-contract', signal: new AbortController().signal } as CapabilityCall;
    const result = await host.call('image_generate', { prompt: 'Fixture contract verification' }, call);
    assert.equal(result.files?.[0]?.mime, 'image/png'); assert.deepEqual(Buffer.from(result.files![0]!.bytes), png);
    const edited = await host.call('image_generate', { prompt:'Reference edit transport verification',referenceFileId:uploaded.id },call);
    assert.equal(editedReference,true); assert.deepEqual(edited.files?.[0]?.inputHashes,[uploaded.hash]);
    const described = await host.call('image_read',{fileId:uploaded.id,prompt:'Validate bound source transport'},call); assert.match(described.text,/Fixture vision response/);
    corrupt = true; await assert.rejects(host.call('image_generate', { prompt: 'Reject malformed image bytes' }, call));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved === undefined) delete process.env.DMW_IMAGE_CONTRACT_KEY; else process.env.DMW_IMAGE_CONTRACT_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
