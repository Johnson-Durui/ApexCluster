import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapChats } from '../src/chat/bootstrap.js';
import { defaultConfig } from '../src/config.js';

test('web and concurrent headless sessions keep independent durable chat stores', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-session-isolation-'));
  const app = path.join(root, 'app');
  const dataRoot = path.join(root, 'data');
  mkdirSync(path.join(app, 'config'), { recursive: true });
  writeFileSync(path.join(app, 'config', 'chat.config.json'), JSON.stringify({ driverMode: 'api', dataRoot }));
  const web = bootstrapChats(defaultConfig(root), 'web-token', app);
  const first = bootstrapChats(defaultConfig(root), 'cli-a-token', app, undefined, { driverMode: 'api', isolatedSession: true });
  const second = bootstrapChats(defaultConfig(root), 'cli-b-token', app, undefined, { driverMode: 'api', isolatedSession: true });
  try {
    assert.ok(web.runtime && first.runtime && second.runtime);
    assert.ok('sessionRoot' in web && 'sessionRoot' in first && 'sessionRoot' in second);
    assert.equal(web.sessionRoot, dataRoot);
    assert.notEqual(first.sessionRoot, second.sessionRoot);
    assert.equal(path.dirname(first.sessionRoot), path.join(dataRoot, 'pipeline-runs'));
    assert.equal(path.dirname(second.sessionRoot), path.join(dataRoot, 'pipeline-runs'));

    const webChat = web.runtime.create({ title: 'web-existing' });
    const firstChat = first.runtime.create({ title: 'cli-first' });
    const secondChat = second.runtime.create({ title: 'cli-second' });
    assert.equal(existsSync(path.join(dataRoot, 'chats', webChat.id, 'chat.json')), true);
    assert.equal(existsSync(path.join(first.sessionRoot, 'chats', firstChat.id, 'chat.json')), true);
    assert.equal(existsSync(path.join(second.sessionRoot, 'chats', secondChat.id, 'chat.json')), true);
    assert.throws(() => web.runtime!.get(firstChat.id), /聊天不存在/);
    assert.throws(() => first.runtime!.get(webChat.id), /聊天不存在/);
    assert.equal(web.runtime.get(webChat.id).title, 'web-existing');
    assert.equal(first.runtime.get(firstChat.id).title, 'cli-first');
    assert.equal(second.runtime.get(secondChat.id).title, 'cli-second');
  } finally {
    await Promise.all([web.runtime?.shutdown(), first.runtime?.shutdown(), second.runtime?.shutdown()]);
    rmSync(root, { recursive: true, force: true });
  }
});
