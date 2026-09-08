import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchAnimeCover, readAnimeCoverCatalog, streamAnimeCover } from "../src/server/workbench-anime-covers.mjs";
import { animeCoversSupportDir } from "../src/server/vault-paths.mjs";

async function writeCoverLibrary(root, overrides = {}) {
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "images", "223147.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const manifest = {
    version: 1,
    usage: "private-local-display",
    covers: [{ title: "凡人修仙传", subjectId: 223147, file: "images/223147.jpg" }],
    ...overrides,
  };
  await fs.writeFile(path.join(root, "封面清单.json"), JSON.stringify(manifest));
}

test("动漫封面目录固定落在 Vault 同级支持库", () => {
  assert.equal(
    animeCoversSupportDir("/Users/test/Infans_Vault"),
    "/Users/test/Infans_Support/10_学习资料/艺术馆藏/动漫封面",
  );
});

test("动漫封面清单只向前端返回标题、条目编号和白名单 URL", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-anime-covers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCoverLibrary(root);
  const catalog = await readAnimeCoverCatalog(root);
  assert.deepEqual(catalog, {
    available: true,
    covers: [{ title: "凡人修仙传", subjectId: 223147, coverUrl: "/api/anime-cover/223147" }],
    warnings: [],
  });
  assert.equal(JSON.stringify(catalog).includes(root), false);
});

test("季度标题变化时按元数据条目编号继续复用原封面", () => {
  const covers = [{ title: "旧系列名", subjectId: 223147, coverUrl: "/api/anime-cover/223147" }];
  assert.equal(matchAnimeCover(covers, {
    title: "新系列名 第1季",
    metadataSource: "Bangumi #223147 · 2026-08-26",
  })?.coverUrl, "/api/anime-cover/223147");
  assert.equal(matchAnimeCover(covers, {
    title: "新系列名 第2季",
    metadataSource: "人工复核 · 2026-08-27",
  }), undefined);
});

test("同一公开条目可为两个私人季度标题复用同一张封面", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-anime-cover-alias-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCoverLibrary(root, {
    covers: [
      { title: "系列 第1季", subjectId: 223147, file: "images/223147.jpg" },
      { title: "系列 第2季", subjectId: 223147, file: "images/223147.jpg" },
    ],
  });
  const catalog = await readAnimeCoverCatalog(root);
  assert.equal(catalog.warnings.length, 0);
  assert.deepEqual(catalog.covers.map((cover) => cover.title), ["系列 第1季", "系列 第2季"]);
});

test("动漫封面拒绝越界路径和符号链接", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-anime-cover-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCoverLibrary(root, {
    covers: [{ title: "越界封面", subjectId: 223147, file: "../outside.jpg" }],
  });
  let catalog = await readAnimeCoverCatalog(root);
  assert.equal(catalog.available, false);
  assert.match(catalog.warnings[0], /越过/);

  await fs.writeFile(path.join(root, "outside.jpg"), "outside");
  await fs.rm(path.join(root, "images", "223147.jpg"));
  await fs.symlink(path.join(root, "outside.jpg"), path.join(root, "images", "223147.jpg"));
  await writeCoverLibrary(root);
  catalog = await readAnimeCoverCatalog(root);
  assert.equal(catalog.available, false);
  assert.match(catalog.warnings[0], /符号链接/);
});

test("动漫封面 HEAD 请求返回精确媒体信息", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-anime-cover-head-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeCoverLibrary(root);
  const headers = new Map();
  const response = {
    statusCode: 0,
    ended: false,
    setHeader(name, value) { headers.set(name, String(value)); },
    end() { this.ended = true; },
  };
  await streamAnimeCover({ method: "HEAD" }, response, root, "223147");
  assert.equal(response.statusCode, 200);
  assert.equal(headers.get("Content-Type"), "image/jpeg");
  assert.equal(headers.get("Content-Length"), "4");
  assert.equal(headers.get("Cache-Control"), "private, max-age=86400");
  assert.equal(response.ended, true);
});

test("支持库未连接时静默退回抽象封面", async () => {
  const catalog = await readAnimeCoverCatalog(path.join(os.tmpdir(), "infans-anime-cover-missing"));
  assert.deepEqual(catalog, { available: false, covers: [], warnings: [] });
});
