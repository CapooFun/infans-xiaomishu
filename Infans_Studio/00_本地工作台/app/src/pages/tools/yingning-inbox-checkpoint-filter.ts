// 项目收件检查点筛选：胶囊太多时默认收成一行，下面证据卡仍按「全部」展示。

export const CHECKPOINT_FILTER_COLLAPSE_AT = 8;

export function checkpointFilterCollapsible(count: number) {
  return count > CHECKPOINT_FILTER_COLLAPSE_AT;
}

export function checkpointFilterChips<T extends { checkpointId: string }>(
  checkpoints: readonly T[],
  selectedId: string | null,
  expanded: boolean,
): readonly T[] {
  if (!checkpointFilterCollapsible(checkpoints.length) || expanded) return checkpoints;
  if (!selectedId) return [];
  const selected = checkpoints.find((item) => item.checkpointId === selectedId);
  return selected ? [selected] : [];
}

export function checkpointFilterToggleLabel(count: number, expanded: boolean) {
  return expanded ? "收起" : `${count} 个检查点`;
}
