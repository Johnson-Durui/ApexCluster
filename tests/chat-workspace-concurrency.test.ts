import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { WorkspaceRegistry, type WorkspaceGrant } from '../src/chat/workspace.js';
import { tempDir } from './helpers.js';

const CHILD_SOURCE = [
  "import { existsSync, writeFileSync } from 'node:fs';",
  "const [moduleUrl, root, project, ready, gate] = process.argv.slice(1);",
  'const { WorkspaceRegistry } = await import(moduleUrl);',
  'const registry = new WorkspaceRegistry(root);',
  "writeFileSync(ready, 'ready');",
  'while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 5));',
  'const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());',
  'process.stdout.write(JSON.stringify(grant));',
].join('\n');

function grantInChild(moduleUrl: string, root: string, project: string, ready: string, gate: string): Promise<WorkspaceGrant> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', CHILD_SOURCE, moduleUrl, root, project, ready, gate], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error('workspace child failed (' + code + '): ' + stderr));
      else resolve(JSON.parse(stdout) as WorkspaceGrant);
    });
  });
}

async function waitFor(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!files.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error('workspace children did not reach the grant barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('independent processes merge grants and stale registries reload revocation state', { timeout: 20_000 }, async () => {
  const root = tempDir('workspace-registry-concurrency-');
  let lockOwner: ReturnType<typeof spawn> | undefined;
  try {
    const registryRoot = path.join(root, 'registry');
    const projectA = path.join(root, 'project-a');
    const projectB = path.join(root, 'project-b');
    const readyA = path.join(root, 'ready-a');
    const readyB = path.join(root, 'ready-b');
    const gate = path.join(root, 'go');
    mkdirSync(projectA);
    mkdirSync(projectB);
    const stale = new WorkspaceRegistry(registryRoot);
    const moduleUrl = pathToFileURL(path.resolve('src/chat/workspace.ts')).href;
    const first = grantInChild(moduleUrl, registryRoot, projectA, readyA, gate);
    const second = grantInChild(moduleUrl, registryRoot, projectB, readyB, gate);
    await waitFor([readyA, readyB]);
    writeFileSync(gate, 'go');
    const grants = await Promise.all([first, second]);

    assert.deepEqual(new Set(stale.list().map(item => item.path.toLowerCase())), new Set([projectA, projectB].map(item => item.toLowerCase())));
    const current = new WorkspaceRegistry(registryRoot);
    current.revoke(grants[0]!.id);
    assert.throws(() => stale.assert(grants[0]!.id), /已撤销/);
    const revokedByStale = stale.revoke(grants[1]!.id);
    assert.equal(revokedByStale.active, false);
    assert.throws(() => current.assert(grants[1]!.id), /已撤销/);

    const projectC = path.join(root, 'project-c');
    const projectD = path.join(root, 'project-d');
    const readyC = path.join(root, 'ready-c');
    const readyD = path.join(root, 'ready-d');
    mkdirSync(projectC);
    mkdirSync(projectD);
    lockOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      lockOwner!.once('spawn', resolve);
      lockOwner!.once('error', reject);
    });
    const lockToken = lockOwner.pid + '-00000000-0000-4000-8000-000000000000';
    const lockDirectory = path.join(registryRoot, '.workspaces.lock');
    mkdirSync(lockDirectory);
    writeFileSync(path.join(lockDirectory, 'owner-' + lockToken + '.json'), JSON.stringify({
      pid: lockOwner.pid,
      token: lockToken,
      createdAt: new Date().toISOString(),
    }));
    let thirdSettled = false;
    let fourthSettled = false;
    const third = grantInChild(moduleUrl, registryRoot, projectC, readyC, gate).finally(() => { thirdSettled = true; });
    const fourth = grantInChild(moduleUrl, registryRoot, projectD, readyD, gate).finally(() => { fourthSettled = true; });
    await waitFor([readyC, readyD]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(thirdSettled, false, 'an active lock owner must not be displaced');
    assert.equal(fourthSettled, false, 'all contenders must preserve the active lock owner');
    lockOwner.kill();
    await new Promise(resolve => lockOwner!.once('exit', resolve));
    lockOwner = undefined;
    const recovered = await Promise.all([third, fourth]);
    assert.deepEqual(new Set(recovered.map(item => item.path.toLowerCase())), new Set([projectC, projectD].map(item => item.toLowerCase())));
    assert.deepEqual(new Set(current.list().map(item => item.path.toLowerCase())),
      new Set([projectA, projectB, projectC, projectD].map(item => item.toLowerCase())));
  } finally {
    lockOwner?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX workspace grants preserve case-distinct directory identities', { skip: platform() === 'win32' }, () => {
  const root = tempDir('workspace-registry-case-');
  try {
    const upper = path.join(root, 'Project');
    const lower = path.join(root, 'project');
    mkdirSync(upper);
    mkdirSync(lower);
    const registry = new WorkspaceRegistry(path.join(root, 'registry'));
    const first = registry.grantFromNativeSelection(upper, registry.issueNativeSelectionRequest());
    const second = registry.grantFromNativeSelection(lower, registry.issueNativeSelectionRequest());
    assert.notEqual(first.id, second.id);
    assert.deepEqual(new Set(registry.list().map(item => item.path)), new Set([upper, lower]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty fixed lock directory left during release is recovered without recursive deletion', () => {
  const root = tempDir('workspace-registry-empty-lock-');
  try {
    const registryRoot = path.join(root, 'registry');
    const project = path.join(root, 'project');
    mkdirSync(registryRoot);
    mkdirSync(project);
    mkdirSync(path.join(registryRoot, '.workspaces.lock'));
    const registry = new WorkspaceRegistry(registryRoot);
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    assert.equal(grant.active, true);
    assert.equal(existsSync(path.join(registryRoot, '.workspaces.lock')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repeated process races preserve every independently granted workspace', { timeout: 30_000 }, async () => {
  const root = tempDir('workspace-registry-races-');
  try {
    const registryRoot = path.join(root, 'registry');
    const moduleUrl = pathToFileURL(path.resolve('src/chat/workspace.ts')).href;
    for (let round = 0; round < 5; round += 1) {
      const gate = path.join(root, 'go-' + round);
      const projects = [0, 1].map(index => path.join(root, 'project-' + round + '-' + index));
      const ready = [0, 1].map(index => path.join(root, 'ready-' + round + '-' + index));
      projects.forEach(project => mkdirSync(project));
      const grants = projects.map((project, index) => grantInChild(moduleUrl, registryRoot, project, ready[index]!, gate));
      await waitFor(ready);
      writeFileSync(gate, 'go');
      await Promise.all(grants);
      assert.equal(new WorkspaceRegistry(registryRoot).list().length, (round + 1) * 2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
