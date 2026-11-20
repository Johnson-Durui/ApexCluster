import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fail = (message, code = 70) => { process.stderr.write(`${message}\n`); process.exit(code); };
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const starttime = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21] ?? '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid request json', 64); }
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.includes('\0')) fail(`invalid ${label}`, 64);
  return value;
}

function safeMarker(value) {
  if (typeof value !== 'string' || !/^dmw-wsl-[a-f0-9-]{20,100}$/.test(value)) fail('invalid marker', 64);
  return value;
}

function secureTool(file) {
  const link = fs.lstatSync(file);
  const info = fs.statSync(file);
  return link.isFile() && !link.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0;
}

function markerPids(marker) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const env = fs.readFileSync(`/proc/${entry}/environ`).toString('utf8').split('\0');
      if (env.includes(`DMW_WSL_TEST_MARKER=${marker}`)) found.push(Number(entry));
    } catch { /* exited or not readable */ }
  }
  return found;
}

function sameProcess(pid, expectedStarttime) {
  try { return starttime(pid) === expectedStarttime; } catch { return false; }
}

function assertWorkspace(root) {
  absolute(root, 'workspace');
  const link = fs.lstatSync(root);
  if (!link.isDirectory() || link.isSymbolicLink()) fail('workspace is not a real directory', 65);
  return fs.realpathSync(root);
}

function stageWorkspace(request) {
  if (!Array.isArray(request.files) || request.files.length > 20_000) fail('invalid staged files', 64);
  const root = `/tmp/dmw-wsl-test-${crypto.randomUUID()}`;
  const workspace = `${root}/workspace`;
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const item of request.files) {
    if (!item || typeof item.path !== 'string' || item.path.startsWith('/') || item.path.includes('\\') || item.path.includes(':') || item.path.includes('\0') || item.path.split('/').some((part) => !part || part === '.' || part === '..')) fail('invalid staged path', 64);
    if (!Number.isInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || typeof item.base64 !== 'string') fail('invalid staged file', 64);
    const data = Buffer.from(item.base64, 'base64');
    if (data.length !== item.size || crypto.createHash('sha256').update(data).digest('hex') !== item.sha256) fail('staged file checksum mismatch', 65);
    const target = `${workspace}/${item.path}`;
    fs.mkdirSync(path.posix.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
  }
  return { root, workspace };
}

function verifyBindings(request) {
  const bindings = [
    [request.nodePath, request.nodeSha256], [request.bwrapPath, request.bwrapSha256],
    [request.setsidPath, request.setsidSha256], [request.unsharePath, request.unshareSha256],
  ];
  for (const [file, expected] of bindings) {
    absolute(file, 'bound tool');
    if (!/^[a-f0-9]{64}$/.test(expected ?? '') || !secureTool(file) || hashFile(file) !== expected) fail('bound tool drifted', 65);
  }
  if (!/^[a-f0-9]{64}$/.test(request.runtimeSha256 ?? '') || !/^[a-f0-9]{64}$/.test(request.hostRunnerSha256 ?? '') || !/^[a-f0-9]{64}$/.test(request.policySha256 ?? '')) fail('invalid proof binding', 65);
}

function sandboxArgs(request, executable, args, cwd = '/workspace') {
  const workspace = assertWorkspace(request.workspace);
  absolute(executable, 'executable');
  if (executable !== request.nodePath) fail('executable is not allowlisted', 65);
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string' || item.includes('\0'))) fail('invalid arguments', 64);
  if (typeof cwd !== 'string' || !(cwd === '/workspace' || cwd.startsWith('/workspace/')) || cwd.includes('\0')) fail('invalid sandbox cwd', 64);
  const env = request.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('invalid environment', 64);
  const bwrap = [
    '--unshare-all', '--die-with-parent', '--new-session', '--tmpfs', '/',
    '--dir', '/usr', '--dir', '/usr/lib', '--ro-bind', '/usr/lib', '/usr/lib',
    '--dir', '/usr/lib64', '--ro-bind-try', '/usr/lib64', '/usr/lib64',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--dir', '/opt', '--dir', '/opt/cursor-agent', '--dir', '/opt/cursor-agent/versions',
    '--dir', path.posix.dirname(request.nodePath), '--ro-bind', request.nodePath, request.nodePath,
    '--dir', '/workspace', '--bind', workspace, '/workspace',
    '--dir', '/home', '--dir', '/home/tester', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--remount-ro', '/',
    '--clearenv', '--setenv', 'HOME', '/home/tester', '--setenv', 'USER', 'tester', '--setenv', 'LOGNAME', 'tester',
    '--setenv', 'PATH', '', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'DMW_WSL_TEST_MARKER', request.marker,
  ];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) fail('invalid environment entry', 64);
    bwrap.push('--setenv', key, value);
  }
  return [...bwrap, '--chdir', cwd, '--', executable, ...args];
}

function spawnSandbox(request, executable, args, cwd) {
  const commandArgs = sandboxArgs(request, executable, args, cwd);
  const child = spawn(request.setsidPath, [request.bwrapPath, ...commandArgs], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    env: { PATH: '/usr/bin:/bin', DMW_WSL_TEST_MARKER: request.marker },
  });
  return child;
}

async function waitChild(child, timeoutMs) {
  let timer;
  const result = await new Promise((resolve) => {
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      resolve({ code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
    child.once('error', (error) => resolve({ code: null, signal: null, error: error.message, timedOut: false }));
    child.once('close', (code, signal) => resolve({ code, signal, timedOut: false }));
  });
  clearTimeout(timer);
  return result;
}

function collect(child) {
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  return { stdout, stderr };
}

async function probe(request) {
  for (const [name, file] of [['node', request.nodePath], ['bwrap', request.bwrapPath], ['setsid', request.setsidPath], ['unshare', request.unsharePath]]) {
    absolute(file, name);
    if (!secureTool(file)) fail(`${name} is missing or insecure`, 65);
  }
  const probeRoot = `/tmp/dmw-wsl-runner-probe-${crypto.randomUUID()}`;
  const workspace = `${probeRoot}/workspace`;
  const outside = `${probeRoot}/outside`;
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(`${outside}/outside-canary.txt`, 'OUTSIDE_CANARY_NON_SECRET\n', { mode: 0o600 });
  fs.writeFileSync(`${outside}/fake-auth.json`, '{"fake":true}\n', { mode: 0o600 });
  const outsideSample = `${outside}/outside-canary.txt`;
  const fakeCredentialSample = `${outside}/fake-auth.json`;
  const outsideSampleHostReadable = fs.readFileSync(outsideSample, 'utf8') === 'OUTSIDE_CANARY_NON_SECRET\n';
  const fakeCredentialSampleHostReadable = fs.readFileSync(fakeCredentialSample, 'utf8') === '{"fake":true}\n';
  const outsideWriteControl = `${outside}/outside-write-control.txt`;
  fs.writeFileSync(outsideWriteControl, 'OUTSIDE_WRITE_CONTROL\n', { mode: 0o600 });
  const outsideSampleHostWritable = fs.readFileSync(outsideWriteControl, 'utf8') === 'OUTSIDE_WRITE_CONTROL\n';
  fs.unlinkSync(outsideWriteControl);
  const server = net.createServer((socket) => { socket.on('error', () => {}); socket.end('ok'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') fail('listener address unavailable');
  const networkControlReachable = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: address.port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  const marker = safeMarker(`dmw-wsl-${crypto.randomUUID()}`);
  const base = { ...request, workspace, marker, env: {} };
  const childSource = String.raw`
    import fs from 'node:fs'; import net from 'node:net';
    const out={started:true};
    for(const [key,file] of [['outsideReadDenied',${JSON.stringify(outsideSample)}],['fakeCredentialReadDenied',${JSON.stringify(fakeCredentialSample)}]]){try{fs.readFileSync(file);out[key]=false}catch{out[key]=true}}
    try{fs.writeFileSync(${JSON.stringify(`${outside}/child-outside-write.txt`)},'bad');out.outsideWriteDenied=false}catch{out.outsideWriteDenied=true}
    out.networkDenied=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:${address.port}});const done=v=>{s.destroy();resolve(v)};s.setTimeout(800,()=>done(true));s.once('connect',()=>done(false));s.once('error',()=>done(true))});
    process.stdout.write(JSON.stringify(out));`;
  const canarySource = String.raw`
    import fs from 'node:fs'; import net from 'node:net'; import {spawnSync} from 'node:child_process';
    const result={}; fs.writeFileSync('/workspace/positive.txt','ok'); result.positive=fs.readFileSync('/workspace/positive.txt','utf8')==='ok';
    for (const [key,file] of [['outsideRead',${JSON.stringify(outsideSample)}],['fakeCredentialRead',${JSON.stringify(fakeCredentialSample)}]]) { try { fs.readFileSync(file); result[key]=false; } catch { result[key]=true; } }
    try { fs.writeFileSync(${JSON.stringify(`${outside}/outside-write.txt`)},'bad'); result.outsideWrite=false; } catch { result.outsideWrite=true; }
    const shell=spawnSync('/bin/sh',['-c','echo escaped']); result.subprocessEscape=Boolean(shell.error)&&shell.error.code==='ENOENT';
    result.networkDenied=await new Promise((resolve)=>{const s=net.connect({host:'127.0.0.1',port:${address.port}}); const done=(v)=>{s.destroy();resolve(v)};s.setTimeout(800,()=>done(true));s.once('connect',()=>done(false));s.once('error',()=>done(true));});
    const nested=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(childSource)}],{encoding:'utf8',timeout:5000});
    try{result.child=JSON.parse(nested.stdout);result.childProcessWorks=nested.status===0&&result.child.started===true}catch{result.childProcessWorks=false}
    process.stdout.write(JSON.stringify(result));`;
  const child = spawnSandbox(base, request.nodePath, ['--input-type=module', '-e', canarySource]);
  const childStarttime = starttime(child.pid);
  const output = collect(child);
  const run = await waitChild(child, 10_000);
  let canaries = {};
  try { canaries = JSON.parse(Buffer.concat(output.stdout).toString('utf8')); } catch { /* fail below */ }
  const remaining = markerPids(marker);
  const normalNamespaceGone = !sameProcess(child.pid, childStarttime);

  const earlyMarker = safeMarker(`dmw-wsl-${crypto.randomUUID()}`);
  const earlyWorkspace = `${probeRoot}/early-workspace`;
  fs.mkdirSync(earlyWorkspace, { mode: 0o700 });
  const earlyBase = { ...request, workspace: earlyWorkspace, marker: earlyMarker, env: {} };
  const earlySource = String.raw`
    import fs from 'node:fs'; import {spawn} from 'node:child_process';
    const nested=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});nested.unref();
    fs.writeFileSync('/workspace/child-ready.txt',String(nested.pid));await new Promise(r=>setTimeout(r,100));`;
  const early = spawnSandbox(earlyBase, request.nodePath, ['--input-type=module', '-e', earlySource]);
  const earlyStarttime = starttime(early.pid);
  const earlyOutput = collect(early);
  const earlyRun = await waitChild(early, 8_000);
  const earlyChildStarted = fs.existsSync(`${earlyWorkspace}/child-ready.txt`) && Number(fs.readFileSync(`${earlyWorkspace}/child-ready.txt`, 'utf8')) > 1;
  const earlyParentTreeTerminationConfirmed = earlyRun.code === 0 && earlyChildStarted && !sameProcess(early.pid, earlyStarttime) && markerPids(earlyMarker).length === 0;

  const cancelMarker = safeMarker(`dmw-wsl-${crypto.randomUUID()}`);
  const cancelWorkspace = `${probeRoot}/cancel-workspace`;
  fs.mkdirSync(cancelWorkspace, { mode: 0o700 });
  const cancelBase = { ...request, workspace: cancelWorkspace, marker: cancelMarker, env: {} };
  const cancelSource = String.raw`
    import fs from 'node:fs'; import {spawn} from 'node:child_process';
    const nested=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});nested.unref();
    fs.writeFileSync('/workspace/child-ready.txt',String(nested.pid));setInterval(()=>{},1000);`;
  const cancel = spawnSandbox(cancelBase, request.nodePath, ['--input-type=module', '-e', cancelSource]);
  const cancelStarttime = starttime(cancel.pid);
  collect(cancel);
  for (let i = 0; i < 30 && !fs.existsSync(`${cancelWorkspace}/child-ready.txt`); i += 1) await sleep(50);
  const cancelChildStarted = fs.existsSync(`${cancelWorkspace}/child-ready.txt`) && Number(fs.readFileSync(`${cancelWorkspace}/child-ready.txt`, 'utf8')) > 1;
  const cancelWait = waitChild(cancel, 8_000);
  try { process.kill(-cancel.pid, 'SIGTERM'); } catch { /* already gone */ }
  await sleep(500);
  if (sameProcess(cancel.pid, cancelStarttime)) {
    try { process.kill(-cancel.pid, 'SIGKILL'); } catch { try { process.kill(cancel.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  const cancelRun = await cancelWait;
  const cancelTreeTerminationConfirmed = cancelChildStarted && !cancelRun.timedOut && !sameProcess(cancel.pid, cancelStarttime) && markerPids(cancelMarker).length === 0;
  server.close();

  const childCanaries = canaries.child ?? {};
  const complete = run.code === 0 && !run.timedOut && normalNamespaceGone && remaining.length === 0 &&
    outsideSampleHostReadable && outsideSampleHostWritable && fakeCredentialSampleHostReadable && networkControlReachable && earlyParentTreeTerminationConfirmed && cancelTreeTerminationConfirmed &&
    ['positive', 'outsideRead', 'outsideWrite', 'fakeCredentialRead', 'networkDenied', 'subprocessEscape', 'childProcessWorks'].every((key) => canaries[key] === true) &&
    ['started', 'outsideReadDenied', 'fakeCredentialReadDenied', 'outsideWriteDenied', 'networkDenied'].every((key) => childCanaries[key] === true);
  if (remaining.length === 0 && markerPids(earlyMarker).length === 0 && markerPids(cancelMarker).length === 0) fs.rmSync(probeRoot, { recursive: true, force: false });
  const proof = {
    version: 1, platform: 'linux', distro: request.distro, verified: complete,
    verifiedAt: new Date().toISOString(), nodePath: request.nodePath, nodeSha256: hashFile(request.nodePath),
    bwrapPath: request.bwrapPath, bwrapSha256: hashFile(request.bwrapPath), setsidPath: request.setsidPath,
    setsidSha256: hashFile(request.setsidPath), unsharePath: request.unsharePath, unshareSha256: hashFile(request.unsharePath),
    runtimeSha256: request.runtimeSha256, hostRunnerSha256: request.hostRunnerSha256, policySha256: request.policySha256,
    positiveWrite: canaries.positive === true, outsideReadDenied: canaries.outsideRead === true,
    outsideWriteDenied: canaries.outsideWrite === true, fakeCredentialReadDenied: canaries.fakeCredentialRead === true,
    networkDenied: canaries.networkDenied === true, subprocessEscapeDenied: canaries.subprocessEscape === true,
    outsideSampleHostReadable, outsideSampleHostWritable, fakeCredentialSampleHostReadable, networkControlReachable,
    childProcessWorks: canaries.childProcessWorks === true && childCanaries.started === true,
    childOutsideReadDenied: childCanaries.outsideReadDenied === true, childFakeCredentialReadDenied: childCanaries.fakeCredentialReadDenied === true,
    childOutsideWriteDenied: childCanaries.outsideWriteDenied === true, childNetworkDenied: childCanaries.networkDenied === true,
    normalTreeTerminationConfirmed: normalNamespaceGone && remaining.length === 0,
    earlyParentTreeTerminationConfirmed, cancelTreeTerminationConfirmed,
    diagnostics: complete ? undefined : JSON.stringify({
      mainRun: run, mainRemaining: remaining, normalNamespaceGone, earlyRun, earlyChildStarted,
      earlyRemaining: markerPids(earlyMarker), cancelRun, cancelChildStarted, cancelRemaining: markerPids(cancelMarker),
      stderr: [Buffer.concat(output.stderr), Buffer.concat(earlyOutput.stderr)].map((value) => value.toString('utf8')).join('\n').slice(-2000),
    }).slice(-4000),
  };
  process.stdout.write(JSON.stringify(proof));
  process.exit(complete ? 0 : 71);
}

async function run(request) {
  verifyBindings(request);
  safeMarker(request.marker);
  const staged = stageWorkspace(request);
  request.workspace = staged.workspace;
  const child = spawnSandbox(request, request.executable, request.args, request.cwd);
  const childStarttime = starttime(child.pid);
  let started = false;
  child.once('spawn', () => {
    started = true;
    process.stdout.write(`${JSON.stringify({ type: 'started', pid: child.pid, starttime: childStarttime, marker: request.marker, stagedRoot: staged.root })}\n`);
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`${JSON.stringify({ type: 'stdout', base64: Buffer.from(chunk).toString('base64') })}\n`));
  child.stderr.on('data', (chunk) => process.stdout.write(`${JSON.stringify({ type: 'stderr', base64: Buffer.from(chunk).toString('base64') })}\n`));
  const result = await waitChild(child, request.timeoutMs);
  await sleep(100);
  const remaining = markerPids(request.marker).filter((pid) => pid !== process.pid);
  const namespaceGone = !sameProcess(child.pid, childStarttime);
  process.stdout.write(`${JSON.stringify({ type: 'exit', ...result, started, namespaceGone, treeConfirmed: namespaceGone && remaining.length === 0, remaining })}\n`);
  if (namespaceGone && remaining.length === 0) fs.rmSync(staged.root, { recursive: true, force: false });
  process.exit(result.code === null ? 72 : result.code);
}

async function control(request) {
  verifyBindings(request);
  const marker = safeMarker(request.marker);
  if (!Number.isInteger(request.pid) || typeof request.starttime !== 'string') fail('invalid process identity', 64);
  const before = markerPids(marker).filter((pid) => pid !== process.pid);
  if (sameProcess(request.pid, request.starttime)) {
    try { process.kill(-request.pid, 'SIGTERM'); } catch { try { process.kill(request.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  for (let i = 0; i < 30 && markerPids(marker).some((pid) => pid !== process.pid); i += 1) await sleep(100);
  let remaining = markerPids(marker).filter((pid) => pid !== process.pid);
  for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 20 && markerPids(marker).some((pid) => pid !== process.pid); i += 1) await sleep(100);
  remaining = markerPids(marker).filter((pid) => pid !== process.pid);
  const confirmed = remaining.length === 0 && !sameProcess(request.pid, request.starttime);
  if (confirmed && typeof request.stagedRoot === 'string' && /^\/tmp\/dmw-wsl-test-[a-f0-9-]{36}$/.test(request.stagedRoot) && fs.existsSync(request.stagedRoot)) {
    const info = fs.lstatSync(request.stagedRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('invalid cleanup root', 74);
    fs.rmSync(request.stagedRoot, { recursive: true, force: false });
  }
  process.stdout.write(JSON.stringify({ confirmed, before, remaining }));
  process.exit(confirmed ? 0 : 72);
}

const request = await stdinJson();
if (request.mode === 'probe') await probe(request);
else if (request.mode === 'run') await run(request);
else if (request.mode === 'control') await control(request);
else fail('unknown mode', 64);
