// 环境与连接 helpers (BUILD-SPEC-B §6.4). Pure: the page and its tests share them.
import type { ApiChatConfiguration, ServiceCapability } from '../../lib/chat-api';
import type { Effort, ExecutionMeta, ModelRole } from '../../lib/types';
import type { StatusKind } from '../../components/ui';

export type Finding = { id: string; level: 'ok' | 'warn' | 'error'; message: string; detail?: string };
export type ProbeReport = { at: string; platform: string; node: string; findings: Finding[]; tools: Record<string, { path: string | null; via: string | null; version: string | null }> };
export type LiveResult = { role: ModelRole; model: string; effort: Effort; status: string; outputValid: boolean; failure: { kind: string; message: string } | null; meta: ExecutionMeta };
export type ProbeResponse = { env: ProbeReport; live: LiveResult[] };
export type LiveTarget = { role: ModelRole; effort: Effort };

export const PROBE_TARGETS: { id: string; role: ModelRole; effort: Effort; label: string }[] = [
  { id: 'claude:max', role: 'claude', effort: 'max', label: 'Claude · Max' },
  { id: 'astra:max', role: 'astra', effort: 'max', label: 'Astra · Max' },
  { id: 'sol:max', role: 'sol', effort: 'max', label: 'Sol · Max' },
  { id: 'sol:ultra', role: 'sol', effort: 'ultra', label: 'Sol · Ultra' },
];

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
/** `win32 10.0.26300` → Windows / 10.0.26300. The probe reports no CPU architecture, so none is shown. */
export function platformParts(platform: string): { name: string; release: string } {
  const [os = '', ...rest] = platform.trim().split(/\s+/);
  return { name: PLATFORM_NAMES[os] ?? (os || '未知'), release: rest.join(' ') };
}

export function findingCounts(findings: Finding[]) {
  return { ok: findings.filter(item => item.level === 'ok').length, warn: findings.filter(item => item.level === 'warn').length, error: findings.filter(item => item.level === 'error').length };
}

export const levelKind: Record<Finding['level'], StatusKind> = { ok: 'ok', warn: 'child', error: 'err' };
export const levelText: Record<Finding['level'], string> = { ok: '正常', warn: '需注意', error: '有问题' };

/** The worst level among findings, as a nav glyph; null while nothing is known. */
export function findingsKind(report: ProbeReport | null): StatusKind | null {
  if (!report) return null;
  const counts = findingCounts(report.findings);
  return counts.error ? 'err' : counts.warn ? 'child' : 'ok';
}

export function toolsKind(report: ProbeReport | null): StatusKind | null {
  if (!report) return null;
  const tools = Object.values(report.tools);
  return tools.length && tools.every(tool => tool.path) ? 'ok' : 'child';
}

/** 运行状态: only `ready` counts as available (the same rule the settings panel states). */
export function servicesKind(services: ServiceCapability[] | undefined): StatusKind | null {
  if (!services) return null;
  const enabled = services.filter(service => service.state !== 'disabled');
  if (!enabled.length) return 'idle';
  return enabled.every(service => service.state === 'ready') ? 'ok' : 'child';
}

export function apiKind(configuration: ApiChatConfiguration | undefined): StatusKind | null {
  if (!configuration) return null;
  if (!configuration.keyReadiness.length && !configuration.modelChecks.length && !configuration.presets.length) return 'idle';   // nothing configured is not "ok"
  if (configuration.presets.length && !configuration.presets.some(preset => preset.available)) return 'err';
  const keysMissing = configuration.keyReadiness.some(key => !key.configured);
  const modelsUnsure = configuration.modelChecks.some(check => check.status !== 'verified' && check.status !== 'simulated');
  return keysMissing || modelsUnsure ? 'child' : 'ok';
}

export function liveLevel(result: LiveResult): Finding['level'] {
  return result.failure ? 'error' : result.outputValid ? 'ok' : 'warn';
}

export function liveKind(results: LiveResult[] | undefined): StatusKind | null {
  if (!results?.length) return null;
  const levels = results.map(liveLevel);
  return levels.includes('error') ? 'err' : levels.includes('warn') ? 'child' : 'ok';
}

export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
