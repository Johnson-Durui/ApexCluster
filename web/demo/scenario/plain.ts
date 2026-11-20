// Plain chats (README.md "Scenario"): any text other than the RoomDesk prompt. The lead seat answers honestly that
// this is a static demo with preset replies and points to ▶ 播放完整演示. The answer arrives through the same events
// as a real turn (task_updated, invocation_started, context_usage, stream_delta, invocation_ended, message,
// task_updated completed). No api_usage: the server emits usage only for pipeline chats.
import { DemoChat, type ChatDriver, type InputResult, type ServerTask } from '../mock/chat-engine';
import { SEAT, addTask, addTurn, appendMessage, cancelAll, complete, context, emitMessage, end, isActive, say, start, taskUpdate } from '../mock/chat-ops';
import type { Script } from '../mock/chat-scheduler';

const ANSWER = [
  '这是一个静态在线演示：页面里的回复都是预先写好的，没有连接任何模型，也不会读写你电脑上的文件，所以我没法真正处理刚才这条消息。',
  '想看多 Agent 协作的完整过程，请点击页面底部的 ▶ 播放完整演示（新聊天页面上的“播放完整演示”链接也可以）。它从一句需求开始：Claude 统筹，Carbon、Astra、Opus 做架构互评，Grok、Hydrogen、Mini 并行调研，Sol 与 Opus 交叉实现，Astra 独立验收；关卡 A 和关卡 B 会停下来等你确认，最后交付一个可运行的会议室预约工具、它的自动化测试和全部文档。',
  '要在自己的项目上使用，请在本机安装工作台，配置模型密钥后再发送需求。',
];
const PIPELINE_NOTE = '你选择了流水线模式。在线演示只预置了“会议室预约工具”这一条流水线，其他需求不会启动流水线。';

export function cannedAnswer(pipelineRequested: boolean): string {
  return (pipelineRequested ? [ANSWER[0], PIPELINE_NOTE, ...ANSWER.slice(1)] : ANSWER).join('\n\n');
}

export class PlainDriver implements ChatDriver {
  readonly kind: string = 'plain';

  constructor(protected readonly pipelineRequested = false) {}

  /** runtime.send: a new turn when the lead is idle; otherwise the message joins the running turn (steering). */
  send(chat: DemoChat, text: string, clientMessageId: string): InputResult {
    const running = chat.record.tasks.find(task => !task.parentTaskId && isActive(task));
    if (running) {
      const message = appendMessage(chat, { role: 'user', text, clientMessageId, turnId: running.turnId, accepted: true });
      chat.record.constraintMessageIds.push(message.id);
      emitMessage(chat, message);
      return { ok: true, message };
    }
    const turnId = chat.rng.uuid();
    const message = appendMessage(chat, { role: 'user', text, clientMessageId, turnId, accepted: true });
    const root = addTask(chat, { turnId, role: 'claude', goal: text.slice(0, 2000) });
    addTurn(chat, root, message.createdAt);
    chat.record.constraintMessageIds.push(message.id);
    taskUpdate(chat, root);
    emitMessage(chat, message);
    chat.sched.spawn(this.reply(chat, root, cannedAnswer(this.pipelineRequested)));
    return { ok: true, message };
  }

  gate(): InputResult {
    return { ok: false, status: 409, error: '该关卡当前未开放' };
  }

  answer(chat: DemoChat, ticketId: string): InputResult {
    void chat; void ticketId;
    return { ok: false, status: 409, error: '该问题已回答或不存在。' };
  }

  cancel(chat: DemoChat): void {
    cancelAll(chat);
  }

  /** The lead's single-invocation answer: start, context, streamed text, end, final message, completed. */
  protected *reply(chat: DemoChat, root: ServerTask, text: string): Script {
    yield chat.rng.int(600, 900);
    const input = 4200 + chat.rng.int(0, 900);
    const invocation = start(chat, root, SEAT.claude, input);
    yield chat.rng.int(300, 500);
    context(chat, root, invocation, input);
    yield chat.rng.int(900, 1400);
    yield* say(chat, root, invocation, text);
    yield chat.rng.int(200, 400);
    end(chat, root, invocation, { used: input + 600, output: 600, finishReason: 'stop' });
    emitMessage(chat, appendMessage(chat, { role: 'assistant', text, turnId: root.turnId, taskId: root.id }), { task: root, invocation });
    complete(chat, root, text);
  }
}

/** A new plain chat (POST /api/chats). The pipeline option is recorded but not run: only RoomDesk has a script. */
export function createPlainChat(options: { id: string; wallBase: number; title: string; workspaceId?: string; pipelineRequested?: boolean }): DemoChat {
  const chat = new DemoChat({ id: options.id, title: options.title, wallBase: options.wallBase, ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}) });
  chat.driver = new PlainDriver(Boolean(options.pipelineRequested));
  return chat;
}
