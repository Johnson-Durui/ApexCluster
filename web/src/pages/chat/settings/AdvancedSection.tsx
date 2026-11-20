// 高级 JSON 配置 (#env-advanced): edit the full settings JSON, then apply it to the form (saving is separate).
export function AdvancedSection({ value, onValue, onApply }: { value: string; onValue(next: string): void; onApply(): void }) {
  return <section className="panel settings-card" id="env-advanced" aria-labelledby="env-advanced-heading">
    <details className="advanced-settings">
      <summary><h2 id="env-advanced-heading">高级 JSON 配置</h2></summary>
      <p className="muted">用于 timeout、输出上限等完整字段。stdio 不接受任意 command、cwd、宿主环境变量或 Docker 创建参数。先应用到表单，再保存。</p>
      <textarea className="mono" aria-label="高级 JSON 配置" rows={18} spellCheck={false} value={value} onChange={event => onValue(event.target.value)} />
      <button type="button" className="button compact" onClick={onApply}>应用 JSON</button>
    </details>
  </section>;
}
