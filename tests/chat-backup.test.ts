import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ChatStore } from '../src/chat/store.js';
import { SessionFiles } from '../src/chat/session-files.js';
import { backupChats, restoreChats } from '../src/chat/backup.js';

function testRoot() { return mkdtempSync(path.join(tmpdir(), 'chat-backup-')); }
function cleanup(root: string) {
  const base = path.resolve(tmpdir()), target = path.resolve(root), relative = path.relative(base, target);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || !path.basename(target).startsWith('chat-backup-')) throw new Error(`拒绝清理测试根目录之外的路径：${target}`);
  rmSync(target, { recursive: true, force: true });
}
function createRegisteredData(data: string) {
  const store = new ChatStore(data), files = new SessionFiles(store), chat = store.create();
  const file = files.upload(chat, { name: '中文.txt', base64: Buffer.from('内容').toString('base64'), clientUploadId: 'u' });
  const message = store.appendMessage(chat, { role: 'user', text: '保存附件', attachmentIds: [file.id] }); files.bind(chat, [file.id], message.id);
  const artifactBlob = store.putBlob(chat.id, 'artifact.txt', '产物内容');
  chat.artifacts.push({ id: 'artifact-1', taskId: 'task-1', name: '报告.txt', relativePath: artifactBlob.relativePath, hash: artifactBlob.hash, bytes: artifactBlob.bytes, kind: 'report', createdAt: new Date().toISOString(), provenance: 'model' });
  const toolBlob = store.putBlob(chat.id, 'tool.txt', '工具回执');
  chat.toolResults = [{ taskId: 'task-1', invocationId: 'inv-1', ref: toolBlob.relativePath, hash: toolBlob.hash, bytes: toolBlob.bytes, name: 'file_read', provenance: 'tool' }];
  chat.tasks.push({ id: 'task-1', turnId: 'turn-1', role: 'sol', goal: '验证备份', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), segment: 1, resultRef: artifactBlob.relativePath, invocationIds: [], noProgressSegments: 0, mode: 'verify' });
  store.appendStream(chat.id, 'stream', '部分流'); store.appendEvent(chat, { type: 'example', data: {} }); store.save(chat);
  return { store, files, chat, file, message, artifactBlob, toolBlob };
}
function manifestAt(backup: string) { return path.join(backup, 'manifest.json'); }

test('backup/restore publishes only a fully validated copy and never overwrites history', () => {
  const root = testRoot(); try {
    const data = path.join(root, 'data'), backup = path.join(root, 'backup'), restored = path.join(root, 'restored');
    const { chat, file, message } = createRegisteredData(data);
    mkdirSync(path.join(data, 'capabilities')); writeFileSync(path.join(data, 'capabilities', 'proof.json'), 'not backed up');
    const manifest = backupChats(data, backup); assert.ok(manifest.files.every(item => item.path.startsWith('chats/')));
    const [restoredChat] = restoreChats(backup, restored); assert.equal(restoredChat!.id, chat.id);
    const restoredStore = new ChatStore(restored); assert.equal(new SessionFiles(restoredStore).read(restoredChat!, file.id).bytes.toString(), '内容');
    assert.equal(restoredStore.readStream(chat.id, 'stream'), '部分流'); assert.equal(restoredStore.messages(chat.id).items[0]?.text, message.text);
    assert.throws(() => restoreChats(backup, restored), /不能覆盖/);
    assert.throws(() => backupChats(data, path.join(data, 'nested')), /来源之外/);
  } finally { cleanup(root); }
});

test('backup rejects corrupted registered attachments and blobs without publishing a directory', () => {
  const root = testRoot(); try {
    const attachmentData = path.join(root, 'attachment-data'), attachmentBackup = path.join(root, 'attachment-backup');
    const attachment = createRegisteredData(attachmentData);
    writeFileSync(path.join(attachmentData, 'chats', attachment.chat.id, 'files', 'inputs', attachment.file.id), '损坏');
    assert.throws(() => backupChats(attachmentData, attachmentBackup), /文件内容校验失败/); assert.equal(existsSync(attachmentBackup), false);

    const blobData = path.join(root, 'blob-data'), blobBackup = path.join(root, 'blob-backup');
    const blob = createRegisteredData(blobData);
    writeFileSync(path.join(blobData, 'chats', blob.chat.id, ...blob.toolBlob.relativePath.split('/')), '损坏工具回执');
    assert.throws(() => backupChats(blobData, blobBackup), /登记内容(长度|哈希)不一致/); assert.equal(existsSync(blobBackup), false);
    assert.equal(readdirSync(root).some(name => name.includes('.staging-')), false);
    const capabilityData = path.join(root, 'capability-data'), capabilityBackup = path.join(root, 'capability-backup');
    const capability = createRegisteredData(capabilityData); const snapshot = capability.store.putBlob(capability.chat.id, 'capability.json', '{"version":1}');
    capability.chat.invocations.push({ id:'inv-1',taskId:'task-1',segment:1,status:'exited',startedAt:'',toolCount:0,promptVersion:'test',inputEstimate:0,contextWindow:null,contextUsed:null,capabilitySnapshotRef:snapshot.relativePath,capabilitySnapshot:snapshot.hash }); capability.store.save(capability.chat);
    writeFileSync(path.join(capabilityData,'chats',capability.chat.id,...snapshot.relativePath.split('/')), '{"version":2}');
    assert.throws(() => backupChats(capabilityData,capabilityBackup), /登记内容哈希不一致/); assert.equal(existsSync(capabilityBackup),false);
  } finally { cleanup(root); }
});

test('restore rejects strict-manifest violations, undeclared inputs and corruption without publishing output', () => {
  const root = testRoot(); try {
    const data = path.join(root, 'data'), backup = path.join(root, 'backup'); const registered = createRegisteredData(data); backupChats(data, backup);
    const original = readFileSync(manifestAt(backup), 'utf8'); const manifest = JSON.parse(original) as { files: unknown[] };

    const undeclared = path.join(backup, 'chats', JSON.parse(original).chatIds[0], 'undeclared.txt'); writeFileSync(undeclared, 'x');
    const undeclaredOutput = path.join(root, 'undeclared-output'); assert.throws(() => restoreChats(backup, undeclaredOutput), /未登记输入/); assert.equal(existsSync(undeclaredOutput), false); unlinkSync(undeclared);

    manifest.files.push(manifest.files[0]); writeFileSync(manifestAt(backup), JSON.stringify(manifest));
    const duplicateOutput = path.join(root, 'duplicate-output'); assert.throws(() => restoreChats(backup, duplicateOutput), /重复路径/); assert.equal(existsSync(duplicateOutput), false);

    const extra = { ...JSON.parse(original), unexpected: true }; writeFileSync(manifestAt(backup), JSON.stringify(extra));
    const extraOutput = path.join(root, 'extra-output'); assert.throws(() => restoreChats(backup, extraOutput), /格式无效/); assert.equal(existsSync(extraOutput), false);

    writeFileSync(manifestAt(backup), original); const valid = JSON.parse(original) as { files: Array<{ path: string }> };
    const corruptFile = path.join(backup, ...valid.files[0]!.path.split('/')), originalBytes = readFileSync(corruptFile); writeFileSync(corruptFile, 'corrupt');
    const corruptOutput = path.join(root, 'corrupt-output'); assert.throws(() => restoreChats(backup, corruptOutput), /完整性/); assert.equal(existsSync(corruptOutput), false);
    writeFileSync(corruptFile, originalBytes);

    const semantic = JSON.parse(original) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    const attachmentPath = `chats/${registered.chat.id}/files/inputs/${registered.file.id}`; const bytes = Buffer.from('伪造但同步清单的附件');
    writeFileSync(path.join(backup, ...attachmentPath.split('/')), bytes);
    const attachmentEntry = semantic.files.find(item => item.path === attachmentPath)!; attachmentEntry.bytes = bytes.length; attachmentEntry.sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(manifestAt(backup), JSON.stringify(semantic));
    const semanticOutput = path.join(root, 'semantic-output'); assert.throws(() => restoreChats(backup, semanticOutput), /文件内容校验失败/); assert.equal(existsSync(semanticOutput), false);
    assert.equal(readdirSync(root).some(name => name.includes('.staging-')), false);
  } finally { cleanup(root); }
});

test('target path cannot traverse a junction or symlink back into the source', () => {
  const root = testRoot(); const link = path.join(root, 'source-link'); try {
    const data = path.join(root, 'data'); createRegisteredData(data);
    symlinkSync(data, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => backupChats(data, path.join(link, 'nested-backup')), /链接|重解析点|来源之外/);
    assert.equal(existsSync(path.join(data, 'nested-backup')), false);
  } finally { if (existsSync(link)) unlinkSync(link); cleanup(root); }
});
