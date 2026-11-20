// The app's one error boundary (App.tsx). The chat section keeps one boundary instance (key 'chat') so ChatPage stays
// mounted across chat switches; `resetKey` (the full route) clears a crash on any route change, during render, so the
// error screen is never drawn for a frame after the user picks another chat. While failed, the boundary claims the
// top-bar title, so the shell's route fallback (正在恢复聊天…) never sits above the error.
import { Component, type ReactNode } from 'react';
import { EmptyState } from '../ui';
import { TopBarTitle } from './ShellSlots';
import { Crumb } from './TopBar';

export const PAGE_FAILED_TITLE = '页面需要重新加载';

interface Props { resetKey: string; children: ReactNode }
interface State { failed: boolean; resetKey: string }

export default class PageBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="page">
      <TopBarTitle><Crumb current={PAGE_FAILED_TITLE} /></TopBarTitle>
      <EmptyState title={PAGE_FAILED_TITLE} icon="alert" tone="error" role="alert">
        <p>运行记录已保存在本机。页面可能在更新后仍持有旧资源，请重新加载以继续。</p>
        <div className="empty-actions"><button type="button" className="btn primary" onClick={() => window.location.reload()}>重新加载页面</button></div>
      </EmptyState>
    </div>;
  }
}
