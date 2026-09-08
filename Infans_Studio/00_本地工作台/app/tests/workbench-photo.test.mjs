import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDisplayModeHiddenProductFeature } from "../src/display-mode.ts";
import {
  clearPhotoLibraryCache,
  DEFAULT_PHOTO_CACHE_DIR,
  DEFAULT_PHOTO_INDEX_DIR,
  exportPhotoMediaToDesktop,
  movePhotoMediaToTrash,
  normalizePhotoPath,
  photoIndexPath,
  readPhotoLibrary,
} from "../src/server/workbench-photo.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-photo-test-"));
  const libraryDir = path.join(root, "Photos");
  const cacheDir = path.join(root, "cache");
  const monthDir = path.join(libraryDir, "MobileBackup", "iPhone", "2026", "08");
  await fs.mkdir(monthDir, { recursive: true });
  await fs.writeFile(path.join(monthDir, "IMG_0001.HEIC"), "image");
  await fs.writeFile(path.join(monthDir, "IMG_0001.MOV"), "motion");
  await fs.writeFile(path.join(monthDir, "clip.MP4"), "video");
  for (let index = 1; index <= 25; index += 1) {
    await fs.writeFile(path.join(monthDir, `Screenshot-${String(index).padStart(2, "0")}.PNG`), "png");
  }
  await fs.writeFile(path.join(monthDir, "notes.txt"), "ignore");
  await fs.writeFile(path.join(monthDir, ".private.JPG"), "ignore");
  const stamp = new Date("2026-08-19T09:30:00.000Z");
  for (const name of await fs.readdir(monthDir)) {
    await fs.utimes(path.join(monthDir, name), stamp, stamp);
  }
  await fs.symlink(os.tmpdir(), path.join(monthDir, "outside"));
  return { root, libraryDir, cacheDir, monthDir };
}

test("照片路径只接受相册根目录下的相对路径", () => {
  assert.equal(normalizePhotoPath("MobileBackup/iPhone"), "MobileBackup/iPhone");
  assert.throws(() => normalizePhotoPath("../outside"), /越过了相册边界/);
  assert.throws(() => normalizePhotoPath("/Volumes/private"), /不合法/);
  assert.throws(() => normalizePhotoPath("MobileBackup\\outside"), /不合法/);
  assert.equal(DEFAULT_PHOTO_CACHE_DIR, "");
  assert.equal(DEFAULT_PHOTO_INDEX_DIR, "");
  assert.ok(photoIndexPath("/tmp/photo-library-example", "/tmp/photo-cache").includes("index-"));
});

test("开源相册入口仍在，但不带私人年月封面，展示模式开不了", async () => {
  const toolsPage = await fs.readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const photoPage = await fs.readFile(new URL("../src/pages/tools/PhotoLibraryView.tsx", import.meta.url), "utf8");
  const photoStyles = await fs.readFile(new URL("../src/pages/tools/photo-library.css", import.meta.url), "utf8");
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const coverDir = new URL("../public/theme/photos/", import.meta.url);
  assert.equal(await fs.readdir(coverDir).then((names) => names.filter((name) => name.endsWith(".webp")).length), 0);
  assert.ok(toolsPage.includes('lazy(() => import("./tools/PhotoLibraryView"))'));
  assert.equal(toolsPage.includes('TOOLS.filter((tool) => tool.id !== "photo")'), false);
  assert.ok(photoPage.includes("导出"));
  assert.ok(photoPage.includes('jsonFetch<PhotoActionResult>("/api/tools/photo/export"'));
  assert.equal(photoPage.includes("流年影集"), false);
  assert.equal(photoPage.includes("山河入梦 · 光影成章"), false);
  assert.equal(photoPage.includes("SEALED"), false);
  assert.equal(photoPage.includes("PRIVATE PHOTO ARCHIVE"), false);
  assert.equal(photoStyles.includes("photo-month-covers"), false);
  assert.equal(photoStyles.includes("photo-year-covers"), false);
  assert.ok(photoStyles.includes("background-image: none"));
  assert.ok(routes.includes('router.use("/api/tools/photo"'));
  assert.ok(routes.includes("assertTrustedOrigin(request)"));
  assert.equal(isDisplayModeHiddenProductFeature({ id: "tools-photo" }), false);
});

test("相册索引配对 Live Photo，并按年、月、日分页", async (t) => {
  const { root, libraryDir, cacheDir } = await fixture();
  t.after(async () => {
    clearPhotoLibraryCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  const years = await readPhotoLibrary({ libraryDir, cacheDir, view: "year", force: true });
  assert.equal(years.libraryTotal, 27);
  assert.deepEqual(years.periods.map((period) => [period.key, period.count]), [["2026", 27]]);
  assert.equal(years.facets.counts.live, 1);
  assert.equal(years.facets.counts.video, 1);
  assert.equal(years.facets.counts.screenshot, 25);

  const months = await readPhotoLibrary({ libraryDir, cacheDir, view: "month", anchor: "2026" });
  assert.deepEqual(months.periods.map((period) => [period.key, period.count]), [["2026-08", 27]]);

  const day = await readPhotoLibrary({ libraryDir, cacheDir, view: "day", anchor: "2026-08", limit: 24 });
  assert.equal(day.entries.length, 24);
  assert.equal(day.nextCursor, "24");
  assert.ok(day.entries.some((entry) => entry.kind === "live" && entry.hasMotion));

  const rest = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", cursor: day.nextCursor, limit: 24 });
  assert.equal(rest.entries.length, 3);
  assert.equal(rest.nextCursor, null);

  const screenshots = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", kind: "screenshot" });
  assert.equal(screenshots.total, 25);
  assert.ok(screenshots.entries.every((entry) => entry.screenshot));

  const videos = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", kind: "video" });
  assert.equal(videos.total, 1);
  assert.ok(videos.entries.every((entry) => entry.kind === "video"));

  const livePhotos = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", kind: "live" });
  assert.equal(livePhotos.total, 1);
  assert.ok(livePhotos.entries.every((entry) => entry.kind === "live"));

  const indexInfo = await fs.stat(photoIndexPath(libraryDir, cacheDir));
  const cacheInfo = await fs.stat(cacheDir);
  assert.equal(indexInfo.mode & 0o777, 0o600);
  assert.equal(cacheInfo.mode & 0o777, 0o700);
});

test("照片索引永久保留，只在明确检查更新时增量合并", async (t) => {
  const { root, libraryDir, cacheDir, monthDir } = await fixture();
  t.after(async () => {
    clearPhotoLibraryCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  const initial = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", force: true });
  const indexFile = photoIndexPath(libraryDir, cacheDir);
  const stored = JSON.parse(await fs.readFile(indexFile, "utf8"));
  assert.equal(stored.version, 2);
  assert.ok(stored.directories.length > 0);
  stored.version = 1;
  delete stored.directories;
  delete stored.lastUpdate;
  await fs.writeFile(indexFile, `${JSON.stringify(stored)}\n`);
  const beforeInfo = await fs.stat(indexFile);

  await fs.writeFile(path.join(monthDir, "IMG_9999.JPG"), "new-image");
  const changedAt = new Date(Date.now() + 5_000);
  await fs.utimes(monthDir, changedAt, changedAt);
  clearPhotoLibraryCache();

  const reopened = await readPhotoLibrary({ libraryDir, cacheDir, view: "all" });
  assert.equal(reopened.libraryTotal, initial.libraryTotal);
  assert.equal((await fs.stat(indexFile)).mtimeMs, beforeInfo.mtimeMs);

  const refreshed = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", refresh: "incremental" });
  assert.equal(refreshed.libraryTotal, initial.libraryTotal + 1);
  assert.deepEqual(refreshed.indexUpdate, { mode: "incremental", added: 1, removed: 0, changed: 0 });
  assert.ok(refreshed.entries.some((entry) => entry.name === "IMG_9999.JPG"));

  clearPhotoLibraryCache();
  const reopenedAgain = await readPhotoLibrary({ libraryDir, cacheDir, view: "all" });
  assert.equal(reopenedAgain.libraryTotal, initial.libraryTotal + 1);
});

test("照片单选与多选可导出原件，Live Photo 保留照片和视频", async (t) => {
  const { root, libraryDir, cacheDir } = await fixture();
  t.after(async () => {
    clearPhotoLibraryCache();
    await fs.rm(root, { recursive: true, force: true });
  });
  const snapshot = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", force: true });
  const live = snapshot.entries.find((entry) => entry.kind === "live");
  const video = snapshot.entries.find((entry) => entry.kind === "video");
  const exportRoot = path.join(root, "desktop-export");
  const result = await exportPhotoMediaToDesktop({
    libraryDir,
    cacheDir,
    ids: [live.id, video.id],
    exportRoot,
    now: new Date("2026-08-25T01:02:03.000Z"),
  });
  assert.equal(result.itemCount, 2);
  assert.equal(result.fileCount, 3);
  assert.deepEqual((await fs.readdir(result.directory)).toSorted(), ["IMG_0001.HEIC", "IMG_0001.MOV", "clip.MP4"]);
});

test("删除会把选中原件移到隐藏回收目录，并从新索引移除", async (t) => {
  const { root, libraryDir, cacheDir } = await fixture();
  t.after(async () => {
    clearPhotoLibraryCache();
    await fs.rm(root, { recursive: true, force: true });
  });
  const before = await readPhotoLibrary({ libraryDir, cacheDir, view: "all", force: true });
  const live = before.entries.find((entry) => entry.kind === "live");
  const screenshot = before.entries.find((entry) => entry.screenshot);
  const result = await movePhotoMediaToTrash({
    libraryDir,
    cacheDir,
    ids: [live.id, screenshot.id],
    now: new Date("2026-08-25T01:02:03.000Z"),
  });
  assert.equal(result.itemCount, 2);
  assert.equal(result.fileCount, 3);
  assert.match(result.recoveryFolder, /^\.infans-photo-trash\//);
  assert.equal((await fs.stat(path.join(libraryDir, result.recoveryFolder, "manifest.json"))).isFile(), true);
  await assert.rejects(fs.stat(path.join(libraryDir, "MobileBackup", "iPhone", "2026", "08", live.name)));
  assert.equal((await fs.stat(photoIndexPath(libraryDir, cacheDir))).isFile(), true);
  clearPhotoLibraryCache();
  const after = await readPhotoLibrary({ libraryDir, cacheDir, view: "all" });
  assert.equal(after.libraryTotal, before.libraryTotal - 2);
  assert.equal(after.entries.some((entry) => entry.id === live.id || entry.id === screenshot.id), false);
});

test("读取故障保留完整年份索引，恢复后可再次增量更新", async (t) => {
  const { root, libraryDir, cacheDir, monthDir } = await fixture();
  t.after(async () => { clearPhotoLibraryCache(); await fs.rm(root, { recursive: true, force: true }); });
  const olderDir = path.join(libraryDir, "MobileBackup", "iPhone", "2025", "06");
  await fs.mkdir(olderDir, { recursive: true });
  await fs.writeFile(path.join(olderDir, "older.JPG"), "older");
  const initial = await readPhotoLibrary({ libraryDir, cacheDir, view: "year" });
  assert.deepEqual(initial.availableYears, ["2026", "2025"]);
  const indexFile = photoIndexPath(libraryDir, cacheDir);
  const saved = JSON.parse(await fs.readFile(indexFile, "utf8"));
  // 确保目录需要扫描，不依赖文件系统时间精度。
  saved.directories.forEach((entry) => { entry.mtimeMs = 0; });
  await fs.writeFile(indexFile, JSON.stringify(saved));
  const before = await fs.readFile(indexFile, "utf8");
  const realOlder = await fs.realpath(olderDir);
  const realMonth = await fs.realpath(monthDir);
  for (const [method, target, code] of [
    ["stat", realOlder, "EIO"],
    ["readdir", realOlder, "EACCES"],
    ["stat", path.join(realMonth, "Screenshot-01.PNG"), "EIO"],
  ]) {
    clearPhotoLibraryCache();
    const original = fs[method].bind(fs);
    const mocked = t.mock.method(fs, method, async (file, ...args) => {
      if (String(file) === target) throw Object.assign(new Error("photo read failed"), { code });
      return original(file, ...args);
    });
    try {
      await assert.rejects(readPhotoLibrary({ libraryDir, cacheDir, view: "year", refresh: "incremental" }), { code: "PHOTO_SCAN_INCOMPLETE" });
      assert.equal(await fs.readFile(indexFile, "utf8"), before, "失败不能覆盖磁盘索引");
      const retained = await readPhotoLibrary({ libraryDir, cacheDir, view: "year" });
      assert.deepEqual(retained.availableYears, initial.availableYears);
      assert.equal(retained.libraryTotal, initial.libraryTotal);
    } finally {
      mocked.mock.restore();
    }
  }
  const restored = await readPhotoLibrary({ libraryDir, cacheDir, view: "year", refresh: "incremental" });
  assert.deepEqual(restored.availableYears, initial.availableYears);
  assert.equal(restored.libraryTotal, initial.libraryTotal);
  // 真正删除的目录仍可从派生索引移除。
  await fs.rm(olderDir, { recursive: true });
  const removed = await readPhotoLibrary({ libraryDir, cacheDir, view: "year", refresh: "incremental" });
  assert.deepEqual(removed.availableYears, ["2026"]);
  assert.equal(removed.libraryTotal, initial.libraryTotal - 1);
});
