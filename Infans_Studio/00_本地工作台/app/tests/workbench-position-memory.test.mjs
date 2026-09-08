import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  WORKBENCH_POSITION_VERSION,
  clampScrollY,
  needsScrollCorrection,
  parseWorkbenchPositionStore,
  projectFeaturePointMemoryId,
  sanitizeWorkbenchLocation,
} from "../src/workbench-position-memory.ts";

test("页面位置 URL 只保留登记过的稳定状态，不保存搜索、AI 参数或 hash", () => {
  assert.equal(
    sanitizeWorkbenchLocation("/projects?project=quit-to-cultivate&tree=features&module=combat&feature=timing&node=node%3Aprecision&q=secret&askSecretary=1#askSecretary=private"),
    "/projects?project=quit-to-cultivate&tree=features&module=combat&feature=timing&node=node%3Aprecision",
  );
  assert.equal(sanitizeWorkbenchLocation("/projects?project=game&from=todo&query=private"), "/projects?project=game&from=todo");
  assert.equal(sanitizeWorkbenchLocation("/projects?project=infans-ai-system&view=wiki&query=private"), "/projects?project=infans-ai-system&view=wiki");
  assert.equal(sanitizeWorkbenchLocation("/schedule?todos=1&query=private"), "/schedule?todos=1");
  assert.equal(sanitizeWorkbenchLocation("/languages?section=exam&query=private"), "/languages?section=exam");
  assert.equal(sanitizeWorkbenchLocation("/unknown?project=x"), null);
});

test("损坏、超限和旧版本本地数据安全降级", () => {
  assert.deepEqual(parseWorkbenchPositionStore("not-json"), { version: WORKBENCH_POSITION_VERSION, lastLocation: "/", scroll: {}, wiki: {} });
  assert.deepEqual(parseWorkbenchPositionStore(JSON.stringify({ version: 0, lastLocation: "/projects" })), { version: WORKBENCH_POSITION_VERSION, lastLocation: "/", scroll: {}, wiki: {} });
  const parsed = parseWorkbenchPositionStore(JSON.stringify({
    version: 1,
    lastLocation: "/projects?project=game&query=private",
    scroll: {
      "/projects?project=game&query=private": { y: 99999999, anchorId: "node:combat", anchorOffset: 9999, updatedAt: 3 },
      "/unknown": { y: 100, updatedAt: 2 },
    },
    wiki: {
      "game:features": { expandedModules: ["combat", "combat", 9], expandedNodes: ["node:a"], updatedAt: 4 },
    },
  }));
  assert.equal(parsed.lastLocation, "/projects?project=game");
  assert.deepEqual(parsed.scroll["/projects?project=game"], { y: 10_000_000, anchorId: "node:combat", anchorOffset: 2000, updatedAt: 3 });
  assert.equal(parsed.scroll["/unknown"], undefined);
  assert.deepEqual(parsed.wiki["game:features"].expandedModules, ["combat"]);
});

test("滚动恢复会夹在当前页面范围内，并忽略容差内的小幅变化", () => {
  assert.equal(clampScrollY(900, 1200, 500), 700);
  assert.equal(clampScrollY(-40, 1200, 500), 0);
  assert.equal(clampScrollY(120, 400, 800), 0);
  assert.equal(needsScrollCorrection(100, 107), false);
  assert.equal(needsScrollCorrection(100, 109), true);
});

test("机制节点优先复用真实 ID，旧树文本路径生成确定且可失效的 ID", () => {
  assert.equal(projectFeaturePointMemoryId("combat", "precision", ["攻击", "精准攻击"]), "node:precision");
  const legacy = projectFeaturePointMemoryId("combat", null, ["攻击", "精准攻击"]);
  assert.equal(legacy, projectFeaturePointMemoryId("combat", undefined, ["攻击", "精准攻击"]));
  assert.notEqual(legacy, projectFeaturePointMemoryId("combat", null, ["攻击", "暴击"]));
});

test("恢复器有硬停止条件，不订阅尺寸变化或把搜索词写入状态", () => {
  const source = readFileSync(new URL("../src/workbench-position-memory.ts", import.meta.url), "utf8");
  const projectPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("ResizeObserver"), true); // 只在禁止反馈环的注释中出现
  assert.equal(source.includes("new ResizeObserver"), false);
  assert.equal(source.includes("visualViewport.addEventListener"), false);
  assert.ok(source.includes("恢复期间暂停写回"));
  assert.ok(source.includes("correctionTimer"));
  assert.equal(projectPage.includes("writeProjectWikiMemory(wikiScope"), true);
  assert.equal(projectPage.includes("setQuery"), true);
  assert.equal(source.includes("query:"), false);
});

test("iPad 切页不会因位置恢复隐藏当前页", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(main, /const ROUTE_CACHE_LIMIT = 2;/u);
  assert.match(styles, /\.page-stack > \.page\.is-cached \{\s*display: none;/u);
  assert.doesNotMatch(styles, /data-position-restoring="true"[^\n]+\.page \{ visibility:hidden/u);
  assert.match(styles, /data-position-restoring="true"[^\n]+\.page\.is-active \{ visibility:visible;pointer-events:auto; \}/u);
});

test("新闻锚点导航不把主动恢复当成滚回顶部", () => {
  const source = readFileSync(new URL("../src/workbench-position-memory.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ isWorkbenchNewsHash \} from "\.\/world-news-target\.ts";/);
  assert.match(source, /if \(isWorkbenchNewsHash\(window\.location\.hash\)\) \{\s*finish\(\);/);
  assert.match(main, /active && window\.scrollY && !isWorkbenchNewsHash\(window\.location\.hash\)/);
});

test("一级目录准备完成前保留当前页，连续点击只提交最后一次", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const prepare = main.indexOf("preloadRoute(nextPath, themeRef.current)");
  const commit = main.indexOf("setPath(nextPath)", prepare);

  assert.ok(prepare >= 0, "切页前会准备目标目录");
  assert.ok(commit > prepare, "目标目录准备完成后才切换活动页");
  assert.ok(main.includes("revision !== routePreparationRevisionRef.current"));
  assert.ok(main.includes("setPendingPath(nextPath)"));
  assert.ok(main.includes('pendingPath === item.path ? "…" : item.index'));
});
