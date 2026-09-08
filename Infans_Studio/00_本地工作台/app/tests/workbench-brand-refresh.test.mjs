import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  shouldCloseMoreSheetAfterRefresh,
  workbenchRefreshFeedbackText,
  WORKBENCH_REFRESH_FEEDBACK_SUFFIX,
} from "../src/workbench-brand-refresh.ts";

test("主题圆环刷新只生成页内反馈，不再触发浏览器硬重载", () => {
  const refreshModule = readFileSync(new URL("../src/workbench-brand-refresh.ts", import.meta.url), "utf8");
  assert.equal(WORKBENCH_REFRESH_FEEDBACK_SUFFIX, "已经刷新啦～");
  assert.equal(workbenchRefreshFeedbackText("银月"), "银月已经刷新啦～");
  assert.equal(workbenchRefreshFeedbackText("梅凝"), "梅凝已经刷新啦～");
  assert.equal(workbenchRefreshFeedbackText("  "), "小秘书已经刷新啦～");
  assert.doesNotMatch(refreshModule, /location\.reload|serviceWorker|sessionStorage/u);
});

test("更多抽屉只在刷新成功后收起，失败保持打开", () => {
  assert.equal(shouldCloseMoreSheetAfterRefresh(true), true);
  assert.equal(shouldCloseMoreSheetAfterRefresh(false), false);
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const moreSheet = main.slice(main.indexOf('{moreOpen ? <motion.div key="more-sheet"'), main.indexOf("{identity && data"));
  const refreshFn = main.slice(main.indexOf("const refreshCurrentPage = async"), main.indexOf("useEffect(() => { void preloadRoute(path"));
  assert.match(moreSheet, /refreshCurrentPage\(\)\.then\(\(ok\) => \{ if \(shouldCloseMoreSheetAfterRefresh\(ok\)\) setMoreOpen\(false\); \}\)/);
  assert.doesNotMatch(moreSheet, /onReload=\{\(\) => \{ setMoreOpen\(false\); void refreshCurrentPage/);
  assert.match(refreshFn, /return true;/);
  assert.match(refreshFn, /catch \(reason\) \{[\s\S]*return false;/);
  assert.doesNotMatch(refreshFn, /catch \(reason\) \{[\s\S]*setMoreOpen/);
});
