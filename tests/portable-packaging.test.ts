import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDir } from './helpers.js';

interface PortableSources {
  config: Record<string, unknown>;
  dataSource: string | null;
  configSource: string;
  dataSourceKind: string;
}

async function helper(): Promise<{
  applyPortablePreferences(base: unknown, override: unknown): Record<string, unknown>;
  resolvePortableSources(input: { project: string; includeData: boolean; upgradeFrom: string | null }): PortableSources;
}> {
  const url = pathToFileURL(path.resolve('scripts/desktop/portable-sources.mjs')).href;
  return await import(url);
}

test('portable upgrade keeps current capabilities, overlays user settings, and imports the portable data directory', async () => {
  const root = tempDir('dmw-portable-upgrade-');
  const project = path.join(root, 'project');
  const oldPackage = path.join(root, 'old-package');
  mkdirSync(path.join(project, 'config'), { recursive: true });
  mkdirSync(path.join(oldPackage, 'app', 'config'), { recursive: true });
  mkdirSync(path.join(oldPackage, 'data'), { recursive: true });
  writeFileSync(path.join(project, 'config', 'workbench.config.json'), JSON.stringify({
    port: 5170,
    models: { sol: { model: 'gpt-6.1-sol', effort: 'max' } },
    adapters: {
      claude: { command: { command: 'current-claude', args: ['current-safe-arg'] }, isolationArgs: ['safe-isolation'] },
      codex: { command: null, ignoreUserConfig: true },
      cursorWriter: { capabilities: { workspaceWriteVerified: true, cliVersion: 'new' } },
    },
    build: { lightReworkEnabled: false, maxRounds: 2, resumePolicy: 'never' },
    contextBudget: { enabled: false },
  }));
  writeFileSync(path.join(oldPackage, 'app', 'config', 'workbench.config.json'), JSON.stringify({
    port: 5199,
    dataDir: '../data',
    workspacesRoot: 'D:/portable-workspaces',
    docWriter: { role: 'astra', effort: 'max' },
    models: { sol: { model: 'stale-or-malicious-model', effort: 'low' } },
    build: { lightReworkEnabled: true, maxRounds: 99, resumePolicy: 'budgeted' },
    contextBudget: { enabled: true },
    adapters: {
      claude: { command: { command: 'user-claude', args: ['--unsafe-old-arg'] }, isolationArgs: ['unsafe-old-isolation'] },
      codex: { command: { command: 'user-codex', args: ['--unsafe-old-arg'] }, ignoreUserConfig: false },
      cursorWriter: { capabilities: { workspaceWriteVerified: false, cliVersion: 'old' } },
    },
  }));

  const { resolvePortableSources } = await helper();
  const result = resolvePortableSources({ project, includeData: false, upgradeFrom: oldPackage });
  assert.equal(result.dataSource, path.join(oldPackage, 'data'));
  assert.equal(result.dataSourceKind, 'portable-upgrade');
  assert.deepEqual(result.config, {
    port: 5199,
    workspacesRoot: 'D:/portable-workspaces',
    docWriter: { role: 'astra', effort: 'max' },
    models: { sol: { model: 'gpt-6.1-sol', effort: 'max' } },
    adapters: {
      claude: { command: { command: 'user-claude' }, isolationArgs: ['safe-isolation'] },
      codex: { command: { command: 'user-codex' }, ignoreUserConfig: true },
      cursorWriter: { capabilities: { workspaceWriteVerified: true, cliVersion: 'new' } },
    },
    build: { lightReworkEnabled: false, maxRounds: 2, resumePolicy: 'never' },
    contextBudget: { enabled: false },
  });
});

test('portable upgrade rejects a source without its config or data directory', async () => {
  const root = tempDir('dmw-portable-invalid-');
  const project = path.join(root, 'project');
  const oldPackage = path.join(root, 'old-package');
  mkdirSync(path.join(project, 'config'), { recursive: true });
  mkdirSync(oldPackage, { recursive: true });
  writeFileSync(path.join(project, 'config', 'workbench.config.json'), '{}');
  const { resolvePortableSources } = await helper();
  assert.throws(
    () => resolvePortableSources({ project, includeData: false, upgradeFrom: oldPackage }),
    /升级源缺少配置/,
  );
});
