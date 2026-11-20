// Skill 来源 (#env-skills): local Skill root directories and whether each is enabled.
import type { ChatSettings, SkillSetting } from '../../../lib/chat-api';

export function SkillsSection({ settings, onChange, rowKeys }: {
  settings: ChatSettings;
  onChange(update: (current: ChatSettings) => ChatSettings): void;
  /** Stable client-side row keys, one per Skill source; never the edited ID, which would remount the row per keystroke. */
  rowKeys?: readonly string[];
}) {
  const update = (index: number, patch: Partial<SkillSetting>) => onChange(current => ({ ...current, skills: current.skills.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  return <section className="panel settings-card" id="env-skills" aria-labelledby="env-skills-heading">
    <div className="settings-section-title">
      <div><h2 id="env-skills-heading">Skill 来源</h2><p>配置本机 Skill 根目录及启用状态。</p></div>
      <button type="button" className="button compact" onClick={() => onChange(current => ({ ...current, skills: [...current.skills, { id: `skills_${current.skills.length + 1}`, root: 'C:\\path\\to\\skills', enabled: true }] }))}>添加来源</button>
    </div>
    {settings.skills.length ? <div className="settings-collection">{settings.skills.map((skill, index) => <div className="settings-item skill-setting" key={rowKeys?.[index] ?? `skill-${index}`}>
      <label className="settings-field">ID<input value={skill.id} onChange={event => update(index, { id: event.target.value })} /></label>
      <label className="settings-field">根目录<input className="mono" value={skill.root} onChange={event => update(index, { root: event.target.value })} /></label>
      <label className="settings-switch"><input type="checkbox" checked={skill.enabled} onChange={event => update(index, { enabled: event.target.checked })} />启用</label>
      <button type="button" className="ghost compact" onClick={() => onChange(current => ({ ...current, skills: current.skills.filter((_, itemIndex) => itemIndex !== index) }))}>删除</button>
    </div>)}</div> : <p className="muted settings-empty">尚未添加 Skill 来源。</p>}
  </section>;
}
