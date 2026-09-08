import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildSecretaryVisualAssetManifest, writeSecretaryVisualAssetArtifacts } from "../scripts/secretary-visual-assets.mjs";
import { SECRETARY_VISUAL_ASSET_ROOT as ROOT, SECRETARY_VISUAL_ASSET_MANIFEST_PATH as MANIFEST, validateSecretaryVisualAssetManifest } from "../src/server/workbench-secretary-visual-assets.mjs";

async function fixture(t) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-rebuild-"));
  t.after(() => fs.rm(vaultRoot, { recursive: true, force: true }));
  const write = async (relative, bytes) => {
    const target = path.join(vaultRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  };
  const first = `${ROOT}/候选/测试/one-avatar.png`;
  const second = `${ROOT}/候选/测试/two-portrait.png`;
  const png = await sharp({ create: { width: 8, height: 12, channels: 3, background: "red" } }).png().toBuffer();
  await write(first, png);
  await write(second, await sharp({ create: { width: 8, height: 12, channels: 3, background: "blue" } }).png().toBuffer());
  const baseline = await buildSecretaryVisualAssetManifest({ vaultRoot, snapshotDate: "2026-09-05" });
  const asset = baseline.assets.find((item) => item.canonicalPath === first);
  const other = baseline.assets.find((item) => item !== asset);
  asset.assetId = `secvis-test-avatarv2-${asset.hash.slice(7, 19)}`;
  asset.assetClass = "source";
  baseline.summary.byAssetClass = { derivative: 1, source: 1 };
  asset.provenance = { origin: "ai-generated", creator: "imagegen", recordPath: `${ROOT}/候选/测试/generation-records.v1.json`, reviewStatus: "pending-capoo" };
  asset.review = { needsCapoo: true, decision: "pending-capoo" };
  asset.focalPoint = { x: 0.4, y: 0.2 };
  asset.derivedFrom = other.assetId;
  other.derivatives = [asset.assetId];
  baseline.deletedAssets = [{ assetId: "secvis-old-avatar-000000000000", reason: "rejected-by-capoo" }];
  await write(MANIFEST, JSON.stringify(baseline));
  await write(`${ROOT}/curation.v1.json`, '{"frozen":"do not rewrite"}\n');
  return { vaultRoot, write, first, second, png, baseline, asset };
}

test("registered identity, provenance, lineage and curation survive a real disk refresh", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.vaultRoot, MANIFEST), "utf8");
  const result = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  for (const original of f.baseline.assets) {
    const item = result.assets.find((asset) => asset.assetId === original.assetId);
    for (const key of ["assetClass", "subject", "kind", "stage", "governanceStatus", "canonicalPath", "currentPaths", "hash", "derivedFrom", "derivatives", "provenance", "review", "focalPoint"]) assert.deepEqual(item[key], original[key], key);
  }
  assert.deepEqual(result.deletedAssets, f.baseline.deletedAssets);
  assert.equal(result.snapshotDate, "2026-09-05");
  assert.equal((await validateSecretaryVisualAssetManifest(result, { vaultRoot: f.vaultRoot })).ok, true);
  assert.equal(await fs.readFile(path.join(f.vaultRoot, MANIFEST), "utf8"), before);
  assert.equal(await fs.readFile(path.join(f.vaultRoot, ROOT, "curation.v1.json"), "utf8"), '{"frozen":"do not rewrite"}\n');
});

test("backups, audit and review pages do not create consumers; explicit asset records still do", async (t) => {
  const f = await fixture(t);
  const initial = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  for (const name of ["manifest-before.json", "consumer-wiring-proposal.v1.json", "consumer-audit.v1.json", "generation-records.v1.json", "live-verification.v1.json", "index.html", "预览/review.html"]) {
    await f.write(`${ROOT}/候选/测试/${name}`, JSON.stringify({ path: f.first }));
  }
  // A private draft with a matching path must not be read as source evidence.
  await f.write("00_本地工作台/本人草稿/private.md", f.first);
  const result = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  assert.deepEqual(result.assets, initial.assets);
  await f.write(`${ROOT}/候选/测试/asset-links.json`, JSON.stringify({ path: f.first }));
  const linked = (await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot })).assets.find((item) => item.assetId === f.asset.assetId);
  assert.ok(linked.consumers.some((item) => item.kind === "asset-record"));
  assert.notEqual(linked.referenceStatus, "referenced");
});

test("live HTML, TSX, CSS and Swift references refresh on add/remove without basename path confusion", async (t) => {
  const f = await fixture(t);
  const sources = ["00_本地工作台/app/index.html", "00_本地工作台/app/src/use.tsx", "00_本地工作台/app/src/use.css", "00_本地工作台/app/native/Use.swift"];
  for (const file of sources) await f.write(file, JSON.stringify({ path: f.first }));
  let result = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  let item = result.assets.find((asset) => asset.assetId === f.asset.assetId);
  assert.equal(item.referenceStatus, "referenced");
  assert.equal(item.consumers.length, 4);
  for (const file of sources) await f.write(file, '"other/folder/one-avatar.png"');
  result = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  item = result.assets.find((asset) => asset.assetId === f.asset.assetId);
  assert.equal(item.consumers.length, 0);
  assert.notEqual(item.referenceStatus, "referenced");
  await f.write(sources[0], '"one-avatar.png"');
  assert.equal((await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot })).assets.find((asset) => asset.assetId === f.asset.assetId).referenceStatus, "referenced");
  await f.write(`${ROOT}/候选/elsewhere/one-avatar.png`, f.png);
  assert.equal((await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot })).assets.find((asset) => asset.assetId === f.asset.assetId).consumers.length, 0);
});

test("new originals and preview media are reported without automatic registration or resurrection", async (t) => {
  const f = await fixture(t);
  await f.write(`${ROOT}/候选/测试/预览/review.png`, f.png);
  await f.write(`${ROOT}/候选/测试/unregistered.png`, f.png);
  await f.write(`${ROOT}/角色/测试/new-master.png`, f.png);
  const result = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  assert.deepEqual(result.assets.map((item) => item.assetId), f.baseline.assets.map((item) => item.assetId));
  assert.equal(result.rebuildReport.discoveries.length, 3);
  assert.ok(result.rebuildReport.discoveries.some((item) => item.path === `${ROOT}/角色/测试/new-master.png`));
  assert.deepEqual(new Set(result.rebuildReport.discoveries.map((item) => item.classification)), new Set(["preview-or-evidence", "unregistered-media"]));
  assert.deepEqual(result.deletedAssets, f.baseline.deletedAssets);
});

test("same registered asset mirrors retain basename references and xcassets requires the exact filename", async (t) => {
  const f = await fixture(t);
  const mirror = "00_本地工作台/app/native/Assets.xcassets/Avatar.imageset/one-avatar.png";
  await f.write(mirror, f.png);
  f.asset.currentPaths.push(mirror);
  f.asset.files.push({ ...f.asset.files[0], path: mirror });
  f.baseline.summary.fileCount += 1;
  await f.write(MANIFEST, JSON.stringify(f.baseline));
  await f.write("00_本地工作台/app/native/Use.swift", '"one-avatar.png"');
  const contentsPath = path.posix.join(path.posix.dirname(mirror), "Contents.json");
  await f.write(contentsPath, '{"images":[{"filename":"different.png"}]}');
  let item = (await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot })).assets.find((asset) => asset.assetId === f.asset.assetId);
  assert.ok(item.consumers.some((consumer) => consumer.path.endsWith("Use.swift")));
  assert.ok(!item.consumers.some((consumer) => consumer.path === contentsPath));
  await f.write(contentsPath, '{"images":[{"filename":"one-avatar.png"}]}');
  item = (await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot })).assets.find((asset) => asset.assetId === f.asset.assetId);
  assert.ok(item.consumers.some((consumer) => consumer.path === contentsPath && consumer.evidence.startsWith("asset-catalog:")));
});

test("an unrelated empty imageset cannot claim another directory's same-named candidate", async (t) => {
  const f = await fixture(t);
  await f.write("00_本地工作台/app/native/Assets.xcassets/Unrelated.imageset/Contents.json", '{"images":[{"filename":"one-avatar.png"}]}');
  const rebuilt = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  assert.ok(rebuilt.assets.every((asset) => asset.consumers.length === 0));
  await fs.rm(path.join(f.vaultRoot, MANIFEST));
  const bootstrap = await buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot });
  assert.ok(bootstrap.assets.every((asset) => asset.consumers.length === 0));
});

test("missing, changed or symlinked registered media fails instead of silently replacing identity", async (t) => {
  const f = await fixture(t);
  await f.write(f.first, "changed");
  await assert.rejects(buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot }), /摘要不一致/u);
  await fs.rm(path.join(f.vaultRoot, f.first));
  await assert.rejects(buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot }), { code: "ENOENT" });
  await fs.symlink(path.join(f.vaultRoot, f.second), path.join(f.vaultRoot, f.first));
  await assert.rejects(buildSecretaryVisualAssetManifest({ vaultRoot: f.vaultRoot }), { code: "PATH_SYMLINK_FORBIDDEN" });
});

test("artifact write refreshes facts atomically while preserving registered IDs and the separate curation", async (t) => {
  const f = await fixture(t);
  const output = await writeSecretaryVisualAssetArtifacts({ vaultRoot: f.vaultRoot });
  const written = JSON.parse(await fs.readFile(path.join(f.vaultRoot, MANIFEST), "utf8"));
  assert.deepEqual(written.assets.map((item) => item.assetId), f.baseline.assets.map((item) => item.assetId));
  assert.deepEqual(written, output.manifest);
  assert.equal(written.snapshotDate, "2026-09-05");
  assert.equal(await fs.readFile(path.join(f.vaultRoot, ROOT, "curation.v1.json"), "utf8"), '{"frozen":"do not rewrite"}\n');
});

test("a concurrent authority edit before replacement is preserved and rejects the stale write", async (t) => {
  const f = await fixture(t);
  const target = await fs.realpath(path.join(f.vaultRoot, MANIFEST));
  const concurrent = structuredClone(f.baseline);
  concurrent.assets[0].review = { needsCapoo: false, decision: "new-user-decision" };
  const originalWrite = fs.writeFile.bind(fs);
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    const result = await originalWrite(file, ...args);
    if (String(file).startsWith(`${target}.`) && String(file).endsWith(".tmp")) {
      await originalWrite(target, JSON.stringify(concurrent));
    }
    return result;
  });
  await assert.rejects(writeSecretaryVisualAssetArtifacts({ vaultRoot: f.vaultRoot }), /写入前变化/u);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), concurrent);
  assert.ok((await fs.readdir(path.dirname(target))).every((name) => !name.endsWith(".tmp")));
});
