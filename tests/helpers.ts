import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockAdapter, type MockOptions } from '../src/adapters/mock.js';
import { defaultConfig, type WorkbenchConfig } from '../src/config.js';
import { CreateRunInputZ, type CreateRunInput } from '../src/core/schemas.js';
import { EventBus } from '../src/orchestrator/events.js';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';

const created: string[] = [];
process.on('exit', () => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上文件可能仍被占用，忽略 */
    }
  }
});

/** 测试用临时目录；进程退出时自动删除 */
export function tempDir(prefix = 'dmw-'): string {
  const d = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), prefix));
  created.push(d);
  return d;
}

export function makeHarness(mock: Partial<MockOptions> = {}, cfgPatch: (c: WorkbenchConfig) => void = () => undefined, deps: Pick<OrchestratorDeps, 'preflightCheck' | 'now'> = {}) {
  const dir = tempDir();
  const config = defaultConfig(dir);
  config.dataDir = path.join(dir, 'data');
  config.workspacesRoot = path.join(dir, 'ws');
  config.preflight.enabled = false;
  cfgPatch(config);
  const store = new RunStore(config.dataDir);
  const bus = new EventBus(store);
  const adapter = new MockAdapter({ delayMs: 0, ...mock });
  const orch = new Orchestrator({ config, store, bus, adapterFor: () => adapter, ...deps });
  return { dir, config, store, bus, orch };
}

export function runInput(scenario: string, patch: Partial<CreateRunInput> = {}): CreateRunInput {
  return CreateRunInputZ.parse({
    title: '个人记账与预算工具',
    mode: 'mock',
    mockScenario: scenario,
    // Existing fixtures verify the pre-document flow; document tests opt in.
    writeDocs: false,
    writePrd: false,
    // 既有流程测试保持隔离；预检专项测试显式开启并注入假探测。
    preflightEnabled: false,
    // 既有流程夹具验证历史双架构师契约；新默认由专项测试覆盖。
    clarifyWith: 'both',
    designMode: 'dual',
    project: {
      prompt: '我想做一个只在自己 Windows 电脑上使用的记账与预算工具，通过浏览器操作。',
      coreFlows: ['手动记一笔支出或收入', '查看本月各分类花费与预算对比'],
    },
    constraints: [
      { text: '必须在 Windows 本机运行，不依赖云服务', kind: 'must' },
      { text: '必须通过浏览器访问界面', kind: 'must' },
    ],
    ...patch,
  });
}
