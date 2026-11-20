/** No-model MXC runner probe. It creates only disposable canaries under the configured data root. */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection, createServer } from 'node:net';
import { resolveCommand, runProcess, scrubEnv } from '../src/adapters/process.js';
import type { WindowsMxcCapability } from '../src/chat/runner-windows.js';

const base = path.resolve(process.env.DMW_DATA_ROOT ?? 'data'); const work = path.join(base, 'work');
mkdirSync(work, { recursive: true });
// Optional absolute output and CLI paths let a refresh be staged without changing the active proof.
const capabilityFile = process.argv[3] ?? path.join(base, 'capabilities', 'runner-windows.json');
if (!path.isAbsolute(capabilityFile)) throw new Error('证明输出必须为绝对路径。');
function validateStagedOutput(): void {
  if (!process.argv[3]) return;
  const parent = path.dirname(capabilityFile);
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink()) throw new Error('候选证明父目录必须已存在且不是链接。');
  const actualParent = realpathSync.native(parent);
  const relative = path.relative(realpathSync.native(work), actualParent);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('候选证明必须写入本轮 work 子目录。');
  if (path.resolve(parent).toLowerCase() !== actualParent.toLowerCase() || /[<>:"|?*\0]/.test(path.basename(capabilityFile))) throw new Error('候选证明路径无效或经过链接。');
  if (existsSync(capabilityFile)) throw new Error('候选证明已存在，拒绝覆盖。');
}
validateStagedOutput();
const requestedCodex = process.argv[4];
if (requestedCodex && (!path.isAbsolute(requestedCodex) || !existsSync(requestedCodex))) throw new Error('指定的 Codex CLI 必须为存在的绝对路径。');
// Keep only OS values MXC needs; never pass unrelated host authentication variables to the sandbox launcher.
const hostEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, OPENAI_API_KEY: 'probe-canary-not-a-secret' };
const env = scrubEnv(hostEnv, ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY']).env;
const codex = resolveCommand('codex', { override: requestedCodex ? { command: requestedCodex } : null });
if (!codex || codex.via === 'cmd-fallback') throw new Error('找不到可直接执行的 Codex CLI。');
const codexCommand = codex;
const root = mkdtempSync(path.join(work, 'windows-mxc-probe-'));
const allowed = path.join(root, 'allowed'); const outside = path.join(root, 'outside'); mkdirSync(allowed); mkdirSync(outside);
const inside = path.join(allowed, 'inside.txt'); const privateCanary = path.join(outside, 'credential-canary.txt'); const childMarker = path.join(allowed, 'child.pid');
writeFileSync(inside, 'allowed'); writeFileSync(privateCanary, 'not-a-real-credential');
const hostControls = { insideReadable: false, privateReadable: false, outsideWritable: false };
try { hostControls.insideReadable = readFileSync(inside, 'utf8') === 'allowed'; } catch { /* remains false */ }
try { hostControls.privateReadable = readFileSync(privateCanary, 'utf8') === 'not-a-real-credential'; } catch { /* remains false */ }
try { writeFileSync(`${privateCanary}.host-control`, 'host-can-write'); hostControls.outsideWritable = true; } catch { /* remains false */ }
const profile = 'workbench-runner-probe';
const token = createHash('sha256').update(`${process.pid}:${Date.now()}`).digest('hex');
let loopbackPort = 0;
const nodeRoot = path.dirname(process.execPath);
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const defaultRunnerCode = fileURLToPath(new URL('../src/chat/runner-windows.ts', import.meta.url));
const runnerCode = process.argv[2] ? process.argv[2] : defaultRunnerCode;
if (!path.isAbsolute(runnerCode) || !existsSync(runnerCode)) throw new Error('runner module 参数必须是存在的绝对路径。');
const policyHash = createHash('sha256').update(JSON.stringify({ version: 'windows-mxc-v2', profile, filesystem: [':root=deny', ':minimal=read', ':workspace_roots=write', ':ticket_root=read', `${path.resolve(nodeRoot)}=read`], network: false, webSearch: 'disabled', probe: 'loopback-listener+explicit-denials+detached-tree-v2' })).digest('hex');
const fsPolicy = `{":root"="deny",":minimal"="read",":workspace_roots"="write",${JSON.stringify(allowed)}="read",${JSON.stringify(nodeRoot)}="read"}`;
const common = ['sandbox', '--enable', 'prefer_mxc', '-C', allowed, '-P', profile, '-c', `default_permissions="${profile}"`, '-c', `permissions.${profile}.filesystem=${fsPolicy}`, '-c', `permissions.${profile}.network.enabled=false`, '-c', 'web_search="disabled"', '--', process.execPath, '-e'];
const script = String.raw`const fs=require('fs'),cp=require('child_process'),net=require('net');const [mode,inside,outside,marker,port,token]=process.argv.slice(1);const denied=e=>e&&['EPERM','EACCES'].includes(e.code);const out={mode,ok:false};const done=()=>console.log('MXC='+JSON.stringify(out));try{if(mode==='inside'){fs.readFileSync(inside);fs.writeFileSync(inside+'.write','ok');out.ok=true;done()}else if(mode==='outside-write'){try{fs.writeFileSync(outside+'.write','x')}catch(e){out.ok=denied(e);out.code=e.code}done()}else if(mode==='outside-read'||mode==='credential-file'){try{fs.readFileSync(outside)}catch(e){out.ok=denied(e);out.code=e.code}done()}else if(mode==='credential-env'){out.ok=!process.env.OPENAI_API_KEY;done()}else if(mode==='network'){const s=net.connect({host:'127.0.0.1',port:Number(port)});s.on('connect',()=>{out.ok=false;s.destroy();done()});s.on('error',e=>{out.ok=denied(e);out.code=e.code;done()});setTimeout(()=>{out.ok=false;s.destroy();done()},1000)}else if(mode==='child'){const r=cp.spawnSync(process.execPath,['-e','process.stdout.write("child-ok")'],{encoding:'utf8'});out.ok=r.status===0&&r.stdout==='child-ok';done()}else if(mode==='child-escape'){const r=cp.spawnSync(process.execPath,['-e','try{require("fs").readFileSync(process.argv[1]);process.stdout.write("read")}catch(e){process.stdout.write("deny:"+e.code);process.exit(1)}',outside],{encoding:'utf8'});out.ok=r.status===1&&/^deny:(EPERM|EACCES)$/.test(r.stdout);done()}else if(mode==='normal-tree'||mode==='cancel-tree'){const child='const fs=require("fs");fs.writeFileSync(process.env.MARKER,JSON.stringify({pid:process.pid,token:process.env.TOKEN,started:Date.now()}));setInterval(()=>{},1000)';const c=cp.spawn(process.execPath,['-e',child],{detached:true,stdio:'ignore',env:{...process.env,MARKER:marker,TOKEN:token}});c.unref();setTimeout(()=>{out.ok=fs.existsSync(marker)&&JSON.parse(fs.readFileSync(marker)).token===token;done();if(mode==='normal-tree')process.exit(0);else setInterval(()=>{},1000)},200)}else done()}catch(e){out.code=e&&e.code||'error';done()}`;
async function probe(mode: string) {
  const result = await runProcess(codexCommand, [...common, script, mode, inside, privateCanary, childMarker, String(loopbackPort), token], { cwd: allowed, env, stdinText: null, timeoutMs: 10_000 });
  const line = result.stdoutTail.split(/\r?\n/).find(value => value.startsWith('MXC='));
  let ok: boolean | null = null; try { ok = line ? JSON.parse(line.slice(4)).ok === true : null; } catch { /* diagnostic stays bounded */ }
  return { ok, exitCode: result.exitCode, timedOut: result.timedOut, exitUnknown: Boolean(result.terminationWarning), stderrCategory: /elevat/i.test(result.stderrTail) ? 'elevation_required' : /denied|EPERM|EACCES/i.test(result.stderrTail) ? 'denied' : null };
}
async function cancellation() {
  const cancelMarker = path.join(allowed, 'cancel-child.pid'); const controller = new AbortController();
  const pending = runProcess(codexCommand, [...common, script, 'cancel-tree', inside, privateCanary, cancelMarker, String(loopbackPort), token], { cwd: allowed, env, stdinText: null, timeoutMs: 10_000, signal: controller.signal });
  const started = await new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 2_000); const poll = () => { if (existsSync(cancelMarker)) { clearTimeout(timer); resolve(true); } else setTimeout(poll, 25); }; poll(); });
  let identity = false; let pid = 0;
  try { const value = JSON.parse(readFileSync(cancelMarker, 'utf8')); identity = value?.token === token && Number.isInteger(value?.pid) && value.pid > 0; pid = value?.pid ?? 0; } catch { /* kept false */ }
  controller.abort(); const result = await pending;
  const childGone = await waitForGone(pid, identity);
  return { started, identity, childGone, cancelled: result.cancelled, exitUnknown: Boolean(result.terminationWarning), timedOut: result.timedOut };
}
async function normalTree() {
  const parent = await probe('normal-tree'); if (!parent.ok || !existsSync(childMarker)) return { ...parent, childGone: false };
  let identity = false; let pid = 0; try { const value = JSON.parse(readFileSync(childMarker, 'utf8')); identity = value?.token === token && Number.isInteger(value?.pid) && value.pid > 0; pid = value?.pid ?? 0; } catch { /* kept false */ }
  return { ...parent, identity, childGone: await waitForGone(pid, identity) };
}
async function waitForGone(pid: number, validIdentity: boolean): Promise<boolean> {
  if (!validIdentity) return false;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}
async function version() { const result = await runProcess(codexCommand, ['--version'], { cwd: allowed, env, stdinText: null, timeoutMs: 10_000 }); return result.exitCode === 0 && !result.terminationWarning ? result.stdoutTail.trim() : null; }
async function verifiedListener(): Promise<{ ok: boolean; close: () => Promise<void> }> {
  const server = createServer(socket => socket.end()); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  const address = server.address(); if (!address || typeof address === 'string') { await close(); return { ok: false, close: async () => {} }; } loopbackPort = address.port;
  try { await new Promise<void>((resolve, reject) => { const socket = createConnection({ host: '127.0.0.1', port: loopbackPort }); socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); }); return { ok: true, close }; }
  catch { await close(); return { ok: false, close: async () => {} }; }
}
async function verifyRunnerModule(proof: WindowsMxcCapability): Promise<{ ok: boolean; diagnostic: string | null }> {
  try {
    const mod = await import(pathToFileURL(runnerCode).href) as { createWindowsMxcRunner?: (input: unknown) => { issueTicket: (invocation: string, spec: any, root: string) => string; run: (ticket: string, invocation: string) => Promise<{ exitCode: number | null; stdoutTail: string; stderrTail: string; terminationWarning?: string }> } | null };
    const runner = mod.createWindowsMxcRunner?.(proof); if (!runner) return { ok: false, diagnostic: 'factory_rejected_proof' };
    const cwd = path.join(allowed, 'module-subdirectory'); mkdirSync(cwd); const parent = path.join(allowed, 'module-parent.txt'); writeFileSync(parent, 'parent');
    writeFileSync(path.join(cwd, 'module.cjs'), 'module.exports="module-ok"'); writeFileSync(path.join(cwd, 'child.cjs'), 'process.stdout.write("child-ok")');
    writeFileSync(path.join(cwd, 'check.cjs'), 'const fs=require("fs"),{spawnSync}=require("child_process");const r=spawnSync(process.execPath,["child.cjs"],{cwd:process.cwd(),encoding:"utf8"});process.stdout.write(String(process.cwd()===process.argv[2]&&fs.readFileSync(process.argv[3],"utf8")==="parent")+":"+require("./module.cjs")+":"+(r.stdout||""))');
    const ticket = runner.issueTicket('probe-module-invocation', { executable: process.execPath, args: ['check.cjs', cwd, parent], cwd, timeoutMs: 10_000, network: 'none', platform: 'windows' }, allowed);
    const result = await runner.run(ticket, 'probe-module-invocation');
    const expected = 'true:module-ok:child-ok'; const observed = result.stdoutTail.trim();
    return { ok: result.exitCode === 0 && observed === expected && !result.terminationWarning, diagnostic: result.exitCode === 0 ? `stdout:${observed.slice(0, 160)}` : `exit:${result.exitCode}: ${result.stderrTail.slice(0, 240)}` };
  } catch (error) { return { ok: false, diagnostic: error instanceof Error ? error.message.slice(0, 240) : 'module_exception' }; }
}
async function main() {
  try {
    const listener = await verifiedListener();
    const results: Record<string, unknown> = {};
    results.hostLoopback = { accepted: listener.ok, port: listener.ok ? '<ephemeral loopback port>' : null };
    for (const mode of ['inside', 'outside-read', 'outside-write', 'credential-file', 'credential-env', 'network', 'child', 'child-escape']) results[mode] = await probe(mode);
    results.normalTree = await normalTree();
    results.cancellation = await cancellation();
    const typed = results as Record<string, any>; const codexVersion = await version();
    await listener.close();
    const tests: WindowsMxcCapability['tests'] = { insideRead: hostControls.insideReadable && typed.inside.ok === true, insideWrite: typed.inside.ok === true, outsideReadDenied: hostControls.privateReadable && typed['outside-read'].ok === true, outsideWriteDenied: hostControls.outsideWritable && typed['outside-write'].ok === true, credentialReadDenied: hostControls.privateReadable && typed['credential-file'].ok === true && typed['credential-env'].ok === true, networkDenied: listener.ok && typed.network.ok === true, childProcessWorks: typed.child.ok === true, childEscapeDenied: typed['child-escape'].ok === true, normalTreeConfirmed: typed.normalTree.ok === true && typed.normalTree.identity === true && typed.normalTree.childGone === true && !typed.normalTree.exitUnknown, cancelTreeConfirmed: typed.cancellation.started === true && typed.cancellation.identity === true && typed.cancellation.childGone === true && typed.cancellation.cancelled === true && !typed.cancellation.exitUnknown, runnerModuleVerified: false };
    const checkedAt = new Date().toISOString(); const allPassed = Object.entries(tests).every(([name, passed]) => name === 'runnerModuleVerified' || passed === true) && Boolean(codexVersion);
    const report: any = { checkedAt, root: '<disposable configured work root>', codexVersion, hostControls, results, tests, proofGenerated: false, capabilityFile };
    if (allPassed) {
      const candidate: WindowsMxcCapability = { version: 3, verified: true, verifiedAt: checkedAt, policyVersion: 'windows-mxc-v2', policySha256: policyHash, codexVersion: codexVersion!, codex: { path: codexCommand.file, sha256: hash(codexCommand.file) }, runnerCode: { path: runnerCode, sha256: hash(runnerCode) }, profile, allowedExecutable: { path: process.execPath, sha256: hash(process.execPath) }, readonlyRoots: [{ path: nodeRoot }], allowedEnv: [], tests: { ...tests, runnerModuleVerified: true } };
      const moduleResult = await verifyRunnerModule(candidate); tests.runnerModuleVerified = moduleResult.ok; report.runnerModuleVerified = moduleResult;
      if (!tests.runnerModuleVerified) { console.log(JSON.stringify(report, null, 2)); return; }
      const proof: WindowsMxcCapability = { ...candidate, tests };
      validateStagedOutput();
      mkdirSync(path.dirname(capabilityFile), { recursive: true });
      const temporary = `${capabilityFile}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(proof, null, 2), { mode: 0o600, flag: 'wx' });
        if (process.argv[3]) linkSync(temporary, capabilityFile);
        else renameSync(temporary, capabilityFile);
        report.proofGenerated = true;
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (path.dirname(path.resolve(root)).toLowerCase() !== realpathSync.native(work).toLowerCase() || lstatSync(root).isSymbolicLink()) throw new Error('探针清理路径不在预定 work 根目录内。');
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`Windows MXC probe failed: ${(error as Error).message}`); process.exitCode = 1; });
