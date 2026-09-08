import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { navigationHref, visibleTrailIndices, isInternalNavigationHref } from "../src/shell/page-navigation-model.ts";

test("path targets use explicit hierarchy, encode IDs, and drop deeper keys", () => {
  assert.equal(navigationHref("/projects", { project: "a&b", view: "wiki", module: "玉青", feature: null }), "/projects?project=a%26b&view=wiki&module=%E7%8E%89%E9%9D%92");
  assert.equal(navigationHref("/markets/assets"), "/markets/assets");
  assert.equal(navigationHref("/topics", { card: 0, node: undefined }), "/topics?card=0");
});

test("overflow keeps the root and current page, with every hidden ancestor reachable", () => {
  assert.deepEqual(visibleTrailIndices(2, true), [0, 1]);
  assert.deepEqual(visibleTrailIndices(4, false), [0, 1, 2, 3]);
  assert.deepEqual(visibleTrailIndices(6, false), [0, 4, 5]);
  assert.deepEqual(visibleTrailIndices(6, true), [0, 5]);
  for (let length = 1; length < 30; length++) {
    for (const compact of [false, true]) {
      const visible = visibleTrailIndices(length, compact);
      assert.equal(visible[0], 0);
      assert.equal(visible.at(-1), length - 1);
      const hidden = visible.flatMap((index, position) => Array.from({ length: index - (visible[position - 1] ?? -1) - 1 }, (_, offset) => (visible[position - 1] ?? -1) + 1 + offset));
      assert.equal(new Set([...visible, ...hidden]).size, length);
    }
  }
});

test("navigation rejects external, protocol-relative, and malformed destinations", () => {
  for (const href of ["https://example.com", "//example.com", "/\\example.com", "javascript:alert(1)", "/tools\n"]) assert.equal(isInternalNavigationHref(href), false);
  assert.equal(isInternalNavigationHref("/tools/native-ui-design"), true);
});

test("the path stays text-only while focus and dropdown surfaces remain usable", async () => {
  const css = await readFile(new URL("../src/shell/page-navigation.css", import.meta.url), "utf8");
  const current = css.match(/\.page-navigation h1\.path-current \{([^}]+)\}/)?.[1] || "";
  assert.match(current, /border:0;/);
  assert.match(current, /border-radius:0;/);
  assert.match(current, /background:transparent;/);
  assert.match(css, /\.path-row a:hover,\.path-row button:hover \{[^}]*background:transparent;[^}]*text-decoration:underline;/);
  assert.match(css, /\.path-menu summary:hover,\.path-menu\[open\] summary \{ background:transparent;/);
  assert.match(css, /:focus-visible \{ outline:2px solid var\(--teal\)/);
  assert.match(css, /\.path-menu-panel \{[^}]*background:var\(--surface-2\)/);
  assert.match(css, /\.path-menu summary \{[^}]*height:44px/);
});

test("only active scoped pages publish, navigation has accessible menus and real links", async () => {
  const source = await readFile(new URL("../src/shell/PageNavigation.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!scope.active\) return/);
  assert.match(source, /entries.delete\(id\)/);
  assert.match(source, /entry.route === route/);
  assert.match(source, /aria-label="页面位置"/);
  assert.match(source, /aria-current="page"/);
  assert.match(source, /<a href=\{item.href\}/);
  assert.match(source, /shouldSoftNavigate/);
  assert.match(source, /event.key === "Escape"/);
  assert.doesNotMatch(source, /description|<p>/);
  assert.doesNotMatch(source, /fetch\(|localStorage|sessionStorage/);
});

test("page title bars no longer carry duplicate subtitles", async () => {
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(main.slice(main.indexOf("const PAGE_META"), main.indexOf("function routePath")), /description:/);
  assert.doesNotMatch(main, /description=\{PAGE_META/);
  assert.doesNotMatch(main, /近 2 日|项待处理/);
  assert.doesNotMatch(styles, /\.page-heading p/);
});

test("repeated tool and project return bars are removed; return-to-todo is retained", async () => {
  const tools = await readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const projects = await readFile(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  for (const source of [tools, projects]) assert.match(source, /<PageTrail items=/);
  assert.doesNotMatch(tools, /className="tools-detail-bar"/);
  assert.doesNotMatch(projects, /className="project-wb-bar"/);
  assert.match(projects, /返回待办/);
  assert.match(projects, /window.addEventListener\("popstate", sync\)/);
});
