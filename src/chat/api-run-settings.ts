import { z } from 'zod';
import type { ModelSpec, ProviderUsage } from '../providers/types.js';

const limit = z.number().int().positive().nullable();
const schedulerSchema = z.object({
  seatConcurrency: z.number().int().positive().default(6),
  fanoutMaxItemsPerCall: limit.default(null),
  workerMaxItemsPerCall: limit.default(null),
  parentOutstanding: limit.default(null),
  queued: limit.default(null),
}).strict();
const budgetSchema = z.object({
  maxUsd: z.number().finite().positive().nullable(),
  maxTokens: limit,
}).strict();
const recoverySchema = z.object({ autoResume: z.boolean().default(false) }).strict();

export type ApiBudget = z.infer<typeof budgetSchema>;
export const apiBudgetPatch = budgetSchema.partial().refine(value => Object.keys(value).length > 0);
export interface ApiRunSettings {
  scheduler: z.infer<typeof schedulerSchema>;
  budget: ApiBudget;
  recovery: z.infer<typeof recoverySchema>;
}

/** Validate API execution settings without affecting legacy chat config. */
export function parseApiRunSettings(input: { scheduler?: unknown; budget?: unknown; recovery?: unknown } = {}): ApiRunSettings {
  return {
    scheduler: schedulerSchema.parse(input.scheduler ?? {}),
    budget: budgetSchema.parse({ maxUsd: null, maxTokens: null, ...z.record(z.string(), z.unknown()).parse(input.budget ?? {}) }),
    recovery: recoverySchema.parse(input.recovery ?? {}),
  };
}

/** Estimated cost from a verified registry price and normalized usage. */
export function estimateUsageUsd(model: ModelSpec, usage: Omit<ProviderUsage, 'type'>): number | null {
  const pricing = model.pricing;
  if (!pricing) return null;
  const cached = usage.cachedInput;
  const writes = usage.cacheWrite ?? 0;
  const long = pricing.longContext && usage.input > pricing.longContext.aboveInputTokens ? pricing.longContext : undefined;
  const inputUsd = (usage.input - cached - writes) * pricing.inputPerMTok
    + cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok)
    + writes * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok);
  return (inputUsd * (long?.inputMultiplier ?? 1) + usage.output * pricing.outputPerMTok * (long?.outputMultiplier ?? 1)) / 1_000_000;
}

/** Use the most expensive input category for reservations made before usage is known. */
export function reserveUsageUsd(model: ModelSpec, input: number, output: number): number | null {
  const pricing = model.pricing;
  if (!pricing) return null;
  const long = pricing.longContext && input > pricing.longContext.aboveInputTokens ? pricing.longContext : undefined;
  const inputPrice = Math.max(pricing.inputPerMTok, pricing.cachedInputPerMTok ?? 0, pricing.cacheWritePerMTok ?? 0);
  return (input * inputPrice * Math.max(1, long?.inputMultiplier ?? 1) + output * pricing.outputPerMTok * Math.max(1, long?.outputMultiplier ?? 1)) / 1_000_000;
}
