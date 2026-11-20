import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import type { ExecContext, ExecSpec } from './types.js';

const secretName = /(api.?key|secret|token|password|passwd|credential|cookie|authorization|private.?key)/i;
const envName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const immutableImage = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64})$/;
const dockerResource = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const installers = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'cargo', 'go', 'dotnet', 'mvn', 'gradle']);

const rawExecSpec = z.object({
  argv: z.array(z.string().min(1).max(32_000)).min(1).max(256),
  cwd: z.string().max(1_024),
  env: z.record(z.string(), z.string().max(32_000)).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000),
  purpose: z.enum(['install', 'build', 'test', 'run']).optional(),
}).strict();

export interface ExecPolicyOptions {
  envAllowlist?: readonly string[];
  installCommands?: readonly string[];
}

export interface ResolvedExec {
  spec: ExecSpec;
  copyDir: string;
  outputDir: string;
  containerCwd: string;
}

function relativeCwd(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) || normalized.split('/').includes('..')) throw new Error('exec cwd 必须是工作副本内的相对路径');
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) throw new Error('exec cwd 不能离开工作副本');
  return clean === '.' ? '/workspace' : '/workspace/' + clean;
}

/** Parse a model-supplied command and apply the host's explicit environment whitelist. */
export function parseExecSpec(value: unknown, options: ExecPolicyOptions = {}): ExecSpec {
  const parsed = rawExecSpec.parse(value);
  const allow = new Set(options.envAllowlist ?? ['CI', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'NODE_ENV', 'NO_COLOR', 'PYTHONUNBUFFERED', 'RUST_BACKTRACE', 'TZ']);
  const env: Record<string, string> = {};
  for (const [name, content] of Object.entries(parsed.env ?? {})) {
    if (!envName.test(name) || secretName.test(name) || !allow.has(name)) throw new Error('exec 环境变量不在白名单：' + name);
    env[name] = content;
  }
  relativeCwd(parsed.cwd);
  return { ...parsed, ...(Object.keys(env).length ? { env } : { env: undefined }) };
}

/** Resolve only host-authorized directories. Symlink traversal inside the copy remains inside the container mount. */
export function resolveExec(value: unknown, context: ExecContext, options: ExecPolicyOptions = {}): ResolvedExec {
  const spec = parseExecSpec(value, options);
  if (!existsSync(context.copyDir) || !statSync(context.copyDir).isDirectory()) throw new Error('exec 工作副本不存在');
  mkdirSync(context.outputDir, { recursive: true });
  if (!statSync(context.outputDir).isDirectory()) throw new Error('exec 输出目录无效');
  const copyDir = realpathSync(context.copyDir);
  const outputDir = realpathSync(context.outputDir);
  if (copyDir.includes(',')) throw new Error('exec 工作副本路径包含 Docker mount 不支持的逗号');
  return { spec, copyDir, outputDir, containerCwd: relativeCwd(spec.cwd) };
}

export function installNetworkAllowed(spec: ExecSpec, enabled: boolean, commands?: readonly string[]): boolean {
  const allowed = new Set(commands ?? installers);
  return enabled && spec.purpose === 'install' && allowed.has(spec.argv[0]!);
}

export function assertImmutableImage(value: string): string {
  if (!immutableImage.test(value)) throw new Error('Docker 沙箱镜像必须固定到 sha256 ID 或仓库摘要');
  return value;
}

export function assertDockerResource(value: string, label: string): string {
  if (!dockerResource.test(value)) throw new Error(label + ' 必须是安全的 Docker 资源名');
  return value;
}
