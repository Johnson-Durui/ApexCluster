// Pipeline pieces (BUILD-SPEC-B §4.4, §4.9). PipelineStatus is the read-only summary used by the inspector 上下文 tab;
// the composer controls, the rail and the gate card live in pipeline/* and are re-exported here so imports stay valid.
import type { ChatPipeline, ChatRecord } from '../../lib/chat-api';
import './pipeline/pipeline.css';

export { PipelineComposerControls } from './pipeline/PipelineComposerControls';
export { PipelineRail } from './pipeline/PipelineRail';
export { GateCard, type GatePhase } from './pipeline/GateCard';

export interface RotationNotice {
  id: string;
  taskId?: string;
  invocationId?: string;
  reason: string;
  nextSegment?: number;
  at: string;
}

const stageLabels: Record<ChatPipeline['stage'], string> = {
  architecture: '架构', 'gate-a': '关卡 A', implementation: '实现', acceptance: '独立验收', 'gate-b': '关卡 B', completed: '完成', cancelled: '已终止',
};
const reasonLabels: Record<string, string> = {
  soft: '接近上下文软限制', hard: '达到上下文硬限制', yield: 'Agent 主动交接', wait: '等待外部结果',
  time: '达到单窗口时限', actions: '达到工具动作上限', crash: '服务恢复交接',
};
const tokenCount = (value: number) => value.toLocaleString('zh-CN');

/** Read-only: preset + stage, usage, window hand-overs and the implementation error. No decision controls. */
export function PipelineStatus({ chat, rotations }: { chat: ChatRecord; rotations: RotationNotice[] }) {
  const pipeline = chat.pipeline;
  if (!pipeline) return null;
  return <section className={`pipeline-status stage-${pipeline.stage}`} aria-label="流水线状态">
    <div className="pipeline-summary">
      <div><span>流水线 · {pipeline.preset}</span><strong>{stageLabels[pipeline.stage] ?? pipeline.stage}</strong></div>
      <dl><div><dt>Token</dt><dd className="mono">{tokenCount(chat.apiUsage?.tokens ?? 0)}</dd></div><div><dt>费用估算</dt><dd className="mono">${(chat.apiUsage?.usd ?? 0).toFixed(4)}</dd></div>{chat.apiUsage?.unpriced ? <div><dt>未计价</dt><dd className="mono">{chat.apiUsage.unpriced}</dd></div> : null}</dl>
    </div>
    {pipeline.implementation?.error ? <p className="chat-error" role="alert">{pipeline.implementation.error}</p> : null}
    {rotations.length ? <details className="pipeline-rotations"><summary>窗口交接 · {rotations.length}</summary><ol>{rotations.slice(-5).reverse().map(item => <li key={item.id}><b>{reasonLabels[item.reason] ?? item.reason}</b><span>{item.nextSegment ? `进入第 ${item.nextSegment} 段` : '已建立新窗口'}{item.taskId ? ` · 任务 ${item.taskId.slice(0, 8)}` : ''}</span></li>)}</ol></details> : null}
  </section>;
}
