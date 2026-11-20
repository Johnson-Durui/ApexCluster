import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function portableCommand(value) {
  if (value === null) return null;
  if (value && typeof value === 'object' && typeof value.command === 'string' && value.command.trim()) {
    return { command: value.command };
  }
  return undefined;
}

/**
 * Migrate only reviewed user preferences. The current source configuration is
 * authoritative for models, arguments, sandboxing, capabilities, budgets and
 * every other execution or safety policy.
 */
export function applyPortablePreferences(current, previous) {
  const result = structuredClone(current);
  if (!previous || typeof previous !== 'object') return result;
  if (Number.isInteger(previous.port) && previous.port >= 1024 && previous.port <= 65535) result.port = previous.port;
  if (typeof previous.workspacesRoot === 'string' && previous.workspacesRoot.trim()) result.workspacesRoot = previous.workspacesRoot;

  const roles = new Set(['claude', 'astra', 'sol']);
  const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  if (previous.docWriter && typeof previous.docWriter === 'object') {
    result.docWriter ??= {};
    if (roles.has(previous.docWriter.role)) result.docWriter.role = previous.docWriter.role;
    if (efforts.has(previous.docWriter.effort)) result.docWriter.effort = previous.docWriter.effort;
  }

  for (const adapter of ['claude', 'codex']) {
    const command = portableCommand(previous.adapters?.[adapter]?.command);
    if (command === undefined) continue;
    result.adapters ??= {};
    result.adapters[adapter] ??= {};
    result.adapters[adapter].command = command;
  }
  return result;
}

export function resolvePortableSources({ project, includeData, upgradeFrom }) {
  const projectConfigFile = path.join(project, 'config', 'workbench.config.json');
  const projectConfig = fs.existsSync(projectConfigFile) ? readJson(projectConfigFile) : {};
  if (!upgradeFrom) {
    return {
      config: projectConfig,
      dataSource: includeData ? path.resolve(project, projectConfig.dataDir ?? 'data') : null,
      configSource: projectConfigFile,
      dataSourceKind: includeData ? 'project' : 'none',
    };
  }

  const root = path.resolve(upgradeFrom);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`升级源不是目录：${root}`);
  const configFile = path.join(root, 'app', 'config', 'workbench.config.json');
  const dataSource = path.join(root, 'data');
  if (!fs.existsSync(configFile) || !fs.statSync(configFile).isFile()) throw new Error(`升级源缺少配置：${configFile}`);
  if (!fs.existsSync(dataSource) || !fs.statSync(dataSource).isDirectory()) throw new Error(`升级源缺少数据目录：${dataSource}`);
  return {
    config: applyPortablePreferences(projectConfig, readJson(configFile)),
    dataSource,
    configSource: configFile,
    dataSourceKind: 'portable-upgrade',
  };
}
