/**
 * 启动：npm start（或双击 scripts/start.cmd）。只监听 127.0.0.1。
 */
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { CursorAdapter } from '../adapters/cursor.js';
import { CursorWslWriterAdapter } from '../adapters/cursor-writer.js';
import { MockAdapter } from '../adapters/mock.js';
import type { ModelAdapter } from '../adapters/types.js';
import { loadConfig } from '../config.js';
import type { ModelRole, Run } from '../core/types.js';
import { randomToken } from '../core/util.js';
import { EventBus } from '../orchestrator/events.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { pruneUnusedReferenceArchives } from '../orchestrator/reference-store.js';
import { RunStore } from '../orchestrator/store.js';
import { createApp } from './app.js';
import { bootstrapChats } from '../chat/bootstrap.js';
import type { ChatRuntime } from '../chat/runtime.js';
import type { NativeDirectorySelector } from '../chat/http.js';

export interface WorkbenchRuntime {
  server: Server;
  orchestrator: Pick<Orchestrator, 'shutdown'>;
  chats?: ChatRuntime;
  directoryPicker?: NativeDirectorySelector;
}

interface ShutdownHooks {
  log: (message: string) => void;
  error: (message: string, error: unknown) => void;
  setExitCode: (code: number) => void;
}

const defaultShutdownHooks: ShutdownHooks = {
  log: (message) => console.log(message),
  error: (message, error) => console.error(message, error),
  setExitCode: (code) => { process.exitCode = code; },
};

/** 停止接入新连接，取消全部模型任务，再断开长连接并等待监听端口释放。 */
export async function stopWorkbench(runtime: WorkbenchRuntime, timeoutMs = 8000): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    runtime.server.close((error) => error ? reject(error) : resolve());
  });
  let shutdownError: unknown;
  try {
    const results = await Promise.allSettled([runtime.orchestrator.shutdown(timeoutMs), runtime.chats?.shutdown(timeoutMs)]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } catch (error) {
    shutdownError = error;
  } finally {
    // SSE/keep-alive 连接会阻止 server.close() 完成；模型进程结束后再统一断开。
    runtime.server.closeAllConnections();
  }
  await closed;
  if (shutdownError) throw shutdownError;
}

/** 返回可重复调用的信号处理器；第二次调用复用同一个关闭过程。 */
export function createShutdownHandler(runtime: WorkbenchRuntime, hooks: ShutdownHooks = defaultShutdownHooks): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  return () => {
    if (stopping) return stopping;
    hooks.log('正在停止：取消进行中的模型调用并结束其进程树……');
    stopping = stopWorkbench(runtime).then(
      () => {
        hooks.log('工作台已停止，监听端口已释放。');
        hooks.setExitCode(0);
      },
      (error) => {
        hooks.error('工作台停止时发生错误：', error);
        hooks.setExitCode(1);
        throw error;
      },
    );
    return stopping;
  };
}

export function startWorkbench(): WorkbenchRuntime {
  const config = loadConfig();
  const store = new RunStore(config.dataDir);
  // 只有完整读取所有运行后才清理过期的未引用上传；保留所有历史快照的原件。
  try {
    const retained = new Set(store.listIds().flatMap(id => {
      const run = store.load(id);
      if (!run) throw new Error(`无法读取运行 ${id}`);
      return run.snapshots.flatMap(snapshot => snapshot.project.referenceArchives?.map(archive => archive.id) ?? []);
    }));
    const removed = pruneUnusedReferenceArchives(config.dataDir, retained);
    if (removed) console.log(`已清理 ${removed} 个超过 7 天未引用的临时 ZIP 上传。`);
  } catch (error) {
    console.warn('跳过参考附件清理：', error instanceof Error ? error.message : String(error));
  }
  const bus = new EventBus(store);
  const mock = new MockAdapter({ delayMs: config.adapters.mock.delayMs });
  const claude = new ClaudeCodeAdapter(config.adapters.claude);
  const codex = new CodexAdapter(config.adapters.codex);
  const cursor = new CursorAdapter(config.adapters.cursor);
  const cursorWriter = new CursorWslWriterAdapter(config.adapters.cursorWriter);
  const cursorRouter: ModelAdapter = { kind: 'cursor', run: (spec, progress, signal) =>
    (spec.phase === 'build' ? cursorWriter : cursor).run(spec, progress, signal) };

  function adapterFor(role: ModelRole, run: Run): ModelAdapter {
    if (run.mode === 'mock') return mock;
    const kind = run.models[role]?.adapter;
    if (!kind) throw new Error(`运行未冻结 ${role} 的执行端，不能补默认`);
    if (kind === 'claude-code') return claude;
    if (kind === 'codex') return codex;
    if (kind === 'cursor') return cursorRouter;
    return mock;
  }

  const orchestrator = new Orchestrator({ config, store, bus, adapterFor });
  const token = randomToken();
  const chats = bootstrapChats(config, randomToken());
  const handler = createApp({ config, orchestrator, bus, token, chatHttp: chats.http, staticDir: path.join(process.cwd(), 'web', 'dist') });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(config.port, config.host, () => {
    // 取得监听端口后才恢复任务；重复启动失败时不得改动正在运行的任务状态。
    orchestrator.recover();
    chats.runtime?.recover();
    console.log(`双模型架构工作台：http://${config.host}:${config.port}`);
    console.log(`数据目录：${config.dataDir}`);
    console.log(`Sol 工作区：${config.workspacesRoot}`);
  });

  const runtime = { server, orchestrator, chats: chats.runtime, directoryPicker: chats.picker };
  const shutdown = createShutdownHandler(runtime);
  // createShutdownHandler 已记录失败并设置非零退出码；信号回调必须消费 rejection，
  // 否则 Node 会把优雅关闭失败升级成未处理 Promise rejection。
  process.once('SIGINT', () => { void shutdown().catch(() => undefined); });
  process.once('SIGTERM', () => { void shutdown().catch(() => undefined); });
  return runtime;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) startWorkbench();
