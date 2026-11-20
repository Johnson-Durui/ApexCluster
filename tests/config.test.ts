import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { tempDir } from './helpers.js';
import { cursorAvailability } from '../src/core/cursor-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('示例配置可以加载，默认型号/强度符合需求文档', () => {
  const cfg = loadConfig(path.join(ROOT, 'config', 'workbench.config.example.json'), ROOT);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.models.claude.model, 'claude-opus-5-5');
  assert.equal(cfg.models.astra.model, 'gpt-6.2-astra');
  assert.equal(cfg.models.sol.model, 'gpt-6.2-sol');
  assert.deepEqual(cfg.docWriter, { role: 'claude', effort: 'xhigh' });
  assert.equal(cfg.timeoutsMinutes.docs, 60);
  assert.deepEqual(cfg.adapters.claude.promptOnlySchemaPhases, []);
  assert.deepEqual(cfg.adapters.codex.promptOnlySchemaPhases, []);
  assert.ok(['claude', 'astra', 'sol'].every((r) => cfg.models[r as 'claude'].effort === 'max'));
  assert.equal(cfg.workspacesRoot, path.join(os.homedir(), 'dmw-ws'));
  assert.equal(cfg.decision.tieMargin, 0.25);
});

test('配置里使用会漂移的别名会被拒绝；未知字段会被拒绝；权重和不为 1 会被拒绝', () => {
  const dir = tempDir();
  const f = path.join(dir, 'c.json');
  writeFileSync(f, JSON.stringify({ models: { claude: { model: 'opus' } } }));
  assert.throws(() => loadConfig(f, dir), /别名/);
  writeFileSync(f, JSON.stringify({ unknownKey: 1 }));
  assert.throws(() => loadConfig(f, dir));
  writeFileSync(f, JSON.stringify({ criteriaWeights: { fit: 0.9 } }));
  assert.throws(() => loadConfig(f, dir), /之和必须为 1/);
  writeFileSync(f, JSON.stringify({ host: '0.0.0.0' }));
  assert.throws(() => loadConfig(f, dir)); // 只允许 127.0.0.1
  writeFileSync(f, JSON.stringify({ docWriter: { role: 'claude', effort: 'ultra' } }));
  assert.throws(() => loadConfig(f, dir), /不支持强度 ultra/);
});

test('Cursor 显示名与工具策略按结构加载，旧能力保留但不启用', () => {
  const dir = tempDir();
  const file = path.join(dir, 'cursor.json');
  const capabilities = {
    verifiedAt: '2026-10-23T10:00:00.000Z', cliVersion: 'test-version', model: 'grok-4.7-high-fast',
    stdinPromptVerified: true, readOnlyToolsVerified: true, commandExitEventsVerified: false, fileChangesVerified: false,
  };
  const save = (cap: object) => writeFileSync(file, JSON.stringify({ adapters: { cursor: { command: { command: process.execPath }, capabilities: cap } } }));
  save(capabilities);
  let config = loadConfig(file, dir);
  assert.equal(cursorAvailability(config.models.grok.model, config.adapters.cursor.capabilities).available, false);
  save({ ...capabilities, reportedModel: 'Grok 4.7 256K High Fast', toolPolicy: 'deny_all', commandBinding: { file: process.execPath, prefixArgs: [] } });
  config = loadConfig(file, dir);
  assert.equal(cursorAvailability(config.models.grok.model, config.adapters.cursor.capabilities, config.adapters.cursor.command).available, true);
  save({ ...capabilities, reportedModel: ' ', toolPolicy: 'deny_all' });
  assert.throws(() => loadConfig(file, dir));
  save({ ...capabilities, reportedModel: 'Grok 4.7 256K High Fast', toolPolicy: 'allow_all' });
  assert.throws(() => loadConfig(file, dir));
});
