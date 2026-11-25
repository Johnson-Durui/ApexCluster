import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '../../lib/chat-api';
import { buildObservatory } from './observatoryModel';
import { GateCard, PipelineComposerControls, PipelineStatus } from './PipelineStatus';

const chat = (stage: NonNullable<ChatRecord['pipeline']>['stage']): ChatRecord => ({
  version: 1, id: 'chat', title: '流水线', createdAt: '', updatedAt: '', seq: 1, messageSeq: 0,
  turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
  apiUsage: { tokens: 12_345, usd: 1.2345, unpriced: 2 },
  pipeline: { preset: 'flagship', stage, revision: 1, gates: { clarify: 'user', architecture: 'user', delivery: 'user' } },
});
const gateCard = (state: Parameters<typeof GateCard>[0]['state']) => {
  const value = chat('gate-a');
  return renderToStaticMarkup(<GateCard chat={value} model={buildObservatory(value, [], [], [], false)} state={state} onDecide={vi.fn()} onRetry={vi.fn()} />);
};

describe('pipeline chat controls', () => {
  it('renders preset selection without inventing a scripted provider entry', () => {
    const html = renderToStaticMarkup(<PipelineComposerControls mode="pipeline" preset="flagship" auto={false} disabled={false} workspaceGranted={false}
      configuration={{ mode: 'api', keyReadiness: [], modelChecks: [], presets: [{ id: 'flagship', rootSeat: 'claude', seats: [], available: true }, { id: 'offline', rootSeat: 'claude', seats: [], available: false, reason: '缺少密钥' }] }}
      onMode={vi.fn()} onPreset={vi.fn()} onAuto={vi.fn()} />);
    expect(html).toContain('普通聊天'); expect(html).toContain('流水线'); expect(html).toContain('flagship'); expect(html).toContain('缺少密钥'); expect(html).toContain('需要先授权项目目录');
    expect(html).not.toContain('ScriptedProvider');
  });

  it('allows selecting an architecture-only preset with a clear Gate-A notice when its provider is verified', () => {
    const html = renderToStaticMarkup(<PipelineComposerControls mode="pipeline" preset="single-provider" auto={false} disabled={false} workspaceGranted
      configuration={{
        mode: 'api', keyReadiness: [], modelChecks: [], presets: [
          { id: 'single-provider', rootSeat: 'claude', seats: [], available: false, scope: 'architecture_only', architectureAvailable: true, reason: '完整流水线需要 Sol 与 Opus 来自不同厂商家族' },
          { id: 'offline', rootSeat: 'claude', seats: [], available: false, reason: '缺少密钥' },
        ],
      }}
      onMode={vi.fn()} onPreset={vi.fn()} onAuto={vi.fn()} />);
    expect(html).toContain('<option value="single-provider" selected="">single-provider（仅架构阶段 · 至关卡 A）</option>');
    expect(html).toContain('仅架构阶段可用（至关卡 A）：完整流水线需要 Sol 与 Opus 来自不同厂商家族');
    expect(html).toContain('<option value="offline" disabled="">offline（缺少密钥）</option>');
  });

  // Split from the original single render (BUILD-SPEC-B §8.1): PipelineStatus is now the read-only inspector summary and
  // the decisions live in GateCard. Every original assertion string is still asserted below.
  it('shows stage, usage, rotations and all Gate A decisions', () => {
    const status = renderToStaticMarkup(<PipelineStatus chat={chat('gate-a')} rotations={[
      { id: 'r1', taskId: 'task-123456789', invocationId: 'inv', reason: 'hard', nextSegment: 2, at: '' },
    ]} />);
    expect(status).toContain('关卡 A');
    expect(status).toContain('12,345'); expect(status).toContain('$1.2345'); expect(status).toContain('未计价');
    expect(status).toContain('达到上下文硬限制'); expect(status).toContain('进入第 2 段');
    const card = gateCard({ phase: 'idle' });
    expect(card).toContain('关卡 A · 架构与 Demo');
    expect(card).toContain('确认继续'); expect(card).toContain('提交修改'); expect(card).toContain('终止流水线');
    expect(card).toContain('decision-card');
    expect(card).not.toContain('提交中…');
  });

  it('locks the gate card while a decision is submitting', () => {
    const card = gateCard({ phase: 'busy', decision: 'confirm' });
    expect(card).toContain('提交中…');
    expect(card).toContain('aria-busy="true"');
    expect(card).not.toContain('>确认继续<');
    expect(card).toMatch(/readOnly=""|readonly=""/);
  });

  it('keeps a network failure inside the card with a retry', () => {
    const card = gateCard({ phase: 'error', kind: 'network', message: '关卡决定提交失败：网络错误。决定没有生效，关卡仍在等你。' });
    expect(card).toContain('role="alert"');
    expect(card).toContain('决定没有生效，关卡仍在等你');
    expect(card).toContain('重试');
  });

  it('shows a 409 refusal without a retry', () => {
    const card = gateCard({ phase: 'error', kind: 'conflict', message: '关卡决定没有生效：成品已变化，请提交返工并复验后再接受' });
    expect(card).toContain('关卡决定没有生效：成品已变化');
    expect(card).not.toContain('重试');
  });

  it('waits honestly when the server has not left the gate yet', () => {
    const card = gateCard({ phase: 'pending', decision: 'confirm' });
    expect(card).toContain('决定已提交，等待服务端推进…');
    expect(card).toContain('aria-busy="true"');
  });
});
