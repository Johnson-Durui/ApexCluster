import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTask, ChatArtifact, ChatRecord, WaitTicket } from '../../lib/chat-api';
import { ActivityList, ArtifactList, AttachmentList, attachmentsForMessage, canPreviewArtifact, ContextList, QuestionCard, StreamList, TaskTree, TodoList } from './ChatPanels';

const agentTask = (id: string, parentTaskId?: string): AgentTask => ({
  id, parentTaskId, turnId: 'turn', role: 'sol', goal: id === 'child' ? '验证子任务' : '主任务', status: 'running',
  createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'edit',
});

describe('chat interaction panels', () => {
  it('renders nested task evidence and a real option/free-text question', () => {
    const tasks: AgentTask[] = [agentTask('root'), { ...agentTask('child', 'root'), profileId: 'document' }];
    const taskHtml = renderToStaticMarkup(<TaskTree tasks={tasks} invocations={[{ id: 'inv', taskId: 'root', segment: 1, status: 'running', startedAt: '', toolCount: 0, promptVersion: 'v1', inputEstimate: 1, contextWindow: 200_000, contextUsed: 40_000, contextHard: 80_000, model: 'gpt-6.1-sol', effort: 'high' }]} fanoutGroups={[{ id: 'group', parentTaskId: 'root', pool: 'hydrogen', total: 2 }]} />);
    const ticket: WaitTicket = { id: 'ticket-id', taskId: 'root', invocationId: 'inv', type: 'user', status: 'pending', createdAt: '', question: '选择下一步', options: ['修复', '停止'] };
    const questionHtml = renderToStaticMarkup(<QuestionCard ticket={ticket} busy={false} value="自由回答" onChange={vi.fn()} onAnswer={vi.fn()} />);
    expect(taskHtml).toContain('主任务'); expect(taskHtml).toContain('验证子任务'); expect(taskHtml).toContain('文档助手');
    expect(taskHtml).toContain('gpt-6.1-sol / high'); expect(taskHtml).toContain('上下文 40k / 80k'); expect(taskHtml).toContain('并行任务 0 / 2');
    expect(questionHtml).toContain('选择下一步'); expect(questionHtml).toContain('修复'); expect(questionHtml).toContain('自由回答');
  });

  it('allows only bounded text-like artifact previews', () => {
    const artifact = (patch: Partial<ChatArtifact>): ChatArtifact => ({ id: 'a', taskId: 't', name: 'change.diff', relativePath: 'x', hash: 'h', bytes: 10, kind: 'diff', createdAt: '', ...patch });
    expect(canPreviewArtifact(artifact({}))).toBe(true);
    expect(canPreviewArtifact(artifact({ name: 'archive.zip', kind: 'file' }))).toBe(false);
    expect(canPreviewArtifact(artifact({ bytes: 600 * 1024 }))).toBe(false);
  });

  it('shows the backend one-based invocation segment without incrementing it', () => {
    const chat: ChatRecord = {
      version: 1, id: 'c', title: 'c', createdAt: '', updatedAt: '', seq: 1, messageSeq: 0, turns: [], tasks: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
      invocations: [{ id: 'inv', taskId: 'task', segment: 3, status: 'exited', startedAt: '', toolCount: 0, promptVersion: 'v1', inputEstimate: 1, contextWindow: 1000, contextUsed: 500, contextHard: 800, model: 'claude-opus-5-5', effort: 'max', rotationReason: 'yield' }],
    };
    const html = renderToStaticMarkup(<ContextList chat={chat} />);
    expect(html).toContain('第 3 段');
    expect(html).not.toContain('第 4 段');
    expect(html).toContain('claude-opus-5-5 · max'); expect(html).toContain('500 / 800 tokens 硬限制'); expect(html).toContain('窗口交接：yield');
  });

  it('shows program todos and keeps Grok as an entire result instead of token text', () => {
    const todoHtml = renderToStaticMarkup(<TodoList todos={[{ id: 'todo', taskId: 'task', text: '检查附件', status: 'in_progress', updatedAt: '', dependsOn: ['prepare'], linkedTaskIds: ['child'], evidenceRefs: ['e1'] }]} />);
    const running = renderToStaticMarkup(<StreamList streams={[{ invocationId: 'g1', taskId: 'task', role: 'grok', text: '不应提前展示', status: 'running' }]} />);
    const ended = renderToStaticMarkup(<StreamList streams={[{ invocationId: 'g1', taskId: 'task', role: 'grok', text: '草稿不展示', status: 'exited' }]} tasks={[{ ...agentTask('task'), status: 'completed', result: '整段结果' }]} />);
    const childEnded = renderToStaticMarkup(<StreamList scope="subtask" streams={[{ invocationId: 's1', taskId: 'child', role: 'sol', text: '草稿不展示', status: 'exited' }]} tasks={[{ ...agentTask('child'), status: 'completed', result: '实现完成' }]} />);
    expect(todoHtml).toContain('检查附件'); expect(todoHtml).toContain('1 项依赖'); expect(todoHtml).toContain('1 个关联任务'); expect(todoHtml).toContain('1 项证据');
    expect(running).toContain('正在整理完整结果'); expect(running).not.toContain('不应提前展示');
    expect(ended).toContain('整段结果'); expect(ended).toContain('等待最终消息');
    expect(childEnded).toContain('子任务已结束'); expect(childEnded).toContain('见任务结果'); expect(childEnded).not.toContain('等待最终消息');
  });

  it('binds an uploaded attachment to the first sent message by attachment id', () => {
    const attachment = { id: 'a1', name: '需求.md', bytes: 20, hash: 'hash', mime: 'text/markdown', createdAt: '', source: 'upload' as const };
    const message = { id: 'm1', seq: 1, role: 'user' as const, text: '请处理', createdAt: '', attachmentIds: ['a1'] };
    expect(attachmentsForMessage([attachment], message)).toEqual([attachment]);
    expect(attachmentsForMessage([attachment], { ...message, attachmentIds: [] })).toEqual([]);
  });

  it('prioritizes a still-running tool when a parallel tool finishes later', () => {
    const html = renderToStaticMarkup(<StreamList streams={[{ invocationId: 'inv', taskId: 'root', role: 'claude', text: '检查中。', status: 'running' }]} tools={[
      { id: 'a', seq: 1, invocationId: 'inv', name: '仍在检查画面', status: 'running', at: '' },
      { id: 'b', seq: 2, invocationId: 'inv', name: '按钮检查已结束', status: 'completed', at: '' },
    ]} />);
    expect(html).toContain('仍在检查画面');
    expect(html).not.toContain('按钮检查已结束');
  });

  it('hides generated sentences while keeping real tool progress for every role', () => {
    for (const role of ['claude', 'astra', 'sol'] as const) {
      const html = renderToStaticMarkup(<StreamList streams={[{ invocationId: 'inv', taskId: 'root', role, text: '先检查加载链路。按钮尚在检', status: 'running' }]} tools={[
        { id: 'unrelated', seq: 1, taskId: 'other', name: '其他任务工具', status: 'running', at: '' },
        { id: 'tool', seq: 2, invocationId: 'inv', name: '确认原生预览状态', status: 'running', at: '' },
      ]} />);
      expect(html).not.toContain('先检查加载链路。');
      expect(html).not.toContain('按钮尚在检');
      expect(html).toContain('确认原生预览状态');
      expect(html).not.toContain('其他任务工具');
      expect(html).not.toContain('stream-caret');
    }
    const waiting = renderToStaticMarkup(<StreamList streams={[{ invocationId: 'inv', taskId: 'root', role: 'claude', text: '不完整', status: 'running' }]} />);
    expect(waiting).not.toContain('不完整');
    expect(waiting).toContain('正在整理回复');
    const interrupted = renderToStaticMarkup(<StreamList streams={[{ invocationId: 'inv', taskId: 'root', role: 'claude', text: '保留中断尾段', status: 'exit_unknown' }]} />);
    expect(interrupted).not.toContain('保留中断尾段');
    expect(interrupted).toContain('退出状态未知');
  });

  it('shows public progress notes and child start/completion in the conversation', () => {
    const chat: ChatRecord = { version: 1, id: 'c', title: 'c', createdAt: '', updatedAt: '', seq: 1, messageSeq: 0, turns: [], tasks: [agentTask('root'), { ...agentTask('child', 'root'), status: 'completed', result: '子智能体最终正文' }], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [], invocations: [], todos: [{ id: 'plan', taskId: 'root', text: '先核查设备协议，再整理实现方案', status: 'in_progress', updatedAt: '' }] };
    const html = renderToStaticMarkup(<ActivityList chat={chat} tools={[{ id: 't', seq: 1, taskId: 'child', name: '读取参考文档', status: 'completed', at: '' }]} turnId="turn" />);
    expect(html).toContain('先核查设备协议，再整理实现方案');
    expect(html).toContain('Sol'); expect(html).toContain('开始工作'); expect(html).toContain('已完成');
    expect(html).toContain('读取参考文档');
    expect(html).not.toContain('子智能体最终正文');
  });

  it('shows a completed child result once after multiple invocation segments', () => {
    const html = renderToStaticMarkup(<StreamList scope="subtask" tasks={[{ ...agentTask('child'), status: 'completed', result: '只显示一次的子任务结果' }]} streams={[
      { invocationId: 'old', taskId: 'child', role: 'sol', text: '旧草稿', status: 'rotated' },
      { invocationId: 'new', taskId: 'child', role: 'sol', text: '新草稿', status: 'exited' },
    ]} />);
    expect(html.split('只显示一次的子任务结果')).toHaveLength(2);
    expect(html).not.toContain('旧草稿'); expect(html).not.toContain('新草稿');
  });

  it('attributes deliverables to the producing seat from real fields only, never as a share', () => {
    const artifact = (patch: Partial<ChatArtifact>): ChatArtifact => ({ id: patch.id ?? 'a', taskId: 'root', name: 'PRD.md', relativePath: 'x', hash: 'h', bytes: 18_000, kind: 'report', createdAt: '', ...patch });
    const tasks: AgentTask[] = [{ ...agentTask('root'), role: 'opus', profileId: 'document' }, { ...agentTask('build'), role: 'sol' }];
    const html = renderToStaticMarkup(<ArtifactList chatId="chat" tasks={tasks} artifacts={[
      artifact({ id: 'model' }),
      artifact({ id: 'program', taskId: 'build', name: 'src.zip', kind: 'diff', provenance: 'workspace' }),
      artifact({ id: 'runner', taskId: 'build', name: '验收记录.txt', kind: 'test', provenance: 'runner' }),
      artifact({ id: 'orphan', taskId: 'missing', name: 'notes.txt', kind: 'file' }),
    ]} />);
    expect(html).toContain('deliv-seat'); expect(html).toContain('Opus · 文档助手');
    expect(html).toContain('Sol 任务 · 程序生成');
    expect(html).toContain('来源未记录');
    expect(html).toContain('>MD<'); expect(html).toContain('>ZIP<'); expect(html).toContain('>TXT<');
    expect(html).not.toContain('%');
    // without tasks there is no attribution at all (older callers)
    expect(renderToStaticMarkup(<ArtifactList chatId="chat" artifacts={[artifact({})]} />)).not.toContain('deliv-seat');
  });

  it('shows one shared project directory after the list when every deliverable was saved there', () => {
    const saved = (id: string, name: string): ChatArtifact => ({ id, taskId: 't', name, relativePath: name, hash: 'h', bytes: 10, kind: 'file', createdAt: '', projectExport: { status: 'saved', path: `D:\\Projects\\roomdesk\\agent-outputs\\${name}`, relativePath: name, workspaceId: 'w', version: 1, hash: 'h' } });
    const html = renderToStaticMarkup(<ArtifactList chatId="chat" artifacts={[saved('a', 'PRD.md'), saved('b', 'arch.md')]} />);
    expect(html.split('已保存到项目').length - 1).toBe(1);
    expect(html).toContain('D:\\Projects\\roomdesk\\agent-outputs');
  });

  it('shows the actual project copy path and preserves download when saving fails', () => {
    const artifact: ChatArtifact = { id: 'a', taskId: 't', name: '报告.docx', relativePath: 'blob', hash: 'h', bytes: 10, kind: 'file', createdAt: '', projectExport: { status: 'saved', path: 'E:\\项目\\agent-outputs\\chat\\报告.docx', relativePath: 'agent-outputs/chat/报告.docx', workspaceId: 'w', version: 1, hash: 'h' } };
    const saved = renderToStaticMarkup(<ArtifactList chatId="chat" artifacts={[artifact]} />);
    expect(saved).toContain('已保存到项目'); expect(saved).toContain('E:\\项目\\agent-outputs\\chat\\报告.docx');
    const failed = renderToStaticMarkup(<AttachmentList chatId="chat" attachments={[{ id: 'f', name: '图片.png', hash: 'h', bytes: 10, mime: 'image/png', createdAt: '', source: 'generated', projectExport: { status: 'failed', error: '目录不可写' } }]} />);
    expect(failed).toContain('保存到项目失败'); expect(failed).toContain('目录不可写'); expect(failed).toContain('文件仍可下载'); expect(failed).toContain('download="图片.png"');
  });
});
