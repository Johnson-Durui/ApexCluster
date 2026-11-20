// A leaf clock (BUILD-SPEC-B §3.4, §7 guards): it ticks once per second only while `active` and unfinished, so no page
// re-renders every second. Without `until` and not active it shows the value of its last tick (frozen).
import { useEffect, useState } from 'react';

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function Elapsed({ since, until, active, prefix = '已用 ', suffix = '' }: { since: string; until?: string; active: boolean; prefix?: string; suffix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || until) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, until]);
  const start = Date.parse(since);
  const end = until ? Date.parse(until) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return <span className="elapsed mono">{prefix}{formatClock(end - start)}{suffix}</span>;
}
