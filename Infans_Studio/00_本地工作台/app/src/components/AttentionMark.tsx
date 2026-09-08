/** 人工关注标记。外层操作负责可访问名称与 aria-pressed，符号只表达视觉状态。 */
export function AttentionMark({ marked, partial = false, count }: { marked: boolean; partial?: boolean; count?: number }) {
  return <span className={`attention-mark${marked ? " is-marked" : ""}${partial ? " is-partial" : ""}`} aria-hidden="true">
    {count && count > 1 ? <b>{count}</b> : null}
    {partial ? <span className="attention-mark-dash" /> : null}
  </span>;
}
