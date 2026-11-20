import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceGateway, type WorkspaceToolIdentity } from '../src/chat/gateway.js';
import type { ChatRecord } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { tempDir } from './helpers.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = tempDir('chat-workspace-');
  const project = path.join(root, 'project');
  const managed = path.join(root, 'managed');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(project, 'README.md'), 'hello workspace\n');
  const registry = new WorkspaceRegistry(managed);
  return { root, project, managed, registry };
}

function grant(f: ReturnType<typeof fixture>) {
  const requestId = f.registry.issueNativeSelectionRequest();
  return f.registry.grantFromNativeSelection(f.project, requestId);
}

test('目录授权只能消费宿主签发的一次性选择请求，撤销和版本变化立即生效', () => {
  const f = fixture();
  assert.throws(() => f.registry.grantFromNativeSelection(f.project, 'browser-value'), /宿主签发/);
  const requestId = f.registry.issueNativeSelectionRequest();
  const workspace = f.registry.grantFromNativeSelection(f.project, requestId);
  assert.throws(() => f.registry.grantFromNativeSelection(f.project, requestId), /已消费/);
  assert.equal(f.registry.assert(workspace.id, 1).active, true);
  const revoked = f.registry.revoke(workspace.id);
  assert.equal(revoked.version, 2);
  assert.throws(() => f.registry.read(workspace.id, 'README.md'), /已撤销/);
  assert.throws(() => f.registry.assert(workspace.id, 1), /已撤销/);
});

test('读取、搜索和哈希写入工作，路径穿越、ADS 与并发覆盖被拒绝', () => {
  const f = fixture(); const workspace = grant(f);
  assert.equal(f.registry.read(workspace.id, 'README.md').text, 'hello workspace\n');
  assert.deepEqual(f.registry.search(workspace.id, 'workspace').map((item) => item.path), ['README.md']);
  assert.deepEqual(f.registry.listFiles(workspace.id), ['README.md', 'src/main.ts']);
  for (const unsafe of ['../outside.txt', 'src/main.ts:secret', '.env', '.git/config']) {
    assert.throws(() => f.registry.read(workspace.id, unsafe), /路径|凭证|版本控制|备用数据流/);
  }
  assert.throws(() => f.registry.write(workspace.id, 'src/main.ts', 'bad', digest('wrong')), /拒绝覆盖/);
  const result = f.registry.write(workspace.id, 'src/main.ts', 'export const value = 2;\n', digest('export const value = 1;\n'));
  assert.equal(result.hash, digest('export const value = 2;\n'));
});

test('Windows 路径别名、设备名、非法字符和凭证 canary 在文件系统访问前被拒绝', () => {
  const f = fixture(); const workspace = grant(f);
  const syntaxCases = [
    '.codex /session.json', '.aws./credentials', 'src/trailing.', 'src/trailing ',
    'CON', 'con.txt', 'src/COM1.txt', 'src/LPT9.log', 'src/NUL.json',
    'src/bad?.txt', 'src/bad*.txt', 'src/bad<name>.txt', 'src/control\u0001.txt', 'src/nul\0.txt',
    'src/main.ts:secret',
  ];
  for (const unsafe of syntaxCases) {
    assert.throws(
      () => f.registry.read(workspace.id, unsafe),
      /Windows 路径段|保留设备名|非法字符|备用数据流/,
      `must reject before probing the filesystem: ${JSON.stringify(unsafe)}`,
    );
  }

  const canary = path.join(f.project, 'credential-canary');
  mkdirSync(canary);
  const credentialNames = ['.npmrc', '.pypirc', '.netrc', '.git-credentials', 'auth.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
  for (const name of credentialNames) writeFileSync(path.join(canary, name), 'canary only\n');
  for (const directory of ['.codex', '.docker', '.kube', '.azure', '.gnupg', '.terraform.d']) {
    mkdirSync(path.join(f.project, directory));
    writeFileSync(path.join(f.project, directory, 'credential-canary.json'), 'canary only\n');
  }
  writeFileSync(path.join(f.project, '.codex', 'session.json'), 'canary only\n');
  mkdirSync(path.join(f.project, '.config', 'gcloud'), { recursive: true });
  mkdirSync(path.join(f.project, '.config', 'gh'), { recursive: true });
  writeFileSync(path.join(f.project, '.config', 'gcloud', 'credentials.db'), 'canary only\n');
  writeFileSync(path.join(f.project, '.config', 'gh', 'hosts.yml'), 'canary only\n');
  writeFileSync(path.join(f.project, '.config', 'example.json'), 'safe config\n');
  const listed = f.registry.listFiles(workspace.id);
  for (const name of credentialNames) {
    assert.equal(listed.includes(`credential-canary/${name}`), false);
    assert.throws(() => f.registry.read(workspace.id, `credential-canary/${name}`), /凭证|认证/);
  }
  assert.equal(listed.some((item) => item.startsWith('.codex/')), false);
  assert.throws(() => f.registry.read(workspace.id, '.codex/session.json'), /凭证|认证/);
  for (const directory of ['.docker', '.kube', '.azure', '.gnupg', '.terraform.d', '.config/gcloud', '.config/gh']) {
    assert.equal(listed.some(item => item.startsWith(`${directory}/`)), false);
    assert.throws(() => f.registry.read(workspace.id, `${directory}/credential-canary.json`), /凭证|认证/);
  }
  assert.equal(f.registry.read(workspace.id, '.config/example.json').text, 'safe config\n');
  const snapshot = f.registry.freeze(workspace.id, 'credential-canary');
  assert.equal(snapshot.files['.config/example.json'], digest('safe config\n'));
  assert.equal(Object.keys(snapshot.files).some(item => item.startsWith('.config/gcloud/') || item.startsWith('.config/gh/')), false);

  for (const alias of [`${f.project}.`, `${f.project} `]) {
    const requestId = f.registry.issueNativeSelectionRequest();
    assert.throws(() => f.registry.grantFromNativeSelection(alias, requestId), /空格或句点/);
  }
  const sensitiveRoot = path.join(f.root, '.aws');
  mkdirSync(sensitiveRoot);
  assert.throws(
    () => f.registry.grantFromNativeSelection(sensitiveRoot, f.registry.issueNativeSelectionRequest()),
    /凭证|认证/,
  );
});

test('执行准备在创建快照前拒绝用户配置目录及其上级目录', () => {
  const profile = realpathSync.native(os.homedir());
  const rejectedRoots = [profile, path.dirname(profile)];
  let assertions = 0;
  const registry = {
    assert: () => {
      assertions += 1;
      return { id: 'workspace', path: rejectedRoots[Math.floor((assertions - 1) / 2)]!, name: 'broad', version: 1, active: true, grantedAt: '' };
    },
    freeze: () => { throw new Error('must reject before snapshot'); },
  } as unknown as WorkspaceRegistry;
  const gateway = new WorkspaceGateway(registry);
  const invocation = { id: 'invocation', taskId: 'task', segment: 1, status: 'running', startedAt: '', toolCount: 0,
    promptVersion: 'test', inputEstimate: 1, contextWindow: null, contextUsed: null } as const;
  const task = { id: 'task', turnId: 'turn', role: 'runner', goal: 'test', status: 'running', createdAt: '', updatedAt: '',
    segment: 1, invocationIds: [invocation.id], noProgressSegments: 0, workspaceId: 'workspace', workspaceVersion: 1,
    mode: 'verify' } as const;
  const chat = { id: 'chat', workspaceId: 'workspace', tasks: [task], invocations: [invocation], apiRoster: { modelHashes: {}, roster: {
    version: 1, rootSeat: 'runner', seats: [{ id: 'runner', kind: 'secondary', promptFile: 'runner.md', strengths: 'test',
      bindings: { default: { model: 'offline', effort: 'test', delegation: 'none' } },
      can: { askUser: false, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: true, exec: true } }],
    pools: [], layers: { architecture: { pools: [] }, implementation: { pools: [] } },
  } } } as unknown as ChatRecord;
  const who = { chat, task, invocation, signal: new AbortController().signal } as unknown as WorkspaceToolIdentity;
  assert.throws(() => gateway.prepareExec(who), /用户配置目录|上级目录/);
  assert.throws(() => gateway.prepareExec(who), /用户配置目录|上级目录/);
  assert.equal(assertions, 4);
});

test('快照、编辑副本、测试副本和集成相互隔离，测试污染不会进入源码', () => {
  const f = fixture(); const workspace = grant(f);
  const baseline = f.registry.freeze(workspace.id, 'task-1');
  const edit = f.registry.createEditCopy(baseline);
  writeFileSync(path.join(edit.path, 'src', 'main.ts'), 'export const value = 3;\n');
  const frozenEdit = f.registry.freezeCopy(edit);
  const testCopy = f.registry.createTestCopy(frozenEdit);
  writeFileSync(path.join(testCopy.path, 'test-output.txt'), 'generated only by tests\n');
  assert.equal(readFileSync(path.join(frozenEdit.path, 'src', 'main.ts'), 'utf8'), 'export const value = 3;\n');
  assert.equal(readFileSync(path.join(f.project, 'src', 'main.ts'), 'utf8'), 'export const value = 1;\n');
  const integrated = f.registry.integrateEdit(workspace.id, baseline, frozenEdit, ['src/main.ts']);
  assert.deepEqual(integrated.changed, ['src/main.ts']);
  assert.equal(readFileSync(path.join(f.project, 'src', 'main.ts'), 'utf8'), 'export const value = 3;\n');
  assert.equal(f.registry.listFiles(workspace.id).includes('test-output.txt'), false);
});

test('用户同期修改和编辑快照漂移都会阻断集成', () => {
  const f = fixture(); const workspace = grant(f);
  const baseline = f.registry.freeze(workspace.id, 'task-2');
  const edit = f.registry.createEditCopy(baseline);
  writeFileSync(path.join(edit.path, 'src', 'main.ts'), 'export const value = 4;\n');
  const frozenEdit = f.registry.freezeCopy(edit);
  writeFileSync(path.join(f.project, 'src', 'main.ts'), 'user concurrent edit\n');
  assert.throws(() => f.registry.integrateEdit(workspace.id, baseline, frozenEdit, ['src/main.ts']), /原工作区/);

  writeFileSync(path.join(f.project, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(frozenEdit.path, 'src', 'main.ts'), 'post-freeze tamper\n');
  assert.throws(() => f.registry.integrateEdit(workspace.id, baseline, frozenEdit, ['src/main.ts']), /编辑快照内容已漂移/);
});

test('伪造快照来源与残留集成 journal 均 fail closed', () => {
  const f = fixture(); const workspace = grant(f);
  const baseline = f.registry.freeze(workspace.id, 'task-guard');
  assert.throws(() => f.registry.createEditCopy({ ...baseline, path: f.project }), /元数据.*不一致/);
  const edit = f.registry.createEditCopy(baseline);
  writeFileSync(path.join(edit.path, 'src', 'main.ts'), 'export const value = 9;\n');
  const frozenEdit = f.registry.freezeCopy(edit);
  const journals = path.join(f.managed, 'integration', workspace.id);
  mkdirSync(journals, { recursive: true });
  writeFileSync(path.join(journals, 'interrupted.json'), `${JSON.stringify({ state: 'pending' })}\n`);
  assert.throws(() => f.registry.integrateEdit(workspace.id, baseline, frozenEdit, ['src/main.ts']), /未收口.*journal/);
});

test('工作区内的链接或 junction 不会被快照跟随', (t) => {
  const f = fixture(); const outside = path.join(f.root, 'outside');
  mkdirSync(outside); writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  try {
    symlinkSync(outside, path.join(f.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`当前平台不能创建测试链接：${(error as Error).message}`);
    return;
  }
  const workspace = grant(f);
  assert.throws(() => f.registry.freeze(workspace.id, 'task-3'), /链接|junction/);
});
test('workspace rejects a hardlink to file bytes outside the authorized directory', () => {
  const root = tempDir('workspace-hardlink-');
  const project = path.join(root, 'project');
  mkdirSync(project);
  const external = path.join(root, 'outside.txt');
  writeFileSync(external, 'outside-only');
  linkSync(external, path.join(project, 'linked.txt'));
  const registry = new WorkspaceRegistry(path.join(root, 'registry'));
  const workspace = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  assert.throws(() => registry.read(workspace.id, 'linked.txt'), /硬链接/);
  assert.throws(() => registry.freeze(workspace.id, 'test-hardlink'), /硬链接/);
});
