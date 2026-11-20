import { useEffect, useState } from 'react';

/** 有任务在运行时每秒刷新一次当前时间，用于显示已用时；没有运行任务时不启动计时器。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
