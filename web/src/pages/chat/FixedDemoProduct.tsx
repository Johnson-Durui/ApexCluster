import { useEffect, useState } from 'react';

const PRODUCT_ROOT = '/fixed-demo/project/';
export default function FixedDemoProduct({ paused, cancelled, active, onPause, onStop }: { paused: boolean; cancelled: boolean; active: boolean; onPause: () => void; onStop: () => void }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${PRODUCT_ROOT}index.html`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('交付成品文件未就绪，请重新打开软件后重试。');
      const text = await response.text();
      if (!text.includes('RoomDesk') || text.length > 128 * 1024) throw new Error('交付成品与预设项目不匹配。');
      // Only this bundled application document is rendered; uploads/model HTML still use text previews.
      const document = text
        .replace(/href=["'](?:\.\/)?src\/styles\.css["']/g, `href="${PRODUCT_ROOT}src/styles.css"`)
        .replace(/src=["'](?:\.\/)?src\/app\.js["']/g, `src="${PRODUCT_ROOT}src/app.js"`);
      if (!controller.signal.aborted) setHtml(document);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '成品加载失败'); });
    return () => controller.abort();
  }, []);
  return <section aria-label="软件内成品预览">
    <div className="fixed-demo-product-note"><span>交付的 RoomDesk 应用示例 · 示例数据</span><span>{cancelled ? '演示已停止' : paused ? '演示已暂停' : '交互式示例应用，可直接操作体验'}</span>{active ? <div><button type="button" className="btn ghost sm" onClick={onPause}>{paused ? '继续演示' : '暂停演示'}</button><button type="button" className="btn ghost sm" onClick={onStop}>停止任务</button></div> : null}</div>
    {error ? <p className="fixed-demo-product-error" role="alert">{error}</p> : html ? <iframe className="fixed-demo-product-frame" title="RoomDesk 会议室预约应用成品" srcDoc={html} /> : <p className="fixed-demo-product-loading" role="status">正在打开交付成品…</p>}
  </section>;
}
