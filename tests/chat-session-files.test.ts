import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/chat/store.js';
import { SessionFiles } from '../src/chat/session-files.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'session-files-'));
  const store = new ChatStore(root); const files = new SessionFiles(store);
  return { root, store, files, chat: store.create(), close: () => rmSync(root, { recursive: true, force: true }) };
}
test('upload is immutable, idempotent and inaccessible until bound to a message', () => {
  const f = fixture(); try {
    const bytes = Buffer.from('中文附件');
    const item = f.files.upload(f.chat, { name: '说明.md', base64: bytes.toString('base64'), clientUploadId: 'upload-1' });
    assert.equal(f.files.list(f.chat).length, 0);
    assert.throws(() => f.files.read(f.chat, item.id), /尚未发送/);
    assert.equal(f.files.upload(f.chat, { name: '说明.md', base64: bytes.toString('base64'), clientUploadId: 'upload-1' }).id, item.id);
    assert.throws(() => f.files.upload(f.chat, { name: '说明.md', base64: 'eA==', clientUploadId: 'upload-1' }), /不同/);
    f.files.bind(f.chat, [item.id], 'message-1');
    assert.equal(f.files.read(f.chat, item.id).bytes.toString(), '中文附件');
    assert.equal(f.store.get(f.chat.id).attachments?.[0]?.messageIds?.[0], 'message-1');
    assert.throws(() => f.files.remove(f.chat, item.id), /已发送/);
    assert.throws(() => f.files.read(f.store.create(), item.id), /不存在/);
  } finally { f.close(); }
});
test('untrusted names and base64 are rejected; quotas count decoded bytes', () => {
  const f = fixture(); try {
    for (const name of ['../escape.txt', 'C:\\file.txt', 'file\u0000.txt', 'file:stream.txt', 'run.exe']) {
      assert.throws(() => f.files.upload(f.chat, { name, base64: 'eA==', clientUploadId: 'a' }));
    }
    assert.throws(() => f.files.upload(f.chat, { name: 'x.txt', base64: 'NOT@base64', clientUploadId: 'a' }));
    assert.throws(() => f.files.publish(f.chat, 't', 'i', [{ name: 'x.bin', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }]));
    assert.equal(f.chat.attachments?.length ?? 0, 0);
  } finally { f.close(); }
});
test('binary outputs are validated as a batch and hashes detect changed storage', () => {
  const f = fixture(); try {
    assert.throws(() => f.files.publish(f.chat, 'task', 'inv', [{ name: 'good.txt', bytes: Buffer.from('ok') }, { name: '../bad', bytes: Buffer.from('bad') }]));
    assert.equal(f.files.list(f.chat).length, 0);
    const [item] = f.files.publish(f.chat, 'task', 'inv', [{ name: '结果.txt', bytes: Buffer.from('真实结果') }]);
    assert.equal(f.files.read(f.chat, item!.id).bytes.toString(), '真实结果');
    writeFileSync(path.join(f.store.sessionDirectory(f.chat.id), 'outputs', item!.id), 'tamper');
    assert.throws(() => f.files.read(f.chat, item!.id), /校验/);
  } finally { f.close(); }
});
test('pending upload can be removed without affecting another chat', () => {
  const f = fixture(); try {
    const item = f.files.upload(f.chat, { name: 'file.txt', base64: '', clientUploadId: 'empty' });
    assert.equal(f.files.read(f.chat, item.id, true).bytes.length, 0);
    f.files.remove(f.chat, item.id);
    assert.equal(f.files.list(f.chat, true).length, 0);
  } finally { f.close(); }
});

test('output files and artifact manifests commit together or roll back the whole batch', () => {
  const f = fixture(); try {
    const save = f.store.save.bind(f.store); f.store.save = () => { throw new Error('disk full'); };
    assert.throws(()=>f.files.publishArtifacts(f.chat,'task','inv',[{name:'one.txt',bytes:Buffer.from('1')},{name:'two.txt',bytes:Buffer.from('2')}]),/disk full/);
    assert.equal(f.chat.artifacts.length,0); assert.equal(f.chat.attachments?.length??0,0);
    f.store.save=save; const batch=f.files.publishArtifacts(f.chat,'task','inv',[{name:'one.txt',bytes:Buffer.from('1')},{name:'two.txt',bytes:Buffer.from('2')}]);
    assert.equal(batch.artifacts.length,2); const restored=f.store.get(f.chat.id);assert.equal(restored.artifacts.length,2);assert.equal(restored.attachments?.length,2);
  } finally {f.close();}
});
