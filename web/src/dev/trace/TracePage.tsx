import { useEffect, useMemo, useReducer, useState } from 'react';
import { Badge, EmptyState, Icon, Modal, SectionTitle } from '../../components/ui';
import { traceEvents } from './fixture';
import { applyTraceEvent, cancelTraceScope, initialTraceState, traceScopeKey, type TraceArtifact, type TraceState } from './traceModel';
import './trace.css';

type Action = { type: 'event'; event: (typeof traceEvents)[number] } | { type: 'cancel'; key: string } | { type: 'reset' };
const reduce = (state: TraceState, action: Action) => action.type === 'event' ? applyTraceEvent(state, action.event) : action.type === 'cancel' ? cancelTraceScope(state, action.key) : initialTraceState;
const demoKey = traceScopeKey(traceEvents[0]!);
const statusText = { idle: '等待开始', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' } as const;
const agentStatusText = { queued: '等待派遣', running: '进行中', completed: '已完成', cancelled: '已取消' } as const;
const toolStatusText = { building: '参数构建中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' } as const;

export default function TracePage() {
  const [state, dispatch] = useReducer(reduce, initialTraceState);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState<TraceArtifact | null>(null);
  const scope = state.scopes[demoKey];

  useEffect(() => {
    if (!playing || cursor >= traceEvents.length) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: 'event', event: traceEvents[cursor]! });
      setCursor(value => value + 1);
    }, 520);
    return () => window.clearTimeout(timer);
  }, [cursor, playing]);
  useEffect(() => { if (cursor >= traceEvents.length) setPlaying(false); }, [cursor]);

  const agents = useMemo(() => Object.values(scope?.agents ?? {}), [scope?.agents]);
  const tools = useMemo(() => Object.values(scope?.tools ?? {}), [scope?.tools]);
  const artifacts = useMemo(() => Object.values(scope?.artifacts ?? {}), [scope?.artifacts]);
  const messages = useMemo(() => Object.values(scope?.messages ?? {}), [scope?.messages]);
  const reset = () => { setPlaying(false); setCursor(0); setPreview(null); dispatch({ type: 'reset' }); };
  const cancel = () => { if (!scope) return; setPlaying(false); dispatch({ type: 'cancel', key: scope.key }); };
  const step = () => {
    if (cursor >= traceEvents.length) return;
    dispatch({ type: 'event', event: traceEvents[cursor]! });
    setCursor(value => value + 1);
  };

  return <div className="page trace-page">
    <header className="trace-hero">
      <div>
        <div className="eyebrow">P0 协作闭环验证</div>
        <h1>多 Agent 开发演示</h1>
        <p>用交接包的 14 条合成事件复现 Agent 分工、参数分片、工具执行、消息汇总和产物交付。</p>
      </div>
      <div className="trace-hero-meta">
        <Badge tone="mock">开发演示 · 模拟数据</Badge>
        <strong>不写入真实运行</strong>
        <small>事件仅在内存播放 · 无模型调用 · 不保存演示记录</small>
      </div>
    </header>

    <section className="trace-control panel" aria-label="演示播放控制">
      <div className="trace-control-state">
        <span className={`trace-state ${scope?.status ?? 'idle'}`} aria-hidden="true" />
        <div><b>{scope?.title ?? '整理多 Agent 前端页面与能力清单'}</b><small>{scope ? `${statusText[scope.status]} · 事件 ${cursor}/${traceEvents.length}` : '等待播放演示事件'}</small></div>
      </div>
      <div className="trace-progress" role="progressbar" aria-label="演示事件进度" aria-valuemin={0} aria-valuemax={traceEvents.length} aria-valuenow={cursor}><i style={{ width: `${cursor / traceEvents.length * 100}%` }} /></div>
      <div className="row">
        <button type="button" className="primary" disabled={cursor >= traceEvents.length || scope?.status === 'cancelled'} onClick={() => setPlaying(value => !value)}><Icon name={playing ? 'stop' : 'activity'} />{playing ? '暂停' : cursor ? '继续播放' : '开始播放'}</button>
        <button type="button" disabled={playing || cursor >= traceEvents.length || scope?.status === 'cancelled'} onClick={step}>单步</button>
        <button type="button" disabled={!scope || scope.status !== 'running'} className="danger" onClick={cancel}><Icon name="stop" />取消本次演示</button>
        <button type="button" onClick={reset}><Icon name="refresh" />重置</button>
      </div>
    </section>

    {!scope ? <section className="panel trace-empty"><EmptyState title="等待演示开始" icon="activity"><p>点击“开始播放”，逐条查看同一 execution 下的协作过程。</p></EmptyState></section> : <div className="trace-layout">
      <div className="trace-main">
        <section className="panel trace-agents">
          <SectionTitle eyebrow="同一 execution 下的父子关系" title="Agent 分工"><Badge>{agents.length} 位参与者</Badge></SectionTitle>
          <div className="trace-agent-grid">{agents.map((agent, index) => <article key={agent.id} className={`trace-agent ${agent.status}`}>
            <header><span className={`mtag ${index === 0 ? 'sol' : index === 1 ? 'claude' : 'astra'}`}>{agent.name.slice(0, 1)}</span><div><b>{agent.name}</b><small>{agent.role || '等待职责信息'}</small></div><Badge tone={agent.status === 'completed' ? 'ok' : agent.status === 'cancelled' ? 'bad' : agent.status === 'running' ? 'info' : ''}>{agentStatusText[agent.status]}</Badge></header>
            <dl><dt>任务</dt><dd>{agent.task ?? (agent.id === 'coordinator' ? '拆分任务并汇总结果' : '等待派遣')}</dd><dt>父任务</dt><dd className="mono">{agent.parentAgentRunId ?? '根任务'}</dd></dl>
            {agent.resultSummary ? <p>{agent.resultSummary}</p> : null}
          </article>)}</div>
        </section>

        <section className="panel trace-answer">
          <SectionTitle eyebrow="协调 Agent 汇总" title="交付消息" />
          {messages.length ? messages.map((message, index) => <p key={index}>{message}</p>) : <p className="muted">Agent 完成后，汇总消息会显示在这里。</p>}
          {scope.summary ? <div className={`alert ${scope.status === 'completed' ? 'ok' : scope.status === 'cancelled' ? 'warn' : 'info'}`} role="status">{scope.summary}</div> : null}
        </section>
      </div>

      <aside className="trace-detail" aria-label="工具与产物">
        <section className="panel">
          <SectionTitle eyebrow="参数完整后才结构化显示" title="工具执行"><Badge>{tools.length} 次</Badge></SectionTitle>
          {tools.length ? <ol className="trace-tool-list">{tools.map(tool => <li key={tool.id} className={tool.status}>
            <div className="trace-tool-title"><Icon name="terminal" /><div><b>{tool.name}</b><small>{agents.find(agent => agent.id === tool.agentId)?.name ?? tool.agentId}</small></div><Badge tone={tool.status === 'completed' ? 'ok' : tool.status === 'failed' || tool.status === 'cancelled' ? 'bad' : 'info'}>{toolStatusText[tool.status]}</Badge></div>
            {tool.status === 'building' ? <code>{tool.argumentsText || '等待参数片段…'}</code> : tool.arguments ? <pre>{JSON.stringify(tool.arguments, null, 2)}</pre> : null}
            {tool.argumentError ? <p className="bad">{tool.argumentError}</p> : null}
            {tool.resultSummary ? <p>{tool.resultSummary}</p> : null}
          </li>)}</ol> : <p className="muted">工具开始后会显示参数构建与结果。</p>}
        </section>

        <section className="panel">
          <SectionTitle eyebrow="只存在于当前浏览器内存" title="产物交付"><Badge>{artifacts.length} 份</Badge></SectionTitle>
          {artifacts.length ? artifacts.map(artifact => <article className="trace-artifact" key={artifact.id}><div><Icon name="file" size={20} /><span><b>{artifact.name}</b><small>{artifact.mediaType} · 模拟产物</small></span></div><div className="row"><button type="button" className="compact" onClick={() => setPreview(artifact)}>预览</button><button type="button" className="compact" onClick={() => downloadArtifact(artifact)}><Icon name="download" size={14} />下载</button></div></article>) : <p className="muted">产物事件到达后才提供本地预览和下载。</p>}
        </section>

        <section className="trace-diagnostics panel">
          <h2>事件边界</h2>
          <dl><dt>Workspace</dt><dd className="mono">{scope.workspaceId}</dd><dt>Session</dt><dd className="mono">{scope.sessionId}</dd><dt>Execution</dt><dd className="mono">{scope.executionId}</dd><dt>最后序号</dt><dd>{scope.lastSeq}</dd><dt>安全忽略</dt><dd>{scope.ignored}</dd></dl>
        </section>
      </aside>
    </div>}
    {preview ? <Modal title={`${preview.name} · 模拟产物`} onClose={() => setPreview(null)}><div className="alert warn"><b>开发演示数据</b><p>该内容来自合成 fixture，不属于任何真实运行。</p></div><pre>{preview.previewText}</pre></Modal> : null}
  </div>;
}

function downloadArtifact(artifact: TraceArtifact) {
  const url = URL.createObjectURL(new Blob([artifact.previewText], { type: `${artifact.mediaType};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url; link.download = artifact.name; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
