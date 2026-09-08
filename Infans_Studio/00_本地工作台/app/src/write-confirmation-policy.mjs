/** Shared, pure confirmation policy for browser and native transports. */
export function skipsWorkbenchWriteConfirmation(action) {
  return action?.kind === "setTodoPriority" || action?.kind === "toggleTodo";
}

export function skipsAiWriteConfirmation(action) {
  return action?.kind === "journal"
    || action?.kind === "addTodo" && action?.scope === "project";
}

export function aiWriteNeedsConfirmation(action, preview, codePath = false) {
  return !skipsAiWriteConfirmation(action)
    && Boolean(action?.requiresConfirm || preview?.requiresConfirm || codePath);
}

export function directWriteSuccessMessage(action) {
  if (action?.kind === "setTodoPriority") return "任务等级已更新";
  if (action?.kind === "toggleTodo") return action.expectedDone ? "任务已恢复" : "任务已完成";
  if (action?.kind === "acceptProductFeature") return "功能已验收";
  if (action?.kind === "addTodo") return "任务已新增";
  if (action?.kind === "journal") return "已记到今天";
  return "已写入";
}
