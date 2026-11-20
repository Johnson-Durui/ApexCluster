import { z } from 'zod';
import type { ModelSpec, ProviderInput } from '../providers/types.js';

const tokenCount = z.number().int().positive();
const policySchema = z.object({
  softTokens: tokenCount,
  hardTokens: tokenCount,
  hardRatio: z.number().positive().max(0.85),
  initialMaxTokens: tokenCount,
  maxOutputTokens: tokenCount,
  maxToolActions: tokenCount.nullable(),
  maxMinutes: z.number().positive(),
}).strict();
export type ContextPolicy = z.infer<typeof policySchema>;
const patchSchema = policySchema.partial();
const contextSchema = z.object({
  seats: patchSchema.optional(),
  pools: patchSchema.optional(),
  overrides: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), patchSchema).optional(),
  hardRatio: policySchema.shape.hardRatio.optional(),
}).strict();
export type ContextSettings = z.infer<typeof contextSchema>;

const seatPolicy: ContextPolicy = {
  softTokens: 160_000, hardTokens: 240_000, hardRatio: 0.5,
  initialMaxTokens: 40_000, maxOutputTokens: 64_000, maxToolActions: 120, maxMinutes: 45,
};
const poolPolicy: ContextPolicy = {
  softTokens: 64_000, hardTokens: 96_000, hardRatio: 0.5,
  initialMaxTokens: 24_000, maxOutputTokens: 32_000, maxToolActions: 80, maxMinutes: 30,
};

export interface WindowLimits {
  soft: number;
  hard: number;
  ceiling: number;
  initialMaxTokens: number;
  outputReserve: number;
}

/** Parse optional local policy overrides before starting any API window. */
export function parseContextSettings(value: unknown): ContextSettings {
  const parsed = contextSchema.safeParse(value ?? {});
  if (!parsed.success) throw new Error(`API 窗口配置无效：${parsed.error.issues.map(issue => issue.path.join('.') || 'context').join(', ')}`);
  return parsed.data;
}

/** Merge a seat or pool override onto its documented defaults. */
export function contextPolicy(settings: ContextSettings | undefined, seatOrPool: string, worker: boolean): ContextPolicy {
  const group = worker ? settings?.pools : settings?.seats;
  const override = settings?.overrides && Object.hasOwn(settings.overrides, seatOrPool) ? settings.overrides[seatOrPool] : undefined;
  return { ...(worker ? poolPolicy : seatPolicy), ...(settings?.hardRatio ? { hardRatio: settings.hardRatio } : {}), ...group, ...override };
}

/** Derive conservative request bounds from the registered model and policy. */
export function resolveLimits(model: ModelSpec, policy: ContextPolicy): WindowLimits {
  const physical = model.maxInputTokens ?? model.contextWindow;
  const ceiling = Math.floor(physical * 0.85);
  const hard = Math.min(policy.hardTokens, Math.floor(physical * policy.hardRatio), ceiling);
  if (hard < 2) throw new Error('注册型号的窗口不足以容纳 API 请求');
  const outputReserve = Math.min(policy.maxOutputTokens, model.maxOutputTokens, Math.floor(hard / 2));
  return {
    soft: Math.min(policy.softTokens, hard - 1), hard, ceiling, outputReserve,
    initialMaxTokens: Math.min(policy.initialMaxTokens, hard - outputReserve),
  };
}

const requestOverhead = 32;

/** Conservative estimate for serialized material, starting at two UTF-8 bytes per token. */
export function estimateTokens(value: unknown, calibration = 1): number {
  return requestOverhead + Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') * Math.max(1, calibration) / 2);
}

/** Learn only upward from additional input tokens, bounded by a one-byte-per-token envelope. */
export function calibrateEstimate(previous: number, estimatedTokens: number, actualTokens: number): number {
  if (estimatedTokens <= requestOverhead || actualTokens <= estimatedTokens) return previous;
  return Math.max(previous, Math.min(2, previous * actualTokens / estimatedTokens));
}

/** Check the request and its output reservation before sending anything to the provider. */
export function assessWindow(used: number, next: ProviderInput, limits: WindowLimits, calibration: number): {
  projected: number; ceilingProjected: number; warn: boolean; rotate: boolean; estimatedDelta: number;
} {
  const estimatedDelta = estimateTokens(next, calibration);
  const input = used + estimatedDelta;
  const projected = input + limits.outputReserve;
  const ceilingProjected = used + estimateTokens(next, 2) + limits.outputReserve;
  return { projected, ceilingProjected, warn: input >= limits.soft,
    rotate: projected > limits.hard || ceilingProjected > limits.ceiling, estimatedDelta };
}

export const WINDOW_REMINDER = '本窗口即将换窗：做完手上这一步，用 notes_write 更新笔记，然后调用 task_yield。';
