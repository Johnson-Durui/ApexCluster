import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FORBIDDEN_MODEL_ALIASES } from '../adapters/types.js';
import type { ModelSpec } from './types.js';

const aliases = new Set([
  ...FORBIDDEN_MODEL_ALIASES, 'latest', 'gpt', 'grok', 'gemini', 'deepseek',
  'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
]);
const id = z.string().max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]+$/).refine(value =>
  !aliases.has(value.toLowerCase()) && !/(^|[-:])latest$/i.test(value) && !value.includes('..'));
const keyName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const label = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const count = z.number().int().positive();
const price = z.number().nonnegative();
const pricing = z.object({
  asOf: z.iso.date(),
  inputPerMTok: price,
  cachedInputPerMTok: price.optional(),
  cacheWritePerMTok: price.optional(),
  outputPerMTok: price,
  longContext: z.object({
    aboveInputTokens: count,
    inputMultiplier: z.number().positive(),
    outputMultiplier: z.number().positive(),
  }).strict().optional(),
}).strict();

const baseUrl = z.url().refine(value => {
  const url = URL.parse(value);
  if (!url) return false;
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || (loopback && url.protocol === 'http:'));
});
const efforts = z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).min(1)
  .refine(values => new Set(values).size === values.length);
const defaultVendors: Record<ModelSpec['protocol'], readonly string[]> = {
  'anthropic-messages': ['anthropic'],
  'openai-responses': ['openai', 'xai', 'deepseek'],
  'google-genai': ['google'],
  'openai-chat': ['openai'],
};
const specSchema = z.object({
  id,
  provider: label,
  family: label,
  protocol: z.enum(['anthropic-messages', 'openai-responses', 'google-genai', 'openai-chat']),
  baseUrl: baseUrl.optional(),
  apiKeyEnv: keyName,
  contextWindow: count,
  maxInputTokens: count.optional(),
  maxOutputTokens: count,
  efforts,
  pricing: pricing.optional(),
}).strict().refine(model => model.maxOutputTokens <= model.contextWindow &&
  (model.maxInputTokens ?? model.contextWindow) <= model.contextWindow).refine(model =>
  model.baseUrl !== undefined || defaultVendors[model.protocol].includes(model.provider), { path: ['baseUrl'] });
const registrySchema = z.object({ version: z.literal(1), models: z.array(specSchema).min(1) }).strict();

/** Parse complete model records without echoing invalid (possibly secret) values. */
export function parseModelRegistry(value: unknown): Map<string, ModelSpec> {
  const result = registrySchema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map(issue => issue.path.join('.') || 'registry');
    throw new Error(`Invalid model registry fields: ${[...new Set(fields)].join(', ')}`);
  }
  const models = new Map(result.data.models.map(model => [model.id, model]));
  if (models.size !== result.data.models.length) throw new Error('Duplicate model ID in registry');
  return models;
}

function readJson(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path.basename(file)}`);
  }
}

/** Local records replace entries by ID. Every override supplies the full model specification. */
export function loadModelRegistry(configDir = fileURLToPath(new URL('../../config/', import.meta.url))): Map<string, ModelSpec> {
  const registry = parseModelRegistry(readJson(path.join(configDir, 'models.registry.json')));
  let local: unknown;
  try {
    local = readJson(path.join(configDir, 'models.registry.local.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return registry;
  }
  for (const [id, model] of parseModelRegistry(local)) registry.set(id, model);
  return registry;
}

/** Fail closed on unknown model IDs and unsupported reasoning bindings. */
export function requireModel(registry: ReadonlyMap<string, ModelSpec>, modelId: string, effort: string): ModelSpec {
  const model = registry.get(modelId);
  if (!model) throw new Error('Model ID is not registered');
  if (!model.efforts.includes(effort)) throw new Error('Model does not support the configured effort');
  return model;
}

/** Bind an API listing proof to the exact parsed configuration. */
export function modelSpecHash(model: ModelSpec): string {
  return createHash('sha256').update(JSON.stringify(model)).digest('hex');
}
