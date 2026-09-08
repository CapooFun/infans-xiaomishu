import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const assetsPage = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const selector = assetsPage.slice(
  assetsPage.indexOf("function InvestmentScopeSelector"),
  assetsPage.indexOf("function InvestmentCashBridge"),
);

test("投资范围按账户页签、账户内市场、概览的因果顺序排列", () => {
  const accountTabs = selector.indexOf('className="asset-investment-account-tabs"');
  const detailPanel = selector.indexOf('className="asset-investment-scope-detail"');
  const marketFilter = selector.indexOf('className="asset-investment-market-filter"');
  const overview = selector.indexOf('className="asset-investment-overview"');

  assert.ok(accountTabs >= 0);
  assert.ok(detailPanel > accountTabs);
  assert.ok(marketFilter > detailPanel);
  assert.ok(overview > marketFilter);
});

test("账户选择只保留页签语义，不再插入解释横栏", () => {
  assert.match(selector, /role="tablist" aria-label="选择投资账户"/);
  assert.match(selector, /role="tab" aria-controls="investment-account-detail"/);
  assert.match(selector, /role="tabpanel" aria-labelledby=\{selectedTabId\}/);
  assert.doesNotMatch(selector, /选择要查看的账户|切换后，下方概览、图表和持仓一起更新。/);
  assert.doesNotMatch(selector, /当前打开的账户|以下数字及后续内容/);
  assert.match(selector, /市场只筛选当前账户内的持仓、贡献和曲线/);
});

test("选中账户页签与下方详情共用同一加重底色", () => {
  assert.doesNotMatch(styles, /\.asset-investment-scope \{[^}]*--investment-account-surface:/);
  assert.match(styles, /:root \{[^}]*--investment-account-surface:/);
  assert.match(styles, /\.asset-investment-scope-detail \{ background:var\(--investment-account-surface\)/);
  assert.match(styles, /\.asset-investment-account-tabs button\.active \{[^}]*background:var\(--investment-account-surface\)/);
});
