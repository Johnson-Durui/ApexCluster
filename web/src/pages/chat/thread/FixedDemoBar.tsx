// Fixed-demo bar (BUILD-SPEC-B §4.8): the 40px thread band of a fixed-demo chat. Labelled as preset playback; no model calls.
import { Tag } from '../../../components/ui';

export interface DemoPlayback { elapsedMs: number; paused: boolean; completed: boolean; cancelled: boolean; productReady: boolean }

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000 % 60)).padStart(2, '0')}`;

export function FixedDemoBar({ playback, sending, onPause, onRestart, onProduct }: { playback: DemoPlayback; sending: boolean; onPause(): void; onRestart(): void; onProduct(): void }) {
  const ended = playback.completed || playback.cancelled;
  return <section className="fixed-demo-banner" aria-label="固定项目演示">
    <Tag tone="mock">▷ 预设演示</Tag>
    <span className="fixed-demo-title">会议室预约工具演示 · 预设流程 · 不调用模型</span>
    <span className="fixed-demo-clock mono">{mmss(Math.min(playback.elapsedMs, 240000))} / 04:00</span>
    <progress value={Math.min(playback.elapsedMs, 240000)} max={240000} aria-label="固定演示进度" />
    <div className="fixed-demo-controls">
      {ended ? <span className="fixed-demo-ended">{playback.cancelled ? '已停止' : '演示完成'}</span> : <button type="button" className="btn ghost sm" onClick={onPause}>{playback.paused ? '继续演示' : '暂停演示'}</button>}
      <button type="button" className="btn ghost sm" onClick={onRestart} disabled={sending}>重新演示</button>
      {playback.productReady ? <button type="button" className="btn sm" onClick={onProduct}>查看成品</button> : null}
    </div>
  </section>;
}
