import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../orchestrator/store.js';

const REGISTRY_NAME = 'unconfirmed-processes.json';

interface DispatchBlockRegistry {
  schema: 1;
  records: Array<{ key: string; warning: string; recordedAt: string }>;
}

function registryFile(dataDir: string): string {
  return path.join(path.resolve(dataDir), REGISTRY_NAME);
}

function loadRegistry(dataDir: string): { registry: DispatchBlockRegistry | null; error: string | null } {
  const file = registryFile(dataDir);
  if (!existsSync(file)) return { registry: null, error: null };
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) return { registry: null, error: '阻断登记文件不是普通文件' };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点不是对象');
    const candidate = parsed as Partial<DispatchBlockRegistry>;
    if (candidate.schema !== 1 || !Array.isArray(candidate.records) || candidate.records.length === 0) throw new Error('schema 或 records 无效');
    for (const record of candidate.records) {
      if (!record || typeof record !== 'object'
        || typeof record.key !== 'string' || !record.key.trim()
        || typeof record.warning !== 'string' || !record.warning.trim()
        || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
        throw new Error('记录字段无效');
      }
    }
    return { registry: candidate as DispatchBlockRegistry, error: null };
  } catch (error) {
    return { registry: null, error: `阻断登记文件损坏：${(error as Error).message}` };
  }
}

export function dispatchBlockReason(dataDir: string): string | null {
  const loaded = loadRegistry(dataDir);
  if (loaded.error) return loaded.error;
  const first = loaded.registry?.records[0];
  return first ? `存在未确认退出的模型进程（${first.key}，${first.recordedAt}）：${first.warning}` : null;
}

export function assertDispatchSafe(dataDir: string): void {
  const reason = dispatchBlockReason(dataDir);
  if (reason) throw new Error(`模型派发已锁定：${reason}`);
}

export function recordUnconfirmedProcess(dataDir: string, key: string, warning: string): void {
  const cleanKey = key.trim();
  const cleanWarning = warning.trim();
  if (!cleanKey || !cleanWarning) throw new Error('未确认进程记录必须包含 key 和 warning');
  mkdirSync(path.resolve(dataDir), { recursive: true });
  const loaded = loadRegistry(dataDir);
  if (loaded.error) throw new Error(loaded.error);
  if (loaded.registry) return;
  const registry: DispatchBlockRegistry = {
    schema: 1,
    records: [{ key: cleanKey.slice(0, 200), warning: cleanWarning.slice(0, 1000), recordedAt: new Date().toISOString() }],
  };
  writeFileAtomicSync(registryFile(dataDir), `${JSON.stringify(registry, null, 2)}\n`);
}
