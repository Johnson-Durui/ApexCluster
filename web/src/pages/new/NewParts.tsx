// Building blocks of 新建评审 (BUILD-SPEC-B §6.3): bordered form sections, range-checked number fields with inline
// errors after blur, the call estimate and the sticky launch card whose footer always stays in view.
import type { ReactNode, Ref } from 'react';
import type { BuildOptions, Effort } from '../../lib/types';
import { Icon, STATUS_GLYPH, type StatusKind } from '../../components/ui';

export const effortNames: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
export const designNames = { dual: '双架构师独立提案', single: 'Claude 主导' } as const;

export function FormSection({ id, index, title, description, action, children }: { id: string; index: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel form-section" id={id} aria-labelledby={`section-${index}`}>
    <header className="form-section-head"><span className="form-section-index mono">{index}</span><div><h2 id={`section-${index}`} tabIndex={-1}>{title}</h2>{description ? <p className="muted">{description}</p> : null}</div>{action ? <div className="form-section-action">{action}</div> : null}</header>
    {children}
  </section>;
}

/** A required text field; the error appears after blur. The input carries its own aria-invalid / aria-describedby. */
export function RequiredField({ id, label, error, children }: { id: string; label: string; error: string; children: ReactNode }) {
  return <label className={`field${error ? ' invalid' : ''}`}><span>{label}</span>{children}{error ? <small className="field-error" id={`${id}-error`}>{error}</small> : null}</label>;
}

/** Range check shared by the inline error and the launch checklist (wording as g2Validation: `{label}需在 1–4 之间`). */
export const inRange = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

export function LimitField({ name, label, min, max, value, onChange, touched, onBlur, unit, children }: { name: string; label: string; min: number; max: number; value: number; onChange(value: number): void; touched: boolean; onBlur(name: string): void; unit?: string; children?: ReactNode }) {
  const invalid = touched && !inRange(value, min, max);
  const id = `limit-${name}`;
  return <label className={`field${invalid ? ' invalid' : ''}`}><span>{label}</span>
    <input id={id} name={name} type="number" min={min} max={max} value={value} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} onChange={event => onChange(Number(event.target.value))} onBlur={() => onBlur(name)} />
    {invalid ? <small className="field-error" id={`${id}-error`}>{label}需在 {min}–{max} 之间</small> : <small className="muted">{min}–{max}{unit ? ` ${unit}` : ''}</small>}
    {children}
  </label>;
}

export interface CheckItem { key: string; label: string; state: 'ok' | 'err' | 'idle'; value?: string; required?: boolean; onFix?: () => void; fixLabel?: string }
const checkKind: Record<CheckItem['state'], StatusKind> = { ok: 'ok', err: 'err', idle: 'idle' };
const checkWord: Record<CheckItem['state'], string> = { ok: '已完成', err: '未完成', idle: '可选' };

export interface EstimateProps {
  designLabel: string; contextEnabled: boolean;
  base: { claude: number; astra: number; sol: number; grok: number }; total: number;
  efforts: { claude: Effort; astra: Effort }; docCalls: number;
  evaluator: Effort | null; finalReview: Effort | null; build: BuildOptions;
}

/** 调用预估 in Chinese (never the raw single/dual keys); conditional calls stay labelled apart from the base. */
export function CallEstimate({ designLabel, contextEnabled, base, total, efforts, docCalls, evaluator, finalReview, build }: EstimateProps) {
  return <div className="estimate">
    <h3>调用预估</h3>
    <p className="estimate-note">设计：{designLabel}。{contextEnabled ? '基础至少' : '基础约'} {total} 次；条件调用只在触发时发生。</p>
    <h4>基础调用</h4><dl>
      <div data-seat="claude"><dt><span className="seat-dot" aria-hidden="true" />Claude</dt><dd>{base.claude} 次 · 设计 {effortNames[efforts.claude]}</dd></div>
      <div data-seat="astra"><dt><span className="seat-dot" aria-hidden="true" />Astra</dt><dd>{base.astra} 次 · 设计 {effortNames[efforts.astra]}</dd></div>
      <div data-seat="sol"><dt><span className="seat-dot" aria-hidden="true" />Sol</dt><dd>{contextEnabled ? '至少 ' : ''}{base.sol} 次（按 1 个作业的首轮）{contextEnabled ? '；包括最终整轮验收，复杂计划另加 init 与里程碑调用' : ''}</dd></div>
      <div><dt><Icon name="file" size={13} />文档</dt><dd>{docCalls ? `${docCalls} 次（按各文档冻结的撰写者与强度；修订另计）` : '不写文档'}</dd></div>
      {base.grok ? <div data-seat="grok"><dt><span className="seat-dot" aria-hidden="true" />Grok</dt><dd>{base.grok} 次（按已启用的摘要 / 问题分组任务）</dd></div> : null}
      {evaluator ? <div data-seat="astra"><dt><span className="seat-dot" aria-hidden="true" />独立评审</dt><dd>每轮 1 次 {effortNames[evaluator]}</dd></div> : null}
      {finalReview ? <div data-seat="claude"><dt><span className="seat-dot" aria-hidden="true" />只读终审</dt><dd>每作业循环结束后最多 1 次 {effortNames[finalReview]}</dd></div> : null}
    </dl>
    <h4>条件增加</h4><p className="estimate-note">分歧复核与 Ultra 裁决、文档修订、输出结构修复、失败后手动重试{build.autoRework ? `、最多 ${Math.max(0, build.maxRounds - 1)} 轮有证据返工` : ''}{build.lightReworkEnabled ? '、每作业最多一次 Grok High 轻量返工及其强制 Astra 独立评审' : ''}。只在触发条件和剩余预算都满足时调用。</p>
    <h4>每作业上限</h4><p className="estimate-note">{build.maxRounds} 轮构建 · {build.maxWriterSessions} 个写者会话 · {build.maxModelCalls} 次模型调用 · {build.maxActiveMinutes} 分钟模型主动时间。多作业分别计账。</p>
    <p className="help-note">Claude Pro 的额度可能不够一次跑完。用完时运行会停在“阻塞”，原样显示恢复时间，由你选择重试或只用成功的一方继续；不会自动降档、自动重试或转按量计费。</p>
  </div>;
}

export interface LaunchProps {
  checks: CheckItem[]; estimate: ReactNode;
  acknowledged: boolean; onAck(value: boolean): void; ackRef: Ref<HTMLInputElement>;
  canLaunch: boolean; buttonLabel: string; reason: string; error: string;
}

/** Sticky launch card: checks and estimate scroll; the footer (ack, reason line, launch button) never leaves the card. */
export function LaunchCard({ checks, estimate, acknowledged, onAck, ackRef, canLaunch, buttonLabel, reason, error }: LaunchProps) {
  return <aside className="new-side" aria-label="启动前确认"><section className="panel launch-card">
    <h2>启动前确认</h2>
    <div className="lc-scroll">
      <ul className="launch-checks">{checks.map(item => <li key={item.key} className={item.state === 'ok' ? 'ok' : item.state === 'err' ? 'missing' : 'optional'}>
        <span className={`st ${checkKind[item.state]}`}><i aria-hidden="true">{STATUS_GLYPH[checkKind[item.state]]}</i><span className="sr-only">{checkWord[item.state]}：</span></span>
        {item.onFix && item.state === 'err' ? <button type="button" className="btn-reset lc-fix" onClick={item.onFix}>{item.label}</button> : <span className="lc-label">{item.label}</span>}
        {item.fixLabel && item.onFix ? <button type="button" className="btn sm" onClick={item.onFix}>{item.fixLabel}</button> : item.value ? <span className="lc-value mono">{item.value}</span> : null}
      </li>)}</ul>
      {estimate}
    </div>
    <div className="lc-foot">
      {error ? <div className="alert bad lc-error" role="alert">{error}</div> : null}
      <label className="check-label ack"><input ref={ackRef} type="checkbox" checked={acknowledged} onChange={event => onAck(event.target.checked)} />我了解真实运行会消耗 Claude Pro 和 ChatGPT Pro 订阅额度</label>
      <p className="lc-why" aria-live="polite">{reason}</p>
      <button type="submit" className="primary launch" disabled={!canLaunch}>{buttonLabel}</button>
      <small className="muted">下一步会再次确认；取消不会发出任何请求。</small>
    </div>
  </section></aside>;
}
