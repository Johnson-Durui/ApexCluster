import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WorkspaceRegistry } from '../src/chat/workspace.js';

function fixture(t: TestContext) {
  const workRoot = path.join(process.cwd(), 'work');
  mkdirSync(workRoot, { recursive: true });
  const root = mkdtempSync(path.join(workRoot, 'chat-changes-'));
  t.after(() => {
    if (path.dirname(root) !== workRoot || !path.basename(root).startsWith('chat-changes-')) throw new Error(`unsafe cleanup ${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'src', 'value.txt'), 'before\nshared\n');
  writeFileSync(path.join(project, 'unchanged.txt'), 'same\n');
  const registry = new WorkspaceRegistry(path.join(root, 'managed'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  return { root, project, registry, grant };
}

test('程序从冻结快照生成新增、修改、二进制和大文件的真实差异', (t) => {
  const f = fixture(t);
  const before = f.registry.freeze(f.grant.id, 'diff-task');
  const edit = f.registry.createEditCopy(before);
  writeFileSync(path.join(edit.path, 'src', 'value.txt'), 'after\nshared\n');
  writeFileSync(path.join(edit.path, 'added.txt'), 'new file\n');
  writeFileSync(path.join(edit.path, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(path.join(edit.path, 'large.txt'), 'L'.repeat(300 * 1024));
  const after = f.registry.freezeCopy(edit);
  const report = f.registry.snapshotDiff(before, after);

  assert.deepEqual(report.files.map((file) => [file.path, file.status]), [
    ['added.txt', 'added'], ['binary.bin', 'added'], ['large.txt', 'added'], ['src/value.txt', 'modified'],
  ]);
  const modified = report.files.find((file) => file.path === 'src/value.txt')!;
  assert.equal(modified.representation, 'text');
  assert.match(modified.fragment!, /-before\n\+after/);
  assert.equal(report.files.find((file) => file.path === 'binary.bin')?.representation, 'binary');
  assert.equal(report.files.find((file) => file.path === 'large.txt')?.representation, 'large');
  assert.match(report.text, /binary or invalid UTF-8/);
  assert.match(report.text, /file exceeds 256 KiB/);
  assert.equal(report.text.includes(Buffer.from([0, 1, 2, 255]).toString('base64')), false);
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.txt'), 'utf8'), 'before\nshared\n');
});

test('无变化不产生文件差异，冻结文件哈希漂移会 fail closed', (t) => {
  const f = fixture(t);
  const before = f.registry.freeze(f.grant.id, 'stable-task');
  const edit = f.registry.createEditCopy(before);
  const unchanged = f.registry.freezeCopy(edit);
  assert.deepEqual(f.registry.snapshotDiff(before, unchanged).files, []);

  writeFileSync(path.join(unchanged.path, 'src', 'value.txt'), 'tampered after freeze\n');
  assert.throws(() => f.registry.snapshotDiff(before, unchanged), /目标快照内容已漂移|哈希已漂移/);
});
