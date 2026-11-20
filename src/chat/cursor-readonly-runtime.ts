import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProcess, type ResolvedCommand, type RunProcessResult } from '../adapters/process.js';
import type { CursorWriteCapabilities, CursorWriterBridge } from '../adapters/cursor-writer.js';
import { CURSOR_NATIVE_TOOL_EXCLUSION_CSV } from './cursor-native-tool-exclusion.js';

export type CursorReadonlyRuntimeFlavor = 'deny' | 'paired';

const WSL: ResolvedCommand = { file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' };
const MOUNT_ANCHOR = "    '--ro-bind', authStore, '/home/codex/.config/cursor', '--dir', '/home/codex/.cursor', '--bind', projectState, '/home/codex/.cursor',\n    '--tmpfs', '/tmp',";
const COMMAND_ANCHOR = "    '--', request.nodePath, request.entryPath, '--print', '--output-format', 'stream-json', '--sandbox', 'enabled',\n    '--trust', '--model', 'grok-4.7-high-fast', '--workspace', '/workspace',";
const GUARDED_COMMAND_ANCHOR = `    '--chdir', '/workspace', '--', request.nodePath, '--require', '/cursor-profile/profile-guard.cjs', '--require', '/cursor-profile/native-approval.cjs', request.entryPath, '--print', '--output-format', 'stream-json', '--sandbox', 'enabled',
    '--trust', '--model', 'grok-4.7-high-fast', '--workspace', '/workspace', '--exclude-tools', ${JSON.stringify(CURSOR_NATIVE_TOOL_EXCLUSION_CSV)},`;
const AUTH_STORE_ANCHOR = "  const authStore = '/home/codex/.config/cursor';";

function hostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function readonlyMounts(flavor: CursorReadonlyRuntimeFlavor): string {
  const paired = flavor === 'paired'
    ? "\n    '--ro-bind', `${profile}/scope-guard.mjs`, '/cursor-profile/scope-guard.mjs',"
    : '';
  return `${MOUNT_ANCHOR.slice(0, -"    '--tmpfs', '/tmp',".length)}    '--ro-bind', \`${'${workspace}'}/.cursor\`, '/workspace/.cursor',
    '--ro-bind', \`${'${profile}'}/hooks.json\`, '/cursor-profile/hooks.json',
    '--ro-bind', \`${'${profile}'}/deny-native.mjs\`, '/cursor-profile/deny-native.mjs',
    '--ro-bind', \`${'${profile}'}/profile-guard.cjs\`, '/cursor-profile/profile-guard.cjs',
    '--ro-bind', \`${'${profile}'}/native-approval.cjs\`, '/cursor-profile/native-approval.cjs',
    '--ro-bind', \`${'${profile}'}/receipt-binding.json\`, '/cursor-profile/receipt-binding.json',${paired}
    '--ro-bind', \`${'${projectState}'}/hooks.json\`, '/home/codex/.cursor/hooks.json',
    '--tmpfs', '/tmp',`;
}

/** Derive a chat-only runtime while fail-closing if the verified legacy mount layout changes. */
export function cursorReadonlyRuntimeSource(flavor: CursorReadonlyRuntimeFlavor): string {
  const source = readFileSync(fileURLToPath(new URL('../adapters/cursor-writer-runtime.mjs', import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
  const occurrences = source.split(MOUNT_ANCHOR).length - 1;
  if (occurrences !== 1) throw new Error(`Cursor chat readonly runtime mount anchor count ${occurrences}, expected 1`);
  const commandOccurrences = source.split(COMMAND_ANCHOR).length - 1;
  if (commandOccurrences !== 1) throw new Error(`Cursor chat guarded command anchor count ${commandOccurrences}, expected 1`);
  return source.replace(MOUNT_ANCHOR, readonlyMounts(flavor)).replace(COMMAND_ANCHOR, GUARDED_COMMAND_ANCHOR);
}

export function cursorReadonlyRuntimeSha256(flavor: CursorReadonlyRuntimeFlavor): string {
  return crypto.createHash('sha256').update(cursorReadonlyRuntimeSource(flavor)).digest('hex');
}

function mountProbeProgram(flavor: CursorReadonlyRuntimeFlavor): string {
  const targets = ['/workspace/.cursor/cli.json', '/cursor-profile/hooks.json', '/cursor-profile/deny-native.mjs', '/cursor-profile/receipt-binding.json',
    '/cursor-profile/profile-guard.cjs', '/cursor-profile/native-approval.cjs', ...(flavor === 'paired' ? ['/cursor-profile/scope-guard.mjs'] : []), '/home/codex/.cursor/hooks.json'];
  const mutable = ['/cursor-profile/cli-config.json', '/home/codex/.cursor/cli-config.json'];
  return `import fs from 'node:fs';const targets=${JSON.stringify(targets)},mutable=${JSON.stringify(mutable)};const attempts=[],mutableAttempts=[];const run=(list,path,op,fn)=>{try{fn();list.push({path,op,code:'SUCCESS'})}catch(error){list.push({path,op,code:error?.code??'UNKNOWN'})}};for(const file of targets){run(attempts,file,'write',()=>fs.writeFileSync(file,'PROBE'));run(attempts,file,'rename',()=>fs.renameSync(file,file+'.moved'));const temp=file+'.readonly-probe-temp';run(attempts,file,'replace',()=>{fs.writeFileSync(temp,'PROBE');try{fs.renameSync(temp,file)}finally{if(fs.existsSync(temp))fs.rmSync(temp,{force:true})}})}for(const file of mutable){const original=fs.readFileSync(file);run(mutableAttempts,file,'write',()=>fs.writeFileSync(file,original));run(mutableAttempts,file,'rename-replace',()=>{const temp=file+'.mutable-probe-temp';fs.writeFileSync(temp,original);fs.renameSync(temp,file)});run(mutableAttempts,file,'replace',()=>{const temp=file+'.mutable-probe-replace';fs.writeFileSync(temp,original);fs.renameSync(temp,file)})}let logAppend=false;try{fs.appendFileSync('/cursor-profile/native-deny-receipts.jsonl','');logAppend=true}catch{}process.stdout.write(JSON.stringify({attempts,mutableAttempts,logAppend})+'\\n');setInterval(()=>{},1000);`;
}

function profileGuardProbeProgram(): string {
  return `const fs=require('node:fs'),crypto=require('node:crypto'),target=process.argv[1],info=fs.lstatSync(target),uidMap=fs.readFileSync('/proc/self/uid_map','utf8').trim().split(/\\n/).map(line=>line.trim().split(/\\s+/).map(Number)),expectedUid=Number(fs.readFileSync('/proc/sys/kernel/overflowuid','utf8').trim()),chunk=require(target),factory=chunk.modules['./src/local-agent-profile.ts'],out={},wr=()=>{};wr.d=(value,defs)=>{for(const [key,get] of Object.entries(defs))Object.defineProperty(value,key,{enumerable:true,get})};factory({exports:out},out,wr);const direct=out.Rb,selectorA=out.UV,selectorB=out.UV,selected=selectorA({localAgent:false}),disabled=['enableTeamHooks','enableWorkspaceOpenHook','enableManagedSkillsSync','enableMarketplacePlugins','enableUserLocalPlugins','enableFirstPartyPlugins','enableMcp'];process.stdout.write(JSON.stringify({uid:info.uid,expectedUid,uidMap,mode:info.mode&0o777,realpathMatches:fs.realpathSync(target)===target,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),same:direct===selected,stable:selectorA===selectorB,disabled:disabled.every(key=>direct.capabilities[key]===false)}));`;
}

export function cursorReadonlyMountProbeRuntimeSource(flavor: CursorReadonlyRuntimeFlavor): string {
  const source = cursorReadonlyRuntimeSource(flavor); const commandOccurrences = source.split(GUARDED_COMMAND_ANCHOR).length - 1;
  const authOccurrences = source.split(AUTH_STORE_ANCHOR).length - 1;
  if (commandOccurrences !== 1) throw new Error(`Cursor chat readonly runtime command anchor count ${commandOccurrences}, expected 1`);
  if (authOccurrences !== 1) throw new Error(`Cursor chat readonly runtime auth anchor count ${authOccurrences}, expected 1`);
  return source
    .replace(AUTH_STORE_ANCHOR, "  const authStore = `${root}/readonly-probe-empty-auth`; fs.mkdirSync(authStore, { mode: 0o700 });")
    .replace(GUARDED_COMMAND_ANCHOR, `    '--', request.nodePath, '--input-type=module', '-e', ${JSON.stringify(mountProbeProgram(flavor))},`);
}

export function cursorReadonlyProfileGuardProbeRuntimeSource(flavor: CursorReadonlyRuntimeFlavor): string {
  const source = cursorReadonlyRuntimeSource(flavor); const commandOccurrences = source.split(GUARDED_COMMAND_ANCHOR).length - 1;
  const authOccurrences = source.split(AUTH_STORE_ANCHOR).length - 1;
  if (commandOccurrences !== 1) throw new Error(`Cursor profile guard probe command anchor count ${commandOccurrences}, expected 1`);
  if (authOccurrences !== 1) throw new Error(`Cursor profile guard probe auth anchor count ${authOccurrences}, expected 1`);
  return source
    .replace(AUTH_STORE_ANCHOR, "  const authStore = `${root}/profile-guard-probe-empty-auth`; fs.mkdirSync(authStore, { mode: 0o700 });")
    .replace(GUARDED_COMMAND_ANCHOR, `    '--', request.nodePath, '--require', '/cursor-profile/profile-guard.cjs', '-e', ${JSON.stringify(profileGuardProbeProgram())}, request.entryPath.replace(/\\/index\\.js$/, '/4060.index.js'),`);
}

/** Fixed no-model mount probe used only by the real WSL regression. */
export function runCursorReadonlyMountProbe(
  flavor: CursorReadonlyRuntimeFlavor,
  capabilities: CursorWriteCapabilities,
  request: Parameters<CursorWriterBridge['run']>[1],
  callbacks: Parameters<CursorWriterBridge['run']>[3],
): Promise<RunProcessResult> {
  const source = cursorReadonlyMountProbeRuntimeSource(flavor);
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  const args = ['-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.setsidPath, '--wait', capabilities.nodePath,
    '--input-type=module', '-e', source, 'run', encoded, request.marker];
  return runProcess(WSL, args, { cwd: process.cwd(), env: hostEnv(), stdinText: null, timeoutMs: callbacks.timeoutMs, signal: callbacks.signal,
    stdoutLogPath: callbacks.stdoutLogPath, stderrLogPath: callbacks.stderrLogPath, onStarted: callbacks.onStarted,
    onStdoutLine: callbacks.onStdoutLine, onStderrLine: callbacks.onStderrLine });
}

/** Exact production bwrap/profile-guard path with owned empty auth and no Cursor agent/model dispatch. */
export function runCursorReadonlyProfileGuardProbe(
  flavor: CursorReadonlyRuntimeFlavor,
  capabilities: CursorWriteCapabilities,
  request: Parameters<CursorWriterBridge['run']>[1],
  callbacks: Parameters<CursorWriterBridge['run']>[3],
): Promise<RunProcessResult> {
  const source = cursorReadonlyProfileGuardProbeRuntimeSource(flavor);
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  const args = ['-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.setsidPath, '--wait', capabilities.nodePath,
    '--input-type=module', '-e', source, 'run', encoded, request.marker];
  return runProcess(WSL, args, { cwd: process.cwd(), env: hostEnv(), stdinText: null, timeoutMs: callbacks.timeoutMs, signal: callbacks.signal,
    stdoutLogPath: callbacks.stdoutLogPath, stderrLogPath: callbacks.stderrLogPath, onStarted: callbacks.onStarted,
    onStdoutLine: callbacks.onStdoutLine, onStderrLine: callbacks.onStderrLine });
}

/** Fixed-flavor run entry. No model prompt or HTTP input can choose mount paths. */
export function runCursorReadonlyRuntime(
  flavor: CursorReadonlyRuntimeFlavor,
  capabilities: CursorWriteCapabilities,
  request: Parameters<CursorWriterBridge['run']>[1],
  prompt: string,
  callbacks: Parameters<CursorWriterBridge['run']>[3],
): Promise<RunProcessResult> {
  const source = cursorReadonlyRuntimeSource(flavor);
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  const args = ['-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.setsidPath, '--wait', capabilities.nodePath,
    '--input-type=module', '-e', source, 'run', encoded, request.marker];
  return runProcess(WSL, args, {
    cwd: process.cwd(), env: hostEnv(), stdinText: prompt, timeoutMs: callbacks.timeoutMs, signal: callbacks.signal,
    stdoutLogPath: callbacks.stdoutLogPath, stderrLogPath: callbacks.stderrLogPath,
    onStarted: callbacks.onStarted, onStdoutLine: callbacks.onStdoutLine, onStderrLine: callbacks.onStderrLine,
  });
}
