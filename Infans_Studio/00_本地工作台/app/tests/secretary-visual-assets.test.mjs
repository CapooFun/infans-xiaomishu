import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SECRETARY_VISUAL_ASSET_ROOT,
  CORE_VISUAL_SUBJECTS,
  loadSecretaryVisualAssetCatalog,
} from "../src/server/workbench-secretary-visual-assets.mjs";
import { createArtLibraryService } from "../src/server/workbench-art-library.mjs";

const studioRoot = path.resolve(path.dirname(fileURLToPath(new URL(".", import.meta.url))), "../..");

test("开源素材库只留小秘书项目，角色是银月和梅凝公开头像", async () => {
  assert.equal(SECRETARY_VISUAL_ASSET_ROOT, "00_本地工作台/10_设计/50_视觉资产/小秘书");
  assert.deepEqual([...CORE_VISUAL_SUBJECTS], ["小秘书", "小秘书视觉系统", "银月", "梅凝"]);
  const loaded = await loadSecretaryVisualAssetCatalog(studioRoot);
  assert.equal(loaded.validation.ok, true);
  assert.equal(loaded.manifest.assets.length, 2);
  assert.deepEqual([...new Set(loaded.manifest.assets.map((asset) => asset.subject))].sort(), ["梅凝", "银月"]);
  assert.ok(loaded.manifest.assets.every((asset) => asset.kind === "头像" && asset.privacy.publishable === true));
  const service = createArtLibraryService({ sources: {}, vaultRoot: studioRoot });
  const projects = await service.projects();
  assert.deepEqual(projects.map((project) => project.id), ["secretary-visual-assets"]);
  assert.equal(projects[0].name, "小秘书");
  const snapshot = await service.snapshot({ projectId: "secretary-visual-assets" });
  assert.equal(snapshot.items.length, 2);
  assert.deepEqual([...new Set(snapshot.items.map((item) => item.annotation.subject))].sort(), ["梅凝", "银月"]);
  for (const item of snapshot.items) await fs.access(path.join(studioRoot, item.relativePath));
  const semantic = await service.semantic({ projectId: "secretary-visual-assets" });
  assert.deepEqual(semantic.tree.map((node) => node.label), ["正式秘书"]);
  assert.deepEqual(semantic.tree[0].children.map((node) => node.label).sort(), ["梅凝", "银月"]);
});

test("小秘书复用游戏项目的索引、目录、路径、筛选和对比界面", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/ArtLibraryView.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function SecretaryVisualLibrary/u);
  assert.match(source, />用途索引</u);
  assert.match(source, />素材目录</u);
});
