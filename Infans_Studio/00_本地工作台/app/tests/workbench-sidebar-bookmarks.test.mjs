import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SIDEBAR_BOOKMARKS,
  defaultSidebarBookmarkLabel,
  isSidebarBookmarkNavigableInDisplayMode,
  isSidebarBookmarkableLocation,
  normalizeSidebarBookmarkLocation,
  normalizeSidebarBookmarks,
} from "../src/sidebar-bookmarks.mjs";
import { readSidebarBookmarks, sidebarBookmarksPath, writeSidebarBookmarks } from "../src/server/workbench-sidebar-bookmarks.mjs";

test("侧栏书签只保留受控内部页面和登记参数", () => {
  assert.equal(normalizeSidebarBookmarkLocation("/projects?project=game-a&feature=combat&q=secret#chat"), "/projects?project=game-a&feature=combat");
  assert.equal(normalizeSidebarBookmarkLocation("/tools/music?path=private"), "/tools/music");
  assert.equal(normalizeSidebarBookmarkLocation("/tools/unknown"), null);
  assert.equal(normalizeSidebarBookmarkLocation("https://example.com/projects?project=game-a"), null);
  assert.equal(isSidebarBookmarkableLocation("/"), true);
  assert.equal(isSidebarBookmarkableLocation("/projects"), true);
  assert.equal(isSidebarBookmarkableLocation("/tools"), true);
  assert.equal(isSidebarBookmarkableLocation("/projects?project=game-a"), true);
  assert.equal(isSidebarBookmarkableLocation("/unknown"), false);
});

test("工作系统四个入口沿用稳定路由并使用新名称", () => {
  for (const [id, label] of [
    ["art-library", "项目素材库"],
    ["native-ui-design", "设计台"],
    ["ai-tools", "工具与素材收藏"],
    ["game-analytics", "游戏数据表现"],
  ]) {
    assert.equal(normalizeSidebarBookmarkLocation(`/tools/${id}`), `/tools/${id}`);
    assert.equal(defaultSidebarBookmarkLabel(`/tools/${id}`), label);
  }
});

test("侧栏书签去重、清理标签并限制为六个", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    location: `/topics?domain=ai&node=node-${index}`,
    label: `  人工智能\n节点 ${index}  `,
  }));
  items.splice(1, 0, { ...items[0], label: "重复" });
  const snapshot = normalizeSidebarBookmarks({ items });
  assert.equal(snapshot.items.length, MAX_SIDEBAR_BOOKMARKS);
  assert.equal(snapshot.items[0].label, "人工智能 节点 0");
  assert.equal(new Set(snapshot.items.map((item) => item.location)).size, MAX_SIDEBAR_BOOKMARKS);
  assert.equal(defaultSidebarBookmarkLabel("/tools/music"), "音乐");
  assert.equal(defaultSidebarBookmarkLabel("/tools/web-bookmarks"), "网页收藏");
  assert.equal(defaultSidebarBookmarkLabel("/tools/food-map"), "美食地图");
  assert.equal(defaultSidebarBookmarkLabel("/languages?section=grammar"), "日语 · 文法");
  assert.equal(defaultSidebarBookmarkLabel("/markets"), "世界资讯 · 日本");
  assert.equal(defaultSidebarBookmarkLabel("/markets?lane=finance"), "世界资讯 · 金融");
  assert.equal(defaultSidebarBookmarkLabel("/markets?lane=ai"), "世界资讯 · AI");
});

test("展示模式保留书签位置，只允许登记过的公开标签跳转", () => {
  for (const location of [
    "/library?kind=writing&open=note-a",
    "/tools/diary-mode",
    "/tools/inbox",
  ]) {
    assert.equal(isSidebarBookmarkNavigableInDisplayMode({ location, label: defaultSidebarBookmarkLabel(location) }), false, location);
  }
  for (const location of [
    "/projects?project=assistant",
    "/markets/assets?tab=income",
    "/tools/art-library",
    "/tools/settings",
    "/tools/photo",
    "/tools/music",
  ]) {
    assert.equal(isSidebarBookmarkNavigableInDisplayMode({ location, label: defaultSidebarBookmarkLabel(location) }), true, location);
  }
  assert.equal(isSidebarBookmarkNavigableInDisplayMode({ location: "/projects?project=assistant", label: "未登记标签" }), false);
});

test("共享书签缺省不创建文件，写入使用 0600 原子派生状态", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-sidebar-bookmarks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readSidebarBookmarks(root), { version: 1, items: [] });
  await assert.rejects(fs.access(sidebarBookmarksPath(root)));
  const written = await writeSidebarBookmarks(root, {
    items: [
      { location: "/tools/music", label: "音乐" },
      { location: "/tools/music", label: "重复" },
      { location: "/languages?section=grammar", label: "日语 · 文法" },
    ],
  });
  assert.deepEqual(written.items.map((item) => item.location), ["/tools/music", "/languages?section=grammar"]);
  assert.deepEqual(await readSidebarBookmarks(root), written);
  assert.equal((await fs.stat(sidebarBookmarksPath(root))).mode & 0o777, 0o600);
});

test("工作台壳层在书签区内提供添加、删除、排序、快捷槽与有界展开", async () => {
  const [main, styles, languages, assets] = await Promise.all([
    fs.readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/pages/languages/LanguagesPage.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(main, /sidebar-mode-switch/);
  assert.match(main, /sidebar-bookmark-add/);
  assert.match(main, /more-sheet-bookmark-add/);
  assert.match(main, /添加当前页面/);
  assert.match(main, /展开其余/);
  assert.doesNotMatch(main, /page-bookmark-toggle/);
  assert.match(main, /GripVertical/);
  assert.match(main, /reorderVisibleSidebarBookmarks/);
  assert.match(main, /sidebar-bookmark-shortcut/);
  assert.match(main, /variant === "desktop" && shortcut/);
  assert.match(main, /more-sheet-bookmarks/);
  assert.match(main, /onOpen=\{\(event, location\) => \{ setMoreOpen\(false\); openSidebarBookmark\(event, location\); \}\}/);
  assert.match(main, /onThemeChange=\{\(next\) => \{ setMoreOpen\(false\); void switchTheme\(next\); \}\}/);
  assert.match(main, /MAX_SIDEBAR_BOOKMARKS/);
  assert.match(styles, /\.sidebar-bookmark-row/);
  assert.match(styles, /\.more-sheet-bookmark-row/);
  assert.match(styles, /\.more-sheet-bookmarks > div \{ display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:6px; \}/);
  assert.match(styles, /\.more-sheet-bookmark-row > a \{ min-height:40px;padding:0 32px;/);
  assert.match(languages, /setSectionState\(readSectionQuery\(\)\)/);
  assert.match(assets, /setTab\(readAssetsTab\(\)\)/);
});
