// Connection notice (BUILD-SPEC-B §4.3.3): one line above the log, never in the composer strip. role=status.
export function ConnectionNotice({ notice, backfill }: { notice: string; backfill: boolean }) {
  if (!notice && !backfill) return null;
  return <div className="conn-notice" role="status">
    {notice ? <p><i aria-hidden="true">↻</i>{notice}</p> : null}
    {backfill ? <p className="is-backfill">较早的执行动态暂未完全恢复，当前任务和最终结果仍可继续查看。</p> : null}
  </div>;
}
