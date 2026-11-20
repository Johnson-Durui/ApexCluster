import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrapChats } from '../src/chat/bootstrap.js';
import { defaultConfig } from '../src/config.js';

function fixture() {
  const testRoot = path.join(process.cwd(), '.test-tmp');
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(path.join(testRoot, 'api-context-'));
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');
  mkdirSync(path.join(app, 'config'), { recursive: true });
  return { root, app, data };
}

test('API bootstrap accepts and forwards validated context settings without making an API call', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.app, 'config', 'chat.config.json'), JSON.stringify({
      driverMode: 'api',
      dataRoot: f.data,
      context: {
        seats: { softTokens: 120_000, hardTokens: 180_000 },
        pools: { softTokens: 48_000, hardTokens: 72_000 },
        overrides: { astra: { maxOutputTokens: 32_000 } },
        hardRatio: 0.4,
      },
    }));
    const boot = bootstrapChats(defaultConfig(f.root), 'test-token', f.app);
    assert.ok(boot.runtime);
    await boot.runtime.shutdown();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('invalid API context fails before creating the configured data root', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.app, 'config', 'chat.config.json'), JSON.stringify({
      driverMode: 'api',
      dataRoot: f.data,
      context: { hardRatio: 0.9 },
    }));
    const boot = bootstrapChats(defaultConfig(f.root), 'test-token', f.app);
    assert.equal(boot.runtime, undefined);
    assert.equal(existsSync(f.data), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('CLI bootstrap ignores API context settings for backward compatibility', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.app, 'config', 'chat.config.json'), JSON.stringify({
      driverMode: 'cli',
      dataRoot: f.data,
      context: { hardRatio: 0.9 },
    }));
    const boot = bootstrapChats(defaultConfig(f.root), 'test-token', f.app);
    assert.ok(boot.runtime);
    await boot.runtime.shutdown();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
