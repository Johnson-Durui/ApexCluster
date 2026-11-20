// The follow pill (BUILD-SPEC-B §4.3.9): sits 10px above the composer. --glass-strong-bg, no backdrop-filter.
// When a pending gate card is off-screen it becomes the gate jump (`.gate.outline`) instead.

export function FollowPill({ unseen, following, gate, onJump, onGate }: {
  unseen: number | null;
  following: boolean;
  /** 'A' | 'B' while a gate card exists but is scrolled out of view. */
  gate: 'A' | 'B' | null;
  onJump(): void;
  onGate(): void;
}) {
  if (gate) {
    return <button type="button" className="follow-pill btn gate outline" onClick={onGate}>◆ 关卡 {gate} 等你决定 · 前往</button>;
  }
  if (following) return null;
  return <button type="button" className="follow-pill btn" onClick={onJump}>
    跟随最新 ↓{unseen ? <> · <span className="mono">{unseen}</span> 条新内容</> : null}
  </button>;
}
