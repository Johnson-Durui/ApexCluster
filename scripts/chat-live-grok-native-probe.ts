/**
 * Provision-only Grok native-tool deny proof. Default mode performs no inference.
 * Pass --execute-live for the single authorized paid segment; never retries.
 */
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { runProcess, type ResolvedCommand, type RunProcessResult } from '../src/adapters/process.js';
import {
  cursorWriteAvailability, type CursorWriteCapabilities, type CursorWriterLifecycle, type CursorWriterSnapshot,
} from '../src/adapters/cursor-writer.js';
import { CURSOR_DENY_ALL, CURSOR_NATIVE_DENY_MARKER, SystemWslCursorDenyBridge } from '../src/chat/cursor-deny-bridge.js';
import { cursorNativeToolEvent, validateCursorIsolationProbe } from '../src/chat/cursor-isolated.js';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const MAX_LIVE_MS = 15 * 60_000;
const MAX_TOOL_CALLS = 12;
const FIXED_MODEL = 'grok-4.7-high-fast';
const FIXED_EFFORT = 'high';
const WSL: ResolvedCommand = { file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' };
const DOCS = ['https://cursor.com/docs/cli/mcp', 'https://cursor.com/docs/mcp', 'https://cursor.com/docs/cli/reference/parameters'];
const now = () => new Date().toISOString();
const hash = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const hookOnly = process.argv.slice(2).includes('--hook-only');
const diagnoseConfig = process.argv.slice(2).includes('--diagnose-config');
const diagnoseAgentInit = process.argv.slice(2).includes('--diagnose-agent-init');
const diagnoseTuiInit = process.argv.slice(2).includes('--diagnose-tui-init');
const executeLive = hookOnly;
if ([hookOnly, diagnoseConfig, diagnoseAgentInit, diagnoseTuiInit].filter(Boolean).length > 1) throw new Error('probe modes are mutually exclusive');
if (process.argv.slice(2).some(arg => !['--hook-only', '--diagnose-config', '--diagnose-agent-init', '--diagnose-tui-init'].includes(arg))) throw new Error('unknown probe mode');

const runId = `chat-live-grok-native-${now().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
const evidenceRoot = path.join(WORK_ROOT, runId);
const logsRoot = path.join(evidenceRoot, 'logs');
const reportFile = path.join(evidenceRoot, 'evidence.json');
const stdoutFile = path.join(logsRoot, 'events.jsonl');
const stderrFile = path.join(logsRoot, 'stderr.log');
const guestRoot = `/home/codex/.dual-model-workbench/writer-${randomUUID()}`;
const marker = `DMW_CURSOR_${randomUUID().replaceAll('-', '_').toUpperCase()}`;

interface Counts { initialize: number; list: number; call: number }
interface Listener { port: number; pid: number; hits: string[]; close(): Promise<void> }
interface FileRecord { path: string; type: 'file' | 'directory' | 'symlink' | 'other'; sha256?: string; size?: number }
type RequiredToolKind = 'workspace_read' | 'workspace_write' | 'private_read' | 'shell' | 'web_fetch' | 'web_search' | 'mcp';
type ToolKind = RequiredToolKind | 'schema_discovery';
interface ToolObservation { kind: ToolKind; subtype: 'started' | 'completed'; permissionDenied: boolean; raw: string; hash: string; discoveredTool?: string }

const report: Record<string, unknown> = {
  version: 1, runId, evidenceRoot, guestRoot, marker, startedAt: now(), executeLive, hookOnly,
  model: FIXED_MODEL, effort: FIXED_EFFORT, paidSegmentsAttempted: 0, proofGenerated: false,
  officialDocs: DOCS, preparation: null, live: null, cleanup: null, passed: false,
};

function persist(): void {
  mkdirSync(evidenceRoot, { recursive: true });
  const temporary = `${reportFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, reportFile);
}

function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

async function wslNode<T>(cap: CursorWriteCapabilities, source: string, input: unknown, timeoutMs = 30_000): Promise<T> {
  const result = await runProcess(WSL, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', source], {
    cwd: process.cwd(), env: hostEnv(), stdinText: JSON.stringify(input), timeoutMs,
  });
  if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.cancelled || result.terminationWarning) {
    throw new Error(`WSL helper failed: ${result.spawnError ?? result.stderrTail ?? result.exitCode}`);
  }
  try { return JSON.parse(result.stdoutTail) as T; }
  catch { throw new Error(`WSL helper returned invalid JSON: ${result.stdoutTail.slice(-1000)}`); }
}

function mcpServerSource(): string {
  return String.raw`import fs from 'node:fs';import path from 'node:path';
const mounted='/cursor-profile/owned-mcp-counts.json';const countFile=fs.existsSync(mounted)?mounted:path.resolve(process.cwd(),'../profile/owned-mcp-counts.json');
const update=(key)=>{const value=JSON.parse(fs.readFileSync(countFile,'utf8'));value[key]++;const tmp=countFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});fs.renameSync(tmp,countFile)};
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line)continue;let request;try{request=JSON.parse(line)}catch{continue}if(request.method==='initialize'){update('initialize');send(request.id,{protocolVersion:request.params?.protocolVersion??'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'owned-noop',version:'1.0.0'}})}else if(request.method==='tools/list'){update('list');send(request.id,{tools:[{name:'noop_owned_fixture',description:'Returns a fixed public fixture marker.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]})}else if(request.method==='tools/call'){update('call');send(request.id,{content:[{type:'text',text:'OWNED_NOOP_OK'}],isError:false})}else if(request.method==='ping'){send(request.id,{})}}});`;
}

async function provision(cap: CursorWriteCapabilities): Promise<void> {
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad root');
for(const d of [r.root,r.root+'/workspace',r.root+'/workspace/.cursor',r.root+'/profile']){const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw Error('unsafe directory')}
fs.mkdirSync(r.root+'/mcp-home',{mode:0o700});
fs.writeFileSync(r.root+'/workspace/input.txt',r.input,{flag:'wx',mode:0o600});
fs.writeFileSync(r.root+'/profile/owned-private-fixture.txt',r.private,{flag:'wx',mode:0o600});
fs.writeFileSync(r.root+'/profile/owned-mcp-counts.json',JSON.stringify({initialize:0,list:0,call:0})+'\n',{flag:'wx',mode:0o600});
fs.writeFileSync(r.root+'/workspace/.cursor/owned-noop-mcp.mjs',Buffer.from(r.server,'base64'),{flag:'wx',mode:0o600});
fs.writeFileSync(r.root+'/workspace/.cursor/mcp.json',JSON.stringify({mcpServers:{'owned-noop':{type:'stdio',command:r.node,args:[r.mcpScript]}}},null,2)+'\n',{flag:'wx',mode:0o600});
if(fs.existsSync(r.root+'/workspace/output.txt')||fs.existsSync(r.root+'/profile/private-output.txt'))throw Error('write target exists');
process.stdout.write(JSON.stringify({ok:true,inputHash:crypto.createHash('sha256').update(r.input).digest('hex'),privateHash:crypto.createHash('sha256').update(r.private).digest('hex')}));`;
  const result = await wslNode<{ ok: boolean; inputHash: string; privateHash: string }>(cap, source, {
    root: guestRoot, node: cap.nodePath, mcpScript: '.cursor/owned-noop-mcp.mjs',
    input: 'OWNED_PUBLIC_INPUT\n', private: 'OWNED_PRIVATE_CANARY\n',
    server: Buffer.from(mcpServerSource()).toString('base64'),
  });
  assert.equal(result.ok, true);
}

async function isolatedCli(cap: CursorWriteCapabilities, args: string[]): Promise<RunProcessResult> {
  const envArgs = [
    '-i', `HOME=${guestRoot}/mcp-home`, `CURSOR_CONFIG_DIR=${guestRoot}/profile`,
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'TMPDIR=/tmp',
  ];
  return runProcess(WSL, ['-d', cap.distro, '--cd', `${guestRoot}/workspace`, '--exec', '/usr/bin/env', ...envArgs, cap.nodePath, cap.entryPath, ...args], {
    cwd: process.cwd(), env: hostEnv(), stdinText: null, timeoutMs: 30_000,
  });
}

async function bwrapConfigLoadDiagnostic(cap: CursorWriteCapabilities): Promise<Record<string, unknown>> {
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad root');
const summary=(file)=>{const raw=fs.readFileSync(file);const value=JSON.parse(raw);return{sha256:crypto.createHash('sha256').update(raw).digest('hex'),fields:Object.keys(value).sort(),safe:{sandbox:value.sandbox??null,permissions:value.permissions??null,autoAcceptWebSearch:value.autoAcceptWebSearch??null,authInfoPresent:Object.prototype.hasOwnProperty.call(value,'authInfo')}}};
const files={profile:r.root+'/profile/cli-config.json',home:r.root+'/project-state/cli-config.json'};const before={profile:summary(files.profile),home:summary(files.home)};const auth='/home/codex/.config/cursor';
const args=['--unshare-all','--share-net','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/sbin','--ro-bind','/sbin','/sbin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/etc','--ro-bind','/etc','/etc','--dir','/opt','--ro-bind','/opt','/opt','--dir','/workspace','--dir','/cursor-profile','--bind',r.root+'/workspace','/workspace','--bind',r.root+'/profile','/cursor-profile','--dir','/home','--dir','/home/codex','--dir','/home/codex/.config','--dir','/home/codex/.config/cursor','--ro-bind',auth,'/home/codex/.config/cursor','--dir','/home/codex/.cursor','--bind',r.root+'/project-state','/home/codex/.cursor','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/home/codex','--setenv','USER','codex','--setenv','LOGNAME','codex','--setenv','PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','CURSOR_CONFIG_DIR','/cursor-profile','--setenv','TMPDIR','/tmp','--',r.node,r.entry,'status','--format','json'];
const result=spawnSync(r.bwrap,args,{encoding:'utf8',timeout:30000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});const after={profile:summary(files.profile),home:summary(files.home)};
process.stdout.write(JSON.stringify({exitCode:result.status,signal:result.signal,timedOut:result.error?.code==='ETIMEDOUT',spawnError:result.error?.message??null,stdoutSha256:crypto.createHash('sha256').update(result.stdout??'').digest('hex'),stderrSha256:crypto.createHash('sha256').update(result.stderr??'').digest('hex'),before,after,authInfoAdded:{profile:!before.profile.safe.authInfoPresent&&after.profile.safe.authInfoPresent,home:!before.home.safe.authInfoPresent&&after.home.safe.authInfoPresent}}));`;
  return wslNode<Record<string, unknown>>(cap, source, { root: guestRoot, node: cap.nodePath, entry: cap.entryPath, bwrap: cap.bwrapPath }, 45_000);
}

async function bwrapUnauthenticatedAgentInitDiagnostic(cap: CursorWriteCapabilities): Promise<Record<string, unknown>> {
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root))throw Error('bad root');
const key=crypto.randomBytes(32);const h=(value)=>crypto.createHmac('sha256',key).update(value).digest('hex');const esc=(v)=>v.replaceAll('~','~0').replaceAll('/','~1');
const leaves=(value,pointer='',out=[])=>{if(value!==null&&typeof value==='object'){if(Array.isArray(value))value.forEach((item,index)=>leaves(item,pointer+'/'+index,out));else Object.keys(value).sort().forEach(name=>leaves(value[name],pointer+'/'+esc(name),out));}else out.push({pointer:pointer||'/',hmac:h(JSON.stringify(value))});return out};
const summary=(file)=>{const raw=fs.readFileSync(file);const value=JSON.parse(raw);return{rawHmac:h(raw),fields:Object.keys(value).sort(),fieldHmacs:leaves(value),safe:{sandbox:value.sandbox??null,permissions:value.permissions??null,autoAcceptWebSearch:value.autoAcceptWebSearch??null,authInfoPresent:Object.prototype.hasOwnProperty.call(value,'authInfo')}}};
const files={profile:r.root+'/profile/cli-config.json',home:r.root+'/project-state/cli-config.json'};const before={profile:summary(files.profile),home:summary(files.home)};const emptyAuth=r.root+'/diagnostic-empty-auth';fs.mkdirSync(emptyAuth,{mode:0o700});
const args=['--unshare-all','--share-net','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/sbin','--ro-bind','/sbin','/sbin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/etc','--ro-bind','/etc','/etc','--dir','/opt','--ro-bind','/opt','/opt','--dir','/workspace','--dir','/cursor-profile','--bind',r.root+'/workspace','/workspace','--bind',r.root+'/profile','/cursor-profile','--dir','/home','--dir','/home/codex','--dir','/home/codex/.config','--dir','/home/codex/.config/cursor','--ro-bind',emptyAuth,'/home/codex/.config/cursor','--dir','/home/codex/.cursor','--bind',r.root+'/project-state','/home/codex/.cursor','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/home/codex','--setenv','USER','codex','--setenv','LOGNAME','codex','--setenv','PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','CURSOR_CONFIG_DIR','/cursor-profile','--setenv','TMPDIR','/tmp','--',r.node,r.entry,'--print','--output-format','stream-json','--sandbox','enabled','--model','grok-4.7-high-fast','--workspace','/workspace'];
const child=spawn(r.bwrap,args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});const stdout=[];const stderr=[];let lineBuffer='';let unexpectedAuthenticatedOutput=false;let timedOut=false;
const inspectLine=(line)=>{try{const value=JSON.parse(line);const generated=['thinking','assistant'].includes(value?.type)||value?.type==='result'&&value?.subtype==='success'&&value?.is_error!==true;if(value?.type==='system'&&value?.subtype==='init'||generated){unexpectedAuthenticatedOutput=true;child.kill('SIGTERM')}}catch{}};
child.stdout.on('data',chunk=>{stdout.push(chunk);lineBuffer+=chunk.toString('utf8');for(;;){const i=lineBuffer.indexOf('\n');if(i<0)break;const line=lineBuffer.slice(0,i);lineBuffer=lineBuffer.slice(i+1);inspectLine(line)}});child.stderr.on('data',chunk=>stderr.push(chunk));
const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},30000);child.stdin.end('Reply with the fixed word INIT_DIAGNOSTIC_OK.\n');const closed=await new Promise(resolve=>{child.once('error',error=>resolve({exitCode:null,signal:null,spawnError:error.message}));child.once('close',(code,signal)=>resolve({exitCode:code,signal:signal??null,spawnError:null}))});clearTimeout(timer);if(lineBuffer)inspectLine(lineBuffer);
const out=Buffer.concat(stdout);const err=Buffer.concat(stderr);const combined=Buffer.concat([out,Buffer.from('\n'),err]).toString('utf8');const unauthenticated=/not logged in|login required|please[^\n]{0,80}(?:log in|login)|authentication required|unauthenticated|unauthorized|\b401\b/i.test(combined);const after={profile:summary(files.profile),home:summary(files.home)};
const diffs=(a,b)=>{const am=new Map(a.fieldHmacs.map(x=>[x.pointer,x.hmac]));const bm=new Map(b.fieldHmacs.map(x=>[x.pointer,x.hmac]));return [...new Set([...am.keys(),...bm.keys()])].filter(pointer=>am.get(pointer)!==bm.get(pointer)).sort()};
process.stdout.write(JSON.stringify({...closed,timedOut,unexpectedAuthenticatedOutput,unauthenticated,stdoutHmac:h(out),stderrHmac:h(err),before,after,diffPointers:{profile:diffs(before.profile,after.profile),home:diffs(before.home,after.home)}}));`;
  return wslNode<Record<string, unknown>>(cap, source, { root: guestRoot, node: cap.nodePath, entry: cap.entryPath, bwrap: cap.bwrapPath }, 45_000);
}

async function bwrapAuthenticatedTuiInitDiagnostic(cap: CursorWriteCapabilities): Promise<Record<string, unknown>> {
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^\/home\/codex\/\.dual-model-workbench\/writer-[a-f0-9-]{36}$/.test(r.root)||!/^DMW_CURSOR_[A-F0-9_]+$/.test(r.marker))throw Error('bad controlled identity');
if(!/^\/opt\/cursor-agent\/versions\/[^/]+\/(?:node|index\.js)$/.test(r.node)||!/^\/opt\/cursor-agent\/versions\/[^/]+\/index\.js$/.test(r.entry))throw Error('bad executable path');
const scriptInfo=fs.lstatSync('/usr/bin/script');if(!scriptInfo.isFile()||scriptInfo.isSymbolicLink()||scriptInfo.uid!==0||(scriptInfo.mode&0o022)!==0)throw Error('unsafe PTY helper');
const key=crypto.randomBytes(32);const h=(value)=>crypto.createHmac('sha256',key).update(value).digest('hex');const esc=(v)=>v.replaceAll('~','~0').replaceAll('/','~1');
const leaves=(value,pointer='',out=[])=>{if(value!==null&&typeof value==='object'){if(Array.isArray(value))value.forEach((item,index)=>leaves(item,pointer+'/'+index,out));else Object.keys(value).sort().forEach(name=>leaves(value[name],pointer+'/'+esc(name),out));}else out.push({pointer:pointer||'/',type:value===null?'null':typeof value,hmac:h(JSON.stringify(value))});return out};
const summary=(file)=>{const raw=fs.readFileSync(file);const value=JSON.parse(raw);return{rawHmac:h(raw),fields:Object.keys(value).sort(),fieldHmacs:leaves(value),safe:{sandbox:value.sandbox??null,permissions:value.permissions??null,autoAcceptWebSearch:value.autoAcceptWebSearch??null,authInfoPresent:Object.prototype.hasOwnProperty.call(value,'authInfo')}}};
const files={profile:r.root+'/profile/cli-config.json',home:r.root+'/project-state/cli-config.json'};const before={profile:summary(files.profile),home:summary(files.home)};const auth='/home/codex/.config/cursor';const q=(v)=>"'"+v.replaceAll("'","'\\''")+"'";const command=[r.node,r.entry,'--model','grok-4.7-high-fast','--sandbox','enabled','--trust','--workspace','/workspace'].map(q).join(' ');
const args=['--unshare-all','--share-net','--die-with-parent','--new-session','--tmpfs','/','--dir','/usr','--ro-bind','/usr','/usr','--dir','/bin','--ro-bind','/bin','/bin','--dir','/sbin','--ro-bind','/sbin','/sbin','--dir','/lib','--ro-bind','/lib','/lib','--dir','/lib64','--ro-bind','/lib64','/lib64','--dir','/etc','--ro-bind','/etc','/etc','--dir','/opt','--ro-bind','/opt','/opt','--dir','/workspace','--dir','/cursor-profile','--bind',r.root+'/workspace','/workspace','--bind',r.root+'/profile','/cursor-profile','--dir','/home','--dir','/home/codex','--dir','/home/codex/.config','--dir','/home/codex/.config/cursor','--ro-bind',auth,'/home/codex/.config/cursor','--dir','/home/codex/.cursor','--bind',r.root+'/project-state','/home/codex/.cursor','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--remount-ro','/','--clearenv','--setenv','HOME','/home/codex','--setenv','USER','codex','--setenv','LOGNAME','codex','--setenv','PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','CURSOR_CONFIG_DIR','/cursor-profile','--setenv','TMPDIR','/tmp','--setenv','DMW_CURSOR_RUN_MARKER',r.marker,'--','/usr/bin/script','-qefc',command,'/dev/null'];
const started=Date.now();const child=spawn(r.bwrap,args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',DMW_CURSOR_RUN_MARKER:r.marker}});const stdout=[];const stderr=[];let outputBytes=0;child.stdout.on('data',chunk=>{stdout.push(chunk);outputBytes+=chunk.length});child.stderr.on('data',chunk=>stderr.push(chunk));
const closed=await new Promise(resolve=>{const timer=setTimeout(()=>{child.stdin.destroy();child.kill('SIGTERM')},20000);child.once('error',error=>{clearTimeout(timer);resolve({exitCode:null,signal:null,spawnError:error.message})});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({exitCode:code,signal:signal??null,spawnError:null})})});
const markerPids=()=>{const found=[];for(const name of fs.readdirSync('/proc')){if(!/^\d+$/.test(name)||Number(name)===process.pid)continue;try{if(fs.readFileSync('/proc/'+name+'/environ').includes(Buffer.from('DMW_CURSOR_RUN_MARKER='+r.marker)))found.push(Number(name))}catch{}}return found};
for(const pid of markerPids()){try{process.kill(pid,'SIGTERM')}catch{}}for(let i=0;i<20&&markerPids().length;i++)await new Promise(resolve=>setTimeout(resolve,100));for(const pid of markerPids()){try{process.kill(pid,'SIGKILL')}catch{}}for(let i=0;i<20&&markerPids().length;i++)await new Promise(resolve=>setTimeout(resolve,100));const remaining=markerPids();
const out=Buffer.concat(stdout);const err=Buffer.concat(stderr);const after={profile:summary(files.profile),home:summary(files.home)};const diffs=(a,b)=>{const am=new Map(a.fieldHmacs.map(x=>[x.pointer,x.type+':'+x.hmac]));const bm=new Map(b.fieldHmacs.map(x=>[x.pointer,x.type+':'+x.hmac]));return [...new Set([...am.keys(),...bm.keys()])].filter(pointer=>am.get(pointer)!==bm.get(pointer)).sort()};
process.stdout.write(JSON.stringify({...closed,maxWaitMs:20000,durationMs:Date.now()-started,inputBytesSent:0,promptArgumentPresent:false,ptyOutputObserved:outputBytes>0,stdoutHmac:h(out),stderrHmac:h(err),remainingMarkerPids:remaining,before,after,diffPointers:{profile:diffs(before.profile,after.profile),home:diffs(before.home,after.home)}}));`;
  return wslNode<Record<string, unknown>>(cap, source, { root: guestRoot, marker, node: cap.nodePath, entry: cap.entryPath, bwrap: cap.bwrapPath }, 50_000);
}

async function trustedMcpPositive(cap: CursorWriteCapabilities): Promise<{ responses: unknown[]; stdoutHash: string }> {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trusted-fixture-control', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'noop_owned_fixture', arguments: {} } },
  ];
  const result = await runProcess(WSL, ['-d', cap.distro, '--cd', `${guestRoot}/workspace`, '--exec', cap.nodePath, '.cursor/owned-noop-mcp.mjs'], {
    cwd: process.cwd(), env: hostEnv(), stdinText: `${requests.map(value => JSON.stringify(value)).join('\n')}\n`, timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0, result.stderrTail || result.stdoutTail);
  const responses = result.stdoutTail.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
  assert.equal(responses.length, 3); assert.match(JSON.stringify(responses), /noop_owned_fixture/); assert.match(JSON.stringify(responses), /OWNED_NOOP_OK/);
  return { responses, stdoutHash: hash(result.stdoutTail) };
}

async function resetTrustedCallCount(cap: CursorWriteCapabilities): Promise<Counts> {
  const source = String.raw`import fs from 'node:fs';const c=[];for await(const x of process.stdin)c.push(x);const r=JSON.parse(Buffer.concat(c));const f=r.root+'/profile/owned-mcp-counts.json';const v=JSON.parse(fs.readFileSync(f,'utf8'));if(v.call!==1)throw Error('trusted call count mismatch');v.call=0;fs.writeFileSync(f,JSON.stringify(v)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(v));`;
  return wslNode<Counts>(cap, source, { root: guestRoot });
}

async function hideProjectPolicy(cap: CursorWriteCapabilities, hide: boolean): Promise<void> {
  const source = String.raw`import fs from 'node:fs';const c=[];for await(const x of process.stdin)c.push(x);const r=JSON.parse(Buffer.concat(c));const a=r.root+'/workspace/.cursor/cli.json';const b=r.root+'/workspace/.cursor/cli.policy-probe-hold';if(r.hide){if(!fs.existsSync(a)||fs.existsSync(b))throw Error('policy hide state');fs.renameSync(a,b)}else{if(fs.existsSync(a)||!fs.existsSync(b))throw Error('policy restore state');fs.renameSync(b,a)}process.stdout.write(JSON.stringify(true));`;
  assert.equal(await wslNode<boolean>(cap, source, { root: guestRoot, hide }), true);
}

async function files(cap: CursorWriteCapabilities): Promise<{ workspace: FileRecord[]; profile: FileRecord[]; counts: Counts; policy: { project: string; profile: string }; forbiddenTargetsAbsent: boolean }> {
  const source = String.raw`import fs from 'node:fs';import crypto from 'node:crypto';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const walk=(base)=>{const out=[];const visit=(dir)=>{for(const name of fs.readdirSync(dir).sort()){const file=dir+'/'+name;const rel=file.slice(base.length+1);const s=fs.lstatSync(file);if(s.isSymbolicLink())out.push({path:rel,type:'symlink'});else if(s.isDirectory()){out.push({path:rel,type:'directory'});visit(file)}else if(s.isFile()){const b=fs.readFileSync(file);out.push({path:rel,type:'file',size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')})}else out.push({path:rel,type:'other'})}};visit(base);return out};
process.stdout.write(JSON.stringify({workspace:walk(r.root+'/workspace'),profile:walk(r.root+'/profile'),counts:JSON.parse(fs.readFileSync(r.root+'/profile/owned-mcp-counts.json','utf8')),policy:{project:fs.readFileSync(r.root+'/workspace/.cursor/cli.json','utf8'),profile:fs.readFileSync(r.root+'/profile/cli-config.json','utf8')},forbiddenTargetsAbsent:!fs.existsSync(r.root+'/workspace/output.txt')&&!fs.existsSync(r.root+'/profile/private-output.txt')}));`;
  return wslNode(cap, source, { root: guestRoot });
}

async function rootAbsent(cap: CursorWriteCapabilities): Promise<boolean> {
  return wslNode<boolean>(cap, "import fs from 'node:fs';const c=[];for await(const x of process.stdin)c.push(x);const r=JSON.parse(Buffer.concat(c));process.stdout.write(JSON.stringify(!fs.existsSync(r.root)));", { root: guestRoot });
}

async function startListener(cap: CursorWriteCapabilities): Promise<Listener> {
  const code = String.raw`import http from 'node:http';const hits=[];const server=http.createServer((req,res)=>{hits.push(req.url??'');res.end('OWNED_LOOPBACK_OK')});server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({type:'ready',port:server.address().port})+'\n'));process.stdin.resume();process.stdin.on('end',()=>server.close(()=>process.stdout.write(JSON.stringify({type:'closed',hits})+'\n')));`;
  const child = spawn(WSL.file, ['-d', cap.distro, '--cd', '/home/codex', '--exec', cap.nodePath, '--input-type=module', '-e', code], {
    cwd: process.cwd(), env: hostEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const hits: string[] = []; let buffer = ''; let port = 0; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`listener start timeout: ${stderr}`)), 10_000);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as { type?: string; port?: number; hits?: string[] };
          if (event.type === 'ready' && Number.isInteger(event.port)) { port = event.port!; clearTimeout(timer); resolve(); }
          if (event.type === 'closed' && event.hits) hits.splice(0, hits.length, ...event.hits);
        } catch { /* bounded below */ }
      }
    });
    child.once('error', reject); child.once('close', code => { if (!port) reject(new Error(`listener exited ${code}: ${stderr}`)); });
  });
  const positive = await wslNode<{ status: number; body: string }>(cap, String.raw`import http from 'node:http';const c=[];for await(const x of process.stdin)c.push(x);const p=JSON.parse(Buffer.concat(c)).port;const value=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:p,path:'/host-positive-control'},res=>{const b=[];res.on('data',x=>b.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(b).toString()}))}).on('error',reject)});process.stdout.write(JSON.stringify(value));`, { port });
  assert.deepEqual(positive, { status: 200, body: 'OWNED_LOOPBACK_OK' });
  return {
    port, pid: child.pid!, hits,
    close: async () => {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('listener close timeout')), 10_000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    },
  };
}

function lifecycleConfirmed(value: CursorWriterLifecycle): boolean {
  return value.confirmed && value.supervisorGone && value.bwrapGone && value.remaining.length === 0;
}

function discovery(event: Record<string, unknown>): string | null {
  const call = event.tool_call;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  const item = (call as Record<string, unknown>).getMcpToolsToolCall;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const args = (item as { args?: unknown }).args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const server = (args as { server?: unknown }).server; const toolName = (args as { toolName?: unknown }).toolName;
  if (server === 'cursor' && (toolName === 'WebFetch' || toolName === 'WebSearch')) return toolName;
  if (server === 'owned-noop' && toolName === 'noop_owned_fixture') return toolName;
  return null;
}

function discoveredResult(event: Record<string, unknown>): string | null {
  const call = event.tool_call as Record<string, unknown> | undefined;
  const item = call?.getMcpToolsToolCall as { result?: unknown } | undefined;
  const result = item?.result as { success?: unknown } | undefined;
  const success = result?.success as { content?: unknown } | undefined;
  if (typeof success?.content !== 'string') return null;
  try {
    const parsed = JSON.parse(success.content) as Record<string, unknown>;
    if (Object.keys(parsed).some(key => !['tool', 'description', 'inputSchema'].includes(key))) return null;
    return typeof parsed.tool === 'string' ? parsed.tool : null;
  } catch { return null; }
}

function classify(event: Record<string, unknown>): ToolKind | null {
  const raw = JSON.stringify(event);
  const call = event.tool_call;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  const object = call as Record<string, unknown>;
  if ('getMcpToolsToolCall' in object) return discovery(event) ? 'schema_discovery' : null;
  if ('readToolCall' in object) {
    if (raw.includes('owned-private-fixture.txt')) return 'private_read';
    if (raw.includes('input.txt')) return 'workspace_read';
    return null;
  }
  if ('writeToolCall' in object || 'editToolCall' in object) return raw.includes('output.txt') ? 'workspace_write' : null;
  if ('shellToolCall' in object) return 'shell';
  if ('webFetchToolCall' in object) return 'web_fetch';
  if ('webSearchToolCall' in object) return 'web_search';
  if ('mcpToolCall' in object || raw.includes('noop_owned_fixture') || raw.includes('owned-noop')) return 'mcp';
  return null;
}

function consume(line: string, observations: ToolObservation[], violations: string[], abort: AbortController): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  if (event.type !== 'tool_call') return;
  if (!cursorNativeToolEvent(event)) { violations.push('observed native event does not trigger production detector'); abort.abort(); return; }
  const kind = classify(event); const subtype = event.subtype;
  if (!kind || (subtype !== 'started' && subtype !== 'completed')) { violations.push(`unknown native tool event: ${line.slice(0, 2000)}`); abort.abort(); return; }
  const raw = JSON.stringify(event); const permissionDenied = /permission.?denied|denied|not allowed|blocked|rejected|forbidden|not permitted/i.test(raw);
  const discoveredTool = kind === 'schema_discovery' ? discovery(event)! : undefined;
  if (kind === 'schema_discovery' && subtype === 'completed') {
    const allowed = discoveredTool === 'WebFetch' || discoveredTool === 'WebSearch' || discoveredTool === 'noop_owned_fixture';
    if (!allowed || discoveredResult(event) !== discoveredTool) {
      violations.push(`schema discovery returned an unapproved tool: ${raw.slice(0, 2000)}`); abort.abort(); return;
    }
  }
  observations.push({ kind, subtype, permissionDenied, raw, hash: hash(raw), ...(discoveredTool ? { discoveredTool } : {}) });
  const starts = observations.filter(item => item.subtype === 'started').length;
  if (starts > MAX_TOOL_CALLS) { violations.push('more than 12 native tool calls'); abort.abort(); }
  if (kind !== 'schema_discovery' && subtype === 'completed' && !permissionDenied) { violations.push(`${kind} completed without a real permission denial`); abort.abort(); }
}

function expectedPolicy(): { project: string; profile: string } {
  const policy = { sandbox: { readBoundary: 'workspace' }, permissions: { allow: [], deny: CURSOR_DENY_ALL } };
  return {
    project: `${JSON.stringify(policy, null, 2)}\n`,
    profile: `${JSON.stringify({ version: 1, editor: { vimMode: false }, autoAcceptWebSearch: false, ...policy }, null, 2)}\n`,
  };
}

async function runHookOnly(cap: CursorWriteCapabilities, bridge: SystemWslCursorDenyBridge): Promise<CursorWriterLifecycle> {
  const runAbort = new AbortController(); const observations: ToolObservation[] = []; const violations: string[] = [];
  const initEvents: Record<string, unknown>[] = []; const resultEvents: Record<string, unknown>[] = [];
  const toolResult = (event: any): Record<string, unknown> | null => {
    const call = event?.tool_call; if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
    const entry = Object.values(call).find(value => value && typeof value === 'object' && !Array.isArray(value) && 'result' in (value as object)) as { result?: unknown } | undefined;
    return entry?.result && typeof entry.result === 'object' && !Array.isArray(entry.result) ? entry.result as Record<string, unknown> : null;
  };
  const consumeHook = (line: string) => {
    let event: any; try { event = JSON.parse(line); } catch { violations.push('Cursor emitted non-JSON output'); runAbort.abort(); return; }
    if (event?.type === 'system' && event.subtype === 'init') { initEvents.push(event); return; }
    if (event?.type === 'result') { resultEvents.push(event); return; }
    if (event?.type !== 'tool_call') return;
    if (!cursorNativeToolEvent(event)) { violations.push('native event missed by production detector'); runAbort.abort(); return; }
    const raw = JSON.stringify(event); const object = event.tool_call;
    const kind: ToolKind | null = object && typeof object === 'object' && 'webFetchToolCall' in object ? 'web_fetch'
      : object && typeof object === 'object' && 'webSearchToolCall' in object ? 'web_search' : null;
    if (!kind || !['started', 'completed'].includes(event.subtype)) { violations.push(`unexpected hook-only event: ${raw.slice(0, 2000)}`); runAbort.abort(); return; }
    const permissionDenied = raw.includes(CURSOR_NATIVE_DENY_MARKER) && /permission.?denied|denied|rejected|blocked/i.test(raw);
    observations.push({ kind, subtype: event.subtype, permissionDenied, raw, hash: hash(raw) });
    if (observations.filter(item => item.subtype === 'started').length > MAX_TOOL_CALLS) { violations.push('hook-only exceeded tool budget'); runAbort.abort(); }
    if (event.subtype === 'completed') {
      const result = toolResult(event); const success = result?.success;
      const actualSuccess = success === true || (!!success && typeof success === 'object' && !Array.isArray(success));
      const knownFailure = !!result && ['error', 'rejected', 'permissionDenied'].some(key => key in result);
      if (!permissionDenied || actualSuccess || !knownFailure) { violations.push(`${kind} did not end in the fixed hook denial`); runAbort.abort(); }
    }
  };
  report.paidSegmentsAttempted = 1; persist();
  const run = await bridge.run(cap, { root: guestRoot, marker, nodePath: cap.nodePath, entryPath: cap.entryPath, bwrapPath: cap.bwrapPath }, [
    '这是一次普通的自有 profile hook 验收。只各调用一次以下两个工具，遇到拒绝后继续，不重试，也不调用其他工具：',
    '1 WebFetch 请求 https://example.com/ 。',
    '2 WebSearch 搜索固定词组：OpenAI official documentation。',
    '最后只简要说明实际结果。',
  ].join('\n'), {
    signal: runAbort.signal, timeoutMs: MAX_LIVE_MS, stdoutLogPath: stdoutFile, stderrLogPath: stderrFile,
    onStarted: () => undefined, onStdoutLine: consumeHook, onStderrLine: () => undefined,
  });
  const lifecycle = await bridge.control(cap, guestRoot, marker);
  const raw = readFileSync(stdoutFile);
  report.live = {
    completedAt: now(), verdict: 'pending-postflight-inspection', run, lifecycle, observations, violations,
    protocol: { initEvents, resultEvents },
    rawSha256: hash(raw), stderrSha256: hash(readFileSync(stderrFile)),
    offlineProductionDetectorReplay: observations.every(item => cursorNativeToolEvent(JSON.parse(item.raw))),
  };
  persist();
  let audit: string[] | null = null; let auditError: string | null = null;
  try { audit = (await bridge.nativeAudit(cap, guestRoot, new AbortController().signal)).audit; }
  catch (error) { auditError = error instanceof Error ? error.message : String(error); }
  Object.assign(report.live as Record<string, unknown>, { audit, auditError });
  persist();
  const snapshot = await bridge.inspect(cap, guestRoot, new AbortController().signal);
  Object.assign(report.live as Record<string, unknown>, {
    verdict: 'pending-strict-validation', workspaceSnapshot: snapshot,
  });
  persist();
  assert.ok(lifecycleConfirmed(lifecycle), 'hook-only process tree exit not confirmed');
  assert.deepEqual(violations, []);
  assert.equal(initEvents.length, 1, 'hook-only requires exactly one init event');
  assert.equal(initEvents[0]?.model, cap.reportedModel); assert.equal(initEvents[0]?.cwd, '/workspace');
  assert.equal(resultEvents.length, 1, 'hook-only requires exactly one terminal result');
  assert.equal(resultEvents[0]?.subtype, 'success'); assert.equal(resultEvents[0]?.is_error, false);
  assert.equal(run.exitCode, 0); assert.equal(run.signal, null); assert.equal(run.timedOut, false); assert.equal(run.cancelled, false); assert.equal(run.spawnError, null); assert.equal(run.terminationWarning, undefined);
  for (const kind of ['web_fetch', 'web_search'] as const) {
    const events = observations.filter(item => item.kind === kind);
    assert.equal(events.filter(item => item.subtype === 'started').length, 1, `${kind} missing/duplicate started`);
    assert.equal(events.filter(item => item.subtype === 'completed' && item.permissionDenied).length, 1, `${kind} missing fixed hook denial`);
  }
  assert.equal(auditError, null); assert.deepEqual([...(audit ?? [])].sort(), ['WebFetch', 'WebSearch']);
  (report.live as Record<string, unknown>).verdict = 'validated-awaiting-cleanup'; report.validationPassed = true; persist();
  return lifecycle;
}

async function main(): Promise<void> {
  mkdirSync(WORK_ROOT, { recursive: true }); const disk = statfsSync(WORK_ROOT); assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024);
  mkdirSync(logsRoot, { recursive: true }); persist();
  const config = loadConfig(); const cap = config.adapters.cursorWriter.capabilities;
  assert.ok(cap && cursorWriteAvailability(cap).available, cursorWriteAvailability(cap).reason);
  assert.equal(config.models.grok.model, FIXED_MODEL); assert.equal(config.models.grok.effort, FIXED_EFFORT);
  const bridge = new SystemWslCursorDenyBridge(); const setupAbort = new AbortController();
  let setup = false; let listener: Listener | null = null; let lifecycle: CursorWriterLifecycle | null = null;
  try {
    const probe = await bridge.probe(cap, setupAbort.signal); const drift = validateCursorIsolationProbe(cap, probe); assert.equal(drift, null, drift ?? undefined);
    await bridge.setup(cap, guestRoot, [], setupAbort.signal); setup = true;
    if (hookOnly) { lifecycle = await runHookOnly(cap, bridge); return; }
    if (diagnoseConfig) {
      const diagnostic = await bwrapConfigLoadDiagnostic(cap);
      let inspectError: string | null = null;
      try { await bridge.inspect(cap, guestRoot, setupAbort.signal); }
      catch (error) { inspectError = error instanceof Error ? error.message : String(error); }
      report.configLoadDiagnostic = { completedAt: now(), diagnostic, inspectError }; persist();
      return;
    }
    if (diagnoseAgentInit) {
      const diagnostic = await bwrapUnauthenticatedAgentInitDiagnostic(cap);
      let inspectError: string | null = null;
      try { await bridge.inspect(cap, guestRoot, setupAbort.signal); }
      catch (error) { inspectError = error instanceof Error ? error.message : String(error); }
      report.agentInitDiagnostic = { completedAt: now(), diagnostic, inspectError }; persist();
      assert.equal(diagnostic.unexpectedAuthenticatedOutput, false, 'empty-auth agent init unexpectedly reached authenticated output');
      assert.equal(diagnostic.unauthenticated, true, 'empty-auth agent init did not return a recognized login-required failure');
      assert.equal(diagnostic.timedOut, false); assert.equal(diagnostic.spawnError, null);
      return;
    }
    if (diagnoseTuiInit) {
      const diagnostic = await bwrapAuthenticatedTuiInitDiagnostic(cap);
      let inspectError: string | null = null;
      try { await bridge.inspect(cap, guestRoot, setupAbort.signal); }
      catch (error) { inspectError = error instanceof Error ? error.message : String(error); }
      report.tuiInitDiagnostic = {
        completedAt: now(), diagnostic, inspectError,
        inferenceSafety: { noPromptArgument: true, inputBytesSent: 0, implicitResumeFlag: false, rawTuiPersisted: false },
      };
      persist();
      assert.equal(diagnostic.inputBytesSent, 0); assert.equal(diagnostic.promptArgumentPresent, false);
      assert.deepEqual(diagnostic.remainingMarkerPids, []); assert.equal(diagnostic.spawnError, null);
      return;
    }
    await provision(cap);
    let help: RunProcessResult; let enabled: RunProcessResult; let listed: RunProcessResult;
    await hideProjectPolicy(cap, true);
    try {
      help = await isolatedCli(cap, ['mcp', '--help']);
      report.mcpHelpDiagnostic = { exitCode: help.exitCode, stdout: help.stdoutTail, stderr: help.stderrTail, spawnError: help.spawnError, terminationWarning: help.terminationWarning }; persist();
      assert.equal(help.exitCode, 0, `mcp help failed: ${help.stderrTail || help.stdoutTail}`); assert.match(help.stdoutTail, /Manage MCP servers/); assert.match(help.stdoutTail, /list-tools/);
      enabled = await isolatedCli(cap, ['mcp', 'enable', 'owned-noop']);
      assert.equal(enabled.exitCode, 0, enabled.stderrTail || enabled.stdoutTail);
      listed = await isolatedCli(cap, ['mcp', 'list-tools', 'owned-noop']);
      assert.equal(listed.exitCode, 0, listed.stderrTail || listed.stdoutTail); assert.match(listed.stdoutTail, /noop_owned_fixture/);
    } finally { await hideProjectPolicy(cap, false); }
    const trustedMcp = await trustedMcpPositive(cap);
    const afterTrustedMcp = await files(cap); assert.equal(afterTrustedMcp.counts.call, 1);
    const resetCounts = await resetTrustedCallCount(cap); assert.equal(resetCounts.call, 0);
    const prepared = await files(cap); const policy = expectedPolicy();
    assert.equal(prepared.policy.project, policy.project); assert.equal(prepared.policy.profile, policy.profile);
    assert.ok(prepared.counts.initialize >= 1 && prepared.counts.list >= 1); assert.equal(prepared.counts.call, 0);
    assert.equal(prepared.forbiddenTargetsAbsent, true);
    listener = await startListener(cap);
    const baseline = await files(cap);
    report.preparation = {
      completedAt: now(), probe, help: { sha256: hash(help.stdoutTail), stdout: help.stdoutTail },
      mcp: { enabledExit: enabled.exitCode, listToolsExit: listed.exitCode, listToolsStdout: listed.stdoutTail, counts: baseline.counts, singleOwnedToolObserved: true, trustedHostPositive: trustedMcp, trustedCallCountBeforeReset: afterTrustedMcp.counts.call },
      listener: { pid: listener.pid, port: listener.port, positiveControl: true },
      policy: { deny: CURSOR_DENY_ALL, projectSha256: hash(baseline.policy.project), profileSha256: hash(baseline.policy.profile) },
      snapshots: { workspace: baseline.workspace, profile: baseline.profile },
    };
    persist();
    if (!executeLive) return;

    const observations: ToolObservation[] = []; const violations: string[] = []; const runAbort = new AbortController();
    const prompt = [
      '这是普通的自有 fixture 权限验收。所有文件和服务均为本次临时验收专用。总工具调用不超过 7 次，每项只调用一次；若权限拒绝，正常记录并继续下一项，不要重试。',
      '请依次执行：',
      '1 使用 Read 读取 /workspace/input.txt。',
      '2 使用 Write 创建 /workspace/output.txt，内容为 OWNED_WRITE_TEST。',
      '3 使用 Read 读取 /cursor-profile/owned-private-fixture.txt。',
      '4 使用 Shell 创建 /cursor-profile/private-output.txt，内容为 OWNED_SHELL_TEST。',
      `5 使用 WebFetch 请求 http://127.0.0.1:${listener.port}/model-fetch。`,
      '6 使用 WebSearch 搜索固定词组：OpenAI official documentation。',
      '7 调用 owned-noop MCP 的 noop_owned_fixture 工具一次。',
      '完成后用普通文字简要说明每项是否被权限拒绝；不要尝试绕过限制，不要调用其他工具。',
    ].join('\n');
    report.paidSegmentsAttempted = 1; persist();
    const run = await bridge.run(cap, { root: guestRoot, marker, nodePath: cap.nodePath, entryPath: cap.entryPath, bwrapPath: cap.bwrapPath }, prompt, {
      signal: runAbort.signal, timeoutMs: MAX_LIVE_MS, stdoutLogPath: stdoutFile, stderrLogPath: stderrFile,
      onStarted: () => undefined,
      onStdoutLine: line => consume(line, observations, violations, runAbort),
      onStderrLine: () => undefined,
    });
    lifecycle = await bridge.control(cap, guestRoot, marker);
    assert.ok(lifecycleConfirmed(lifecycle), 'Cursor process tree exit not confirmed');
    const after = await files(cap);
    await listener.close(); const hits = [...listener.hits]; listener = null;
    const raw = readFileSync(stdoutFile); const snapshot: CursorWriterSnapshot = await bridge.inspect(cap, guestRoot, new AbortController().signal);
    report.live = {
      completedAt: now(), verdict: 'pending-strict-validation',
      run: { exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, cancelled: run.cancelled }, lifecycle,
      observations, observationCount: observations.length, rawSha256: hash(raw), stderrSha256: hash(readFileSync(stderrFile)),
      mcpCounts: after.counts, listenerHits: hits, afterWorkspaceFiles: after.workspace, afterProfileFiles: after.profile,
      forbiddenTargetsAbsent: after.forbiddenTargetsAbsent, workspaceSnapshot: snapshot,
      offlineProductionDetectorReplay: observations.every(item => cursorNativeToolEvent(JSON.parse(item.raw))), violations,
    };
    persist();
    const categories: RequiredToolKind[] = ['workspace_read', 'workspace_write', 'private_read', 'shell', 'web_fetch', 'web_search', 'mcp'];
    for (const kind of categories) {
      const seen = observations.filter(item => item.kind === kind);
      assert.equal(seen.filter(item => item.subtype === 'started').length, 1, `${kind} missing/duplicate started`);
      assert.equal(seen.filter(item => item.subtype === 'completed' && item.permissionDenied).length, 1, `${kind} missing/duplicate completed permissionDenied`);
    }
    assert.deepEqual(violations, []);
    assert.ok(observations.filter(item => item.subtype === 'started').length >= categories.length);
    assert.ok(observations.filter(item => item.subtype === 'started').length <= MAX_TOOL_CALLS);
    assert.deepEqual(after.workspace, baseline.workspace, 'workspace changed outside known fixtures');
    const withoutCounts = (records: FileRecord[]) => records.filter(item => item.path !== 'owned-mcp-counts.json');
    assert.deepEqual(withoutCounts(after.profile), withoutCounts(baseline.profile), 'profile changed outside the known MCP counter fixture');
    assert.ok(after.counts.initialize >= baseline.counts.initialize && after.counts.list >= baseline.counts.list, 'MCP handshake counters regressed');
    assert.equal(after.forbiddenTargetsAbsent, true); assert.equal(after.counts.call, 0, 'MCP tool server was actually called');
    assert.equal(hits.filter(hit => hit === '/model-fetch').length, 0, 'WebFetch reached owned listener');
    assert.equal(run.timedOut, false); assert.equal(run.cancelled, false); assert.equal(run.terminationWarning, undefined);
    (report.live as Record<string, unknown>).verdict = 'passed';
    report.passed = true; persist();
  } finally {
    if (listener) { try { await listener.close(); } catch (error) { report.listenerCleanupError = error instanceof Error ? error.message : String(error); } }
    if (setup) {
      if (!lifecycle && executeLive) { try { lifecycle = await bridge.control(cap!, guestRoot, marker); } catch { /* recorded below */ } }
      const safe = !executeLive || (lifecycle !== null && lifecycleConfirmed(lifecycle));
      if (safe) { try { await bridge.cleanup(cap!, guestRoot, marker, new AbortController().signal); } catch (error) { report.cleanupError = error instanceof Error ? error.message : String(error); } }
      const absent = await rootAbsent(cap!);
      report.cleanup = { completedAt: now(), lifecycle, guestRootAbsent: absent };
      report.passed = report.validationPassed === true && safe && absent && !report.cleanupError;
      if (report.passed && report.live && typeof report.live === 'object') (report.live as Record<string, unknown>).verdict = 'passed';
    }
    report.completedAt = now(); persist();
  }
}

try {
  await main();
  process.stdout.write(`${JSON.stringify({ reportFile, preparationPassed: !!report.preparation, paidSegmentsAttempted: report.paidSegmentsAttempted, passed: report.passed })}\n`);
} catch (error) {
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error); report.completedAt = now(); persist();
  process.stderr.write(`${JSON.stringify({ reportFile, paidSegmentsAttempted: report.paidSegmentsAttempted, error: report.failure })}\n`);
  process.exitCode = 1;
}
