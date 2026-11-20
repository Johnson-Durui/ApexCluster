// Pre-baked chats for the sidebar (README.md "Scenario"). Each one is produced by running its script in instant
// mode at page start, with timestamps in the past, so its final state is exactly what the live script would leave:
//   会议室预约工具 RoomDesk   the full pipeline, both gates confirmed by the user, completed
//   整理一份周报模板          plain chat: lead plus a Mini and a Hydrogen worker, one deliverable, completed
//   README 中英对照           plain chat waiting on a question; answering it finishes the turn with a short reply
// The ids are fixed, so a reload on #/?chat=<id> finds the same chat again.
import type { WaitTicket } from '../../src/lib/chat-api';
import { DemoChat, type ChatInput, type InputResult, type ServerInvocation, type ServerTask } from '../mock/chat-engine';
import {
  SEAT, addTask, addTurn, appendMessage, ask, complete, context, emitMessage, end, publish, resolve, say, start, taskUpdate, tool, toolResult, toolStart,
  waitFor, type SeatModel,
} from '../mock/chat-ops';
import type { Script } from '../mock/chat-scheduler';
import { registerText } from './content';
import { PlainDriver } from './plain';
import { createRoomDeskChat } from './roomdesk';
import readmeZh from '../public/demo-project/README.md?raw';

export interface SampleBuild { chat: DemoChat; inputs: ChatInput[] }
export interface SampleDefinition { key: string; id: string; offsetMs: number; build(wallBase: number): SampleBuild }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A child seat's single invocation: start, context, optional tool, streamed note, end, completed (adopted). */
function* childRun(chat: DemoChat, task: ServerTask, seat: SeatModel, input: number, note: string, toolName?: string, toolText?: string): Script {
  const invocation = start(chat, task, seat, input);
  yield chat.rng.int(300, 500);
  context(chat, task, invocation, input);
  yield chat.rng.int(700, 1300);
  if (toolName && toolText) yield* tool(chat, task, invocation, toolName, toolText);
  yield* say(chat, task, invocation, note);
  yield chat.rng.int(200, 400);
  end(chat, task, invocation, { used: input + 700, output: 700 });
  yield chat.rng.int(120, 240);
  complete(chat, task, note, 'adopted');
}

/** The first user message of a sample chat: turn, root task (queued), task_updated, message. */
function firstTurn(chat: DemoChat, text: string): ServerTask {
  const turnId = chat.rng.uuid();
  const message = appendMessage(chat, { role: 'user', text, clientMessageId: chat.rng.uuid(), turnId, accepted: true });
  const root = addTask(chat, { turnId, role: 'claude', goal: text });
  addTurn(chat, root, message.createdAt);
  chat.record.constraintMessageIds.push(message.id);
  taskUpdate(chat, root);
  emitMessage(chat, message);
  return root;
}

function finalAnswer(chat: DemoChat, root: ServerTask, invocation: ServerInvocation, text: string): void {
  emitMessage(chat, appendMessage(chat, { role: 'assistant', text, turnId: root.turnId, taskId: root.id }), { task: root, invocation });
  complete(chat, root, text);
}

// ---------------------------------------------------------------- 整理一份周报模板

const WEEKLY_PROMPT = '帮我整理一份团队周报模板：要有本周进展、风险和下周计划，简洁好填，一屏能看完。';
const WEEKLY_ANSWER = [
  '周报模板已整理好，见交付文件 周报模板.md。',
  '结构（控制在一屏以内）：',
  '1. 本周结论：一句话说清最重要的变化。\n2. 本周进展：表格，事项 / 目标 / 状态 / 结果。\n3. 风险与求助：写明影响、需要谁、期望时间。\n4. 下周计划：最多三项，按优先级排序。\n5. 数据（可选）：本周与上周对比。',
  '填写约定：没有内容的栏目写“无”，不要删除栏目；延期事项写明新的完成时间。文末附了一行填写检查，提交前对照即可。',
].join('\n\n');

function* weeklyTurn(chat: DemoChat, root: ServerTask): Script {
  yield 900;
  let invocation = start(chat, root, SEAT.claude, 5200);
  yield 400;
  context(chat, root, invocation, 5200);
  yield 1100;
  yield* say(chat, root, invocation, '先收集常见周报栏目，再统一格式和填写说明：Mini 列栏目，Hydrogen 检查篇幅和填写难度。');
  const mini = addTask(chat, { turnId: root.turnId, parent: root, role: 'mini', goal: '列出团队周报的常见栏目，并标出必填与可选' });
  const hydrogen = addTask(chat, { turnId: root.turnId, parent: root, role: 'hydrogen', goal: '检查模板篇幅与填写难度，给出精简建议' });
  yield* tool(chat, root, invocation, 'agent_submit', '已派发 Mini 列栏目、Hydrogen 检查篇幅。', () => { taskUpdate(chat, mini); taskUpdate(chat, hydrogen); });
  let ticket: WaitTicket | null = null;
  yield* tool(chat, root, invocation, 'task_collect', '等待 Mini、Hydrogen 回传。', () => { ticket = waitFor(chat, root, invocation, { childIds: [mini.id, hydrogen.id] }); });
  yield 300;
  end(chat, root, invocation, { used: 6100, output: 500, rotationReason: 'wait' });
  taskUpdate(chat, root);
  yield 700;
  yield { all: [
    childRun(chat, mini, SEAT.mini, 3800, '常见栏目：本周结论、进展、风险与求助、下周计划、数据指标。必填：结论、进展、风险、计划；数据可选。进展建议用表格，方便横向对比。'),
    childRun(chat, hydrogen, SEAT.hydrogen, 4400, '篇幅控制在一屏以内：结论一句话，进展最多 5 行，下周计划最多 3 项。每个栏目给一行示例或说明；没有内容写“无”而不是删除栏目，方便汇总。'),
  ] };
  resolve(chat, ticket!, root);
  yield 900;
  invocation = start(chat, root, SEAT.claude, 9600);
  yield 400;
  context(chat, root, invocation, 9600);
  yield 1300;
  yield* tool(chat, root, invocation, 'artifact_publish', '已发布 周报模板.md。', () => { publish(chat, root, invocation, 'weekly-template'); });
  yield* say(chat, root, invocation, WEEKLY_ANSWER);
  yield 300;
  end(chat, root, invocation, { used: 11800, output: 1400, finishReason: 'stop' });
  finalAnswer(chat, root, invocation, WEEKLY_ANSWER);
}

function buildWeekly(id: string, wallBase: number): SampleBuild {
  const chat = new DemoChat({ id, title: '整理一份周报模板', wallBase });
  chat.driver = new PlainDriver(false);
  const root = firstTurn(chat, WEEKLY_PROMPT);
  chat.sched.spawn(weeklyTurn(chat, root));
  return { chat, inputs: [] };
}

// ---------------------------------------------------------------- README 中英对照

const README_PROMPT = '把 RoomDesk 的 README 整理成中英对照版本，术语前后保持一致。';
const README_QUESTION = 'README 的英文版放在哪里？同一文件交替最直观，拆成两个文件更便于分别更新，只对照两节改动最小。';
const README_OPTIONS = ['同一文件内中英段落交替', '拆成 README.md 和 README.en.md 两个文件', '只把“运行”和“测试”两节做成中英对照'];

/** English versions of the README sections, in README order (title and intro, 运行, 测试, 目录, 规则摘要). */
const README_EN = [
  `# RoomDesk · Team Meeting Room Booking

A small web app with no third-party dependencies: browse each floor's room schedule, get a live conflict check with the nearest free slot while booking, and export one meeting or a whole day as an iCal (.ics) file.

On first load the page shows sample data (3 floors, 8 rooms and a few meetings today and tomorrow). All names and meetings are fictional; you can delete them and bring them back with "Restore sample data" in the footer.`,
  `## Running

The page is plain static files. Open \`index.html\` through any static server, for example:

\`\`\`bash
npx serve .
# or
python -m http.server 8000
\`\`\`

Browsers do not load module scripts from \`file://\`, so use HTTP. The page uses relative paths only and works under any sub-path.`,
  `## Testing

Requires Node.js 22 or later; no \`npm install\` is needed:

\`\`\`bash
npm test
\`\`\`

It runs \`node --test "tests/*-test.mjs"\`: 30 tests covering floor filtering, slot validation, conflict detection, free-slot suggestions, the storage format and iCal export (escaping, 75-byte folding, CRLF).`,
  `## Layout

| Path | Contents |
|---|---|
| \`index.html\` | Page structure |
| \`src/roomdesk-core.mjs\` | All booking rules as pure functions without DOM access, shared by the page and the tests |
| \`src/app.js\` | Page interaction, rendering and localStorage access |
| \`src/styles.css\` | Styles, system fonts only |
| \`tests/roomdesk-core-test.mjs\` | \`node:test\` tests |
| \`docs/\` | PRD, architecture, developer guide, acceptance record and requirement trace (shipped with the package) |`,
  `## Rules

- Working hours 08:00–21:00, a 15-minute grid, at most 4 hours per booking.
- Two bookings of the same room on the same day overlap by the half-open interval \`[start, end)\`; back-to-back bookings do not conflict.
- Exported .ics files use \`TZID=Asia/Shanghai\` and include a \`VTIMEZONE\`.
- Data stays in this browser's localStorage (key \`roomdesk:v1:state\`) and is never uploaded.`,
];

/** The Chinese README split at its '## ' headings: [title and intro, 运行, 测试, 目录, 规则摘要]. */
const README_ZH = readmeZh.trim().split(/\n(?=## )/).map(section => section.trim());

function readmeInterleaved(only?: Set<number>): string {
  return README_ZH.map((zh, index) => !only || only.has(index) ? `${zh}\n\n${README_EN[index] ?? ''}`.trim() : zh).join('\n\n') + '\n';
}

registerText('readme-interleaved', 'README.md', readmeInterleaved(), 'file');
registerText('readme-zh-linked', 'README.md', `[English](README.en.md) · 中文\n\n${README_ZH.join('\n\n')}\n`, 'file');
registerText('readme-en', 'README.en.md', `English · [中文](README.md)\n\n${README_EN.join('\n\n')}\n`, 'file');
registerText('readme-partial', 'README.md', readmeInterleaved(new Set([1, 2])), 'file');

const README_REPLIES = [
  '已按“同一文件内中英段落交替”整理好 README.md：每一节先中文、后英文，术语统一按 Mini 的术语表，命令、路径和键名保持原样。文件在交付文件里，可以直接预览。',
  '已拆成两个文件：README.md 保持中文，README.en.md 是英文版。两个文件开头互相链接，章节一一对应，术语统一按 Mini 的术语表。',
  '已把“运行”和“测试”两节做成中英对照，其余章节保持中文，改动最小；命令和路径保持原样。',
];

class ReadmeDriver extends PlainDriver {
  override readonly kind = 'readme';
  answerText = '';

  override answer(chat: DemoChat, ticketId: string, text?: string, clientMessageId?: string): InputResult {
    const ticket = chat.record.tickets.find(item => item.id === ticketId && item.type === 'user' && item.status === 'pending');
    const root = ticket ? chat.record.tasks.find(task => task.id === ticket.taskId) : undefined;
    if (!ticket || !root || !text?.trim()) return { ok: false, status: 409, error: '该问题已回答或不存在。' };
    // runtime.answer: append the message, resolve the ticket, queue the task, then the message event.
    const message = appendMessage(chat, { role: 'user', text, ...(clientMessageId ? { clientMessageId } : {}), turnId: root.turnId, taskId: root.id, accepted: true });
    chat.record.constraintMessageIds.push(message.id);
    ticket.status = 'resolved';
    ticket.resolvedAt = chat.iso();
    ticket.answer = text;
    chat.emit('ticket_updated', ticket, { task: root });
    if (!chat.record.tickets.some(item => item.taskId === root.id && item.status === 'pending')) taskUpdate(chat, root, { status: 'queued' });
    emitMessage(chat, message, { task: root });
    this.answerText = text;
    chat.sched.signal('answer', 900);
    return { ok: true, message };
  }
}

function* readmeTurn(chat: DemoChat, root: ServerTask, driver: ReadmeDriver): Script {
  yield 800;
  let invocation = start(chat, root, SEAT.claude, 7400);
  yield 400;
  context(chat, root, invocation, 7400);
  yield 1200;
  yield* say(chat, root, invocation, '先统一术语，再按你选的排版整理。Mini 提取 README 里的术语和固定说法。');
  const mini = addTask(chat, { turnId: root.turnId, parent: root, role: 'mini', goal: '提取 README 中的术语与固定说法，给出统一译法' });
  yield* tool(chat, root, invocation, 'agent_submit', '已派发 Mini 整理术语表。', () => taskUpdate(chat, mini));
  let ticket: WaitTicket | null = null;
  yield* tool(chat, root, invocation, 'task_collect', '等待 Mini 回传。', () => { ticket = waitFor(chat, root, invocation, { childIds: [mini.id] }); });
  yield 300;
  end(chat, root, invocation, { used: 8100, output: 400, rotationReason: 'wait' });
  taskUpdate(chat, root);
  yield 700;
  yield* childRun(chat, mini, SEAT.mini, 5200, '术语表：会议室 meeting room · 预约 booking · 楼层 floor · 冲突检测 conflict detection · 空闲时段 free slot · 示例数据 sample data · 本地存储 localStorage · 半开区间 half-open interval。命令、路径和键名保持原样，不翻译。',
    'user_source_read', '已读取 README.md（5 节）。');
  resolve(chat, ticket!, root);
  yield 900;

  // The lead asks how to lay the English version out, then waits for the visitor.
  invocation = start(chat, root, SEAT.claude, 9900);
  yield 400;
  context(chat, root, invocation, 9900);
  yield 1000;
  yield* say(chat, root, invocation, '术语已统一。英文版放在哪里，取决于你们怎么维护 README，需要你定一下。');
  const askId = toolStart(chat, root, invocation, 'ask_user');
  yield 500;
  ask(chat, root, invocation, README_QUESTION, README_OPTIONS);
  yield 200;
  toolResult(chat, root, invocation, askId, 'ask_user', '已向你提问，等待回答。');
  yield 300;
  end(chat, root, invocation, { used: 10600, output: 300, rotationReason: 'wait' });
  taskUpdate(chat, root);
  yield { wait: 'answer' };

  // Answered: Hydrogen translates, the lead publishes and replies.
  const choice = README_OPTIONS.indexOf(driver.answerText.trim());
  const variant = choice < 0 ? 0 : choice;
  invocation = start(chat, root, SEAT.claude, 11800);
  yield 400;
  context(chat, root, invocation, 11800);
  yield 900;
  yield* say(chat, root, invocation, choice < 0 ? `收到：“${driver.answerText.trim().slice(0, 60)}”。按同一文件内中英段落交替整理。Hydrogen 翻译并对齐段落。` : `按“${README_OPTIONS[variant]}”整理。Hydrogen 翻译并对齐段落。`);
  // Option 3 translates only the two sections 运行 and 测试 (readme-partial); the other options translate all five.
  const sections = variant === 2 ? ['运行', '测试'] : ['标题与简介', '运行', '测试', '目录', '规则摘要'];
  const hydrogen = addTask(chat, { turnId: root.turnId, parent: root, role: 'hydrogen',
    goal: variant === 2 ? '按术语表翻译 README 的“运行”“测试”两节，并与中文段落逐节对齐' : '按术语表翻译 README 各节，并与中文段落逐节对齐' });
  yield* tool(chat, root, invocation, 'agent_submit', '已派发 Hydrogen 翻译。', () => taskUpdate(chat, hydrogen));
  let second: WaitTicket | null = null;
  yield* tool(chat, root, invocation, 'task_collect', '等待 Hydrogen 回传。', () => { second = waitFor(chat, root, invocation, { childIds: [hydrogen.id] }); });
  yield 300;
  end(chat, root, invocation, { used: 12400, output: 500, rotationReason: 'wait' });
  taskUpdate(chat, root);
  yield 600;
  yield* childRun(chat, hydrogen, SEAT.hydrogen, variant === 2 ? 6100 : 9300, `已翻译 ${sections.length} 节并逐节对齐：${sections.join('、')}。术语按术语表统一，代码块、命令和键名保持原样。`, 'notes_write', `已写入英文译文（${sections.length} 节）。`);
  resolve(chat, second!, root);
  yield 800;
  invocation = start(chat, root, SEAT.claude, 15800);
  yield 400;
  context(chat, root, invocation, 15800);
  yield 900;
  const files = variant === 1 ? ['readme-zh-linked', 'readme-en'] : [variant === 2 ? 'readme-partial' : 'readme-interleaved'];
  for (const key of files) yield* tool(chat, root, invocation, 'artifact_publish', '已发布 README 文件。', () => { publish(chat, root, invocation, key); });
  const reply = README_REPLIES[variant];
  yield* say(chat, root, invocation, reply);
  yield 300;
  end(chat, root, invocation, { used: 17200, output: 600, finishReason: 'stop' });
  finalAnswer(chat, root, invocation, reply);
}

function buildReadme(id: string, wallBase: number): SampleBuild {
  const chat = new DemoChat({ id, title: 'README 中英对照', wallBase, workspaceId: 'w-roomdesk' });
  const driver = new ReadmeDriver(false);
  chat.driver = driver;
  const root = firstTurn(chat, README_PROMPT);
  chat.sched.spawn(readmeTurn(chat, root, driver));
  return { chat, inputs: [] };
}

// ---------------------------------------------------------------- the list

export const SAMPLES: SampleDefinition[] = [
  {
    key: 'roomdesk', id: 'chat-r7d3k9m2p5xa', offsetMs: 2 * 24 * HOUR + 3 * HOUR + 20 * MINUTE,
    build: wallBase => ({
      chat: createRoomDeskChat({ id: 'chat-r7d3k9m2p5xa', wallBase, clientMessageId: '6f1c2a9e-4b7d-4e2a-9c51-3d8e7a0b5f14', title: '会议室预约工具 RoomDesk', presetProject: true }),
      inputs: [
        { type: 'gate', gate: 'A', auto: false, delay: 41_000 },
        { type: 'gate', gate: 'B', auto: false, delay: 26_000 },
      ],
    }),
  },
  { key: 'weekly', id: 'chat-w4n8q2t6y1kc', offsetMs: 3 * HOUR + 12 * MINUTE, build: wallBase => buildWeekly('chat-w4n8q2t6y1kc', wallBase) },
  { key: 'readme', id: 'chat-e5b9h3v7u2ld', offsetMs: 26 * MINUTE, build: wallBase => buildReadme('chat-e5b9h3v7u2ld', wallBase) },
];
