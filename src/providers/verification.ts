import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../orchestrator/store.js';
import { modelSpecHash } from './registry.js';
import { safeProviderError } from './redact.js';
import type { ModelProvider, ModelSpec, WireProtocol } from './types.js';

const versionsSchema = z.object({ anthropic: z.string().min(1), openai: z.string().min(1), google: z.string().min(1) }).strict();
const modelCheck = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['verified', 'not_listed', 'error']),
  reason: z.string().optional(),
}).strict();
const verificationSchema = z.object({
  version: z.literal(1),
  checkedAt: z.iso.datetime(),
  sdkVersions: versionsSchema,
  models: z.array(modelCheck).min(1),
}).strict().refine(proof => new Set(proof.models.map(model => model.id)).size === proof.models.length);

export type ModelVerification = z.infer<typeof verificationSchema>;

const requireModule = createRequire(import.meta.url);

function installedVersion(packageName: string): string {
  let dir = path.dirname(requireModule.resolve(packageName));
  while (dir !== path.dirname(dir)) {
    let metadata: { name?: unknown; version?: unknown } | undefined;
    try {
      metadata = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (metadata?.name === packageName && typeof metadata.version === 'string') return metadata.version;
    dir = path.dirname(dir);
  }
  throw new Error(`Installed SDK version unavailable: ${packageName}`);
}

/** Record the versions actually loaded from disk, including in an installed package. */
export function providerSdkVersions(): ModelVerification['sdkVersions'] {
  return {
    anthropic: installedVersion('@anthropic-ai/sdk'),
    openai: installedVersion('openai'),
    google: installedVersion('@google/genai'),
  };
}

/** Identify every missing key before model listing starts. */
export function modelsMissingKeys(models: readonly ModelSpec[]): ModelSpec[] {
  return models.filter(model => !process.env[model.apiKeyEnv]?.trim());
}

/** Verify ID visibility once for each distinct API target. Listing does not test inference parameters. */
export async function verifyModelListings(
  models: readonly ModelSpec[],
  providerFor: (protocol: WireProtocol) => ModelProvider,
  signal: AbortSignal,
): Promise<ModelVerification> {
  if (modelsMissingKeys(models).length) throw new Error('Model listings require all selected API keys');
  const sdkVersions = providerSdkVersions();
  const listings = new Map<string, Promise<Set<string>>>();
  const checks = await Promise.all(models.map(async model => {
    type Check = z.infer<typeof modelCheck>;
    const common = { id: model.id, provider: model.provider, specHash: modelSpecHash(model) };
    const target = JSON.stringify([model.protocol, model.provider, model.baseUrl, model.apiKeyEnv]);
    try {
      let pending = listings.get(target);
      if (!pending) {
        pending = providerFor(model.protocol).listModels(model, signal).then(ids => new Set(ids));
        listings.set(target, pending);
      }
      const ids = await pending;
      if (ids.has(model.id)) return { ...common, status: 'verified' } satisfies Check;
      return { ...common, status: 'not_listed', reason: 'Configured API account did not list the exact model ID' } satisfies Check;
    } catch (error) {
      signal.throwIfAborted();
      const safe = safeProviderError(error, process.env[model.apiKeyEnv]?.trim() ?? '');
      return { ...common, status: 'error', reason: safe.message } satisfies Check;
    }
  }));
  return verificationSchema.parse({ version: 1, checkedAt: new Date().toISOString(), sdkVersions, models: checks });
}

/** Atomically replace verification results. Local configuration stays outside the proof. */
export function saveModelVerification(dataRoot: string, proof: ModelVerification): string {
  const validated = verificationSchema.parse(proof);
  const directory = path.join(dataRoot, 'capabilities');
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'models.api.json');
  writeFileAtomicSync(output, `${JSON.stringify(validated, null, 2)}\n`);
  return output;
}

/** Missing or invalid proofs leave API bindings unavailable. */
export function readModelVerification(dataRoot: string): ModelVerification | null {
  try {
    return verificationSchema.safeParse(JSON.parse(readFileSync(path.join(dataRoot, 'capabilities', 'models.api.json'), 'utf8'))).data ?? null;
  } catch {
    return null;
  }
}
