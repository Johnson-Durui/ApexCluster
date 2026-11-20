import { z } from 'zod/v4';
import { assertDockerResource, assertImmutableImage } from './policy.js';

const settingsSchema = z.object({
  backend: z.enum(['docker', 'wsl-bwrap', 'windows-mxc', 'local-unsafe']).default('docker'),
  installNetwork: z.boolean().default(false),
  browserImage: z.string().min(1).optional(),
  docker: z.object({
    image: z.string().min(1),
    cacheVolume: z.string().default('dmw-exec-package-cache'),
    memory: z.string().regex(/^\d+[mMgG]$/).optional(),
    cpus: z.number().finite().positive().optional(),
    pidsLimit: z.number().int().positive().optional(),
    user: z.string().regex(/^\d+:\d+$/).optional(),
    envAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).optional(),
    installCommands: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).optional(),
  }).strict().optional(),
}).strict();

export type ExecSettings = z.infer<typeof settingsSchema>;

/** Read local execution settings without pulling an image or making container changes. */
export function parseExecSettings(value: unknown): ExecSettings {
  const result = settingsSchema.parse(value ?? {});
  if (result.browserImage) assertImmutableImage(result.browserImage);
  if (result.docker) {
    assertImmutableImage(result.docker.image);
    assertDockerResource(result.docker.cacheVolume, 'Docker 缓存卷');
  }
  return result;
}
