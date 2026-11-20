import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { EmptyState } from './components/ui';
import Sidebar from './components/shell/Sidebar';
import TopBar from './components/shell/TopBar';
import StatusBar from './components/shell/StatusBar';
import PageBoundary from './components/shell/PageBoundary';
import { dismissToast, toast, Toasts } from './components/Toast';
import './components/shell/shell.css';
import type { Run } from './lib/types';

const HomePage = lazy(() => import('./pages/home/HomePage'));
const ChatPage = lazy(() => import('./pages/chat/ChatPage'));
const NewPage = lazy(() => import('./pages/new/NewPage'));
const EnvironmentPage = lazy(() => import('./pages/new/EnvironmentPage'));
const RunPage = lazy(() => import('./pages/run/RunPage'));
const TracePage = import.meta.env.DEV ? lazy(() => import('./dev/trace/TracePage')) : null;
const ObservatoryPreview = import.meta.env.DEV ? lazy(() => import('./dev/observatory/ObservatoryPreview')) : null;
const ThreadPreview = import.meta.env.DEV ? lazy(() => import('./dev/thread/ThreadPreview')) : null;
const InspectorPreview = import.meta.env.DEV ? lazy(() => import('./dev/inspector/InspectorPreview')) : null;

export function navigate(path: string) { window.location.hash = path; }

type Section = 'chat' | 'runs' | 'new' | 'environment' | 'run' | 'trace' | 'observatory' | 'thread' | 'inspector' | 'missing';
const DEV_SECTIONS: Record<string, Section> = { '/dev/trace': 'trace', '/dev/observatory': 'observatory', '/dev/thread': 'thread', '/dev/inspector': 'inspector' };

export default function App() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || '/');
  const main = useRef<HTMLElement>(null);
  const routePath = route.split('?')[0] || '/';
  const routeId = /^\/runs\/([A-Za-z0-9._-]+)$/.exec(routePath)?.[1];
  const section: Section = routePath === '/' ? 'chat' : routePath === '/history' ? 'runs' : routePath === '/new' ? 'new' : routePath === '/environment' ? 'environment' : routeId ? 'run' : import.meta.env.DEV && DEV_SECTIONS[routePath] ? DEV_SECTIONS[routePath] : 'missing';
  useEffect(() => {
    const handle = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', handle);
    return () => window.removeEventListener('hashchange', handle);
  }, []);
  useEffect(() => { main.current?.scrollTo?.({ top: 0 }); window.scrollTo(0, 0); }, [route]);
  const createdRun = useRef<string | null>(null);
  useEffect(() => {
    const created = (event: Event) => {
      const run = (event as CustomEvent<{ id: string; title: string }>).detail;
      createdRun.current = run.id;
      toast({ id: 'created-run', className: 'created-run-notice', sticky: true, closeLabel: '关闭任务创建通知', title: `任务已创建：${run.title}`, actions: [{ label: '打开刚创建的任务 →', href: `#/runs/${run.id}` }] });
    };
    window.addEventListener('workbench:run-created', created);
    return () => window.removeEventListener('workbench:run-created', created);
  }, []);
  useEffect(() => { if (createdRun.current && route === `/runs/${createdRun.current}`) { dismissToast('created-run'); createdRun.current = null; } }, [route]);

  return <div className="app" data-section={section}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); main.current?.focus(); }}>跳到主要内容</a>
    <Sidebar route={route} />
    <div className="app-main">
      <TopBar route={route} />
      <main id="main-content" ref={main} tabIndex={-1} className={`app-view${section === 'run' ? ' is-run' : section === 'chat' ? ' is-chat' : ''}`}>
        {/* one boundary for the whole chat section (ChatPage stays mounted); resetKey clears a crash on every route change */}
        <PageBoundary key={section === 'chat' ? 'chat' : route} resetKey={route}>
          <Suspense fallback={<div role="status" className="loading">正在载入工作台…</div>}>
            {section === 'chat' ? <ChatPage />
              : section === 'runs' ? <HomePage />
              : section === 'new' ? <NewPage onCreated={(run: Run) => navigate(`/runs/${run.id}`)} />
              : section === 'environment' ? <EnvironmentPage />
              : section === 'run' ? <RunPage key={routeId} id={routeId!} />
              : section === 'trace' && TracePage ? <TracePage />
              : section === 'observatory' && ObservatoryPreview ? <ObservatoryPreview />
              : section === 'thread' && ThreadPreview ? <ThreadPreview />
              : section === 'inspector' && InspectorPreview ? <InspectorPreview />
              : <div className="page"><EmptyState title="这个页面不存在" icon="help"><div className="empty-actions"><a href="#/" className="btn primary">返回聊天</a><a href="#/history" className="btn">任务历史</a></div></EmptyState></div>}
          </Suspense>
        </PageBoundary>
      </main>
    </div>
    <StatusBar />
    <Toasts />
  </div>;
}
