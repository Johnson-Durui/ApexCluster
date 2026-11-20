/**
 * 模拟适配器：按场景返回与本次运行一致的结构化输出，模拟进度、延迟、取消和故障。
 * 产出一律 simulated=true；界面必须显著标注“模拟数据”。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdapterKind } from '../core/types.js';
import { MockFailure, mockOutput } from './mock-scenarios.js';
import { emptyMeta, type AdapterProgress, type AdapterResult, type ModelAdapter, type ModelTaskSpec } from './types.js';

export interface MockOptions {
  /** 每个任务的模拟耗时（毫秒）；测试里设为 0 */
  delayMs: number;
  /** 额外注入的故障：role.phase.attempt → 故障类型 */
  inject?: Record<string, MockFailure['kind']>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export class MockAdapter implements ModelAdapter {
  readonly kind: AdapterKind = 'mock';
  constructor(private readonly opts: MockOptions = { delayMs: 800 }) {}

  async run(spec: ModelTaskSpec, onProgress: (p: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult> {
    const startedAt = new Date().toISOString();
    const meta = emptyMeta('mock', spec, startedAt);
    meta.command = ['(模拟)', spec.role, spec.phase, `attempt=${spec.attempt}`];
    meta.processStarted = true;
    meta.reportedModels = [spec.model];
    meta.reportedModelSource = null;
    meta.modelConfirmed = false;
    meta.warnings.push('模拟数据：没有调用任何真实模型');
    const steps = ['读取需求快照', spec.phase === 'build' ? '编写代码并运行测试' : '分析中', '整理结构化输出'];
    const end = (r: Omit<AdapterResult, 'meta' | 'simulated'>): AdapterResult => {
      const endedAt = new Date().toISOString();
      return { ...r, meta: { ...meta, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt), sessionId: `mock-${spec.taskId}` }, simulated: true };
    };
    try {
      onProgress({ at: startedAt, kind: 'started', text: `模拟会话已启动（${spec.model} · ${spec.effort}）` });
      for (const s of steps) {
        await sleep(this.opts.delayMs / steps.length, signal);
        onProgress({ at: new Date().toISOString(), kind: 'info', text: s });
      }
      const injected = this.opts.inject?.[`${spec.role}.${spec.phase}.${spec.attempt}`];
      if (injected === 'hang') {
        await sleep(spec.timeoutMs, signal);
        return end({ status: 'timed_out', failure: { kind: 'timeout', message: '模拟：超时' }, rawText: null, structured: null, toolLog: [] });
      }
      if (injected === 'invalid_json') {
        return end({ status: 'succeeded', failure: null, rawText: '这不是 JSON', structured: null, toolLog: [] });
      }
      if (injected) throw new MockFailure(injected, `模拟故障：${injected}`);
      const prod = mockOutput(spec);
      const rawText = JSON.stringify(prod.output, null, 2);
      mkdirSync(spec.logDir, { recursive: true });
      writeFileSync(path.join(spec.logDir, 'final-message.txt'), rawText, 'utf8');
      return end({ status: 'succeeded', failure: null, rawText, structured: null, toolLog: prod.toolLog });
    } catch (e) {
      if (signal.aborted) return end({ status: 'cancelled', failure: { kind: 'cancelled', message: '已取消' }, rawText: null, structured: null, toolLog: [] });
      if (e instanceof MockFailure) {
        const kind = e.kind === 'invalid_json' || e.kind === 'hang' ? 'process_error' : e.kind;
        return end({ status: 'failed', failure: { kind, message: e.message }, rawText: null, structured: null, toolLog: [] });
      }
      return end({ status: 'failed', failure: { kind: 'process_error', message: (e as Error).message }, rawText: null, structured: null, toolLog: [] });
    }
  }
}
