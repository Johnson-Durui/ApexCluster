import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { bootstrapChats } from '../src/chat/bootstrap.js';
import type { ChatEvent, ChatRecord } from '../src/chat/types.js';
import type { ChatRuntime } from '../src/chat/runtime.js';
import type { WorkspaceRegistry } from '../src/chat/workspace.js';
import { loadConfig } from '../src/config.js';
import { randomToken } from '../src/core/util.js';
import { pendingPipelineGate, type PipelineGateId } from '../src/pipeline/state.js';

export interface PipelineCliOptions { requirement: string; workspace: string; auto: boolean; preset: string }
export interface HeadlessSession { runtime: ChatRuntime; registry: WorkspaceRegistry; sessionRoot?: string }
export interface PipelineCliIo {
  out(line: string): void;
  error(line: string): void;
  isTTY: boolean;
  ask(question: string): Promise<string>;
}
export interface PipelineCliDependencies {
  createSession(options: PipelineCliOptions): Promise<HeadlessSession> | HeadlessSession;
  io: PipelineCliIo;
}

const usage = 'npm run pipeline -- --requirement <file> --workspace <directory> [--auto] [--preset <name>]';

export function parsePipelineArgs(argv: readonly string[]): PipelineCliOptions {
  let requirement: string | undefined;
  let workspace: string | undefined;
  let preset = 'flagship';
  let auto = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === '--auto') { auto = true; continue; }
    if (['--requirement', '--workspace', '--preset'].includes(item)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${item} 缺少参数。\n${usage}`);
      if (item === '--requirement') requirement = value;
      else if (item === '--workspace') workspace = value;
      else preset = value;
      continue;
    }
    throw new Error(`未知参数 ${item}。\n${usage}`);
  }
  if (!requirement || !workspace) throw new Error(`必须提供 --requirement 和 --workspace。\n${usage}`);
  if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(preset)) throw new Error('--preset 格式无效');
  return { requirement: path.resolve(requirement), workspace: path.resolve(workspace), auto, preset };
}

function defaultIo(): PipelineCliIo {
  return {
    out: line => console.log(line), error: line => console.error(line), isTTY: Boolean(stdin.isTTY && stdout.isTTY),
    ask: async question => {
      const reader = createInterface({ input: stdin, output: stdout });
      try { return await reader.question(`${question} `); } finally { reader.close(); }
    },
  };
}

function defaultSession(): HeadlessSession {
  const boot = bootstrapChats(loadConfig(), randomToken(), process.cwd(), undefined, { driverMode: 'api', isolatedSession: true });
  if (!boot.runtime || !boot.registry) throw new Error('流水线运行层不可用；请检查 config/chat.config.json、模型验证和执行后端');
  return { runtime: boot.runtime, registry: boot.registry, ...('sessionRoot' in boot ? { sessionRoot: boot.sessionRoot } : {}) };
}

function emit(io: PipelineCliIo, value: unknown): void { io.out(JSON.stringify(value)); }

async function gateDecision(io: PipelineCliIo, gateId: PipelineGateId): Promise<{ decision: 'confirm'|'revise'|'cancel'; feedback?: string }> {
  const answer = (await io.ask(`关卡 ${gateId}：输入 confirm、revise 或 cancel`)).trim().toLowerCase();
  if (answer === 'confirm') return { decision: 'confirm' };
  if (answer === 'cancel') return { decision: 'cancel' };
  if (answer === 'revise') {
    const feedback = (await io.ask('请输入修订要求：')).trim();
    if (!feedback) throw new Error('修订要求不能为空');
    return { decision: 'revise', feedback };
  }
  throw new Error('关卡决定必须是 confirm、revise 或 cancel');
}

export async function runPipelineCli(argv: readonly string[], dependencies?: Partial<PipelineCliDependencies>): Promise<number> {
  const io = dependencies?.io ?? defaultIo();
  let options: PipelineCliOptions;
  try {
    options = parsePipelineArgs(argv);
    if (!statSync(options.requirement).isFile()) throw new Error('--requirement 必须是文件');
    if (!statSync(options.workspace).isDirectory()) throw new Error('--workspace 必须是目录');
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let session: HeadlessSession;
  try { session = await (dependencies?.createSession ?? defaultSession)(options); }
  catch (error) { io.error(error instanceof Error ? error.message : String(error)); return 5; }
  const { runtime, registry } = session;
  let unsubscribe = () => {};
  try {
    const grant = registry.grantFromNativeSelection(options.workspace, registry.issueNativeSelectionRequest());
    const chat = runtime.create({ workspaceId: grant.id, pipeline: { preset: options.preset, auto: options.auto } });
    unsubscribe = runtime.subscribe(chat.id, (event: ChatEvent) => emit(io, { type: 'event', event: {
      type: event.type, seq: event.seq, taskId: event.taskId, invocationId: event.invocationId,
    } }));
    emit(io, { type: 'started', chatId: chat.id, workspaceId: grant.id, preset: options.preset, auto: options.auto,
      ...(session.sessionRoot ? { sessionRoot: session.sessionRoot } : {}) });
    runtime.send(chat.id, { text: readFileSync(options.requirement, 'utf8'), clientMessageId: `pipeline-cli-${Date.now()}`, confirmCost: true });
    for (;;) {
      await runtime.idle(60 * 60_000);
      const current: ChatRecord = runtime.get(chat.id);
      const stage = current.pipeline?.stage;
      if (stage === 'completed') { emit(io, { type: 'completed', chatId: chat.id, stage }); return 0; }
      if (stage === 'cancelled') { emit(io, { type: 'cancelled', chatId: chat.id, stage }); return 3; }
      const currentRoot = stage === 'architecture' || stage === 'gate-a'
        ? current.pipeline?.architectureTaskId : current.pipeline?.implementation?.rootTaskId;
      const failedTask = current.tasks.find(task => !task.parentTaskId && (!currentRoot || task.id === currentRoot)
        && ['failed', 'interrupted', 'cancelled'].includes(task.status));
      if (current.blockedReason || failedTask) {
        io.error(JSON.stringify({ type: 'failed', chatId: chat.id, stage, reason: current.blockedReason ?? failedTask?.error ?? failedTask?.status }));
        return 4;
      }
      const gateId = current.pipeline && pendingPipelineGate(current.pipeline);
      const ticket = current.tickets.find(item => item.type === 'user' && item.status === 'pending');
      if (!gateId && !ticket) { io.error(JSON.stringify({ type: 'stalled', chatId: chat.id, stage })); return 4; }
      if (!io.isTTY) {
        emit(io, { type: 'input_required', chatId: chat.id, ...(gateId ? { gateId } : { ticketId: ticket!.id, question: ticket!.question }) });
        return 3;
      }
      if (gateId) runtime.decidePipelineGate(chat.id, gateId, await gateDecision(io, gateId));
      else runtime.answer(chat.id, { ticketId: ticket!.id, text: await io.ask(ticket!.question ?? '请输入决定：'), clientMessageId: `pipeline-answer-${Date.now()}` });
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 4;
  } finally { unsubscribe(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runPipelineCli(process.argv.slice(2));
}
