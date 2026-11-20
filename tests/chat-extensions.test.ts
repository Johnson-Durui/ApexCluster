import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs, { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { bootstrapChats } from '../src/chat/bootstrap.js';
import { ExtensionHost, extensionConfigSchema } from '../src/chat/extensions/index.js';
import { compileMcpSchema, McpJsonRpcSession, pinnedLookup, requestPinned } from '../src/chat/extensions/mcp-client.js';
import type { CapabilityCall } from '../src/chat/capability-contract.js';
import type { ChatAttachment, ChatRecord } from '../src/chat/types.js';

const emptyChat = (): ChatRecord => ({ version: 1, id: 'chat', title: 'test', createdAt: '', updatedAt: '', seq: 0, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [] });
const task = { id: 'task', turnId: 'turn', role: 'claude' as const, goal: 'test', status: 'running' as const, createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' as const };
const invocation = { id: 'inv', taskId: 'task', segment: 1, status: 'running' as const, startedAt: '', toolCount: 0, promptVersion: 'x', inputEstimate: 0, contextWindow: null, contextUsed: null };
const context = (chat = emptyChat(), signal = new AbortController().signal): CapabilityCall => ({ chat, task, invocation, toolCallId: 'inv:1', signal });
const fixture = () => {
  const testRoot = path.join(process.cwd(), '.test-tmp'); mkdirSync(testRoot, { recursive: true }); const root = mkdtempSync(path.join(testRoot, 'chat-ext-')), skill = path.join(root, 'skill'); mkdirSync(path.join(skill, 'references'), { recursive: true }); mkdirSync(path.join(skill, 'SCRIPTS'));
  mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: example\ndescription: Example skill\n---\n\nUse references/a.md only.\n'); writeFileSync(path.join(skill, 'references', 'a.md'), 'reference'); writeFileSync(path.join(skill, 'scripts', 'run.js'), 'throw new Error()'); writeFileSync(path.join(skill, 'SCRIPTS', 'upper.js'), 'throw new Error()');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), metadata: ChatAttachment = { id: 'img', name: 'a.png', bytes: image.length, hash: 'hash', mime: 'image/png', createdAt: '', source: 'upload', messageIds: ['m'] };
  return { root, skill, image, metadata, options: { configFile: path.join(root, 'config.json'), readFile: (_chat: ChatRecord, id: string) => { if (id !== 'img') throw new Error('missing'); return { metadata, bytes: image }; }, listFiles: () => [metadata] } };
};
const readServer = (overrides: Record<string,unknown> = {}) => ({ id: 'exa', transport: 'http', url: 'http://127.0.0.1:18782/mcp', toolAllowlist: ['web_search_exa'], toolAccess: { web_search_exa: 'read' }, searchTool: 'web_search_exa', ...overrides });

test('strict settings require explicit access classes and reject native stdio hosts', async () => {
  assert.throws(() => extensionConfigSchema.parse({ version: 1, mcp: [{ id: 'x', transport: 'http', url: 'https://example.com', toolAllowlist: ['read'], toolAccess: {} }] }), /精确分类/);
  assert.throws(() => extensionConfigSchema.parse({ version: 1, mcp: [{ id: 'x', transport: 'http', url: 'https://example.com', toolAllowlist: ['write'], toolAccess: { write: 'write' }, writeToolAllowlist: [] }] }), /写工具/);
  const legacy = extensionConfigSchema.parse({ version: 1, mcp: [readServer({ apiKeyEnv: 'DMW_TEST_MCP_AUTH_KEY' })] });
  assert.equal('apiKeyHeader' in legacy.mcp[0]!, false, 'legacy configs must not gain a serialized default');
  const headerConfigured = extensionConfigSchema.parse({ version: 1, mcp: [readServer({ apiKeyHeader: 'x-api-key' })] }).mcp[0]!;
  assert.equal(headerConfigured.transport, 'http'); if (headerConfigured.transport === 'http') assert.equal(headerConfigured.apiKeyHeader, 'x-api-key');
  assert.throws(() => extensionConfigSchema.parse({ version: 1, mcp: [readServer({ apiKeyHeader: 'X-Custom-Key' })] }), /apiKeyHeader/);
  assert.throws(() => extensionConfigSchema.parse({ version: 1, documentWorker: { enabled: true, url: 'https://example.com' } }), /本机/);
  const f = fixture(); try { const host = new ExtensionHost(f.options); await assert.rejects(host.configure({ version: 1, mcp: [{ id: 'x', transport: 'stdio', dockerCli: process.execPath, dockerCliSha256: 'a'.repeat(64), image: `fake@sha256:${'b'.repeat(64)}`, toolAllowlist: ['read'], toolAccess: { read: 'read' } }] }), /Docker CLI/); } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('skill creation is available before installation; reads are progressive and scripts denied', async () => {
  const f = fixture(); try {
    const host = new ExtensionHost(f.options); assert.ok(host.definitions(task).some(tool => tool.name === 'skill_create')); assert.ok(!host.definitions(task).some(tool => tool.name === 'skill_list'));
    const candidate = await host.call('skill_create', { name: 'new_skill', description: 'A skill', instructions: 'Do work.', resources: [{ path: 'references/a.md', text: 'ref' }] }, context()); assert.equal(candidate.files?.[0]?.mime, 'application/zip'); assert.equal(Buffer.from(candidate.files![0]!.bytes).readUInt32LE(0), 0x04034b50);
    await host.configure({ version: 1, skills: [{ id: 'example', root: f.skill, enabled: true }] }); assert.match((await host.call('skill_list',{},context())).text,/Example skill/); assert.match((await host.call('skill_read',{skillId:'example',resource:'references/a.md'},context())).text,/reference/); await assert.rejects(host.call('skill_read',{skillId:'example',resource:'scripts/run.js'},context()),/脚本/); await assert.rejects(host.call('skill_read',{skillId:'example',resource:'SCRIPTS/upper.js'},context()),/脚本/); await assert.rejects(host.call('skill_read',{skillId:'example',resource:'../config.json'},context()),/越界/);
    const evaluated = await host.call('skill_evaluate',{skillId:'example',cases:[{id:'1',expected:'yes',without:'no',with:'yes'},{id:'2',expected:'ok',without:'ok',with:'ok'}]},context()); assert.deepEqual((evaluated.data as any).exactMatches,{without:1,with:2}); assert.equal((evaluated.data as any).semanticScore,null);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('missing persisted Skills stay locally unavailable while valid Skills and recovery settings remain usable', async () => {
  const f = fixture(), missing = path.join(f.root, 'missing-skill');
  try {
    const persisted = { version: 1, skills: [{ id: 'example', root: f.skill, enabled: true }, { id: 'missing', root: missing, enabled: true }] };
    writeFileSync(f.options.configFile, JSON.stringify(persisted));
    const host = new ExtensionHost(f.options);
    assert.ok(host.definitions(task).some(tool => tool.name === 'skill_list'));
    const listed = await host.call('skill_list', {}, context());
    assert.deepEqual((listed.data as Array<{ id: string }>).map(item => item.id), ['example']);
    assert.match((await host.call('skill_read', { skillId: 'example' }, context())).text, /Example skill/);
    await assert.rejects(host.call('skill_read', { skillId: 'missing' }, context()), /ENOENT/);
    await assert.rejects(host.call('skill_evaluate', { skillId: 'missing', cases: [{ id: '1', expected: '', without: '', with: '' }, { id: '2', expected: '', without: '', with: '' }] }, context()), /ENOENT/);
    const statuses = await host.status();
    assert.equal(statuses.find(item => item.id === 'skill:example')?.state, 'ready');
    assert.equal(statuses.find(item => item.id === 'skill:missing')?.state, 'unavailable');
    await assert.rejects(host.configure(persisted), /ENOENT/);
    writeFileSync(f.options.configFile, JSON.stringify({ ...persisted, mcp: [{ id: 'unsafe', transport: 'stdio', dockerCli: process.execPath, dockerCliSha256: 'a'.repeat(64), image: `fake@sha256:${'b'.repeat(64)}`, toolAllowlist: ['read'], toolAccess: { read: 'read' } }] }));
    assert.throws(() => new ExtensionHost(f.options), /Docker CLI/);
    rmSync(f.skill, { recursive: true, force: true });
    assert.ok(host.definitions(task).some(tool => tool.name === 'skill_list'), 'cached availability may keep metadata tools visible until an explicit refresh');
    await assert.rejects(host.call('skill_read', { skillId: 'example' }, context()), /ENOENT/, 'availability cache must never grant read access');
    const missingStatuses = await host.status();
    assert.equal(missingStatuses.find(item => item.id === 'skill:example')?.state, 'unavailable');
    assert.ok(!host.definitions(task).some(tool => ['skill_list', 'skill_read', 'skill_evaluate'].includes(tool.name)));
    mkdirSync(missing); writeFileSync(path.join(missing, 'SKILL.md'), '---\nname: recovered\ndescription: Recovered skill\n---\n\nRecovered.\n');
    assert.ok(!host.definitions(task).some(tool => tool.name === 'skill_list'), 'a cached unavailable Skill is refreshed outside the hot path');
    assert.deepEqual(((await host.call('skill_list', {}, context())).data as Array<{ id: string }>).map(item => item.id), ['missing']);
    assert.ok(host.definitions(task).some(tool => tool.name === 'skill_list'));
    assert.equal((await host.status()).find(item => item.id === 'skill:missing')?.state, 'ready');
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('chat runtime still starts when a persisted enabled Skill directory disappeared', async () => {
  const f = fixture(), app = path.join(f.root, 'app'), data = path.join(f.root, 'data');
  try {
    mkdirSync(path.join(app, 'config'), { recursive: true }); mkdirSync(path.join(data, 'config'), { recursive: true });
    writeFileSync(path.join(app, 'config', 'chat.config.json'), JSON.stringify({ dataRoot: data }));
    writeFileSync(path.join(data, 'config', 'chat-services.json'), JSON.stringify({ version: 1, skills: [{ id: 'missing', root: path.join(f.root, 'missing-skill'), enabled: true }], documentWorker: { enabled: false, url: 'http://127.0.0.1:18781' } }));
    const boot = bootstrapChats(loadConfig(path.join(process.cwd(), 'config', 'workbench.config.example.json'), process.cwd()), 'test-token', app);
    assert.ok(boot.runtime, 'an unavailable optional Skill must not disable the core chat runtime');
    assert.ok(boot.http, 'settings and recovery HTTP routes must remain available');
    await boot.runtime.shutdown();
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('bootstrap rejects a linked receipt root before changing its target permissions', async t => {
  const f = fixture(), app = path.join(f.root, 'app'), data = path.join(f.root, 'data');
  assert.ok(path.resolve(f.root).startsWith(path.join(process.cwd(), '.test-tmp') + path.sep));
  const target = path.join(f.root, 'unrelated-directory'), receiptRoot = path.join(data, 'work', 'job-receipts');
  mkdirSync(path.join(app, 'config'), { recursive: true }); mkdirSync(path.dirname(receiptRoot), { recursive: true }); mkdirSync(target);
  writeFileSync(path.join(app, 'config', 'chat.config.json'), JSON.stringify({ dataRoot: data }));
  symlinkSync(target, receiptRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const before = lstatSync(target), chmodCalls: string[] = [], originalChmod = fs.chmodSync;
  t.mock.method(fs, 'chmodSync', (file: Parameters<typeof fs.chmodSync>[0], mode: Parameters<typeof fs.chmodSync>[1]) => {
    chmodCalls.push(String(file)); return originalChmod(file, mode);
  });
  syncBuiltinESMExports();
  let boot: ReturnType<typeof bootstrapChats> | undefined;
  try {
    boot = bootstrapChats(loadConfig(path.join(process.cwd(), 'config', 'workbench.config.example.json'), process.cwd()), 'test-token', app);
    assert.equal(boot.runtime, undefined);
    assert.deepEqual(chmodCalls, [], 'rejected receipt links must never reach chmod');
    const after = lstatSync(target);
    assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await boot?.runtime?.shutdown();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a disabled persisted stdio MCP may lose its Docker file without weakening enabled or new configuration checks', async () => {
  const f = fixture(), dockerCli = path.join(f.root, 'missing', 'docker.exe');
  const server = { id: 'gone', enabled: false, transport: 'stdio', dockerCli, dockerCliSha256: 'a'.repeat(64), image: `fake@sha256:${'b'.repeat(64)}`, toolAllowlist: ['read'], toolAccess: { read: 'read' } };
  try {
    writeFileSync(f.options.configFile, JSON.stringify({ version: 1, mcp: [server] }));
    const host = new ExtensionHost(f.options);
    assert.ok(!host.definitions(task).some(tool => ['mcp_list', 'mcp_call'].includes(tool.name)));
    await assert.rejects(host.call('mcp_list', { serverId: 'gone' }, context()), /MCP未启用/);
    await assert.rejects(host.configure({ version: 1, mcp: [server] }), /ENOENT/);
    writeFileSync(f.options.configFile, JSON.stringify({ version: 1, mcp: [{ ...server, enabled: true }] }));
    assert.throws(() => new ExtensionHost(f.options), /ENOENT/);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('JSON-RPC session validates initialize, pagination and matching response identities without a native process', async () => {
  const seen: string[] = []; const session = new McpJsonRpcSession(async (request:any, expected) => { seen.push(request.method); if (expected === null) return {}; if (request.method === 'initialize') return { protocolVersion:'2025-03-26',serverInfo:{name:'fake'} }; if (request.method === 'tools/list' && !request.params.cursor) return { tools:[{name:'read',inputSchema:{type:'object'},outputSchema:{type:'object'}}],nextCursor:'two' }; if (request.method === 'tools/list') return { tools:[{name:'other',inputSchema:{type:'object'}}] }; return { content:[{type:'text',text:'ok'}],isError:false }; });
  await session.initialize(); const tools=await session.tools();assert.deepEqual(tools.map(tool=>tool.name),['read','other']);assert.deepEqual(tools[0]?.outputSchema,{type:'object'}); assert.equal(((await session.call('read',{})) as any).content[0].text,'ok'); assert.deepEqual(seen,['initialize','notifications/initialized','tools/list','tools/list','tools/call']);
  const bad = new McpJsonRpcSession(async () => ({ protocolVersion:'wrong',serverInfo:{name:'fake'} })); await assert.rejects(bad.initialize(),/协商/);
  let lookupArgs: unknown[]=[];pinnedLookup({address:'203.0.113.7',family:4},{all:true},(...args:unknown[])=>{lookupArgs=args;});assert.deepEqual(lookupArgs,[null,[{address:'203.0.113.7',family:4}]]);
  const draft7=compileMcpSchema({$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false});assert.equal(draft7({ok:true}),true);assert.equal(draft7({ok:'yes'}),false);assert.throws(()=>compileMcpSchema({$schema:'https://json-schema.org/draft/2099-01/schema',type:'object'}),/不受支持/);
});

test('HTTP MCP supports bounded SSE, negotiated sessions, schema validation, DELETE and explicit Exa mapping', async () => {
  const f = fixture(); let deletes = 0, sessionCalls = 0; const searchArguments: Array<Record<string,unknown>>=[]; const server = createServer(async (req,res) => {
    assert.equal(req.headers['mcp-protocol-version'],'2025-03-26'); if (req.method === 'DELETE') { deletes++; res.statusCode=204; return res.end(); } const chunks:Buffer[]=[]; for await(const chunk of req) chunks.push(chunk as Buffer); const rpc=JSON.parse(Buffer.concat(chunks).toString()) as any;
    if (rpc.method==='initialize') { res.setHeader('content-type','application/json');res.setHeader('mcp-session-id','session-1');return res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}})); }
    assert.equal(req.headers['mcp-session-id'],'session-1');sessionCalls++; if(rpc.method==='notifications/initialized'){res.statusCode=202;return res.end();}
    if(rpc.method==='tools/list'){res.setHeader('content-type','text/event-stream');res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools:[{name:'web_search_exa',description:'search',inputSchema:{$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{query:{type:'string'},numResults:{type:'integer'},objective:{type:'string'}},required:['query','objective'],additionalProperties:false},outputSchema:{$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{sources:{type:'array',items:{type:'string'}}},required:['sources'],additionalProperties:false}},{name:'publish',description:'write',inputSchema:{type:'object',additionalProperties:false}}]}})}\n\n`);const timer=setTimeout(()=>res.end(),5_000);res.once('close',()=>clearTimeout(timer));return;}
    if(rpc.method==='tools/call'&&rpc.params?.name==='web_search_exa')searchArguments.push(rpc.params.arguments);const query=rpc.params?.arguments?.query;const result=query==='bad-json'?{content:[{type:'text',text:'bad'}],isError:'false',structuredContent:{sources:[]}}:query==='bad-sse'?{content:[{type:'text',text:'bad'}],isError:false,structuredContent:{sources:'invalid'}}:query==='error-sse'?{content:[{type:'text',text:'upstream failed'}],isError:true}:{content:[{type:'text',text:'https://example.test/source'}],structuredContent:{sources:['https://example.test/source']}};
    if(['bad-sse','sse-success','error-sse'].includes(query)){res.setHeader('content-type','text/event-stream');return res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})}\n\n`);} res.setHeader('content-type','application/json');return res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  }); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  try { const host=new ExtensionHost(f.options);await host.configure({version:1,mcp:[readServer({url:`http://127.0.0.1:${address.port}/mcp`,toolAllowlist:['web_search_exa','publish'],toolAccess:{web_search_exa:'read',publish:'write'},writeToolAllowlist:['publish'],allowWrites:false})]});const started=Date.now(),listed=await host.call('mcp_list',{serverId:'exa'},context());assert.ok(Date.now()-started<2_000,'持续SSE应在匹配帧到达后完成');assert.match(listed.text,/outputSchema/);assert.ok(host.definitions(task).some(tool=>tool.name==='mcp_exa_web_search_exa'&&tool.inputSchema.required));assert.ok(!host.definitions(task).some(tool=>tool.name==='mcp_exa_publish'));await assert.rejects(host.call('mcp_call',{serverId:'exa',tool:'publish',arguments:{}},context()),/写工具未启用/);await assert.rejects(host.call('mcp_call',{serverId:'exa',tool:'web_search_exa',arguments:{query:1,numResults:3}},context()),/schema/);assert.match((await host.call('web_search',{query:'latest',numResults:3},context())).text,/source/);assert.deepEqual(searchArguments.at(-1),{query:'latest',numResults:3,objective:'latest'});assert.match((await host.call('web_search',{query:'sse-success',numResults:3,objective:'verify SSE'},context())).text,/source/);assert.deepEqual(searchArguments.at(-1),{query:'sse-success',numResults:3,objective:'verify SSE'});await assert.rejects(host.call('web_search',{query:'bad-json',numResults:3},context()),/isError存在时必须为boolean/);await assert.rejects(host.call('web_search',{query:'bad-sse',numResults:3},context()),/outputSchema/);await assert.rejects(host.call('web_search',{query:'error-sse',numResults:3},context()),/upstream failed/);assert.ok(sessionCalls>=8);assert.ok(deletes>=7);await assert.rejects(requestPinned(new URL('https://10.0.0.1/test'),{method:'POST',body:Buffer.from('{}'),maxBytes:1024,timeoutMs:1000,signal:new AbortController().signal}),/非公网/); }
  finally { await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(f.root,{recursive:true,force:true}); }
});

test('HTTP MCP applies the configured API-key header to initialize, list, call and cleanup', async () => {
  const f = fixture(), envName = 'DMW_TEST_MCP_AUTH_KEY', previous = process.env[envName];
  process.env[envName] = 'opaque-test-key';
  const seen: Array<{ method: string; rpc?: string; authorization?: string; apiKey?: string }> = [];
  const server = createServer(async (req, res) => {
    const entry = { method: req.method ?? '', authorization: req.headers.authorization, apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined };
    if (req.method === 'DELETE') { seen.push(entry); res.statusCode = 204; return res.end(); }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const rpc = JSON.parse(Buffer.concat(chunks).toString()) as any; seen.push({ ...entry, rpc: rpc.method });
    if (rpc.method === 'initialize') { res.setHeader('mcp-session-id', 'auth-session'); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'auth-test' } } })); }
    if (rpc.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
    res.setHeader('content-type', 'application/json');
    if (rpc.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'web_search_exa', inputSchema: { type: 'object', additionalProperties: false } }] } }));
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
  const run = async (apiKeyHeader?: 'Authorization' | 'x-api-key') => {
    seen.length = 0; const host = new ExtensionHost(f.options);
    await host.configure({ version: 1, mcp: [readServer({ url: `http://127.0.0.1:${address.port}/mcp`, apiKeyEnv: envName, ...(apiKeyHeader ? { apiKeyHeader } : {}) })] });
    assert.match((await host.call('mcp_call', { serverId: 'exa', tool: 'web_search_exa', arguments: {} }, context())).text, /ok/);
    assert.deepEqual(seen.map(item => item.rpc ?? item.method), ['initialize', 'notifications/initialized', 'tools/list', 'DELETE', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE']);
    for (const request of seen) if (apiKeyHeader === 'x-api-key') { assert.equal(request.apiKey, 'opaque-test-key'); assert.equal(request.authorization, undefined); } else { assert.equal(request.authorization, 'Bearer opaque-test-key'); assert.equal(request.apiKey, undefined); }
  };
  try {
    await run(); await run('Authorization'); await run('x-api-key');
    delete process.env[envName]; seen.length = 0; const host = new ExtensionHost(f.options);
    await host.configure({ version: 1, mcp: [readServer({ url: `http://127.0.0.1:${address.port}/mcp`, apiKeyEnv: envName, apiKeyHeader: 'x-api-key' })] });
    await assert.rejects(host.call('mcp_list', { serverId: 'exa' }, context()), /环境变量 DMW_TEST_MCP_AUTH_KEY 未设置/); assert.equal(seen.length, 0);
  } finally {
    previous === undefined ? delete process.env[envName] : process.env[envName] = previous;
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(f.root, { recursive: true, force: true });
  }
});

test('media requires explicit paid-call opt-in, bounded response and injected real decoder contract', async () => {
  const f=fixture(),old=process.env.DMW_TEST_MEDIA_KEY;process.env.DMW_TEST_MEDIA_KEY='opaque-test-value';let decodedMime:'image/png'|'image/webp'='image/png';const imageRequests:any[]=[];const options={...f.options,inspectImage:async()=>({mime:decodedMime,width:1,height:1})};
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);assert.equal(req.headers.authorization,'Bearer opaque-test-value');if(req.url==='/large'){res.setHeader('content-type','application/json');return res.end('x'.repeat(2048));}res.setHeader('content-type','application/json');const body=Buffer.concat(chunks).toString();if(body.includes('messages'))return res.end(JSON.stringify({choices:[{message:{content:'图像描述'}}]}));const parsed=JSON.parse(body);imageRequests.push(parsed);if(req.url==='/gpt-image'&&Object.hasOwn(parsed,'response_format')){res.statusCode=400;return res.end(JSON.stringify({error:{message:'Unknown parameter: response_format'}}));}res.end(JSON.stringify({data:[{b64_json:f.image.toString('base64')}]}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  try { const host=new ExtensionHost(options);await host.configure({version:1,media:{vision:{enabled:true,allowPaidCalls:false,endpoint:`http://127.0.0.1:${address.port}/vision`,model:'fake',apiKeyEnv:'DMW_TEST_MEDIA_KEY'},image:{enabled:true,allowPaidCalls:true,endpoint:`http://127.0.0.1:${address.port}/image`,model:'fake',apiKeyEnv:'DMW_TEST_MEDIA_KEY'}}});assert.ok(!host.definitions(task).some(tool=>tool.name==='image_read'));assert.equal((await host.status()).find(item=>item.id==='media:vision')?.state,'disabled');await assert.rejects(host.call('image_read',{fileId:'img',prompt:'describe'},context()),/未允许/);decodedMime='image/webp';const generated=await host.call('image_generate',{prompt:'draw'},context());assert.equal(generated.files?.[0]?.mime,'image/webp');assert.match(generated.files![0]!.name,/\.webp$/);assert.equal(imageRequests.at(-1)?.response_format,'b64_json','legacy image services must retain explicit b64 response format');
    decodedMime='image/png';await host.configure({version:1,media:{image:{enabled:true,allowPaidCalls:true,endpoint:`http://127.0.0.1:${address.port}/gpt-image`,model:'gpt-image-2',apiKeyEnv:'DMW_TEST_MEDIA_KEY'}}});const gptImage=await host.call('image_generate',{prompt:'draw with GPT Image 2'},context());assert.equal(Object.hasOwn(imageRequests.at(-1)!,'response_format'),false,'GPT Image models must omit unsupported response_format');assert.equal(imageRequests.at(-1)?.model,'gpt-image-2');assert.equal(gptImage.files?.[0]?.mime,'image/png');assert.deepEqual(gptImage.files?.[0]?.bytes,f.image);
    await host.configure({version:1,media:{image:{enabled:true,allowPaidCalls:true,endpoint:`http://127.0.0.1:${address.port}/large`,model:'fake',apiKeyEnv:'DMW_TEST_MEDIA_KEY',maxOutputBytes:1024}}});await assert.rejects(host.call('image_generate',{prompt:'draw'},context()),/字节上限/);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));old===undefined?delete process.env.DMW_TEST_MEDIA_KEY:process.env.DMW_TEST_MEDIA_KEY=old;rmSync(f.root,{recursive:true,force:true});}
});
