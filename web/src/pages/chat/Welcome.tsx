// Welcome (BUILD-SPEC-B §4.8): one honest sentence about what happens, three starters that only fill the composer, and
// the fixed demo entry. Vertically centred in the log; it fades out on send (§7 row 10).
import { Icon } from '../../components/ui';

const starters = [
  { label: '整理这个项目', text: '帮我梳理这个项目的结构和当前进展。', icon: 'folder' },
  { label: '修复一个问题', text: '帮我定位并修复一个问题：', icon: 'flag' },
  { label: '聊聊一个想法', text: '我有一个想法，想和你一起完善：', icon: 'message' },
] as const;

export default function Welcome({ workspaceName, leaving, onStart, onDemo }: {
  workspaceName?: string;
  /** Sending: the block fades out (CSS, 160ms). */
  leaving: boolean;
  onStart(text: string): void;
  onDemo(): void;
}) {
  return <div className={`welcome${leaving ? ' is-leaving' : ''}`}>
    <p className="welcome-kicker mono">新聊天 · 本机工作空间</p>
    <h2>{workspaceName ? `我们在${workspaceName}中做些什么？` : '今天，我们一起完成什么？'}</h2>
    <p className="welcome-lede">写下目标即可。主控会拆解任务、分派给合适的席位，并把进展实时画在右侧的任务地图上；需要你决定的地方会停下来等你。</p>
    <div className="welcome-starts" role="group" aria-label="快捷开始">
      {starters.map(starter => <button type="button" key={starter.label} className="btn" onClick={() => onStart(starter.text)}><Icon name={starter.icon} size={15} />{starter.label}</button>)}
    </div>
    <p className="welcome-demo">
      <button type="button" className="btn-reset welcome-demo-link" onClick={onDemo}>演示一个完整项目 · 会议室预约工具 · 4 分钟 →</button>
      <small>预设流程，不调用模型</small>
    </p>
  </div>;
}
