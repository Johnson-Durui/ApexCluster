import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const mode = process.argv[1];
const encoded = process.argv[2] ?? '';
const markerArg = process.argv[3] ?? '';
const request = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : {};
const ROOT_RE = /^\/home\/codex\/\.dual-model-workbench\/writer-[0-9a-f-]{36}$/;
const MARKER_RE = /^DMW_CURSOR_[A-Z0-9_]{16,100}$/;

function fail(message, code = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function assertRoot(root) {
  if (typeof root !== 'string' || !ROOT_RE.test(root)) fail('invalid writer root');
  return root;
}

function assertMarker(marker) {
  if (typeof marker !== 'string' || !MARKER_RE.test(marker)) fail('invalid run marker');
  return marker;
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) fail('invalid relative file');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('node_modules') || normalized.split('/').includes('.git')) fail('unsafe relative file');
  return normalized;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function starttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return tail[19] ?? null;
  } catch {
    return null;
  }
}

function sameProcess(pid, expected) {
  return Number.isSafeInteger(pid) && pid > 1 && typeof expected === 'string' && starttime(pid) === expected;
}

function markerPids(marker) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      let marked = args.includes(marker);
      if (!marked) {
        try {
          const environment = fs.readFileSync(`/proc/${entry}/environ`).toString('utf8').split('\0').filter(Boolean);
          marked = environment.includes(`DMW_CURSOR_RUN_MARKER=${marker}`);
        } catch { /* inaccessible or exited */ }
      }
      if (marked) found.push(Number(entry));
    } catch { /* process exited */ }
  }
  return found;
}

function safeEnv(extra = {}) {
  return {
    HOME: '/home/codex', USER: 'codex', LOGNAME: 'codex', SHELL: '/bin/sh',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...extra,
  };
}

function secureRootExecutable(file) {
  const link = fs.lstatSync(file);
  const info = fs.statSync(file);
  return !link.isSymbolicLink() && info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0;
}

function securePrivateDirectory(directory) {
  const link = fs.lstatSync(directory);
  const info = fs.statSync(directory);
  return !link.isSymbolicLink() && info.isDirectory() && info.uid === (process.getuid?.() ?? -1) && (info.mode & 0o077) === 0;
}

function resolveResolvConf(fileSystem = fs) {
  const source = '/etc/resolv.conf';
  const sourceInfo = fileSystem.lstatSync(source);
  const safe = (info) => info.isFile() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0;
  if (sourceInfo.isSymbolicLink()) {
    const target = fileSystem.realpathSync(source);
    if (target !== '/mnt/wsl/resolv.conf') throw new Error('unexpected WSL resolv.conf target');
    if (!safe(fileSystem.lstatSync(target))) throw new Error('unsafe WSL resolv.conf target');
    return { sourcePath: target, sandboxPath: target, mountOption: '--file', layout: 'wsl-symlink-v1' };
  }
  if (!safe(sourceInfo)) throw new Error('unsafe WSL resolv.conf regular file');
  return { sourcePath: source, sandboxPath: source, mountOption: '--ro-bind-data', layout: 'root-regular-v2' };
}

function ensureNoDrvfs() {
  const mounts = fs.readFileSync('/proc/mounts', 'utf8');
  return !mounts.split('\n').some((line) => /\sdrvfs\s/.test(line));
}

function confDisabled(text, section, key) {
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { current = heading[1].toLowerCase(); continue; }
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (pair && current === section && pair[1].trim().toLowerCase() === key) return pair[2].trim().toLowerCase() === 'false';
  }
  return false;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function probe() {
  const nodePath = request.nodePath;
  const entryPath = request.entryPath;
  const bwrapPath = request.bwrapPath;
  const setsidPath = request.setsidPath;
  if (![nodePath, entryPath, bwrapPath, setsidPath].every((file) => typeof file === 'string' && path.posix.isAbsolute(file))) fail('invalid executable paths');
  const conf = fs.readFileSync('/etc/wsl.conf', 'utf8');
  const versionProfile = `/tmp/dmw-cursor-version-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(versionProfile, { mode: 0o700 });
  let version;
  try {
    const result = spawnSync(nodePath, [entryPath, '--version'], { encoding: 'utf8', env: safeEnv({ CURSOR_CONFIG_DIR: versionProfile }), timeout: 15_000 });
    if (result.status !== 0 || result.error) fail(`version check failed: ${result.error?.message ?? result.stderr ?? result.status}`);
    version = String(result.stdout).trim().split(/\r?\n/)[0] ?? '';
  } finally {
    fs.rmSync(versionProfile, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({
    uid: process.getuid?.() ?? -1,
    machineId: fs.readFileSync('/etc/machine-id', 'utf8').trim(),
    kernel: os.release(), nodeSha256: sha256(nodePath), entrySha256: sha256(entryPath),
    bwrapSha256: sha256(bwrapPath), setsidSha256: sha256(setsidPath),
    bwrapSecure: secureRootExecutable(bwrapPath), setsidSecure: secureRootExecutable(setsidPath), version,
    automountDisabled: confDisabled(conf, 'automount', 'enabled'),
    interopDisabled: confDisabled(conf, 'interop', 'enabled'),
    drvfsAbsent: ensureNoDrvfs(),
  }));
}

async function setup() {
  const root = assertRoot(request.root);
  const input = JSON.parse((await readStdin()).toString('utf8'));
  if (!Array.isArray(input.files) || input.files.length > 5) fail('invalid staged file count');
  fs.mkdirSync(path.posix.dirname(root), { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  for (const name of ['workspace', 'profile', 'project-state']) fs.mkdirSync(`${root}/${name}`, { mode: 0o700 });
  fs.mkdirSync(`${root}/workspace/.cursor`, { mode: 0o700 });
  const controlled = input.files.map((item) => `/workspace/${relativeFile(item.path)}`);
  const policy = { sandbox: { readBoundary: 'workspace' }, permissions: { allow: controlled.flatMap((file) => [`Read(${file})`, `Write(${file})`]), deny: [
    'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)',
    'Read(/workspace/.cursor/**)', 'Write(/workspace/.cursor/**)',
    'Read(/cursor-profile/**)', 'Write(/cursor-profile/**)',
    'Read(/home/codex/.cursor/**)', 'Write(/home/codex/.cursor/**)',
    'Read(/home/**)', 'Write(/home/**)', 'Read(/root/**)', 'Write(/root/**)',
    'Read(/proc/**)', 'Write(/proc/**)', 'Read(/tmp/**)', 'Write(/tmp/**)',
    'Read(/etc/**)', 'Write(/etc/**)', 'Read(/usr/**)', 'Write(/usr/**)',
    'Read(/opt/**)', 'Write(/opt/**)', 'Read(/bin/**)', 'Write(/bin/**)',
    'Read(/sbin/**)', 'Write(/sbin/**)', 'Read(/lib/**)', 'Write(/lib/**)',
    'Read(/lib64/**)', 'Write(/lib64/**)', 'Read(/dev/**)', 'Write(/dev/**)',
    'Read(/run/**)', 'Write(/run/**)', 'Read(/sys/**)', 'Write(/sys/**)',
    'Read(/var/**)', 'Write(/var/**)', 'Read(/mnt/**)', 'Write(/mnt/**)',
  ] } };
  const projectPolicy = `${JSON.stringify(policy, null, 2)}\n`;
  const profilePolicy = `${JSON.stringify({ version: 1, editor: { vimMode: false }, autoAcceptWebSearch: false, ...policy }, null, 2)}\n`;
  fs.writeFileSync(`${root}/workspace/.cursor/cli.json`, projectPolicy, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(`${root}/profile/cli-config.json`, profilePolicy, { flag: 'wx', mode: 0o600 });
  for (const item of input.files) {
    const rel = relativeFile(item.path);
    const data = Buffer.from(item.base64, 'base64');
    if (data.length !== item.size || crypto.createHash('sha256').update(data).digest('hex') !== item.sha256) fail('staged content checksum mismatch');
    const target = `${root}/workspace/${rel}`;
    fs.mkdirSync(path.posix.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ root, policySha256: sha256(`${root}/workspace/.cursor/cli.json`) }));
}

function writeControl(file, value) {
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}

async function run() {
  const root = assertRoot(request.root);
  const marker = assertMarker(markerArg);
  if (request.marker !== marker) fail('marker mismatch');
  const authStore = '/home/codex/.config/cursor';
  if (!securePrivateDirectory(authStore)) fail('Cursor auth store ownership or mode is unsafe');
  const workspace = `${root}/workspace`;
  const profile = `${root}/profile`;
  const projectState = `${root}/project-state`;
  let resolv;
  try { resolv = resolveResolvConf(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  const args = [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--tmpfs', '/', '--dir', '/usr', '--ro-bind', '/usr', '/usr', '--dir', '/bin', '--ro-bind', '/bin', '/bin',
    '--dir', '/sbin', '--ro-bind', '/sbin', '/sbin', '--dir', '/lib', '--ro-bind', '/lib', '/lib',
    '--dir', '/lib64', '--ro-bind', '/lib64', '/lib64', '--dir', '/etc', '--ro-bind', '/etc', '/etc',
    '--dir', '/mnt', '--dir', '/mnt/wsl', resolv.mountOption, '3', resolv.sandboxPath,
    '--dir', '/opt', '--ro-bind', '/opt', '/opt',
    '--dir', '/workspace', '--dir', '/cursor-profile',
    '--bind', workspace, '/workspace', '--bind', profile, '/cursor-profile',
    '--dir', '/home', '--dir', '/home/codex', '--dir', '/home/codex/.config', '--dir', '/home/codex/.config/cursor',
    '--ro-bind', authStore, '/home/codex/.config/cursor', '--dir', '/home/codex/.cursor', '--bind', projectState, '/home/codex/.cursor',
    '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--remount-ro', '/', '--clearenv',
    '--setenv', 'HOME', '/home/codex', '--setenv', 'USER', 'codex', '--setenv', 'LOGNAME', 'codex',
    '--setenv', 'SHELL', '/bin/sh', '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8', '--setenv', 'CURSOR_CONFIG_DIR', '/cursor-profile',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'NODE_COMPILE_CACHE', '/tmp/compile-cache', '--setenv', 'DMW_CURSOR_RUN_MARKER', marker,
    '--', request.nodePath, request.entryPath, '--print', '--output-format', 'stream-json', '--sandbox', 'enabled',
    '--trust', '--model', 'grok-4.7-high-fast', '--workspace', '/workspace',
  ];
  const resolvFd = fs.openSync(resolv.sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const openedResolv = fs.fstatSync(resolvFd);
  if (!openedResolv.isFile() || openedResolv.uid !== 0 || (openedResolv.mode & 0o022) !== 0) {
    fs.closeSync(resolvFd); fail('unsafe opened WSL resolv.conf');
  }
  let child;
  try {
    child = spawn(request.bwrapPath, args, { stdio: ['pipe', 'inherit', 'inherit', resolvFd], env: safeEnv({ DMW_CURSOR_RUN_MARKER: marker }), detached: false });
  } finally {
    fs.closeSync(resolvFd);
  }
  const control = { marker, supervisorPid: process.pid, supervisorStarttime: starttime(process.pid), bwrapPid: child.pid, bwrapStarttime: starttime(child.pid), root };
  writeControl(`${root}/control.json`, control);
  let stopping = false;
  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    if (sameProcess(control.bwrapPid, control.bwrapStarttime)) child.kill(signal);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));
  process.stdin.pipe(child.stdin);
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 70, error }));
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 71 : 72), signal }));
  });
  fs.writeFileSync(`${root}/supervisor-exit.json`, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  process.exit(result.code);
}

async function control() {
  const root = assertRoot(request.root);
  const marker = assertMarker(request.marker);
  const file = `${root}/control.json`;
  if (!fs.existsSync(file)) fail('control record missing', 65);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.root !== root || record.marker !== marker) fail('control record mismatch', 66);
  const before = markerPids(marker);
  if (sameProcess(record.supervisorPid, record.supervisorStarttime)) process.kill(record.supervisorPid, 'SIGTERM');
  const waitUntil = async (predicate, attempts) => {
    for (let i = 0; i < attempts; i += 1) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 100)); }
    return predicate();
  };
  await waitUntil(() => !sameProcess(record.supervisorPid, record.supervisorStarttime) && !sameProcess(record.bwrapPid, record.bwrapStarttime) && markerPids(marker).length === 0, 30);
  if (sameProcess(record.bwrapPid, record.bwrapStarttime)) process.kill(record.bwrapPid, 'SIGTERM');
  await waitUntil(() => !sameProcess(record.bwrapPid, record.bwrapStarttime) && markerPids(marker).length === 0, 20);
  if (sameProcess(record.bwrapPid, record.bwrapStarttime)) process.kill(record.bwrapPid, 'SIGKILL');
  if (sameProcess(record.supervisorPid, record.supervisorStarttime)) process.kill(record.supervisorPid, 'SIGKILL');
  await waitUntil(() => markerPids(marker).length === 0, 20);
  const remaining = markerPids(marker);
  const confirmed = remaining.length === 0 && !sameProcess(record.supervisorPid, record.supervisorStarttime) && !sameProcess(record.bwrapPid, record.bwrapStarttime);
  process.stdout.write(JSON.stringify({ confirmed, before, remaining, supervisorGone: !sameProcess(record.supervisorPid, record.supervisorStarttime), bwrapGone: !sameProcess(record.bwrapPid, record.bwrapStarttime) }));
  process.exit(confirmed ? 0 : 72);
}

function walk(directory, prefix = '') {
  const result = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = `${directory}/${name}`;
    const info = fs.lstatSync(full);
    if (info.isSymbolicLink()) result.push({ path: rel, type: 'symlink' });
    else if (info.isDirectory()) result.push(...walk(full, rel));
    else if (info.isFile()) {
      const data = fs.readFileSync(full);
      result.push({ path: rel, type: 'file', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), base64: data.toString('base64') });
    } else result.push({ path: rel, type: 'other' });
  }
  return result;
}

async function inspect() {
  const root = assertRoot(request.root);
  process.stdout.write(JSON.stringify({ files: walk(`${root}/workspace`) }));
}

async function cleanup() {
  const root = assertRoot(request.root);
  if (markerPids(assertMarker(request.marker)).length) fail('marked process remains', 73);
  const removed = [];
  for (const name of ['profile', 'project-state']) {
    const target = `${root}/${name}`;
    if (!fs.existsSync(target)) continue;
    const info = fs.lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('cleanup target type mismatch', 74);
    fs.rmSync(target, { recursive: true, force: false });
    removed.push(target);
  }
  process.stdout.write(JSON.stringify({ removed }));
}

if (mode === 'probe') await probe();
else if (mode === 'setup') await setup();
else if (mode === 'run') await run();
else if (mode === 'control') await control();
else if (mode === 'snapshot') await inspect();
else if (mode === 'cleanup') await cleanup();
else fail('unknown runtime mode');
