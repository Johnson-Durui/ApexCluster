/** H8 的前置 smoke，不证明上下文语义。默认只显示计划；每次一个完整型号，无自动重试。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { liveProbe, type LiveProbeResult } from '../../src/probe.js';
import { modelReported } from '../../src/adapters/types.js';
import type { Effort } from '../../src/core/types.js';

export function h8ProbeRequest(args: string[]) {
  const allowed = new Set(['--yes', '--role=claude', '--role=astra', '--role=sol']);
  if (args.some(arg => !allowed.has(arg)) || args.filter(arg => arg.startsWith('--role=')).length !== 1) {
    throw new Error('用法：tsx docs/verification/v05-h8-probe.ts --role=claude|astra|sol [--yes]');
  }
  return { role: args.find(arg => arg.startsWith('--role='))!.slice(7) as 'claude' | 'astra' | 'sol', confirmed: args.includes('--yes') };
}

export function h8SmokeVerdict(result: LiveProbeResult) {
  const modelMismatch = result.meta.reportedModels.length > 0 && !modelReported(result.model, result.meta.reportedModels);
  const effortMismatch = result.meta.reportedEffort !== null && result.meta.reportedEffort !== result.effort;
  return {
    smokeOnly: true,
    smokeSucceeded: result.status === 'succeeded' && result.outputValid && !result.meta.terminationWarning && !modelMismatch && !effortMismatch,
    modelMismatch, effortMismatch,
    modelConfirmed: result.meta.modelConfirmed, effortConfirmed: result.meta.effortConfirmed,
    contextValidationComplete: false, canEnableResume: false,
    remaining: ['窗口版本绑定实测', 'usage/cached 口径', '压缩事件完整性', 'CLI 参数实际生效'],
  };
}

export async function main(args = process.argv.slice(2)) {
  const request = h8ProbeRequest(args);
  const config = loadConfig();
  const root = path.resolve('work/v05-completion-20261024');
  config.dataDir = path.join(root, 'data');
  config.workspacesRoot = path.join(root, 'ws');
  config.timeoutsMinutes.probe = 3;
  const effort: Effort = request.role === 'claude' ? config.finalReview.effort : config.models[request.role].effort;
  const plan = {
    experiment: 'H8-preflight-smoke', smokeOnly: true, role: request.role, model: config.models[request.role].model, effort,
    maxCalls: 1, timeoutMinutes: 3, sandbox: 'read_only', networkTools: false,
    resumeSessionId: null, automaticRetries: 0, credentialsReadByWorkbench: false,
    evidenceRoot: root, confirmed: request.confirmed,
  };
  console.log(JSON.stringify(plan));
  if (!request.confirmed) return;
  mkdirSync(root, { recursive: true });
  const result = (await liveProbe(config, [{ role: request.role, effort }]))[0]!;
  const verdict = h8SmokeVerdict(result);
  const file = path.join(root, `h8-${request.role}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ plan, result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ file, status: result.status, outputValid: result.outputValid, failure: result.failure,
    requestedModel: result.model, effort: result.effort, reportedModels: result.meta.reportedModels,
    modelConfirmed: result.meta.modelConfirmed, terminationWarning: result.meta.terminationWarning ?? null,
    durationMs: result.meta.durationMs, usage: result.meta.usage, reportedEffort: result.meta.reportedEffort,
    effortConfirmed: result.meta.effortConfirmed, warnings: result.meta.warnings, verdict }));
  if (!verdict.smokeSucceeded) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
