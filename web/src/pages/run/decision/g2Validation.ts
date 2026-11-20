import type { G2Input } from '../../../lib/types';

export type G2Spec = G2Input['specs'][number];
export type G2BuildOverride = NonNullable<G2Input['buildOverrides']>[string];
export interface G2LightReworkContext { configuredEnabled: boolean; exactModel: boolean; evaluatorEnabled: boolean; contextBudgetEnabled: boolean; capabilityAvailable: boolean; capabilityReason?: string }

export function lightReworkG2BlockReason(context: G2LightReworkContext): string | null {
  if (!context.configuredEnabled) return '创建运行时未启用 Grok 轻量返工，旧记录不能在 G2 补开';
  if (!context.exactModel) return 'Grok 必须固定为 grok-4.7-high-fast · High';
  if (!context.capabilityAvailable) return context.capabilityReason || 'Cursor WSL 写入能力不可用';
  if (!context.evaluatorEnabled) return '必须启用 Astra 独立评审';
  if (context.contextBudgetEnabled) return '与 T12 构建上下文会话预算不能同时开启';
  return null;
}

export function nextAcceptanceId(acceptance: G2Spec['acceptance']): string {
  const used = new Set(acceptance.map((item) => item.id.trim()));
  let index = 1;
  while (used.has(`AC${index}`)) index += 1;
  return `AC${index}`;
}

export function validateG2Specs(candidateIds: string[], specs: G2Spec[]): string[] {
  const errors: string[] = [];
  if (candidateIds.length < 1 || candidateIds.length > 3) errors.push('请选择 1–3 个候选进入验证');
  for (const candidateId of candidateIds) {
    const spec = specs.find((item) => item.candidateId === candidateId);
    if (!spec) {
      errors.push(`候选 ${candidateId} 缺少 MVP 规格`);
      continue;
    }
    if (!spec.goal.trim()) errors.push(`候选 ${candidateId} 的 MVP 目标不能为空`);
    if (spec.acceptance.length === 0) errors.push(`候选 ${candidateId} 至少需要一项验收标准`);
    const ids = new Set<string>();
    for (const criterion of spec.acceptance) {
      const id = criterion.id.trim();
      if (!id) errors.push(`候选 ${candidateId} 的验收项编号不能为空`);
      else if (ids.has(id)) errors.push(`候选 ${candidateId} 的验收项编号 ${id} 重复`);
      else ids.add(id);
      if (!criterion.description.trim()) errors.push(`${candidateId} · ${criterion.id} 的验收说明不能为空`);
      if (criterion.kind === 'command' && !criterion.command?.trim()) errors.push(`${candidateId} · ${criterion.id} 是命令型验收项，必须填写 PowerShell 命令`);
    }
    if (spec.timeboxMinutes < 10 || spec.timeboxMinutes > 600) errors.push(`${candidateId} 的时间上限需在 10–600 分钟之间`);
  }
  return errors;
}

export function validateBuildOverrides(candidateIds: string[], overrides: Record<string, G2BuildOverride>, lightContext?: G2LightReworkContext): string[] {
  const errors: string[] = [];
  const ranges = [
    ['maxRounds', '构建轮数', 1, 4],
    ['maxWriterSessions', '写者会话上限', 1, 100],
    ['maxModelCalls', '模型调用上限', 1, 200],
    ['maxActiveMinutes', '模型主动时间上限', 1, 1440],
  ] as const;
  for (const candidateId of candidateIds) {
    const value = overrides[candidateId];
    if (!value) continue;
    for (const [key, label, min, max] of ranges) {
      const number = value[key];
      if (number !== undefined && (!Number.isInteger(number) || number < min || number > max)) errors.push(`候选 ${candidateId} 的${label}需在 ${min}–${max} 之间`);
    }
    if (value.lightReworkMinutes !== undefined && (!Number.isInteger(value.lightReworkMinutes) || value.lightReworkMinutes < 1 || value.lightReworkMinutes > 15)) errors.push(`候选 ${candidateId} 的 Grok 轻量返工时间需在 1–15 分钟之间`);
    if (value.lightReworkEnabled && lightContext) {
      const reason = lightReworkG2BlockReason(lightContext);
      if (reason) errors.push(`候选 ${candidateId} 不能启用 Grok 轻量返工：${reason}`);
    }
  }
  return errors;
}
