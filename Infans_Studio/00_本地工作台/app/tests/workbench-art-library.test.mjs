import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ART_LIBRARY_ANNOTATIONS_PATH,
  ART_LIBRARY_DECISIONS_PATH,
  ART_LIBRARY_MOVES_PATH,
  ART_LIBRARY_TAGS_PATH,
  ART_SEMANTIC_CATALOG_PATH,
  createArtLibraryService,
} from "../src/server/workbench-art-library.mjs";

function fakePng(width, height, colorType = 6, marker = 0) {
  const buffer = Buffer.alloc(34);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = colorType;
  buffer[33] = marker;
  return buffer;
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "infans-art-library-"));
  const root = path.join(base, "game");
  const cacheDir = path.join(base, "cache");
  await fs.mkdir(path.join(root, ".infans"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "characters"), { recursive: true });
  await fs.mkdir(path.join(root, "candidates", "batch-a"), { recursive: true });
  await fs.mkdir(path.join(root, "archive", "batch-a"), { recursive: true });
  await fs.mkdir(path.join(root, "delivery", "steam"), { recursive: true });
  await fs.mkdir(path.join(root, "scenes"), { recursive: true });
  await fs.writeFile(path.join(root, ".infans", "art-library.v1.json"), JSON.stringify({
    schemaVersion: 1,
    project: { id: "test-game", name: "测试游戏" },
    scanRoots: [
      { id: "runtime", path: "assets", label: "工程素材", role: "runtime", category: "游戏内" },
      { id: "candidates", path: "candidates", label: "AI 候选", role: "source", zone: "candidate", category: "候选" },
      { id: "archive", path: "archive", label: "归档素材", role: "archive", engineIgnore: true, category: "归档" },
      { id: "steam", path: "delivery/steam", label: "Steam", role: "platform", category: "平台" },
    ],
    ignore: ["**/.DS_Store"],
    categories: ["游戏内", "归档", "平台"],
    archiveTarget: "archive",
    tagLibrary: ART_LIBRARY_TAGS_PATH,
    referenceScan: { roots: ["scenes"], completeForRuntime: true, completeForZones: ["formal", "candidate", "archive"] },
    platformSets: [{ id: "steam-test", name: "Steam", rule: "steam-store.v1", scanRootIds: ["steam"] }],
  }, null, 2));
  await fs.writeFile(path.join(root, ART_LIBRARY_TAGS_PATH), JSON.stringify({
    schemaVersion: 1,
    projectId: "test-game",
    rules: [
      { id: "characters", match: { pathPrefix: "assets/characters/" }, groups: [{ label: "对象", tags: ["主角", "敌人"] }, { label: "用途", tags: ["角色立绘"] }] },
    ],
  }, null, 2));
  await fs.writeFile(path.join(root, ART_SEMANTIC_CATALOG_PATH), JSON.stringify({
    schemaVersion: 1,
    project: { id: "test-game", name: "测试游戏" },
    sourceFingerprint: "sha256:test",
    categoryTree: [
      { id: "characters", label: "人物", children: [{ id: "player", label: "玩家" }, { id: "enemies", label: "敌人" }] },
      { id: "items", label: "物品" },
    ],
    entities: [{
      id: "entity:player:main",
      entityType: "player",
      gameId: "main",
      displayName: "玩家角色",
      categoryPath: ["characters", "player"],
      sourceFiles: ["scenes/main.tscn"],
      fields: { form: "当前形态" },
      confidence: "authoritative-resource",
      assetRelations: [{ assetId: "asset:path:assets/characters/hero.png", assetPath: "assets/characters/hero.png", role: "portrait", sourceFile: "scenes/main.tscn", confidence: "explicit-resource-field" }],
    }],
    assets: [{
      id: "asset:path:assets/characters/hero.png",
      path: "assets/characters/hero.png",
      fileName: "hero.png",
      sourceZones: ["formal"],
      categoryPath: ["characters", "player"],
      semanticSource: "explicit-resource-field",
      entityIds: ["entity:player:main"],
      references: [{ file: "scenes/main.tscn", line: 1 }],
      usageStatus: "used",
    }],
    conflicts: { duplicateEntityIds: [], missingAssetPaths: [] },
  }, null, 2));
  const shared = fakePng(64, 64, 6, 1);
  await fs.writeFile(path.join(root, "assets", "characters", "hero.png"), shared);
  await fs.writeFile(path.join(root, "candidates", "batch-a", "hero-ai.png"), fakePng(96, 96, 6, 4));
  await fs.writeFile(path.join(root, "archive", "batch-a", "hero-source.png"), shared);
  await fs.writeFile(path.join(root, "delivery", "steam", "header.png"), fakePng(920, 430, 2, 2));
  await fs.writeFile(path.join(root, "scenes", "main.tscn"), 'texture = "res://assets/characters/hero.png"\n');
  const service = createArtLibraryService({ sources: { "test-game": { root } }, cacheDir });
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  return { base, root, cacheDir, service };
}

test("美术库持久保留索引，只在明确刷新时增量合并", async (t) => {
  const { root, service } = await fixture(t);
  const first = await service.snapshot({ projectId: "test-game", view: "files" });
  assert.equal(first.stats.total, 4);
  assert.equal(first.indexUpdate.mode, "full");
  assert.equal(first.items.find((item) => item.name === "hero.png")?.referenceStatus, "using");
  assert.deepEqual(first.items.find((item) => item.name === "hero.png")?.references, [{ path: "scenes/main.tscn", kind: "scene" }]);
  assert.equal(first.items.find((item) => item.name === "hero-source.png")?.referenceStatus, "unreferenced");
  assert.equal(first.items.find((item) => item.name === "hero.png")?.duplicate, true);

  await fs.writeFile(path.join(root, "assets", "characters", "enemy.png"), fakePng(80, 96, 6, 3));
  const cached = await service.snapshot({ projectId: "test-game", view: "files" });
  assert.equal(cached.stats.total, 4, "普通进入页面不应重扫目录");

  const refreshed = await service.snapshot({ projectId: "test-game", view: "files", refresh: true });
  assert.equal(refreshed.stats.total, 5);
  assert.deepEqual(refreshed.indexUpdate, { mode: "incremental", added: 1, changed: 0, removed: 0 });
});

test("尺寸合规只是系统事实，不会自动晋升为正式", async (t) => {
  const { root, service } = await fixture(t);
  const snapshot = await service.snapshot({ projectId: "test-game", view: "platform" });
  const header = snapshot.platformSets[0].slots.find((slot) => slot.id === "header-capsule");
  assert.equal(header.checks.specification, "pass");
  assert.equal(header.candidates[0].manualConclusion, "unjudged");
  await assert.rejects(fs.access(path.join(root, ART_LIBRARY_DECISIONS_PATH)), /ENOENT/u);
});

test("素材位置直接定义正式、AI 候选和归档三个区域", async (t) => {
  const { root, service } = await fixture(t);
  const snapshot = await service.snapshot({ projectId: "test-game", view: "files" });
  assert.deepEqual(snapshot.zones.map((zone) => [zone.id, zone.count]), [["formal", 1], ["candidate", 1], ["archive", 1]]);
  const formal = snapshot.zones.find((zone) => zone.id === "formal");
  assert.equal(formal.roots[0].directories[0].path, "characters");
  const browse = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "characters" });
  assert.deepEqual(browse.items.map((item) => [item.name, item.zone]), [["hero.png", "formal"]]);
  await assert.rejects(fs.access(path.join(root, ART_LIBRARY_DECISIONS_PATH)), /ENOENT/u);
});

test("对象关联只解析当前美术索引中的完整路径并沿用原状态和 ID", async (t) => {
  const { service } = await fixture(t);
  const snapshot = await service.snapshot({ projectId: "test-game", view: "files" });
  const paths = ["assets/characters/hero.png", "candidates/batch-a/hero-ai.png", "../secret.png", "hero.png"];
  const related = await service.resolveLinkedItems({ projectId: "test-game", paths });
  assert.equal(related.length, 2);
  for (const item of related) {
    const original = snapshot.items.find((row) => row.relativePath === item.path);
    assert.ok(original);
    assert.equal(item.id, original.id);
    assert.equal(item.zone, original.zone);
    assert.ok(item.previewUrl.includes(`id=${item.id}`));
  }
});

test("文件事实标签会筛选整个目录树，而不只筛选打开后的文件", async (t) => {
  const { root, service } = await fixture(t);
  await fs.mkdir(path.join(root, "assets", "unused"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "unused", "unused.png"), fakePng(72, 72, 6, 9));
  await service.snapshot({ projectId: "test-game", view: "files", refresh: true });

  const all = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "" });
  assert.deepEqual(all.directories.map((row) => row.path), ["characters", "unused"]);

  const using = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "", system: "using" });
  assert.deepEqual(using.directories.map((row) => [row.path, row.count]), [["characters", 1]]);
  assert.equal(using.directories[0].samples[0].name, "hero.png");
  assert.equal(using.filteredZoneTotal, 1);
  assert.deepEqual(using.filter, { system: "using", query: "" });

  const unreferenced = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "", system: "unreferenced" });
  assert.deepEqual(unreferenced.directories.map((row) => [row.path, row.count]), [["unused", 1]]);
  assert.equal(unreferenced.filteredZoneTotal, 1);

  const duplicate = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "", system: "duplicate" });
  assert.deepEqual(duplicate.directories.map((row) => [row.path, row.count]), [["characters", 1]]);
  assert.equal(duplicate.filteredZoneTotal, 1);

  const unknown = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "", system: "unknown" });
  assert.deepEqual(unknown.directories, []);
  assert.equal(unknown.filteredZoneTotal, 0);

  const searched = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "", q: "unused.png" });
  assert.deepEqual(searched.directories.map((row) => [row.path, row.count]), [["unused", 1]]);
});

test("正式素材说明是项目内的可校正 AI 初稿，候选和归档不生成", async (t) => {
  const { root, service } = await fixture(t);
  const seeded = await service.seedFormalAnnotations({ projectId: "test-game" });
  assert.deepEqual({ created: seeded.created, formalTotal: seeded.formalTotal }, { created: 1, formalTotal: 1 });
  const rows = (await fs.readFile(path.join(root, ART_LIBRARY_ANNOTATIONS_PATH), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relativePath, "assets/characters/hero.png");
  assert.equal(rows[0].provenance, "ai-draft");

  const snapshot = await service.snapshot({ projectId: "test-game", view: "files" });
  const hero = snapshot.items.find((item) => item.name === "hero.png");
  const candidate = snapshot.items.find((item) => item.name === "hero-ai.png");
  assert.equal(hero.annotation.provenance, "ai-draft");
  assert.equal(candidate.annotation, null);

  await service.appendAnnotation({ projectId: "test-game", assetId: hero.id, purpose: "主角青年期立绘，用于开场对话。", subject: "主角", form: "青年", scene: "开场", avoid: "成年结局", tags: ["主角", "青年形态"] });
  const corrected = await service.snapshot({ projectId: "test-game", view: "files" });
  const correctedHero = corrected.items.find((item) => item.name === "hero.png");
  assert.equal(correctedHero.annotation.provenance, "capoo-confirmed");
  assert.equal(correctedHero.annotation.form, "青年");
  assert.deepEqual(correctedHero.annotation.tags, ["主角", "青年形态"]);
  const searched = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "characters", q: "成年结局" });
  assert.deepEqual(searched.items.map((item) => item.name), ["hero.png"]);
});

test("用途标签由游戏项目规则提供，并支持只点标签保存", async (t) => {
  const { service } = await fixture(t);
  const browse = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "characters" });
  const hero = browse.items.find((item) => item.name === "hero.png");
  assert.deepEqual(hero.suggestedTagGroups, [
    { label: "对象", tags: ["主角", "敌人"] },
    { label: "用途", tags: ["角色立绘"] },
  ]);
  await service.appendAnnotation({ projectId: "test-game", assetId: hero.id, purpose: "", subject: "", form: "", scene: "", avoid: "", tags: ["主角"] });
  const saved = await service.browse({ projectId: "test-game", rootId: "runtime", directory: "characters", q: "主角" });
  assert.deepEqual(saved.items[0].annotation.tags, ["主角"]);
});

test("圆圈待处理标记适用于所有素材区域，并随文件移动", async (t) => {
  const { service } = await fixture(t);
  const initial = await service.snapshot({ projectId: "test-game", view: "files" });
  const candidate = initial.items.find((item) => item.name === "hero-ai.png");
  const flagged = await service.setAssetAttention({ projectId: "test-game", assetId: candidate.id, needsAttention: true });
  assert.equal(flagged.annotation.needsAttention, true);
  assert.ok(Date.parse(flagged.annotation.attentionChangedAt));
  const moved = await service.moveAssets({ projectId: "test-game", assetIds: [candidate.id], targetRootId: "runtime", targetSubdirectory: "characters" });
  const afterMove = await service.snapshot({ projectId: "test-game", view: "files" });
  assert.equal(afterMove.items.find((item) => item.name === "hero-ai.png")?.annotation?.needsAttention, true);
  await service.undoMove({ projectId: "test-game", batchId: moved.batchId });
});

test("使用清单按实际引用文件分组，并支持整组标记与最近三十分钟索引", async (t) => {
  const { service } = await fixture(t);
  const initial = await service.snapshot({ projectId: "test-game", view: "files" });
  const hero = initial.items.find((item) => item.name === "hero.png");
  const usage = await service.usage({ projectId: "test-game", recentMinutes: 30 });
  assert.equal(usage.stats.assets, 1);
  assert.equal(usage.stats.sources, 1);
  assert.equal(usage.groups[0].sources[0].path, "scenes/main.tscn");
  assert.deepEqual(usage.groups[0].sources[0].items.map((item) => item.id), [hero.id]);

  const flagged = await service.setAssetsAttention({ projectId: "test-game", assetIds: [hero.id], needsAttention: true });
  assert.equal(flagged.count, 1);
  const after = await service.usage({ projectId: "test-game", recentMinutes: 30 });
  assert.equal(after.stats.attention, 1);
  assert.equal(after.stats.recent, 1);
  assert.equal(after.recentItems[0].id, hero.id);
});

test("中文内容索引按项目分类树返回实体，并接合现有素材详情", async (t) => {
  const { service } = await fixture(t);
  const root = await service.semantic({ projectId: "test-game", category: "characters" });
  assert.equal(root.selection.label, "人物");
  assert.deepEqual(root.tree.map((node) => [node.label, node.entityCount, node.assetCount]), [["人物", 1, 1], ["物品", 0, 0]]);
  assert.deepEqual(root.selection.children.map((node) => [node.label, node.entityCount, node.assetCount]), [["玩家", 1, 1], ["敌人", 0, 0]]);

  const player = await service.semantic({ projectId: "test-game", category: "characters/player" });
  assert.equal(player.entities[0].displayName, "玩家角色");
  assert.equal(player.entities[0].gameId, "main");
  assert.equal(player.assets[0].libraryItem.name, "hero.png");
  assert.equal(player.assets[0].libraryItem.referenceStatus, "using");
  assert.deepEqual(player.selection.breadcrumbs.map((row) => row.label), ["人物", "玩家"]);
});

test("对象关联素材只保留有真实引用证据的使用中素材，并返回全部关联项", async (t) => {
  const { root, service } = await fixture(t);
  const catalogPath = path.join(root, ART_SEMANTIC_CATALOG_PATH);
  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  const entity = catalog.entities[0];
  const sceneLines = [];
  for (let index = 1; index <= 5; index += 1) {
    const relative = `assets/characters/used-${index}.png`;
    const assetId = `asset:path:${relative}`;
    await fs.writeFile(path.join(root, relative), fakePng(80 + index, 96, 6, index + 10));
    sceneLines.push(`texture_${index} = "res://${relative}"`);
    entity.assetRelations.push({ assetId, assetPath: relative, role: "portrait", sourceFile: "scenes/all-portraits.tscn", confidence: "explicit-resource-field" });
    catalog.assets.push({
      id: assetId,
      path: relative,
      fileName: `used-${index}.png`,
      sourceZones: ["formal"],
      categoryPath: ["characters", "player"],
      semanticSource: "explicit-resource-field",
      entityIds: [entity.id],
      references: [{ file: "scenes/all-portraits.tscn", line: index }],
      usageStatus: "used",
    });
  }
  const unusedId = "asset:path:candidates/batch-a/hero-ai.png";
  entity.assetRelations.push({ assetId: unusedId, assetPath: "candidates/batch-a/hero-ai.png", role: "portrait", sourceFile: "semantic-grouping-only", confidence: "inferred" });
  catalog.assets.push({
    id: unusedId,
    path: "candidates/batch-a/hero-ai.png",
    fileName: "hero-ai.png",
    sourceZones: ["candidate"],
    categoryPath: ["characters", "player"],
    semanticSource: "inferred",
    entityIds: [entity.id],
    references: [],
    usageStatus: "unreferenced",
  });
  await fs.writeFile(path.join(root, "scenes", "all-portraits.tscn"), `${sceneLines.join("\n")}\n`);
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  await service.snapshot({ projectId: "test-game", view: "files", refresh: true });

  const player = await service.semantic({ projectId: "test-game", category: "characters/player" });
  assert.equal(player.entities[0].assetRelations.length, 6);
  assert.ok(player.entities[0].assetRelations.every((relation) => relation.assetId !== unusedId));
  assert.ok(player.assets.some((asset) => asset.id === unusedId), "未使用素材仍可在分类与素材目录中浏览");

  const candidates = await service.semantic({ projectId: "test-game", category: "characters", zone: "candidate" });
  assert.deepEqual(candidates.tree.map((node) => node.label), ["人物"]);
  assert.ok(candidates.assets.every((asset) => asset.libraryItem?.zone === "candidate" || asset.sourceZones.includes("candidate")));
  assert.ok(candidates.assets.some((asset) => asset.id === unusedId));
  assert.equal(candidates.tree.reduce((sum, node) => sum + node.assetCount, 0), candidates.assets.length);
});

test("缩略图生成轻量 WebP 并按尺寸档缓存", async (t) => {
  const { root, cacheDir, service } = await fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await fs.writeFile(path.join(root, "assets", "characters", "hero.png"), png);
  const snapshot = await service.snapshot({ projectId: "test-game", view: "files", refresh: true });
  const hero = snapshot.items.find((item) => item.name === "hero.png");
  const response = new PassThrough();
  response.headers = {};
  response.setHeader = (key, value) => { response.headers[String(key).toLowerCase()] = value; };
  await service.sendThumbnail(response, { projectId: "test-game", assetId: hero.id, size: "tiny" });
  assert.equal(response.headers["content-type"], "image/webp");
  const files = await fs.readdir(path.join(cacheDir, "thumbnails", "test-game"));
  assert.ok(files.some((file) => /-240-q58\.webp$/u.test(file)));
});

test("素材说明通过稳定身份和移动记录跟随文件", async (t) => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, "assets", "characters", "enemy.png"), fakePng(80, 96, 6, 7));
  await service.snapshot({ projectId: "test-game", view: "files", refresh: true });
  await service.seedFormalAnnotations({ projectId: "test-game" });
  const initial = await service.snapshot({ projectId: "test-game", view: "files" });
  const enemy = initial.items.find((item) => item.name === "enemy.png");
  const uid = enemy.assetUid;
  const moved = await service.moveAssets({ projectId: "test-game", assetIds: [enemy.id], targetRootId: "archive", targetSubdirectory: "batch-a" });
  await fs.access(path.join(root, "archive", ".gdignore"));
  await service.undoMove({ projectId: "test-game", batchId: moved.batchId });
  const restored = await service.snapshot({ projectId: "test-game", view: "files" });
  assert.equal(restored.items.find((item) => item.name === "enemy.png")?.assetUid, uid);
});

test("AI 候选可批量升为正式并通过移动记录撤销", async (t) => {
  const { root, service } = await fixture(t);
  const initial = await service.snapshot({ projectId: "test-game", view: "files" });
  const candidate = initial.items.find((item) => item.name === "hero-ai.png");
  const moved = await service.moveAssets({ projectId: "test-game", assetIds: [candidate.id], targetRootId: "runtime", targetSubdirectory: "characters" });
  assert.equal(moved.count, 1);
  await fs.access(path.join(root, "assets", "characters", "hero-ai.png"));
  await assert.rejects(fs.access(path.join(root, "candidates", "batch-a", "hero-ai.png")), /ENOENT/u);
  const rows = (await fs.readFile(path.join(root, ART_LIBRARY_MOVES_PATH), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].sourceZone, "candidate");
  assert.equal(rows[0].targetZone, "formal");

  await service.undoMove({ projectId: "test-game", batchId: moved.batchId });
  await fs.access(path.join(root, "candidates", "batch-a", "hero-ai.png"));
  await assert.rejects(fs.access(path.join(root, "assets", "characters", "hero-ai.png")), /ENOENT/u);
});

test("移动素材默认可按需镜像原相对目录", async (t) => {
  const { root, service } = await fixture(t);
  const initial = await service.snapshot({ projectId: "test-game", view: "files" });
  const candidate = initial.items.find((item) => item.name === "hero-ai.png");
  const moved = await service.moveAssets({ projectId: "test-game", assetIds: [candidate.id], targetRootId: "runtime", preserveSubdirectories: true });
  await fs.access(path.join(root, "assets", "batch-a", "hero-ai.png"));
  const rows = (await fs.readFile(path.join(root, ART_LIBRARY_MOVES_PATH), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].destinationPath, "assets/batch-a/hero-ai.png");
  await service.undoMove({ projectId: "test-game", batchId: moved.batchId });
});

test("仍被游戏引用的正式素材不能被移出正式目录", async (t) => {
  const { service } = await fixture(t);
  const snapshot = await service.snapshot({ projectId: "test-game", view: "files" });
  const hero = snapshot.items.find((item) => item.name === "hero.png");
  await assert.rejects(
    service.moveAssets({ projectId: "test-game", assetIds: [hero.id], targetRootId: "archive", targetSubdirectory: "batch-a" }),
    (error) => error?.code === "ART_LIBRARY_MOVE_REFERENCE_BLOCKED",
  );
});

test("AI 候选允许被游戏试装，但使用中时不能从 Godot 外部强移", async (t) => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, "scenes", "candidate.tscn"), 'texture = "res://candidates/batch-a/hero-ai.png"\n');
  const snapshot = await service.snapshot({ projectId: "test-game", view: "files", refresh: true });
  const candidate = snapshot.items.find((item) => item.name === "hero-ai.png");
  assert.equal(candidate.referenceStatus, "using");
  await assert.rejects(
    service.moveAssets({ projectId: "test-game", assetIds: [candidate.id], targetRootId: "runtime", targetSubdirectory: "characters" }),
    (error) => error?.code === "ART_LIBRARY_MOVE_REFERENCE_BLOCKED",
  );
});

test("美术库拒绝项目外扫描路径", async (t) => {
  const { root, cacheDir } = await fixture(t);
  await fs.writeFile(path.join(root, ".infans", "art-library.v1.json"), JSON.stringify({
    schemaVersion: 1,
    project: { id: "test-game", name: "测试游戏" },
    scanRoots: [{ id: "escape", path: "../outside", role: "source" }],
  }));
  const service = createArtLibraryService({ sources: { "test-game": { root } }, cacheDir });
  await assert.rejects(service.snapshot({ projectId: "test-game" }), (error) => error?.code === "ART_LIBRARY_PATH_INVALID");
});

test("工作系统按项目素材库、设计台、工具与素材收藏、游戏数据表现排列", async () => {
  const source = await fs.readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const workTools = [...source.matchAll(/id: "([^"]+)",\s+group: "work",\s+name: "([^"]+)"/gu)].map((match) => [match[1], match[2]]);
  assert.deepEqual(workTools, [
    ["art-library", "项目素材库"],
    ["native-ui-design", "设计台"],
    ["ai-tools", "工具与素材收藏"],
    ["game-analytics", "游戏数据表现"],
  ]);
  assert.match(source, /\/tools\/\$\{id\}/u);
  assert.match(source, /<ArtLibraryView active=\{active\}/u);
});

test("项目素材库作为扩展工具登记进小秘书产品 Wiki", async () => {
  const wiki = new URL("../../10_设计/扩展工具/小秘书模块_扩展工具.md", import.meta.url);
  try {
    const source = await fs.readFile(wiki, "utf8");
    assert.match(source, /\| 项目素材库 \| 稳定 \|[^\n]+\| tools-art-library \|/u);
    assert.match(source, /#### 项目素材库｜ID：tools-art-library/u);
    assert.match(source, /每个游戏以项目根目录的 `\.infans\/art-library\.v1\.json` 登记正式、AI 候选、归档/u);
  } catch (error) {
    if (error?.code === "ENOENT") {
      // 开源候选不带私有产品 Wiki；缺文件时跳过，避免为了绿测试把私人设计稿加回来。
      return;
    }
    throw error;
  }
});

test("美术内容索引和素材目录共用正式、AI 候选和归档切换，文件事实保持独立筛选", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  assert.match(source, /label: "不限事实"[\s\S]*label: "使用中"[\s\S]*label: "未引用"[\s\S]*label: "重复文件"[\s\S]*label: "引用未知"/u);
  assert.match(source, /aria-label="素材状态"[\s\S]*正式素材[\s\S]*AI 候选素材[\s\S]*归档素材/u);
  assert.match(source, /setArtZone\(zone\)/u);
  assert.match(source, /<SemanticView projectId=\{project\.id\} zone=\{artZone\}/u);
  assert.match(source, /filteredAssets = useMemo[\s\S]*asset\.libraryItem\?\.zone === zone[\s\S]*asset\.sourceZones\?\.includes\(zone\)/u);
  assert.match(source, /filteredEntities = useMemo[\s\S]*assetsById\.has\(relation\.assetId\)/u);
  assert.match(source, /filter\(\(id\) => !artZone \|\| artZone === id\)/u);
  assert.match(source, /!artZone \? <PlatformSection/u);
  assert.match(source, /className="art-fact-tabs"/u);
  assert.match(source, /className="art-search-toggle"/u);
  assert.match(source, /className="art-search-popover"/u);
  assert.match(source, /visibleData\?\.directories/u);
  assert.match(source, /filteredZoneTotal/u);
});

test("素材对比是明确模式，整卡选择第二张后自动打开", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../src/pages/tools/art-library.css", import.meta.url), "utf8");
  assert.match(source, /art-compare-mode-toggle/u);
  assert.match(source, /compareMode \? <CompareTray/u);
  assert.match(source, /className="art-compare-select-surface"/u);
  assert.match(source, /if \(!exists && next\.length === 2\) setComparing\(true\)/u);
  assert.match(source, /与另一张对比/u);
  assert.doesNotMatch(source, /selectedItems\.length === 2 \? <button[^>]+setComparing/u);
  assert.match(css, /\.art-fullscreen:not\(\.art-compare\) nav button:nth-child\(-n\+2\)/u);
});

test("美术库先显示持久索引，再在后台和窗口回焦时增量更新", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  assert.match(source, /await load\(\); if \(!disposed\) await load\(true, true\)/u);
  assert.match(source, /window\.addEventListener\("focus", onFocus\)/u);
  assert.match(source, /lastRefresh\.current\.get\(projectId\)/u);
});

test("素材库首次进入用途索引，之后恢复上次项目、类型和美术视图，不含生产台", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_ASSET_LIBRARY_LOCATION[^\n]+viewMode: "semantic"/u);
  assert.match(source, /localStorage\.getItem\(ASSET_LIBRARY_LOCATION_KEY\)/u);
  assert.match(source, /localStorage\.setItem\(ASSET_LIBRARY_LOCATION_KEY/u);
  assert.match(source, /useState<ArtViewMode>\(initialLocation\.viewMode\)/u);
  assert.match(source, />用途索引</u);
  assert.match(source, />素材目录</u);
  assert.doesNotMatch(source, />AI 生产台</u);
  assert.doesNotMatch(source, /ArtProductionDesk|viewMode === "production"|ArtIntakePanel|intake\/sync|交给 Windows/u);
  assert.doesNotMatch(source, />使用位置</u);
  assert.match(source, /\/api\/tools\/art-library\/semantic/u);
  assert.match(source, /\/api\/tools\/art-library\/attention/u);
  assert.match(source, /className="art-reference-list"[\s\S]*实际使用位置/u);
  assert.match(source, /thumbUrl\(project\.id, item\.id, "preview"\)/u);
  assert.match(source, /载入原图 1:1/u);
});

test("素材库不再挂载 Windows 生图画架或生产台入口", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /AI 生产台|ArtProductionDesk|windows-render/u);
  assert.match(source, /type ArtViewMode = "semantic" \| "library"/u);
});

test("用途索引由左侧目录承担分类，素材卡把操作、说明与可复制文件名放在图片右侧", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../src/pages/tools/art-library.css", import.meta.url), "utf8");
  assert.match(source, /所属分类/u);
  assert.match(source, /具体用途/u);
  assert.match(source, /art-semantic-asset-preview[\s\S]*art-semantic-asset-actions[\s\S]*art-semantic-asset-summary[\s\S]*CopyAssetFileName/u);
  assert.match(source, /navigator\.clipboard\?\.writeText/u);
  assert.match(source, /title=\{`点击复制：\$\{value\}`\}/u);
  assert.doesNotMatch(source, /art-semantic-entity-category|归类：\{categoryLabel\}|art-semantic-asset-category|art-semantic-asset-folder/u);
  assert.match(source, /查看素材属性与路径/u);
  assert.doesNotMatch(source, /ENTITY_TYPE_LABELS|entityFieldSummary/u);
  assert.match(source, /className="art-view-tabs"/u);
  assert.match(source, /art-semantic-tree-toggle/u);
  assert.match(css, /\.art-file-image\{[^}]*aspect-ratio:1/u);
  assert.match(css, /\.art-semantic-asset-image img\{[^}]*width:100%!important;height:100%!important[^}]*object-fit:contain/u);
  assert.match(css, /\.art-semantic-asset\{[^}]*grid-template-columns:96px minmax\(0,1fr\)/u);
  assert.match(css, /\.art-semantic-file-name code\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/u);
  assert.match(css, /@media\(max-width:760px\)\{[^}]*\.art-project-tabs\{display:flex/u);
  assert.match(css, /@media\(min-width:761px\)\{\.art-project-tabs\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)\}\}/u);
  assert.match(css, /\.art-image-actions\{[^}]*flex-shrink:0/u);
  assert.match(css, /\.art-image-actions\{flex-wrap:nowrap;overflow-x:auto/u);
});

test("用途索引把关注与说明编辑留在每张素材右上方", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../src/pages/tools/art-library.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function UsageView|usageSnapshotCache/u);
  assert.match(source, /import \{ AttentionMark as AttentionCircle \} from "..\/..\/components\/AttentionMark"/u);
  assert.match(source, /art-semantic-asset-attention/u);
  assert.match(source, /art-semantic-asset-edit/u);
  assert.match(source, /className="art-semantic-asset-actions"/u);
  assert.match(source, /onToggleAttention\(item\)/u);
  assert.doesNotMatch(source, /art-semantic-entity-attention|onToggleGroup/u);
  assert.doesNotMatch(source, /relations\.slice\(/u);
  assert.match(source, /rows\.map\(\(\{relation,asset\}\)/u);
  assert.match(css, /\.art-view-tabs:not\(\.art-kind-tabs\)\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/u);
  assert.match(css, /\.art-semantic-asset-actions\{[^}]*justify-content:flex-end/u);
  assert.match(css, /\.art-semantic-asset \.art-semantic-asset-attention,\.art-semantic-asset-edit\{position:static/u);
  assert.match(css, /\.art-semantic-entity-assets\{[^}]*max-height:min\(56vh,520px\)[^}]*display:flex[^}]*flex-direction:column[^}]*overflow-y:auto/u);
});

test("文件夹预览保留素材原比例并在叠放区域居中", async () => {
  const css = await fs.readFile(new URL("../src/pages/tools/art-library.css", import.meta.url), "utf8");
  assert.match(css, /\.art-folder-preview>i\{[^}]*display:flex;align-items:center;justify-content:center/u);
  assert.match(css, /\.art-folder-preview>i img\{[^}]*width:auto;height:auto;max-width:100%;max-height:100%/u);
  assert.doesNotMatch(css, /\.art-folder-preview>i img\{width:100%;height:100%/u);
});

test("美术库移动、撤销和 Mac 打开都沿用本机边界，不提供删除或引用改写接口", async () => {
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const start = routes.indexOf('router.use("/api/tools/art-library"');
  const end = routes.indexOf('router.use("/api/tools/photo"', start);
  const artRoutes = routes.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(artRoutes, /assertLoopbackOnly\(request\)/u);
  assert.match(artRoutes, /url\.pathname === "\/attention" \|\| url\.pathname === "\/attention-batch"[\s\S]*assertPersistentWrite\(request\)/u);
  assert.match(artRoutes, /url\.pathname === "\/annotation"/u);
  assert.match(artRoutes, /url\.pathname === "\/attention"/u);
  assert.match(artRoutes, /"\/move", "\/move\/undo", "\/open"/u);
  assert.doesNotMatch(artRoutes, /url\.pathname === "\/(?:delete|rewrite)"/u);
});

test("一句说明覆盖正式候选归档，保留原记录与标记，并拒绝过期编辑", async (t) => {
  const { service } = await fixture(t);
  const initial = await service.snapshot({ projectId: "test-game", view: "files" });
  for (const zone of ["formal", "candidate", "archive"]) {
    const item = initial.items.find((entry) => entry.zone === zone);
    assert.ok(item, zone);
    await service.appendAnnotation({ projectId: "test-game", assetId: item.id, purpose: "原有说明", subject: "原有对象", avoid: "不要用于结局", tags: ["旧标签"] });
    await service.setAssetAttention({ projectId: "test-game", assetId: item.id, needsAttention: true });
    const result = await service.appendAnnotation({ projectId: "test-game", assetId: item.id, mode: "purpose", purpose: "保留发型，脸年轻一点", expectedPurpose: "原有说明" });
    assert.equal(result.annotation.purpose, "保留发型，脸年轻一点");
    assert.equal(result.annotation.subject, "原有对象");
    assert.equal(result.annotation.avoid, "不要用于结局");
    assert.deepEqual(result.annotation.tags, ["旧标签"]);
    assert.equal(result.annotation.needsAttention, true);
    await assert.rejects(service.appendAnnotation({ projectId: "test-game", assetId: item.id, mode: "purpose", purpose: "过期覆盖", expectedPurpose: "原有说明" }), { code: "ART_LIBRARY_PURPOSE_CONFLICT" });
    await service.setAssetAttention({ projectId: "test-game", assetId: item.id, needsAttention: false });
    const fresh = await service.snapshot({ projectId: "test-game", view: "files" });
    assert.equal(fresh.items.find((entry) => entry.id === item.id).annotation.purpose, "保留发型，脸年轻一点");
    const cleared = await service.appendAnnotation({ projectId: "test-game", assetId: item.id, mode: "purpose", purpose: "", expectedPurpose: "保留发型，脸年轻一点" });
    assert.equal(cleared.annotation.purpose, "");
    assert.equal(cleared.annotation.avoid, "不要用于结局");
    assert.equal(cleared.annotation.needsAttention, false);
  }
});

test("同时保存说明和标记不会相互覆盖，同时编辑会保留冲突", async (t) => {
  const { service } = await fixture(t);
  const snapshot = await service.snapshot({ projectId: "test-game", view: "files" });
  const item = snapshot.items.find((entry) => entry.zone === "candidate");
  const input = { projectId: "test-game", assetId: item.id, mode: "purpose" };
  await Promise.all([
    service.appendAnnotation({ ...input, purpose: "先调整构图", expectedPurpose: "" }),
    service.setAssetAttention({ ...input, needsAttention: true }),
  ]);
  const after = await service.snapshot({ projectId: "test-game", view: "files" });
  const note = after.items.find((entry) => entry.id === item.id).annotation;
  assert.equal(note.purpose, "先调整构图");
  assert.equal(note.needsAttention, true);
  const edits = await Promise.allSettled([
    service.appendAnnotation({ ...input, purpose: "先调整留白", expectedPurpose: note.purpose }),
    service.appendAnnotation({ ...input, purpose: "过期编辑", expectedPurpose: note.purpose }),
  ]);
  assert.equal(edits[0].status, "fulfilled");
  assert.equal(edits[1].status, "rejected");
  assert.equal(edits[1].reason.code, "ART_LIBRARY_PURPOSE_CONFLICT");
});
