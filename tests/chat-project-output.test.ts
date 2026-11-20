import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { PROJECT_OUTPUT_DIRECTORY, ProjectOutputStore } from '../src/artifacts/project-output.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';

function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), 'work', 'project-output-'));
  const project = path.join(root, '中文 project');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'source.txt'), 'source');
  const registry = new WorkspaceRegistry(path.join(root, 'managed'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  return { root, project, registry, grant, outputs: new ProjectOutputStore(registry) };
}

test('文档、图片和压缩包逐字节保存到项目输出目录，重名生成新版本', (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const files = [
    { name: '预览 图片.png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]) },
    { name: '报告.docx', bytes: Buffer.from([80, 75, 3, 4, 0, 1, 2, 0, 255]) },
    { name: '资料.zip', bytes: Buffer.from([80, 75, 3, 4, 9, 8, 7, 6]) },
  ];
  for (const file of files) {
    const saved = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-123', ...file });
    assert.equal(saved.relativePath, `${PROJECT_OUTPUT_DIRECTORY}/chat-123/${file.name}`);
    assert.deepEqual(readFileSync(saved.path), file.bytes);
  }
  const original = readFileSync(path.join(f.project, PROJECT_OUTPUT_DIRECTORY, 'chat-123', '报告.docx'));
  const second = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-123', name: '报告.docx', bytes: Buffer.from('new version') });
  assert.equal(second.relativePath, `${PROJECT_OUTPUT_DIRECTORY}/chat-123/报告 (2).docx`);
  assert.deepEqual(readFileSync(second.path), Buffer.from('new version'));
  assert.deepEqual(readFileSync(path.join(f.project, PROJECT_OUTPUT_DIRECTORY, 'chat-123', '报告.docx')), original);
});

test('无效授权、旧版本、越界名称和 Windows 设备名均在写入前拒绝', (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const save = (patch: Partial<Parameters<ProjectOutputStore['save']>[0]> = {}) => f.outputs.save({
    workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-guard', name: 'safe.txt', bytes: Buffer.from('safe'), ...patch,
  });
  assert.throws(() => save({ workspaceId: 'w-unknown' }), /不存在/);
  for (const name of ['../escape.txt', 'folder/file.txt', 'file:stream.txt', 'CON', 'com1.txt', 'trailing.']) assert.throws(() => save({ name }), /不安全/);
  assert.throws(() => save({ chatId: '../outside' }), /身份无效/);
  f.registry.revoke(f.grant.id);
  assert.throws(() => save(), /已撤销/);
  const current = f.registry.grantFromNativeSelection(f.project, f.registry.issueNativeSelectionRequest());
  assert.equal(current.version, 3);
  assert.throws(() => save(), /版本已变化/);
  assert.equal(existsSync(path.join(f.root, 'outside')), false);
});

test('回滚只删除自身未变化的输出，用户改动后的文件保留', (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const first = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-rollback', name: 'first.txt', bytes: Buffer.from('first') });
  f.outputs.rollback(first);
  assert.equal(existsSync(first.path), false);
  const changed = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-rollback', name: 'changed.txt', bytes: Buffer.from('before') });
  writeFileSync(changed.path, 'user changed');
  assert.throws(() => f.outputs.rollback(changed), /已被修改|保留/);
  assert.equal(readFileSync(changed.path, 'utf8'), 'user changed');
});

test('输出回执核验拒绝错误哈希、篡改、伪造路径和失效授权', (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const saved = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-verify', name: 'result.bin', bytes: Buffer.from('official') });
  f.outputs.verify(saved, saved.hash);
  const wrongHash = createHash('sha256').update('wrong').digest('hex');
  assert.throws(() => f.outputs.verify(saved, wrongHash), /哈希不一致/);
  assert.throws(() => f.outputs.verify({ ...saved, path: path.join(f.root, 'outside.bin') }, saved.hash), /路径无效/);
  assert.throws(() => f.outputs.verify({ ...saved, relativePath: '../outside.bin' }, saved.hash), /路径无效/);
  writeFileSync(saved.path, 'tampered');
  assert.throws(() => f.outputs.verify(saved, saved.hash), /已被修改/);
  const stillValid = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-verify', name: 'revoked.bin', bytes: Buffer.from('valid') });
  f.registry.revoke(f.grant.id);
  assert.throws(() => f.outputs.verify(stillValid, stillValid.hash), /已撤销/);
});

test('暂存文件清理失败不把已提交输出误报为失败', { concurrency: false }, (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const original = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file: Parameters<typeof fs.unlinkSync>[0]) => {
    if (path.basename(String(file)).startsWith('.pending-')) throw new Error('fixture locked staging');
    return original(file);
  });
  syncBuiltinESMExports();
  let saved;
  try {
    saved = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-cleanup', name: 'committed.txt', bytes: Buffer.from('committed') });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
  assert.equal(readFileSync(saved.path, 'utf8'), 'committed');
  f.outputs.verify(saved, saved.hash);
});

test('链接输出目录被拒绝', (t) => {
  const linked = fixture(); t.after(() => rmSync(linked.root, { recursive: true, force: true }));
  const outside = path.join(linked.root, 'outside'); mkdirSync(outside);
  try { symlinkSync(outside, path.join(linked.project, PROJECT_OUTPUT_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`当前平台不能创建链接攻击样本：${(error as Error).message}`); return; }
  assert.throws(() => linked.outputs.save({ workspaceId: linked.grant.id, workspaceVersion: 1, chatId: 'chat-link', name: 'escape.txt', bytes: Buffer.from('no') }), /链接|越界/);
});

test('生成产物不进入工作区源码快照', (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const saved = f.outputs.save({ workspaceId: f.grant.id, workspaceVersion: 1, chatId: 'chat-snapshot', name: '交付.txt', bytes: Buffer.from('deliverable') });
  assert.equal(readFileSync(saved.path, 'utf8'), 'deliverable');
  assert.throws(() => f.registry.read(f.grant.id, saved.relativePath), /受管产物目录/);
  assert.throws(() => f.registry.write(f.grant.id, saved.relativePath, 'overwrite', saved.hash), /受管产物目录/);
  assert.deepEqual(f.registry.listFiles(f.grant.id), ['source.txt']);
  const snapshot = f.registry.freeze(f.grant.id, 'task-after-output');
  assert.deepEqual(Object.keys(snapshot.files), ['source.txt']);
});
