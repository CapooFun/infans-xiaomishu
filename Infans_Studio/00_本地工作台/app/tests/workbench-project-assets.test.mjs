import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createProjectAssetService, PROJECT_ASSET_CATALOG, PROJECT_ASSET_CONFIG, PROJECT_ASSET_ANNOTATIONS } from "../src/server/workbench-project-assets.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-asset-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".infans"));
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "assets/music.wav"), Buffer.from("0123456789abcdef"));
  await fs.writeFile(path.join(root, "assets/font.ttf"), Buffer.from("font-preview"));
  const catalog = { schemaVersion: 1, project: { id: "sample", name: "样例游戏" }, generatedAt: "2026-09-03T00:00:00Z",
    locales: [{ id: "zh-CN", label: "中文" }, { id: "ja", label: "日文" }], coverage: ["只读取现行资源"], items: [
      { id: "font", kind: "font", name: "正文字体", path: "assets/font.ttf", category: "字体", zone: "formal", sources: [], metadata: { family: "Sample", weight: "400" } },
      { id: "music", kind: "audio", name: "战斗音乐", path: "assets/music.wav", category: "背景音乐", zone: "candidate", references: [{ path: "scenes/battle.tscn", line: 3 }], metadata: { duration: 3 } },
      { id: "name", kind: "text", name: "角色名称", key: "character.name", category: "角色", zone: "formal", sources: [{ path: "data/characters.json", pointer: "/0/name" }], values: { "zh-CN": "修士", ja: "修士" } },
      { id: "skill", kind: "text", name: "招式名称", key: "skill.name", category: "技能", zone: "formal", sources: [{ path: "data/skills.json", pointer: "/0/name" }], values: { "zh-CN": "飞剑", ja: "" } },
    ] };
  await fs.writeFile(path.join(root, PROJECT_ASSET_CONFIG), JSON.stringify({ schemaVersion: 1, project: catalog.project, catalogPath: PROJECT_ASSET_CATALOG }));
  const writeCatalog = () => fs.writeFile(path.join(root, PROJECT_ASSET_CATALOG), JSON.stringify(catalog));
  await writeCatalog();
  return { root, catalog, writeCatalog, service: createProjectAssetService({ sources: { sample: { root } } }) };
}

class Response extends Writable {
  headers = new Map(); chunks = []; statusCode = 200;
  setHeader(key, value) { this.headers.set(key.toLowerCase(), value); }
  _write(chunk, encoding, next) { this.chunks.push(Buffer.from(chunk)); next(); }
  get body() { return Buffer.concat(this.chunks); }
}

test("browse reads project categories, locales and sources without writing metadata", async (t) => {
  const { root, service } = await fixture(t);
  const result = await service.browse({ projectId: "sample", kind: "text" });
  assert.equal(result.available, true);
  assert.deepEqual(result.counts, { font: 1, text: 2, audio: 1, video: 0 });
  assert.equal(result.items[0].sources[0].pointer, "/0/name");
  assert.equal(result.items[0].values.ja, "修士");
  assert.deepEqual(result.items[0].annotation, { note: "", needsAttention: false, revision: null });
  await assert.rejects(fs.stat(path.join(root, PROJECT_ASSET_ANNOTATIONS)), { code: "ENOENT" });
});

test("directories count subtrees independently of search, and state never drops unlinked candidates", async (t) => {
  const { catalog, writeCatalog, service } = await fixture(t);
  catalog.items[2].categoryPath = ["角色", "主角"];
  catalog.items[3].categoryPath = ["角色", "主角", "招式"];
  catalog.items[3].zone = "candidate";
  await writeCatalog();
  const result = await service.browse({ projectId: "sample", kind: "text", directory: "角色/主角", zone: "candidate", q: "不匹配" });
  assert.equal(result.total, 0);
  assert.deepEqual(result.zoneCounts, { formal: 1, candidate: 1, archive: 0, unknown: 0 });
  assert.equal(result.directories[0].count, 1);
  assert.equal(result.directories[0].children[0].children[0].path, "角色/主角/招式");
  const candidates = await service.browse({ projectId: "sample", kind: "text", directory: "角色/主角", zone: "candidate" });
  assert.deepEqual(candidates.items.map((row) => row.id), ["skill"]);
  assert.deepEqual(candidates.items[0].links, []);
  assert.equal((await service.browse({ projectId: "sample", kind: "text", directory: "角色/主" })).total, 0);
  await assert.rejects(service.browse({ projectId: "sample", zone: "approved" }), { status: 400 });
});

test("old catalogs still have category directories and no inferred object or usage links", async (t) => {
  const { service } = await fixture(t);
  const result = await service.browse({ projectId: "sample", kind: "audio" });
  assert.deepEqual(result.directories, [{ path: "背景音乐", label: "背景音乐", count: 1, children: [] }]);
  assert.deepEqual(result.items[0].links, []);
  assert.deepEqual(await service.links({ projectId: "sample", itemId: "music" }), { links: [] });
  assert.deepEqual(await service.links({ projectId: "unknown", assetPath: "../../secret" }), { links: [] });
});

test("object lookup crosses media and art without approving or conflating evidence, and retains notes", async (t) => {
  const { root, catalog, writeCatalog, service } = await fixture(t);
  const makeLink = (relation, objectId = "hero") => ({ objectId, label: objectId === "hero" ? "主角" : "其他角色", type: "character", role: "名称", relation, sources: [{ path: "data/characters.json", pointer: "/hero/name" }] });
  catalog.items[1].links = [makeLink("intended")];
  catalog.items[2].links = [makeLink("source"), makeLink("source", "other")];
  catalog.items[3].links = [makeLink("registered")];
  catalog.items[3].zone = "archive";
  catalog.artLinks = [{ path: "assets/hero.png", zone: "candidate", links: [makeLink("referenced")] }];
  await writeCatalog();
  await service.saveAnnotation({ projectId: "sample", itemId: "music", expectedRevision: null, note: "声音再轻一点", needsAttention: true });
  const withArt = createProjectAssetService({ sources: { sample: { root } }, resolveArtItems: async ({ projectId, paths }) => {
    assert.equal(projectId, "sample"); assert.deepEqual(paths, ["assets/hero.png"]);
    return [{ id: "current-art-id", path: paths[0], zone: "candidate", fileAvailable: true, previewUrl: "/registered-preview" }];
  } });
  const first = await withArt.related({ projectId: "sample", objectId: "hero", limit: 2 });
  assert.equal(first.total, 4); assert.equal(first.hasMore, true);
  assert.equal(first.items[0].zone, "candidate");
  assert.equal(first.items[0].annotation.note, "声音再轻一点");
  assert.equal(first.items[0].links[0].relation, "intended");
  assert.equal(first.items[1].links.length, 1); assert.equal(first.items[1].links[0].relation, "source");
  const second = await withArt.related({ projectId: "sample", objectId: "hero", offset: 2, limit: 2 });
  assert.equal(second.hasMore, false); assert.equal(second.items[0].zone, "archive");
  assert.equal(second.items[0].links[0].relation, "registered");
  assert.equal(second.items[1].kind, "art"); assert.equal(second.items[1].id, "current-art-id");
  assert.equal(second.items[1].zone, "candidate"); assert.equal(second.items[1].links[0].relation, "referenced");
  assert.equal((await service.links({ projectId: "sample", assetPath: "assets/hero.png" })).links[0].objectId, "hero");
  assert.deepEqual(await service.links({ projectId: "sample", assetPath: "assets/not-listed.png" }), { links: [] });
  await assert.rejects(withArt.related({ projectId: "sample", objectId: "missing" }), { status: 404 });
});

test("malformed navigation and unsupported or evidence-free relations reject visibly", async (t) => {
  for (const change of [
    (item) => { item.categoryPath = ["角色/主角"]; },
    (item) => { item.links = [{ objectId: "hero", label: "主角", relation: "approved", sources: [{ path: "data/hero.json" }] }]; },
    (item) => { item.links = [{ objectId: "hero", label: "主角", relation: "referenced", sources: [] }]; },
    (item) => { item.links = [{ objectId: "hero", label: "主角", relation: "source", sources: [{ path: "../secret" }] }]; },
  ]) {
    const { catalog, writeCatalog, service } = await fixture(t);
    change(catalog.items[2]); await writeCatalog();
    await assert.rejects(service.browse({ projectId: "sample", kind: "text" }));
  }
});

test("search, category, missing locale and pagination operate on the whole catalog", async (t) => {
  const { service } = await fixture(t);
  const page = await service.browse({ projectId: "sample", kind: "text", limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.hasMore, true);
  assert.equal((await service.browse({ projectId: "sample", kind: "text", offset: 1, limit: 1 })).items[0].id, "skill");
  assert.equal((await service.browse({ projectId: "sample", kind: "text", q: "飞剑" })).total, 1);
  assert.equal((await service.browse({ projectId: "sample", kind: "text", missing: true })).items[0].id, "skill");
  assert.equal((await service.browse({ projectId: "sample", kind: "text", category: "角色", missing: true })).total, 0);
  assert.equal((await service.browse({ projectId: "sample", kind: "video" })).total, 0);
});

test("note and attention preserve each other and persist across service instances", async (t) => {
  const { root, service } = await fixture(t);
  const one = await service.saveAnnotation({ projectId: "sample", itemId: "music", expectedRevision: null, note: "减弱鼓点" });
  const two = await service.saveAnnotation({ projectId: "sample", itemId: "music", expectedRevision: one.annotation.revision, needsAttention: true });
  assert.equal(two.annotation.note, "减弱鼓点");
  const nextService = createProjectAssetService({ sources: { sample: { root } } });
  const result = await nextService.browse({ projectId: "sample", kind: "audio", attention: true, q: "鼓点" });
  assert.equal(result.total, 1); assert.equal(result.items[0].zone, "candidate");
  assert.equal(result.items[0].references[0].path, "scenes/battle.tscn");
  const cleared = await nextService.saveAnnotation({ projectId: "sample", itemId: "music", expectedRevision: two.annotation.revision, note: "" });
  assert.equal(cleared.annotation.note, ""); assert.equal(cleared.annotation.needsAttention, true);
});

test("simultaneous stale saves conflict, expose latest revision and do not overwrite", async (t) => {
  const { service } = await fixture(t);
  const [first, second] = await Promise.allSettled([
    service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, note: "甲" }),
    service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, needsAttention: true }),
  ]);
  assert.equal(first.status, "fulfilled"); assert.equal(second.status, "rejected");
  assert.equal(second.reason.status, 409); assert.equal(second.reason.annotation.note, "甲");
  const latest = await service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: second.reason.annotation.revision, needsAttention: true });
  assert.equal(latest.annotation.note, "甲"); assert.equal(latest.annotation.needsAttention, true);
});

test("unknown project and missing catalog are explicit unavailable states", async (t) => {
  const { root, service } = await fixture(t);
  assert.equal((await service.browse({ projectId: "__proto__" })).available, false);
  await fs.unlink(path.join(root, PROJECT_ASSET_CONFIG));
  assert.equal((await service.browse({ projectId: "sample" })).available, false);
  await assert.rejects(service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, note: "x" }), { status: 404 });
});

test("catalog refresh reflects changed source values; duplicate ids fail visibly", async (t) => {
  const { catalog, writeCatalog, service } = await fixture(t);
  await service.browse({ projectId: "sample" });
  catalog.items[2].values["zh-CN"] = "新的原文内容";
  await writeCatalog();
  assert.equal((await service.browse({ projectId: "sample", kind: "text", q: "新的原文" })).total, 1);
  catalog.items.push(catalog.items[0]); await writeCatalog();
  await assert.rejects(service.browse({ projectId: "sample" }), { status: 422 });
});

test("traversal, hidden directories and mismatched media extension are rejected", async (t) => {
  const { catalog, writeCatalog, service } = await fixture(t);
  for (const unsafe of ["../outside.ttf", "assets/../../outside.ttf", "/tmp/outside.ttf", ".git/secret.ttf", "assets/data.json"]) {
    catalog.items[0].path = unsafe; await writeCatalog();
    await assert.rejects(service.browse({ projectId: "sample" }));
  }
});

test("symbolic links in catalog, file and annotation paths fail closed", async (t) => {
  const { root, service } = await fixture(t);
  const target = path.join(root, "assets/font.ttf");
  await fs.rename(target, path.join(root, "font-real.ttf"));
  await fs.symlink(path.join(root, "font-real.ttf"), target);
  await assert.rejects(service.browse({ projectId: "sample", kind: "font" }), { status: 403 });
  await assert.rejects(service.streamFile({ method: "GET", headers: {} }, new Response(), { projectId: "sample", itemId: "font" }), { status: 403 });
  await fs.writeFile(path.join(root, "untouched.jsonl"), "");
  await fs.symlink(path.join(root, "untouched.jsonl"), path.join(root, PROJECT_ASSET_ANNOTATIONS));
  await assert.rejects(service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, note: "x" }), { status: 403 });
  assert.equal(await fs.readFile(path.join(root, "untouched.jsonl"), "utf8"), "");
  await fs.rename(path.join(root, PROJECT_ASSET_CATALOG), path.join(root, "catalog-real.json"));
  await fs.symlink(path.join(root, "catalog-real.json"), path.join(root, PROJECT_ASSET_CATALOG));
  await assert.rejects(service.browse({ projectId: "sample" }), { status: 403 });
});

test("media ranges, suffix ranges, HEAD and invalid ranges match original bytes", async (t) => {
  const { service } = await fixture(t);
  for (const [method, range, status, body] of [["GET", "bytes=2-5", 206, "2345"], ["GET", "bytes=-3", 206, "def"], ["GET", "bytes=30-40", 416, ""], ["HEAD", undefined, 200, ""], ["GET", undefined, 200, "0123456789abcdef"]]) {
    const response = new Response();
    await service.streamFile({ method, headers: { range } }, response, { projectId: "sample", itemId: "music" });
    assert.equal(response.statusCode, status); assert.equal(response.body.toString(), body);
    if (status !== 416) assert.equal(response.headers.get("content-type"), "audio/wav");
  }
  await assert.rejects(service.streamFile({ method: "GET", headers: {} }, new Response(), { projectId: "sample", itemId: "name" }), { status: 404 });
});

test("missing media is visible and does not masquerade as a playable file", async (t) => {
  const { root, service } = await fixture(t);
  await fs.unlink(path.join(root, "assets/music.wav"));
  assert.equal((await service.browse({ projectId: "sample", kind: "audio" })).items[0].fileAvailable, false);
  await assert.rejects(service.streamFile({ method: "GET", headers: {} }, new Response(), { projectId: "sample", itemId: "music" }), { status: 404 });
});

test("invalid input and corrupt history are rejected without replacing existing data", async (t) => {
  const { root, service } = await fixture(t);
  await assert.rejects(service.saveAnnotation({ projectId: "sample", itemId: "name", note: "x" }), { status: 400 });
  await assert.rejects(service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, note: "x".repeat(1201) }), { status: 400 });
  await fs.writeFile(path.join(root, PROJECT_ASSET_ANNOTATIONS), "not json\n");
  await assert.rejects(service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, note: "x" }), { status: 422 });
  assert.equal(await fs.readFile(path.join(root, PROJECT_ASSET_ANNOTATIONS), "utf8"), "not json\n");
});

test("an externally edited history without a trailing newline remains readable after append", async (t) => {
  const { root, service } = await fixture(t);
  const first = await service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: null, note: "旧说明" });
  const history = path.join(root, PROJECT_ASSET_ANNOTATIONS);
  await fs.writeFile(history, (await fs.readFile(history, "utf8")).trimEnd());
  await service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: first.annotation.revision, needsAttention: true });
  const result = await service.browse({ projectId: "sample", kind: "text", attention: true });
  assert.equal(result.total, 1); assert.equal(result.items[0].annotation.note, "旧说明");
});

test("annotation history copied from another project cannot become this project's notes", async (t) => {
  const { root, service } = await fixture(t);
  const raw = JSON.stringify({ schemaVersion: 1, projectId: "different-project", itemId: "name", note: "别的项目", revision: "copied", needsAttention: true });
  await fs.writeFile(path.join(root, PROJECT_ASSET_ANNOTATIONS), `${raw}\n`);
  await assert.rejects(service.browse({ projectId: "sample", kind: "text" }), { status: 422 });
  await assert.rejects(service.saveAnnotation({ projectId: "sample", itemId: "name", expectedRevision: "copied", note: "覆盖" }), { status: 422 });
  assert.equal(await fs.readFile(path.join(root, PROJECT_ASSET_ANNOTATIONS), "utf8"), `${raw}\n`);
});
