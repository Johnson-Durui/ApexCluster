import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerBackend, dockerRunArgs } from '../src/exec/docker.js';
import { LocalUnsafeExecBackend } from '../src/exec/local-unsafe.js';
import { EXEC_OUTPUT_LIMIT_BYTES } from '../src/exec/output-limit.js';
import { assertImmutableImage, installNetworkAllowed, parseExecSpec } from '../src/exec/policy.js';

const image = 'sha256:' + 'a'.repeat(64);

test('Docker exec policy accepts argv but rejects shell-shaped input, traversal, and ambient secrets', () => {
  assert.deepEqual(parseExecSpec({ argv: ['node', '-v'], cwd: '.', timeoutMs: 1_000, env: { CI: '1' } }), {
    argv: ['node', '-v'], cwd: '.', timeoutMs: 1_000, env: { CI: '1' },
  });
  assert.throws(() => parseExecSpec({ command: 'node -v', cwd: '.', timeoutMs: 1_000 }), /argv/);
  assert.throws(() => parseExecSpec({ argv: ['node'], cwd: '../outside', timeoutMs: 1_000 }), /相对路径|离开/);
  assert.throws(() => parseExecSpec({ argv: ['node'], cwd: 'C:\\host', timeoutMs: 1_000 }), /相对路径/);
  assert.throws(() => parseExecSpec({ argv: ['node'], cwd: '.', timeoutMs: 1_000, env: { API_TOKEN: 'canary' } }), /白名单/);
});

test('only an install-purpose package manager can receive install networking', () => {
  const npmInstall = parseExecSpec({ argv: ['npm', 'ci'], cwd: '.', timeoutMs: 1_000, purpose: 'install' });
  const npmTest = parseExecSpec({ argv: ['npm', 'test'], cwd: '.', timeoutMs: 1_000, purpose: 'test' });
  const nodeInstall = parseExecSpec({ argv: ['node', 'install.js'], cwd: '.', timeoutMs: 1_000, purpose: 'install' });
  assert.equal(installNetworkAllowed(npmInstall, true), true);
  assert.equal(installNetworkAllowed(npmTest, true), false);
  assert.equal(installNetworkAllowed(nodeInstall, true), false);
  assert.equal(installNetworkAllowed(npmInstall, false), false);
});

test('Docker configuration requires an immutable image and emits a bounded task-only run', () => {
  assert.equal(assertImmutableImage(image), image);
  assert.throws(() => assertImmutableImage('node:latest'), /固定/);
  const args = dockerRunArgs(
    { image, packageCacheVolume: 'dmw-cache', installNetwork: true },
    { argv: ['node', 'script.js'], cwd: '.', timeoutMs: 1_000, purpose: 'run', env: { CI: '1' } },
    'C:\\owned-copy', '/workspace', 'dmw-exec-unit',
  );
  const flattened = args.join(' ');
  assert.match(flattened, /--network none/);
  assert.match(flattened, /--pull never/);
  assert.match(flattened, /--read-only/);
  assert.match(flattened, /--cap-drop ALL/);
  assert.match(flattened, /no-new-privileges=true/);
  assert.match(flattened, /type=bind,src=C:\\owned-copy,dst=\/workspace/);
  assert.match(flattened, /type=volume,src=dmw-cache,dst=\/cache/);
  assert.doesNotMatch(flattened, /docker\.sock|Users[\\/]local-profile|type=bind[^ ]+dst=\/cache/);

  const installArgs = dockerRunArgs(
    { image, packageCacheVolume: 'dmw-cache', installNetwork: true },
    { argv: ['npm', 'ci'], cwd: '.', timeoutMs: 1_000, purpose: 'install' },
    'C:\\owned-copy', '/workspace', 'dmw-exec-install',
  );
  assert.match(installArgs.join(' '), /--network bridge/);
});

function fakeDocker(root: string): string {
  const script = path.join(root, 'fake-docker.mjs');
  writeFileSync(script, `
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [state, image, ...raw] = process.argv.slice(2);
if (process.env.DMW_DOCKER_CLI_API_KEY) process.exit(77);
const args = raw[0] === '--host' ? raw.slice(2) : raw;
const safe = value => value.replace(/[^a-zA-Z0-9_.-]/g, '_');
if (args[0] === 'context' && args[1] === 'inspect') { console.log('npipe:////./pipe/dmw-offline-fixture'); process.exit(0); }
if (args[0] === 'volume' && args[1] === 'inspect') { console.log(args.at(-1) === 'dmw-unowned-cache' ? '' : 'exec-v1'); process.exit(0); }
if (args[0] === 'version') { console.log(JSON.stringify({ Os: 'linux' })); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') { console.log(JSON.stringify({ Id: image, RepoDigests: [] })); process.exit(0); }
if (args[0] === 'container' && args[1] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const running = path.join(state, safe(name) + '.running');
  const stopped = path.join(state, safe(name) + '.stop');
  writeFileSync(path.join(state, 'last-run.json'), JSON.stringify(args));
  writeFileSync(running, '1');
  if (args.at(-1) === 'hang') {
    const poll = setInterval(() => {
      if (existsSync(stopped) || !existsSync(running)) { clearInterval(poll); rmSync(running, { force: true }); process.exit(143); }
    }, 10);
    await new Promise(() => {});
  } else {
    console.log('fake stdout'); console.error('fake stderr'); rmSync(running, { force: true }); process.exit(0);
  }
}
if (args[0] === 'container' && args[1] === 'stop') {
  const name = args.at(-1); writeFileSync(path.join(state, safe(name) + '.stop'), '1'); rmSync(path.join(state, safe(name) + '.running'), { force: true }); process.exit(0);
}
if (args[0] === 'container' && args[1] === 'kill') {
  const name = args.at(-1); rmSync(path.join(state, safe(name) + '.running'), { force: true }); process.exit(0);
}
if (args[0] === 'container' && args[1] === 'inspect') {
  const name = args.at(-1);
  if (existsSync(path.join(state, safe(name) + '.running'))) { console.log('{}'); process.exit(0); }
  console.error('Error: No such object: ' + name); process.exit(1);
}
console.error('unexpected fake Docker args', args); process.exit(2);
`);
  return script;
}

function tempContext(root: string, signal: AbortSignal) {
  const copyDir = path.join(root, 'copy');
  const outputDir = path.join(root, 'output-' + Math.random().toString(16).slice(2));
  mkdirSync(copyDir, { recursive: true });
  return { copyDir, outputDir, signal };
}

test('Docker backend probes the fixed image and captures output through an argv-only CLI', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-fake-docker-'));
  const previousCanary = process.env.DMW_DOCKER_CLI_API_KEY;
  try {
    process.env.DMW_DOCKER_CLI_API_KEY = 'never-in-child-environment';
    const script = fakeDocker(root);
    const backend = new DockerBackend({
      image, packageCacheVolume: 'dmw-unit-cache',
      dockerCommand: { file: process.execPath, prefixArgs: [script, root, image] },
    });
    assert.deepEqual(await backend.probe(), { ok: true });
    const context = tempContext(root, new AbortController().signal);
    const result = await backend.run(
      { argv: ['node', '-e', 'ok'], cwd: '.', timeoutMs: 2_000, purpose: 'test' },
      context,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.network, 'none');
    assert.match(readFileSync(path.join(context.outputDir, result.stdoutRef), 'utf8'), /fake stdout/);
    assert.match(readFileSync(path.join(context.outputDir, result.stderrRef), 'utf8'), /fake stderr/);
  } finally {
    if (previousCanary === undefined) delete process.env.DMW_DOCKER_CLI_API_KEY;
    else process.env.DMW_DOCKER_CLI_API_KEY = previousCanary;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Docker sandbox rejects a remote daemon before it can bind the authorized path', async () => {
  const value = process.env.DOCKER_HOST;
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-remote-docker-'));
  try {
    process.env.DOCKER_HOST = 'tcp://192.0.2.5:2375';
    const backend = new DockerBackend({ image, packageCacheVolume: 'dmw-unit-cache' });
    assert.equal((await backend.probe()).ok, false);
    await assert.rejects(backend.run({ argv: ['node', '-v'], cwd: '.', timeoutMs: 1_000 }, tempContext(root, new AbortController().signal)), /只允许本机/);
  } finally {
    if (value === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = value;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Docker backend confirms exact-name cancellation cleanup', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-fake-docker-cancel-'));
  try {
    const script = fakeDocker(root);
    const otherContainer = path.join(root, `dmw-exec-${'1'.repeat(32)}.running`);
    writeFileSync(otherContainer, '1');
    const controller = new AbortController();
    const context = tempContext(root, controller.signal);
    const backend = new DockerBackend({
      image, packageCacheVolume: 'dmw-unit-cache',
      dockerCommand: { file: process.execPath, prefixArgs: [script, root, image] },
    });
    setTimeout(() => controller.abort(), 500);
    const result = await backend.run({ argv: ['hang'], cwd: '.', timeoutMs: 5_000 }, context);
    assert.equal(result.cancelled, true, JSON.stringify(result));
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.timedOut, false);
    assert.match(readFileSync(path.join(root, 'last-run.json'), 'utf8'), /dmw-exec-/);
    assert.equal(readFileSync(otherContainer, 'utf8'), '1', 'unrelated container is still running');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local unsafe backend shares the combined output cap and reports unconfirmed descendants', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-local-output-limit-'));
  try {
    const context = tempContext(root, new AbortController().signal);
    const backend = new LocalUnsafeExecBackend();
    const result = await backend.run({
      argv: [process.execPath, '-e', "const b=Buffer.alloc(65536,120);setInterval(()=>{process.stdout.write(b);process.stderr.write(b)},0)"],
      cwd: '.', timeoutMs: 10_000, purpose: 'test',
    }, context);
    const captured = statSync(result.stdoutRef).size + statSync(result.stderrRef).size;
    assert.equal(result.outputLimited, true);
    assert.equal(result.exitConfirmed, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(captured, EXEC_OUTPUT_LIMIT_BYTES);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const realImage = process.env.DMW_DOCKER_SANDBOX_IMAGE;
test('Docker refuses root execution, omitted resource boundaries, and unowned named cache volumes', async () => {
  assert.throws(() => new DockerBackend({ image, packageCacheVolume: 'dmw-unit-cache', user: '0:0' }), /非 root/);
  assert.throws(() => new DockerBackend({ image, packageCacheVolume: 'dmw-unit-cache', memory: '0m' }), /至少为 6 MiB/);
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-unowned-docker-'));
  try {
    const script = fakeDocker(root);
    const backend = new DockerBackend({ image, packageCacheVolume: 'dmw-unowned-cache',
      dockerCommand: { file: process.execPath, prefixArgs: [script, root, image] } });
    assert.match((await backend.probe()).reason ?? '', /所有权标签/);
    await assert.rejects(backend.run({ argv: ['node', '-v'], cwd: '.', timeoutMs: 1000 }, tempContext(root, new AbortController().signal)), /所有权标签/);
    assert.equal(existsSync(path.join(root, 'last-run.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real Docker sandbox isolates host, env, network, and confirms timeout cleanup', { skip: realImage ? false : 'set DMW_DOCKER_SANDBOX_IMAGE to an immutable local image ID' }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-real-docker-'));
  const suffix = randomUUID().replaceAll('-', '');
  const volume = 'dmw-real-cache-' + suffix;
  const ownerLabel = 'com.dual-model-workbench.owner=exec-v1';
  const volumeLabel = 'com.dual-model-workbench.fixture=m5-real';
  const listed = () => execFileSync('docker', ['container', 'ls', '-a',
    '--filter', 'label=' + ownerLabel, '--filter', 'volume=' + volume, '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  let ownedVolume = false;
  try {
    const backend = new DockerBackend({ image: realImage!, packageCacheVolume: volume, user: '10001:10001', installNetwork: true });
    const probe = await backend.probe();
    if (!probe.ok) { t.skip('Docker unavailable: ' + probe.reason); return; }
    assert.throws(() => execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }));
    execFileSync('docker', ['volume', 'create', '--label', volumeLabel, '--label', ownerLabel, volume], { stdio: 'ignore' });
    ownedVolume = true;
    assert.deepEqual(listed(), []);
    const copyDir = path.join(root, 'copy');
    mkdirSync(copyDir);
    writeFileSync(path.join(copyDir, 'inside.txt'), 'inside-only');
    const canaryName = 'DMW_HOST_SECRET_CANARY';
    process.env[canaryName] = 'must-not-enter-container';

    const context = (name: string) => ({ copyDir, outputDir: path.join(root, name), signal: new AbortController().signal });
    const isolation = await backend.run({
      argv: ['node', '-e', `const fs=require('fs');if(process.env.${canaryName})process.exit(7);console.log(fs.readFileSync('/workspace/inside.txt','utf8'));try{fs.readFileSync('/host-sentinel')}catch{console.log('host-blocked')}`],
      cwd: '.', timeoutMs: 10_000, purpose: 'test',
    }, context('isolation'));
    assert.equal(isolation.exitCode, 0);
    assert.match(readFileSync(path.join(root, 'isolation', isolation.stdoutRef), 'utf8'), /inside-only[\s\S]*host-blocked/);

    const noNetwork = await backend.run({
      argv: ['node', '-e', `require('dns').lookup('example.com',error=>{console.log(error?'network-blocked':'network-open');process.exit(error?0:9)})`],
      cwd: '.', timeoutMs: 10_000, purpose: 'run',
    }, context('network'));
    assert.equal(noNetwork.exitCode, 0);
    assert.match(readFileSync(path.join(root, 'network', noNetwork.stdoutRef), 'utf8'), /network-blocked/);

    const npmArgs = ['npm', 'view', 'is-number', 'version', '--fetch-retries=0', '--fetch-timeout=7000', '--cache=/tmp/dmw-test-cache', '--prefer-online'];
    const install = await backend.run({ argv: npmArgs, cwd: '.', timeoutMs: 12_000, purpose: 'install' }, context('install'));
    assert.equal(install.network, 'full');
    assert.equal(install.exitCode, 0, readFileSync(path.join(root, 'install', install.stderrRef), 'utf8'));
    assert.match(readFileSync(path.join(root, 'install', install.stdoutRef), 'utf8'), /\d+\.\d+\.\d+/);
    const regular = await backend.run({ argv: npmArgs, cwd: '.', timeoutMs: 12_000, purpose: 'run' }, context('ordinary-npm'));
    assert.equal(regular.network, 'none');
    assert.notEqual(regular.exitCode, 0);
    assert.equal(regular.exitConfirmed, true);
    const cacheArgs = ['npm', 'view', 'is-number', 'version', '--fetch-retries=0', '--fetch-timeout=7000'];
    const seededCache = await backend.run({ argv: cacheArgs, cwd: '.', timeoutMs: 12_000, purpose: 'install' }, context('seed-cache'));
    assert.equal(seededCache.exitCode, 0, readFileSync(path.join(root, 'seed-cache', seededCache.stderrRef), 'utf8'));
    const sharedCache = await backend.run({ argv: [...cacheArgs, '--offline'], cwd: '.', timeoutMs: 12_000, purpose: 'run' }, context('read-cache'));
    assert.equal(sharedCache.exitCode, 0, readFileSync(path.join(root, 'read-cache', sharedCache.stderrRef), 'utf8'));
    assert.equal(sharedCache.network, 'none');

    const output = await backend.run({
      argv: ['node', '-e', "const b=Buffer.alloc(65536,120);let i=0;setInterval(()=>{(i++%2?process.stderr:process.stdout).write(b)},0)"],
      cwd: '.', timeoutMs: 10_000, purpose: 'test',
    }, context('output-limit'));
    const captured = statSync(path.join(root, 'output-limit', output.stdoutRef)).size + statSync(path.join(root, 'output-limit', output.stderrRef)).size;
    assert.equal(output.outputLimited, true);
    assert.equal(output.exitConfirmed, true);
    assert.equal(output.timedOut, false);
    assert.equal(output.cancelled, false);
    assert.equal(captured, EXEC_OUTPUT_LIMIT_BYTES);

    const timeout = await backend.run({ argv: ['node', '-e', 'setInterval(()=>{},1000)'], cwd: '.', timeoutMs: 500 }, context('timeout'));
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.exitConfirmed, true);

    const controller = new AbortController();
    const cancelledContext = { ...context('cancel'), signal: controller.signal };
    const waiting = backend.run({ argv: ['node', '-e', "console.log('started');setInterval(()=>{},1000)"], cwd: '.', timeoutMs: 10_000 }, cancelledContext);
    const marker = path.join(cancelledContext.outputDir, 'stdout.txt');
    const cutoff = Date.now() + 6_000;
    let started = false;
    let activeContainers: string[];
    let cancelled: Awaited<typeof waiting>;
    try {
      while (Date.now() < cutoff) {
        try { started = readFileSync(marker, 'utf8').includes('started'); } catch { /* Await initial log creation. */ }
        if (started) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      activeContainers = listed();
    } finally {
      controller.abort();
      cancelled = await waiting;
    }
    assert.equal(started, true, 'expected to cancel after the container command started');
    assert.equal(activeContainers.length, 1, 'expected to observe the held fixture container');
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.exitConfirmed, true);
    assert.deepEqual(listed(), []);
  } finally {
    delete process.env.DMW_HOST_SECRET_CANARY;
    if (ownedVolume) {
      const label = execFileSync('docker', ['volume', 'inspect', '--format', '{{ index .Labels "com.dual-model-workbench.fixture" }}', volume], { encoding: 'utf8' }).trim();
      if (label === 'm5-real') execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
