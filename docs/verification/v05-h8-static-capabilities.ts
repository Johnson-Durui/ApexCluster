/**
 * H8 的零推理调用能力快照。
 *
 * 只运行 CLI 的版本、帮助、特性和模型目录命令；不发送模型提示词，
 * 不读取登录凭证，不把目录窗口或 help 文本提升为运行时上下文事实。
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.js';
import { resolveCommand, scrubEnv, type ResolvedCommand } from '../../src/adapters/process.js';

const OUTPUT_ROOT = path.resolve('work/v05-acceptance-20261026/h8');
const TARGET_MODELS = new Set(['gpt-6-astra', 'gpt-6.1-sol']);
const TARGET_FEATURES = ['async_compaction', 'context_management'] as const;

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CatalogModel {
  slug?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  auto_compact_token_limit?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

function run(command: ResolvedCommand, args: string[], env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command.file, [...command.prefixArgs, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function firstLine(text: string): string | null {
  return text.trim().split(/\r?\n/, 1)[0] || null;
}

function parseCatalog(text: string) {
  const parsed = JSON.parse(text) as { models?: CatalogModel[] };
  return (parsed.models ?? [])
    .filter(item => typeof item.slug === 'string' && TARGET_MODELS.has(item.slug))
    .map(item => ({
      slug: item.slug as string,
      displayName: typeof item.display_name === 'string' ? item.display_name : null,
      contextWindow: Number.isSafeInteger(item.context_window) && (item.context_window as number) > 0
        ? item.context_window as number
        : null,
      autoCompactTokenLimit: Number.isSafeInteger(item.auto_compact_token_limit) && (item.auto_compact_token_limit as number) > 0
        ? item.auto_compact_token_limit as number
        : null,
      defaultReasoningLevel: typeof item.default_reasoning_level === 'string' ? item.default_reasoning_level : null,
      supportedReasoningLevels: Array.isArray(item.supported_reasoning_levels)
        ? item.supported_reasoning_levels.flatMap(level => {
            if (!level || typeof level !== 'object') return [];
            const effort = (level as { effort?: unknown }).effort;
            return typeof effort === 'string' ? [effort] : [];
          })
        : [],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface FeatureEvidence {
  name: typeof TARGET_FEATURES[number];
  found: boolean;
  maturity: string | null;
  enabled: boolean | null;
  lineNumber: number | null;
  evidenceLine: string | null;
}

/** 保留目标 flag 的有界精确行；不从相似名称或缺字段的行猜测状态。 */
export function parseFeatureEvidence(text: string): FeatureEvidence[] {
  const lines = text.split(/\r?\n/);
  return TARGET_FEATURES.map(name => {
    const lineIndex = lines.findIndex(line => new RegExp(`^${name}(?:\\s|$)`).test(line));
    if (lineIndex < 0) return { name, found: false, maturity: null, enabled: null, lineNumber: null, evidenceLine: null };
    const evidenceLine = lines[lineIndex]!.trim().slice(0, 240);
    const match = new RegExp(`^${name}\\s+(.+?)\\s+(true|false)$`).exec(evidenceLine);
    return {
      name,
      found: true,
      maturity: match?.[1]?.trim() || null,
      enabled: match?.[2] === 'true' ? true : match?.[2] === 'false' ? false : null,
      lineNumber: lineIndex + 1,
      evidenceLine,
    };
  });
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function conservativeH8Conclusion(input: {
  claudeHelp: string;
  codexFeatures: FeatureEvidence[];
  bundledCatalog: ReturnType<typeof parseCatalog>;
  refreshedCatalog: ReturnType<typeof parseCatalog>;
}) {
  const refreshed = new Map(input.refreshedCatalog.map(item => [item.slug, item]));
  const bundled = new Map(input.bundledCatalog.map(item => [item.slug, item]));
  const features = new Map(input.codexFeatures.map(item => [item.name, item]));
  return {
    catalogWindowsObserved: [...TARGET_MODELS].sort().map(slug => ({
      slug,
      refreshed: refreshed.get(slug)?.contextWindow ?? null,
      bundled: bundled.get(slug)?.contextWindow ?? null,
      consistent: refreshed.get(slug)?.contextWindow != null
        && refreshed.get(slug)?.contextWindow === bundled.get(slug)?.contextWindow,
    })),
    helpAndFeatureObservations: {
      claudeAutocompactListed: /(?:^|\s)--autocompact(?:\s|[=,]|$)/m.test(input.claudeHelp),
      claudeAutocompactRangeListed: /100k[–-]1M tokens/i.test(input.claudeHelp),
      codexAsyncCompaction: features.get('async_compaction') ?? null,
      codexContextManagement: features.get('context_management') ?? null,
    },
    runtimeContextWindow: null,
    usageSemantics: 'unknown' as const,
    compactions: null,
    canEnableResume: false,
    classification: {
      catalogWindow: 'observed_not_runtime_verified',
      usageSemantics: 'unobservable_from_single_turn',
      compactionEvents: 'unverified',
      autoCompactEffect: 'unverified',
    },
  };
}

export async function main() {
  const config = loadConfig();
  const claude = resolveCommand('claude', { override: config.adapters.claude.command });
  const codex = resolveCommand('codex', { override: config.adapters.codex.command });
  if (!claude || !codex) throw new Error('Claude 或 Codex CLI 不可用');

  const claudeEnv = scrubEnv(process.env, config.adapters.claude.scrubEnvKeys).env;
  const codexEnv = scrubEnv(process.env, config.adapters.codex.scrubEnvKeys).env;
  const [claudeVersion, claudeHelp, codexVersion, codexFeatures, bundledCatalog, refreshedCatalog] = [
    run(claude, ['--version'], claudeEnv),
    run(claude, ['--help'], claudeEnv),
    run(codex, ['--version'], codexEnv),
    run(codex, ['features', 'list'], codexEnv),
    run(codex, ['debug', 'models', '--bundled'], codexEnv),
    run(codex, ['debug', 'models'], codexEnv),
  ];
  const commands = { claudeVersion, claudeHelp, codexVersion, codexFeatures, bundledCatalog, refreshedCatalog };
  for (const [name, result] of Object.entries(commands)) {
    if (result.exitCode !== 0) throw new Error(`${name} 失败：${result.stderr.trim().slice(0, 500)}`);
  }

  const bundled = parseCatalog(bundledCatalog.stdout);
  const refreshed = parseCatalog(refreshedCatalog.stdout);
  const features = parseFeatureEvidence(codexFeatures.stdout);
  if (bundled.length !== TARGET_MODELS.size || refreshed.length !== TARGET_MODELS.size) {
    throw new Error('模型目录缺少 H8 目标型号');
  }
  const conclusion = conservativeH8Conclusion({
    claudeHelp: claudeHelp.stdout,
    codexFeatures: features,
    bundledCatalog: bundled,
    refreshedCatalog: refreshed,
  });
  const report = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    inferenceCalls: 0,
    cli: {
      claude: { version: firstLine(claudeVersion.stdout || claudeVersion.stderr), path: claude.file, sha256: await sha256(claude.file) },
      codex: { version: firstLine(codexVersion.stdout || codexVersion.stderr), path: codex.file, sha256: await sha256(codex.file) },
    },
    catalogs: { bundled, refreshed },
    features,
    conclusion,
    evidencePolicy: [
      '模型目录窗口是当前 CLI 的能力观察值，不是当前会话占用或服务端运行时确认。',
      '单轮 usage 无法区分每轮上下文与累计消耗，语义保持 unknown。',
      '没有制造超长上下文；缺少压缩事件不能写成 0 次压缩。',
      '帮助或特性列表仅证明表面存在，不能证明参数实际生效。',
    ],
  };
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const output = path.join(OUTPUT_ROOT, 'static-capabilities.json');
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output, inferenceCalls: 0, cli: report.cli, conclusion }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
