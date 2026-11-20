import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const HARNESS = path.join(WORK_ROOT, 'harness-completion-20261104');
const SUPERVISOR = { binaryPath: 'fixture-supervisor.exe', sourceCsSha256: '1'.repeat(64), wrapperSha256: '2'.repeat(64),
  binarySha256: '3'.repeat(64), compilerSha256: '4'.repeat(64), manifestSha256: '5'.repeat(64), protocol: 1 };

function put(root: string, relative: string, text = 'fixture'): string {
  const file = path.join(root, ...relative.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file;
}

function baseFixture(kind: 'claude' | 'codex') {
  mkdirSync(HARNESS, { recursive: true });
  const fixture = mkdtempSync(path.join(HARNESS, `job-receipt-caller-${kind}-`));
  const app = path.join(fixture, 'app'); mkdirSync(app); writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
  const capture = path.join(fixture, 'driver-options.jsonl');
  const command = put(app, `fixture-${kind}.exe`);
  const jobs = `import fs from 'node:fs';import path from 'node:path';
export const loadChatWindowsJobSupervisorAssets=()=>(${JSON.stringify(SUPERVISOR)});
export function validateChatWindowsJobReceiptRoot(value){if(!path.isAbsolute(value)||!fs.statSync(value).isDirectory()||path.basename(value)!=='job-receipts')throw Error('unsafe receipt root');return fs.realpathSync(value);}`;
  put(app, 'src/chat/windows-job-process.js', jobs);
  put(app, 'src/adapters/process.js', `export const resolveCommand=()=>({file:${JSON.stringify(command)},prefixArgs:[],via:'config'});`);
  put(app, 'config/workbench.config.json', '{}');
  const jobProbe = path.join(fixture, 'job-probe.json');
  writeFileSync(jobProbe, JSON.stringify({ schema: 'dual-model-workbench/windows-job-probe/v1', passed: true, realModelCalls: 0, appRoot: app, supervisor: SUPERVISOR }));
  return { fixture, app, capture, jobProbe };
}

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 40_000 });
}

function reportRoot(stdout: string): string {
  const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  const parsed = JSON.parse(last) as { reportFile: string; passed: boolean };
  assert.equal(parsed.passed, true); return path.dirname(parsed.reportFile);
}

function captures(file: string): Array<{ receiptRoot: string; role: string }> {
  return readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test('Claude qualification passes its compiled-validated receipt root to both actual driver calls', () => {
  const f = baseFixture('claude'); let liveRoot = ''; let passed = false;
  try {
    put(f.app, 'src/config.js', `export const loadConfig=()=>({models:{claude:{model:'claude-opus-5-5',effort:'max'}},adapters:{claude:{command:{}}}});`);
    put(f.app, 'src/chat/mcp-bridge.mjs');
    put(f.app, 'src/chat/drivers.js', `import {createHmac} from 'node:crypto';import {appendFileSync,lstatSync} from 'node:fs';import path from 'node:path';
export const commandFingerprint=()=> 'f'.repeat(64);
export async function runClaudeHostTools(_command,_config,_proof,input,options){
 const info=lstatSync(options.receiptRoot);if(!info.isDirectory()||path.basename(options.receiptRoot)!=='job-receipts')throw Error('receiptRoot missing');
 appendFileSync(${JSON.stringify(f.capture)},JSON.stringify({receiptRoot:options.receiptRoot,role:'claude'})+'\\n');
 const name=input.tools[0].name,token=createHmac('sha256',options.bridgeToken).update(input.chatId+'\\n'+input.invocation.id).digest('hex');let cancelled=false;
 try{const response=await fetch(options.bridgeUrl+'/internal/chat-tools/'+input.chatId+'/'+input.invocation.id,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({name,arguments:name==='read'?{path:'public.txt'}:{}}),signal:input.signal});if(name==='read')await response.text();}
 catch(error){if(!input.signal.aborted)throw error;cancelled=true;}
 const process={terminationWarning:undefined,spawnError:null,timedOut:false,cancelled,windowsJob:{protocol:1,ready:true,final:true,confirmed:true,jobActiveProcesses:0,rootExited:true,resumed:true,cancelReceived:cancelled,activeBeforeStop:cancelled?2:0}};
 options.onClaudeProcessResult(process);return{text:cancelled?'':'CLAUDE_JOB_PUBLIC_READ_OK',exitConfirmed:true,finishReason:cancelled?'cancelled':'completed'};
}`);
    const child = run('scripts/chat-live-claude-job-probe.ts', ['--app-root', f.app, '--job-probe-evidence', f.jobProbe, '--execute-live']);
    assert.equal(child.status, 0, child.stderr); liveRoot = reportRoot(child.stdout);
    const seen = captures(f.capture); assert.deepEqual(seen.map(item => item.role), ['claude', 'claude']);
    assert.equal(new Set(seen.map(item => item.receiptRoot)).size, 1);
    assert.ok(seen[0]!.receiptRoot.startsWith(path.join(WORK_ROOT, 'chat-live-claude-job-')));
    assert.equal(path.basename(seen[0]!.receiptRoot), 'job-receipts'); passed = true;
  } finally { if (passed) { rmSync(f.fixture, { recursive: true, force: true }); if (liveRoot && existsSync(liveRoot)) rmSync(liveRoot, { recursive: true, force: true }); } }
});

test('Codex qualification passes its compiled-validated receipt root to Astra and Sol normal/cancel calls', () => {
  const f = baseFixture('codex'); let liveRoot = ''; let passed = false;
  try {
    put(f.app, 'src/config.js', `export const loadConfig=()=>({models:{astra:{model:'gpt-6.2-astra',effort:'max'},sol:{model:'gpt-6.2-sol',effort:'max'}},adapters:{codex:{command:{}}}});`);
    for (const file of ['src/chat/codex-policy.js', 'src/chat/types.js', 'src/chat/windows-job-app-server.js']) put(f.app, file);
    put(f.app, 'src/chat/drivers.js', `import {appendFileSync,lstatSync} from 'node:fs';import path from 'node:path';
export const commandFingerprint=()=> 'f'.repeat(64);export class CodexAppServer{consume(_line){}}
export async function runCodexHostTools(_command,_config,_proof,input,role,options){
 const info=lstatSync(options.receiptRoot);if(!info.isDirectory()||path.basename(options.receiptRoot)!=='job-receipts')throw Error('receiptRoot missing');
 appendFileSync(${JSON.stringify(f.capture)},JSON.stringify({receiptRoot:options.receiptRoot,role})+'\\n');
 const cancelled=input.tools[0].name==='probe_wait';for(const phase of ['version','discovery','isolated'])options.onCodexJobEvidence({phase,confirmed:true,rootExited:true,activeProcesses:0,targetPid:123,cancelReceived:cancelled&&phase==='isolated',activeBeforeStop:cancelled&&phase==='isolated'?1:0});
 if(cancelled){void input.callTool('probe_wait',{});await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return{text:'',exitConfirmed:true,finishReason:'cancelled'};}
 const result=await input.callTool('probe_read',{path:'public.txt'});new CodexAppServer().consume(JSON.stringify({method:'item/completed',params:{item:{id:'fixture-call',type:'dynamicToolCall',tool:'probe_read',status:'completed',success:true,contentItems:[{type:'inputText',text:result.text}]}}}));
 return{text:result.text,exitConfirmed:true,finishReason:'completed'};
}`);
    const child = run('scripts/chat-live-codex-job-probe.ts', ['--app-root', f.app, '--job-probe-evidence', f.jobProbe,
      '--qualification-id', randomUUID(), '--codex-version', 'codex-cli fixture', '--execute-live']);
    assert.equal(child.status, 0, child.stderr); liveRoot = reportRoot(child.stdout);
    const seen = captures(f.capture); assert.deepEqual(seen.map(item => item.role), ['astra', 'astra', 'sol', 'sol']);
    assert.equal(new Set(seen.map(item => item.receiptRoot)).size, 1);
    assert.ok(seen[0]!.receiptRoot.startsWith(path.join(WORK_ROOT, 'chat-live-codex-job-')));
    assert.equal(path.basename(seen[0]!.receiptRoot), 'job-receipts'); passed = true;
  } finally { if (passed) { rmSync(f.fixture, { recursive: true, force: true }); if (liveRoot && existsSync(liveRoot)) rmSync(liveRoot, { recursive: true, force: true }); } }
});
