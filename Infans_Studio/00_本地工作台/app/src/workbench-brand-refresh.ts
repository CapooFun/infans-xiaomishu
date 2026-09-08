export const WORKBENCH_REFRESH_FEEDBACK_SUFFIX = "已经刷新啦～";

export function workbenchRefreshFeedbackText(secretaryName: string): string {
  const name = secretaryName.trim() || "小秘书";
  return `${name}${WORKBENCH_REFRESH_FEEDBACK_SUFFIX}`;
}

/** 更多抽屉只在刷新成功后收起；失败或仍在刷新时保持打开。 */
export function shouldCloseMoreSheetAfterRefresh(ok: boolean): boolean {
  return ok === true;
}
