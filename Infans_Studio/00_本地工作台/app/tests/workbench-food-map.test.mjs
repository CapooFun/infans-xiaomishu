import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { straightLineDistanceKm } from "../src/food-map-distance.ts";
import {
  foodMapCatalogPath,
  foodMapStatePath,
  readFoodMap,
  readFoodMapState,
  writeFoodMapPlaceState,
} from "../src/server/workbench-food-map.mjs";

function catalogMarkdown() {
  return `---
description: test food map
tags: [test]
---

\`\`\`json
${JSON.stringify({
  schemaVersion: 1,
  updatedAt: "2026-09-02T00:00:00+09:00",
  tasteProfile: { sweetness: "不特别甜", favorites: ["巴斯克"], currentInterests: ["美式烤肉"] },
  placeMedia: {
    "beltz-test": {
      imageUrl: "https://example.com/beltz.jpg",
      imageAlt: "BELTZ 巴斯克芝士蛋糕",
      imageKind: "official",
      imageSourceLabel: "BELTZ 官网",
      imageSourceUrl: "https://example.com/beltz",
      menuHighlights: [
        { name: "巴斯克芝士蛋糕 S", price: "¥750", note: "低甜候选" },
        { name: "过长菜单不应出现", price: null, note: null },
      ],
      menuSourceLabel: "官方菜单",
      menuUrl: "https://example.com/beltz/menu",
    },
  },
  places: [
    {
      id: "beltz-test",
      name: "BELTZ Test",
      area: "广尾",
      station: "广尾",
      category: "dessert",
      tags: ["巴斯克"],
      latitude: 35.6514395,
      longitude: 139.7130389,
      address: "Hiroo, Tokyo",
      profileMatch: "high",
      reason: "巴斯克候选",
      sourceType: "google-saved-food",
      sourceLabel: "Google 地图 · 美食（本人收藏）",
      sourceUrl: "https://www.google.com/maps/search/?api=1&query=BELTZ",
      verifiedAt: "2026-09-02",
      initialState: "explore",
    },
    {
      id: "closed-test",
      name: "Closed Test",
      area: "池袋",
      station: "池袋",
      category: "meal",
      tags: ["历史收藏"],
      latitude: 35.73,
      longitude: 139.71,
      address: "Ikebukuro, Tokyo",
      profileMatch: "neutral",
      reason: "关店历史",
      sourceType: "google-saved-food",
      sourceLabel: "Google 地图 · 美食（本人收藏）",
      sourceUrl: "https://www.google.com/maps/search/?api=1&query=Closed",
      verifiedAt: "2026-09-02",
      initialState: "archived",
      closed: true,
    },
  ],
}, null, 2)}
\`\`\`
`;
}

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-food-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = foodMapCatalogPath(root);
  await fs.mkdir(path.dirname(catalog), { recursive: true });
  await fs.writeFile(catalog, catalogMarkdown(), "utf8");
  return root;
}

test("美食地图 GET 只读合并原件，不顺手创建派生状态", async (t) => {
  const root = await createRoot(t);
  const snapshot = await readFoodMap(root);
  assert.equal(snapshot.places.length, 2);
  assert.equal(snapshot.places[0].listState, "explore");
  assert.equal(snapshot.places[1].listState, "archived");
  assert.equal(snapshot.places[0].imageKind, "official");
  assert.equal(snapshot.places[0].menuHighlights[0].name, "巴斯克芝士蛋糕 S");
  assert.equal(snapshot.places[0].menuHighlights[0].price, "¥750");
  assert.equal(snapshot.places[1].imageUrl, "");
  assert.match(snapshot.places[0].navigationUrl, /destination=35\.6514395,139\.7130389/);
  assert.doesNotMatch(snapshot.places[0].navigationUrl, /origin=/);
  await assert.rejects(fs.access(foodMapStatePath(root)));
});

test("美食关注与收藏只保存稳定 ID，黑榜和归档自动取消关注", async (t) => {
  const root = await createRoot(t);
  let snapshot = await writeFoodMapPlaceState(root, { id: "beltz-test", followed: true });
  assert.equal(snapshot.places[0].followed, true);
  snapshot = await writeFoodMapPlaceState(root, { id: "beltz-test", listState: "favorite", note: "  喜欢但别太甜\n" });
  assert.equal(snapshot.places[0].listState, "favorite");
  assert.equal(snapshot.places[0].followed, true);
  assert.equal(snapshot.places[0].note, "喜欢但别太甜");
  snapshot = await writeFoodMapPlaceState(root, { id: "beltz-test", listState: "blacklist" });
  assert.equal(snapshot.places[0].followed, false);
  snapshot = await writeFoodMapPlaceState(root, { id: "beltz-test", listState: "archived", followed: true });
  assert.equal(snapshot.places[0].followed, false);
  assert.equal((await fs.stat(foodMapStatePath(root))).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys((await readFoodMapState(root)).items), ["beltz-test"]);
});

test("美食派生状态拒绝未知地点与非法状态", async (t) => {
  const root = await createRoot(t);
  await assert.rejects(writeFoodMapPlaceState(root, { id: "missing-place", followed: true }), /不在当前原件/);
  await assert.rejects(writeFoodMapPlaceState(root, { id: "beltz-test", listState: "deleted" }), /状态不正确/);
});

test("东京直线距离在浏览器本地按公里计算", () => {
  const distance = straightLineDistanceKm(
    { latitude: 35.681236, longitude: 139.767125 },
    { latitude: 35.6514395, longitude: 139.7130389 },
  );
  assert.ok(distance > 5.5 && distance < 6.5, distance);
});

test("美食页保持卡片决策、显式定位与 Google 导航，不出现搜索框", async () => {
  const [source, css, toolsPage] = await Promise.all([
    fs.readFile(new URL("../src/pages/tools/FoodMapView.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/pages/tools/food-map.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(source, /当前位置不会发送给小秘书/);
  assert.match(source, /探索.*收藏.*黑榜/s);
  assert.match(source, /navigationUrl/);
  assert.match(source, /loading="lazy"/);
  assert.match(source, /MENU NOTES/);
  assert.match(source, /imageSourceUrl/);
  assert.doesNotMatch(source, /<input|type="search"|placeholder=.*搜索/u);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /food-card-image/);
  assert.match(css, /food-detail-menu/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(toolsPage, /id: "food-map",\s+group: "life"/);
});
