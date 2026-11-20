import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { killTree } from '../../adapters/process.js';
import { runProcess, type ResolvedCommand } from '../../adapters/process.js';
import type { McpConfig } from './config.js';

const protocolVersion = '2025-03-26';
type RpcEnvelope = { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
export interface McpToolManifest { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }
export interface McpManifest { serverId: string; tools: McpToolManifest[] }
export class McpProcessError extends Error { constructor(message: string, public readonly exitConfirmed: boolean) { super(message); this.name = 'McpProcessError'; } }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
export function compileMcpSchema(schema: Record<string, unknown>) {
  const declared = schema.$schema;
  if (declared !== undefined && typeof declared !== 'string') throw new Error('MCP JSON schema草案声明无效');
  if (declared === 'http://json-schema.org/draft-07/schema#' || declared === 'https://json-schema.org/draft-07/schema') return new Ajv({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
  if (declared === undefined || declared === 'https://json-schema.org/draft/2020-12/schema' || declared === 'https://json-schema.org/draft/2020-12/schema#') return new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
  throw new Error(`MCP JSON schema草案不受支持: ${declared}`);
}

function ipv4Private(ip: string) {
  const parts = ip.split('.').map(Number); if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return true; const [a,b,c] = parts as [number,number,number,number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}
function ipv6Private(raw: string) {
  const ip = raw.toLowerCase().split('%')[0]!; if (ip.startsWith('::ffff:')) return ipv4Private(ip.slice(7));
  if (ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89a-f]/.test(ip) || /^ff/.test(ip) || ip.startsWith('2001:db8:') || ip.startsWith('2001:0:') || ip.startsWith('2001:2:') || ip.startsWith('2001:10:') || ip.startsWith('2001:20:') || ip.startsWith('2002:')) return true;
  const first = Number.parseInt(ip.split(':')[0] || '0', 16); return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff;
}
const privateAddress = (address: string) => isIP(address) === 4 ? ipv4Private(address) : isIP(address) === 6 ? ipv6Private(address) : true;
const host = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
const loopback = (address: string) => address === '::1' || address.startsWith('127.');
export function assertEndpoint(raw: string): URL {
  const url = new URL(raw), hostname = host(url), local = hostname === 'localhost' || loopback(hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('扩展端点只允许HTTPS或本机loopback HTTP');
  if (url.username || url.password || url.hash) throw new Error('扩展端点不能包含凭据或fragment'); return url;
}
async function pinnedAddress(url: URL) {
  const hostname = host(url); if (isIP(hostname)) { if (privateAddress(hostname) && !loopback(hostname)) throw new Error('远程端点不能指向非公网地址'); return { address: hostname, family: isIP(hostname) as 4 | 6 }; }
  const addresses = await lookup(hostname, { all: true, verbatim: true }); if (!addresses.length) throw new Error('扩展端点无法解析');
  if (hostname === 'localhost') { const item = addresses.find(value => loopback(value.address)); if (!item) throw new Error('localhost未解析到loopback'); return item; }
  if (addresses.some(item => privateAddress(item.address))) throw new Error('远程端点包含非公网解析结果'); return addresses[0]!;
}
export function pinnedLookup(pinned: { address: string; family: number }, options: unknown, callback: (...args: any[]) => void) {
  if (options && typeof options === 'object' && (options as { all?: unknown }).all === true) callback(null, [pinned]);
  else callback(null, pinned.address, pinned.family);
}
export async function requestPinned(url: URL, options: { method: 'POST' | 'DELETE'; headers?: Record<string,string>; body?: Buffer; maxBytes: number; timeoutMs: number; signal: AbortSignal; sseExpectedId?: number }) {
  const pinned = await pinnedAddress(url); return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    let settled = false; const done = (error?: Error, value?: { status: number; headers: http.IncomingHttpHeaders; body: Buffer }) => { if (settled) return; settled = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value!); };
    const transport = url.protocol === 'https:' ? https : http; const request = transport.request({ protocol: url.protocol, hostname: host(url), port: url.port || undefined, path: `${url.pathname}${url.search}`, method: options.method, headers: { ...options.headers, ...(options.body ? { 'content-length': String(options.body.length) } : {}) }, lookup: ((_name: string, lookupOptions: unknown, callback: (...args: any[]) => void) => pinnedLookup(pinned, lookupOptions, callback)) as any, ...(url.protocol === 'https:' ? { ...(isIP(host(url)) ? {} : { servername: host(url) }), rejectUnauthorized: true } : {}) }, response => {
      const chunks: Buffer[] = []; let bytes = 0, sse = ''; const decoder = new StringDecoder('utf8'), isSse = String(response.headers['content-type'] ?? '').includes('text/event-stream'); response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) { response.destroy(); done(new Error('响应超过字节上限')); return; } chunks.push(chunk); if (isSse && options.sseExpectedId !== undefined) { sse += decoder.write(chunk); for (;;) { const match = /\r?\n\r?\n/.exec(sse); if (!match?.index && match?.index !== 0) break; const end = match.index + match[0].length, frame = sse.slice(0,end); sse = sse.slice(end); const data = frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n'); if (!data) continue; try { if ((JSON.parse(data) as RpcEnvelope)?.id === options.sseExpectedId) { response.destroy(); done(undefined,{status:response.statusCode??0,headers:response.headers,body:Buffer.from(frame)}); return; } } catch (error) { response.destroy(); done(error instanceof Error?error:new Error(String(error))); return; } } } }); response.once('end', () => { decoder.end(); done(undefined, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }); }); response.on('error', error => done(error));
    });
    const abort = () => request.destroy(new Error('调用已取消')); options.signal.addEventListener('abort', abort, { once: true }); const timer = setTimeout(() => request.destroy(new Error('调用超时')), options.timeoutMs); request.once('error', error => done(error)); if (options.signal.aborted) abort(); else { if (options.body) request.write(options.body); request.end(); }
  });
}
function parseEnvelope(value: unknown, expectedId: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP响应不是JSON-RPC对象'); const rpc = value as RpcEnvelope;
  if (rpc.jsonrpc !== '2.0' || rpc.id !== expectedId || (!!rpc.error === ('result' in rpc))) throw new Error('MCP JSON-RPC身份或结构无效');
  if (rpc.error) throw new Error(typeof rpc.error.message === 'string' ? rpc.error.message.slice(0, 500) : 'MCP返回错误'); return rpc.result;
}
function parseResponse(body: Buffer, contentType: string, expectedId: number) {
  if (contentType.includes('application/json')) return parseEnvelope(JSON.parse(body.toString('utf8')), expectedId);
  if (contentType.includes('text/event-stream')) { let found: unknown; for (const event of body.toString('utf8').split(/\r?\n\r?\n/)) { const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /,'')).join('\n'); if (!data) continue; const value = JSON.parse(data); if ((value as RpcEnvelope)?.id === expectedId) found = parseEnvelope(value, expectedId); } if (found === undefined) throw new Error('MCP SSE未包含匹配响应'); return found; }
  throw new Error('MCP响应类型必须是JSON或SSE');
}

export class McpJsonRpcSession {
  private id = 0;
  constructor(private readonly exchange: (request: object, expectedId: number | null) => Promise<unknown>) {}
  private request(method: string, params: unknown) { const id = ++this.id; return this.exchange({ jsonrpc: '2.0', id, method, params }, id); }
  private notify(method: string, params: unknown) { return this.exchange({ jsonrpc: '2.0', method, params }, null); }
  async initialize() { const result = await this.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'dual-model-workbench', version: '1' } }) as any; if (result?.protocolVersion !== protocolVersion || !result.serverInfo || typeof result.serverInfo.name !== 'string') throw new Error('MCP初始化协商无效'); await this.notify('notifications/initialized', {}); }
  async tools() { const tools: McpToolManifest[] = []; let cursor: string | undefined, pages = 0; do { if (++pages > 20) throw new Error('MCP工具分页超过上限'); const page = await this.request('tools/list', cursor ? { cursor } : {}) as any; if (!Array.isArray(page?.tools)) throw new Error('MCP tools/list响应无效'); for (const raw of page.tools) { if (!raw || typeof raw.name !== 'string' || !raw.inputSchema || typeof raw.inputSchema !== 'object' || Array.isArray(raw.inputSchema) || (raw.outputSchema !== undefined && (!raw.outputSchema || typeof raw.outputSchema !== 'object' || Array.isArray(raw.outputSchema)))) throw new Error('MCP工具schema无效'); tools.push({ name: raw.name, ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 500) } : {}), inputSchema: raw.inputSchema, ...(raw.outputSchema === undefined ? {} : { outputSchema: raw.outputSchema }) }); if (tools.length > 1000) throw new Error('MCP工具数量超过上限'); } cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined; } while (cursor); if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('MCP声明重复工具'); return tools; }
  call(name: string, args: unknown) { return this.request('tools/call', { name, arguments: args }); }
}

function validateManifest(config: McpConfig, tools: McpToolManifest[]) { const byName = new Map(tools.map(tool => [tool.name, tool])); for (const name of config.toolAllowlist) if (!byName.has(name)) throw new Error(`MCP未声明已配置工具 ${name}`); return { serverId: config.id, tools: config.toolAllowlist.map(name => byName.get(name)!) }; }
function validateTool(config: McpConfig, manifest: McpManifest, tool: string, args: unknown) {
  if (!config.toolAllowlist.includes(tool) || !(tool in config.toolAccess)) throw new Error('MCP工具未分类或不在允许清单'); if (config.toolAccess[tool] === 'write' && (!config.allowWrites || !config.writeToolAllowlist.includes(tool))) throw new Error('MCP写工具未启用');
  const schema = manifest.tools.find(item => item.name === tool)?.inputSchema; if (!schema) throw new Error('MCP工具schema未发现'); const validate: ValidateFunction = compileMcpSchema(schema); if (!validate(args)) throw new Error(`MCP参数不符合服务端schema: ${validate.errors?.map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join(', ') ?? 'invalid'}`);
}
function validateToolResult(manifest: McpManifest, tool: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MCP工具结果格式无效');
  const result = raw as Record<string, unknown>;
  if ((result.isError !== undefined && typeof result.isError !== 'boolean') || !Array.isArray(result.content)) throw new Error('MCP工具结果必须包含content数组，isError存在时必须为boolean');
  for (const item of result.content) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).type !== 'string') throw new Error('MCP工具content结构无效');
    const block = item as Record<string, unknown>;
    if (block.type === 'text') { if (typeof block.text !== 'string') throw new Error('MCP文本content结构无效'); continue; }
    if (block.type === 'image' || block.type === 'audio') { if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') throw new Error('MCP媒体content结构无效'); continue; }
    if (block.type === 'resource') { if (!block.resource || typeof block.resource !== 'object' || Array.isArray(block.resource) || typeof (block.resource as Record<string, unknown>).uri !== 'string') throw new Error('MCP资源content结构无效'); continue; }
    throw new Error(`MCP content类型不受协商版本支持: ${block.type}`);
  }
  const outputSchema = manifest.tools.find(item => item.name === tool)?.outputSchema;
  if (outputSchema && result.isError !== true) {
    if (!('structuredContent' in result)) throw new Error('MCP工具声明outputSchema但未返回structuredContent');
    const validate: ValidateFunction = compileMcpSchema(outputSchema);
    if (!validate(result.structuredContent)) throw new Error(`MCP structuredContent不符合服务端outputSchema: ${validate.errors?.map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join(', ') ?? 'invalid'}`);
  }
  return raw;
}
async function dockerSession(config: Extract<McpConfig,{transport:'stdio'}>, signal: AbortSignal) {
  if (!path.isAbsolute(config.dockerCli) || !['docker', 'docker.exe'].includes(path.basename(config.dockerCli).toLowerCase())) throw new Error('stdio MCP仅允许绝对路径Docker CLI'); const actual = createHash('sha256').update(readFileSync(config.dockerCli)).digest('hex'); if (actual !== config.dockerCliSha256) throw new Error('Docker CLI摘要漂移');
  const instance = randomUUID(), name = `dmw-mcp-${instance}`, label = `com.dualmodelworkbench.mcp.instance=${instance}`, command: ResolvedCommand = { file: config.dockerCli, prefixArgs: [], via: 'direct' }, env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const execute = (args:string[],timeoutMs:number,executionSignal?:AbortSignal) => runProcess(command,args,{cwd:path.dirname(config.dockerCli),env,stdinText:null,timeoutMs,signal:executionSignal,tailBytes:256*1024});
  const owned = async () => { const result=await execute(['container','ls','-aq','--no-trunc','--filter',`label=${label}`,'--filter',`name=^/${name}$`],5_000); if(result.terminationWarning)throw new McpProcessError(result.terminationWarning,false);if(result.exitCode!==0||result.spawnError||result.timedOut)throw new McpProcessError('无法确认Docker容器身份',false);const ids=result.stdoutTail.trim().split(/\r?\n/).filter(Boolean);if(ids.some(id=>!/^[a-f0-9]{64}$/.test(id))||ids.length>1)throw new McpProcessError('Docker容器身份结果无效',false);return ids[0]; };
  const inspectGone = async (id:string) => { const result=await execute(['container','inspect',id],5_000);if(result.terminationWarning||result.spawnError||result.timedOut)throw new McpProcessError('无法确认Docker容器已删除',false);if(result.exitCode===0)return false;if(!/No such (?:object|container)/i.test(result.stderrTail))throw new McpProcessError('Docker inspect未能证明容器已删除',false);return true; };
  const removeOwned = async (expected?:string) => { const id=await owned();if(!id)return true;if(expected&&id!==expected)throw new McpProcessError('Docker容器身份漂移',false);const removal=await execute(['container','rm','-f',id],10_000);if(removal.terminationWarning||removal.spawnError||removal.timedOut)throw new McpProcessError('Docker容器删除状态未知',false);return await inspectGone(id); };
  const createArgs=['create','-i','--name',name,'--label','com.dualmodelworkbench.mcp.managed=true','--label',label,'--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1','--user','65532:65532','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',config.image,...config.serverArgs];
  const created=await execute(createArgs,config.timeoutMs,signal);if(created.terminationWarning)throw new McpProcessError(created.terminationWarning,false);let containerId=/^[a-f0-9]{64}$/m.exec(created.stdoutTail)?.[0];if(created.exitCode!==0||created.spawnError||created.timedOut||created.cancelled||!containerId){try{if(!await removeOwned())throw new Error();}catch{throw new McpProcessError('Docker create失败且无法确认无残留容器',false);}if(created.timedOut||created.cancelled)throw new McpProcessError('Docker create超时或取消；已清理当前可见容器，但延迟daemon状态未知',false);throw new McpProcessError(`Docker create失败: ${(created.stderrTail||created.spawnError||'unknown').slice(-300)}`,true);}const discovered=await owned();if(discovered!==containerId){try{await removeOwned(containerId);}catch{}throw new McpProcessError('Docker create回执与受控容器不一致',false);}
  const child = spawn(config.dockerCli, ['start','-ai',containerId], { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'], env }); let buffer = '', stderr = '', waiters: Array<{ resolve:(value:unknown)=>void; reject:(error:Error)=>void; id:number|null }> = [], done = false, cleanupPromise:Promise<boolean>|undefined;
  const fail = (error: Error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); };
  child.stdin.on('error', error => fail(error)); child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); }); child.stdout.on('data', chunk => { buffer += String(chunk); if (Buffer.byteLength(buffer) > config.maxOutputBytes) return fail(new Error('MCP输出超过上限')); for (;;) { const pos = buffer.indexOf('\n'); if (pos < 0) break; const line = buffer.slice(0,pos).trim(); buffer = buffer.slice(pos+1); if (!line) continue; try { const value = JSON.parse(line), id = (value as any)?.id; const index = waiters.findIndex(item => item.id === id); if (index >= 0) waiters.splice(index,1)[0]!.resolve(value); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); } } }); child.once('error', error => fail(error)); child.once('exit', code => { if (!done) void execute(['container','logs',containerId],3_000).then(log=>fail(new Error(`Docker MCP提前退出 (${code ?? 'unknown'}): ${(log.stderrTail||log.stdoutTail||stderr).slice(-500)}`)),()=>fail(new Error(`Docker MCP提前退出 (${code ?? 'unknown'}): ${stderr.slice(-300)}`))); });
  child.once('spawn', () => { if (done && child.pid) void killTree(child.pid); });
  const stop = async () => cleanupPromise ??= (async()=>{done=true;let containerGone=false;try{containerGone=await removeOwned(containerId);}catch{return false;}let cliGone=true;if(child.pid&&child.exitCode===null){cliGone=await killTree(child.pid);if(!cliGone)try{child.kill();}catch{}}return containerGone&&cliGone;})();
  const abort = () => { void stop().then(confirmed => fail(new McpProcessError(confirmed ? 'MCP调用已取消' : '无法确认MCP进程树已退出', confirmed))); }; signal.addEventListener('abort', abort, { once: true });
  const exchange = async (request: object, expectedId: number | null) => { if (signal.aborted) throw new McpProcessError('MCP调用已取消', true); let timer: NodeJS.Timeout | undefined; const promise = expectedId === null ? Promise.resolve({}) : new Promise((resolve,reject) => { const waiter = { resolve: (value:unknown) => { if (timer) clearTimeout(timer); resolve(value); }, reject: (error:Error) => { if (timer) clearTimeout(timer); reject(error); }, id: expectedId }; waiters.push(waiter); timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index,1); reject(new Error('MCP调用超时')); },config.timeoutMs); }); child.stdin.write(JSON.stringify(request)+'\n'); if (expectedId === null) return {}; return await promise.then(value => parseEnvelope(value, expectedId)); };
  return { session: new McpJsonRpcSession(exchange), close: async () => { signal.removeEventListener('abort',abort); const confirmed = await stop(); if (!confirmed) throw new McpProcessError('无法确认MCP进程树已退出', false); } };
}
async function httpSession(config: Extract<McpConfig,{transport:'http'}>, signal: AbortSignal) {
  const url = assertEndpoint(config.url); let sessionId: string | undefined;
  const headers = () => { const value: Record<string,string> = { 'content-type':'application/json', accept:'application/json, text/event-stream','mcp-protocol-version':protocolVersion }; if (sessionId) value['mcp-session-id'] = sessionId; if (config.apiKeyEnv) { const key = process.env[config.apiKeyEnv]; if (!key) throw new Error(`MCP环境变量 ${config.apiKeyEnv} 未设置`); if (config.apiKeyHeader === 'x-api-key') value['x-api-key'] = key; else value.authorization = `Bearer ${key}`; } return value; };
  const exchange = async (request: object, expectedId: number | null) => { const response = await requestPinned(url,{method:'POST',headers:headers(),body:Buffer.from(JSON.stringify(request)),maxBytes:config.maxOutputBytes,timeoutMs:config.timeoutMs,signal,...(expectedId===null?{}:{sseExpectedId:expectedId})}); if (response.status >= 300 && response.status < 400) throw new Error('MCP端点禁止重定向'); if (response.status < 200 || response.status >= 300) throw new Error(`MCP HTTP ${response.status}`); const received=Array.isArray(response.headers['mcp-session-id'])?response.headers['mcp-session-id'][0]:response.headers['mcp-session-id'];if(received&&!/^[A-Za-z0-9._~-]{1,200}$/.test(received))throw new Error('MCP会话身份无效');if(received&&sessionId&&received!==sessionId)throw new Error('MCP会话身份发生漂移');sessionId??=received; if (expectedId === null) return {}; return parseResponse(response.body,String(response.headers['content-type']??''),expectedId); };
  return { session: new McpJsonRpcSession(exchange), close: async () => { if (!sessionId) return; const cleanupSignal = AbortSignal.timeout(Math.min(config.timeoutMs,5_000)); const response = await requestPinned(url,{method:'DELETE',headers:headers(),maxBytes:1024,timeoutMs:Math.min(config.timeoutMs,5_000),signal:cleanupSignal}); if (![200,202,204,404,405].includes(response.status)) throw new Error(`MCP会话关闭失败 ${response.status}`); } };
}
async function open(config: McpConfig, signal: AbortSignal) { return config.transport === 'stdio' ? dockerSession(config,signal) : httpSession(config,signal); }
export async function discoverMcp(config: McpConfig, signal: AbortSignal): Promise<McpManifest> { const opened = await open(config,signal); try { await opened.session.initialize(); return validateManifest(config,await opened.session.tools()); } finally { await opened.close(); } }
export async function callMcp(config: McpConfig, tool: string, args: unknown, signal: AbortSignal, known?: McpManifest): Promise<unknown> { const opened = await open(config,signal); try { await opened.session.initialize(); const manifest = validateManifest(config,await opened.session.tools()); if (known && createHash('sha256').update(canonical(known)).digest('hex') !== createHash('sha256').update(canonical(manifest)).digest('hex')) throw new Error('MCP工具schema已漂移，请重新发现能力'); validateTool(config,manifest,tool,args); return validateToolResult(manifest,tool,await opened.session.call(tool,args)); } finally { await opened.close(); } }
