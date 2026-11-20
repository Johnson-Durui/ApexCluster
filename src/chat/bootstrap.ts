import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statfsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import type { WorkbenchConfig } from '../config.js';
import { loadModelRegistry } from '../providers/registry.js';
import { readModelVerification } from '../providers/verification.js';
import { createApiChatBinding } from './api-driver.js';
import { createChatDrivers } from './drivers.js';
import { createChatHttp, NativeDirectorySelector } from './http.js';
import { ChatRuntime, type ChatRuntimeOptions, type WorkspaceToolHost } from './runtime.js';
import { ChatStore } from './store.js';

import { WorkspaceRegistry } from './workspace.js';
import { WorkspaceGateway } from './gateway.js';
import { SandboxRunner, validateSandboxCapability, type SandboxCapability } from './runner.js';
import { RunnerRouter } from './runner-router.js';
import type { CommandRunner, RunnerAvailability, RunnerCommandInfo } from './runner-contract.js';
import { createWindowsMxcRunner } from './runner-windows.js';
import { loadWslTestRunner } from './runner-wsl.js';
import { SessionFiles } from './session-files.js';
import { ExtensionHost } from './extensions/index.js';
import { NativeCodexMediaProvider } from './codex-native-media.js';
import { CourseCapabilities, DocumentProvider } from './document-provider.js';
import { validateChatWindowsJobReceiptRoot } from './windows-job-process.js';
import { ProjectOutputStore } from '../artifacts/project-output.js';
import { loadRoster } from './roster.js';
import { parseContextSettings } from './window.js';
import { parseApiRunSettings } from './api-run-settings.js';
import { createExecBackend } from '../exec/factory.js';
import { parseExecSettings } from '../exec/settings.js';
import { ExecTools } from '../exec/tools.js';
import { parsePipelineSettings } from '../pipeline/state.js';
import type { Roster } from './roster.js';

/** Shared by the desktop and production-policy acceptance producers; callers cannot disable it. */
export function createProductionChatRuntime(options: Omit<ChatRuntimeOptions, 'executionPolicyVersion'>): ChatRuntime {
  return new ChatRuntime({ ...options, executionPolicyVersion: 1 });
}

export const DEFAULT_CHAT_ROOT = path.join('data', 'chat');
const MODULE_CONFIG_ROOT = fileURLToPath(new URL('../../config/', import.meta.url));

const chatSettingsSchema = z.object({
  driverMode: z.enum(['api', 'cli']).optional(),
  dataRoot: z.string().optional(),
  capabilitiesFile: z.string().optional(),
  rosterFile: z.string().optional(),
  gates: z.unknown().optional(),
  context: z.unknown().optional(),
  scheduler: z.unknown().optional(),
  budget: z.unknown().optional(),
  recovery: z.unknown().optional(),
  quality: z.unknown().optional(),
  exec: z.unknown().optional(),
}).strict();

function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function shippedConfigFile(cwd: string, name: string): string {
  const local = path.join(cwd, 'config', name);
  return existsSync(local) ? local : path.join(MODULE_CONFIG_ROOT, name);
}

/** 只载入已有实测证明；应用启动不会执行隔离探针或推理。 */
export function loadChatRunners(dataRoot: string) {
  const backends: Partial<Record<'windows' | 'linux', CommandRunner>> = {};
  const platforms: RunnerAvailability[] = [];
  const windowsFile = path.join(dataRoot, 'capabilities', 'runner-windows.json');
  try {
    const runner = existsSync(windowsFile) ? createWindowsMxcRunner(JSON.parse(readFileSync(windowsFile, 'utf8'))) : null;
    if (runner) backends.windows = runner;
    platforms.push({ platform: 'windows', available: !!runner, ...(runner ? {} : { reason: 'Windows MXC 本机隔离证明缺失、无效或已漂移' }) });
  } catch (error) { platforms.push({ platform: 'windows', available: false, reason: `Windows MXC 证明无效：${error instanceof Error ? error.message : String(error)}` }); }
  const linux = loadWslTestRunner(path.join(dataRoot, 'capabilities', 'runner-wsl.json'), { workRootWindows: path.join(dataRoot, 'work') });
  if (linux.runner) backends.linux = linux.runner;
  platforms.push(linux.availability);
  const legacyFile = path.join(dataRoot, 'capabilities', 'runner.json');
  if (existsSync(legacyFile)) {
    try {
      const proof = JSON.parse(readFileSync(legacyFile, 'utf8')) as SandboxCapability;
      const reason = validateSandboxCapability(proof);
      if (!reason && !backends[proof.platform]) {
        backends[proof.platform] = new SandboxRunner(proof);
        const availability = platforms.find(item => item.platform === proof.platform)!;
        availability.available = true; delete availability.reason;
      }
    } catch { /* 无效的旧 wrapper 证明不会影响独立平台的已验证能力。 */ }
  }
  const runner = Object.keys(backends).length ? new RunnerRouter(backends) : undefined;
  return { runner, availability: { available: !!runner, reason: runner ? undefined : '受控测试 runner 缺少有效的本机隔离证明', platforms, commands: runner?.commandInfo() ?? [] } };
}
/** A headless run can own its chat journal while sharing the configured capabilities and grants. */
export interface BootstrapChatOverrides { driverMode?: 'api' | 'cli'; dataRoot?: string; isolatedSession?: boolean }
export function bootstrapChats(config: WorkbenchConfig, bridgeToken: string, cwd = process.cwd(), workspaceHost?: (registry: WorkspaceRegistry) => WorkspaceToolHost,
  overrides: BootstrapChatOverrides = {}) {
  let dataRoot = path.resolve(cwd, DEFAULT_CHAT_ROOT);
  try {
    const file = path.join(cwd, 'config', 'chat.config.json');
    const settings = chatSettingsSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
    // Existing local configs predate driverMode and retain CLI semantics. A clean
    // checkout with no local override follows the repository's API default.
    const driverMode = overrides.driverMode ?? settings.driverMode ?? (existsSync(file) ? 'cli' : 'api');
    const apiContext = driverMode === 'api' ? parseContextSettings(settings.context) : undefined;
    const apiRunSettings = driverMode === 'api' ? parseApiRunSettings(settings) : undefined;
    const execSettings = driverMode === 'api' ? parseExecSettings(settings.exec) : undefined;
    const pipelineSettings = driverMode === 'api' ? parsePipelineSettings(settings) : undefined;
    dataRoot = overrides.dataRoot ? path.resolve(overrides.dataRoot) : settings.dataRoot ? resolveFrom(cwd, settings.dataRoot) : path.resolve(cwd, DEFAULT_CHAT_ROOT);
    if (driverMode === 'api') {
      const environment = path.join(cwd, '.env');
      if (existsSync(environment)) process.loadEnvFile(environment);
    }
    mkdirSync(dataRoot, { recursive: true });
    const info = statfsSync(dataRoot);
    if (info.bavail * info.bsize < 256 * 1024 * 1024) throw new Error('聊天数据盘可用空间少于256MiB');
    const probe = path.join(dataRoot, `.write-check-${process.pid}`); writeFileSync(probe, 'ok', { flag: 'wx' }); unlinkSync(probe);
    let sessionRoot = dataRoot;
    if (overrides.isolatedSession) {
      const runs = path.join(dataRoot, 'pipeline-runs');
      mkdirSync(runs, { recursive: true, mode: 0o700 });
      sessionRoot = mkdtempSync(path.join(runs, 'run-'));
    }
    const workRoot = path.join(dataRoot, 'work'); mkdirSync(workRoot, { recursive: true });
    const sessionWork = path.join(sessionRoot, 'work');
    if (sessionRoot !== dataRoot) mkdirSync(sessionWork, { mode: 0o700 });
    const registry = new WorkspaceRegistry(workRoot);
    const picker = new NativeDirectorySelector(registry);
    let runner: CommandRunner | undefined;
    let availability: { available: boolean; reason?: string; platforms: RunnerAvailability[]; commands: RunnerCommandInfo[] };
    let drivers: ChatRuntimeOptions['drivers'] = {};
    let api: ChatRuntimeOptions['api'];
    let pipelineRosters: ReadonlyMap<string, Roster> | undefined;
    if (driverMode === 'cli') {
      validateChatWindowsJobReceiptRoot(workRoot);
      const configuredReceiptRoot = path.join(workRoot, 'job-receipts'); mkdirSync(configuredReceiptRoot, { recursive: true, mode: 0o700 });
      validateChatWindowsJobReceiptRoot(configuredReceiptRoot);
      chmodSync(configuredReceiptRoot, 0o700);
      const receiptRoot = validateChatWindowsJobReceiptRoot(configuredReceiptRoot);
      ({ runner, availability } = loadChatRunners(dataRoot));
      drivers = createChatDrivers(config, { bridgeUrl: `http://127.0.0.1:${config.port}`, bridgeToken, capabilitiesFile: settings.capabilitiesFile ? resolveFrom(cwd, settings.capabilitiesFile) : path.join(dataRoot, 'capabilities', 'models.json'), receiptRoot });
    } else {
      ({ runner, availability } = loadChatRunners(dataRoot));
      const registryFile = shippedConfigFile(cwd, 'models.registry.json');
      const modelRegistry = loadModelRegistry(path.dirname(registryFile));
      const rosterFile = settings.rosterFile ? resolveFrom(cwd, settings.rosterFile) : shippedConfigFile(cwd, 'roster.json');
      api = createApiChatBinding(loadRoster(rosterFile, modelRegistry), modelRegistry, readModelVerification(dataRoot), {
        context: apiContext,
      });
      pipelineRosters = new Map([
        ['flagship', api.roster],
        ['single-provider', loadRoster(shippedConfigFile(cwd, 'presets/roster.single-provider.json'), modelRegistry)],
      ]);
    }
    const projectOutputs = new ProjectOutputStore(registry);
    const store = new ChatStore(sessionRoot); const files = new SessionFiles(store, projectOutputs);
    const documents: DocumentProvider = new DocumentProvider(files, () => extensions.settings().documentWorker);
    let extensions!: ExtensionHost;
    const nativeMedia = new NativeCodexMediaProvider({ config, proofFile:path.join(dataRoot,'capabilities','native-media.json'), scratchRoot:sessionWork, settings:()=>extensions.settings().media.codex, readFile:(chat,fileId)=>files.read(chat,fileId), inspectImage:(file,signal)=>documents.inspectImage(file,signal) });
    extensions = new ExtensionHost({ configFile: path.join(dataRoot, 'config', 'chat-services.json'), readFile: (chat, fileId) => files.read(chat, fileId), listFiles: chat => files.list(chat), inspectImage: (file, signal) => documents.inspectImage(file, signal), nativeMedia });
    const capabilities = new CourseCapabilities(documents, extensions);
    const executor = execSettings ? new ExecTools(createExecBackend(execSettings, runner), path.join(sessionWork, 'exec'), execSettings.docker) : undefined;
    const browserExecutor = execSettings?.backend === 'docker' && execSettings.docker && execSettings.browserImage
      ? new ExecTools(createExecBackend({ ...execSettings, installNetwork: false,
        docker: { ...execSettings.docker, image: execSettings.browserImage } }), path.join(sessionWork, 'exec-browser'), execSettings.docker)
      : undefined;
    const workspace = workspaceHost?.(registry) ?? new WorkspaceGateway(registry, runner);
    const runtime = createProductionChatRuntime({ store, drivers, ...(api ? { api, apiRunSettings, executor, browserExecutor, pipelineSettings, pipelineRosters,
      ...(workspace instanceof WorkspaceGateway ? { pipelineWorkspace: workspace } : {}) } : {}), workspace, capabilities, projectOutputs, requireCostConfirmation: true });
    return { runtime, registry, picker, sessionRoot, http: createChatHttp({ runtime, registry, picker, bridgeToken, port: config.port, dataRoot: sessionRoot, runner: availability }) };
  } catch (error) {
    const unavailableReason = `聊天运行层未启动：${error instanceof Error ? error.message : String(error)}`;
    return { runtime: undefined, registry: undefined, picker: undefined, http: createChatHttp({ bridgeToken, port: config.port, dataRoot, unavailableReason }) };
  }
}
