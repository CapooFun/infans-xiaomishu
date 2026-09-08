import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addVideoFavorite, readVideoFavorites, removeVideoFavorite, videoFavoritesPath } from "../src/server/workbench-video-favorites.mjs";

async function fixture(t) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-favorites-vault-"));
  const library = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-favorites-library-"));
  t.after(() => Promise.all([
    fs.rm(vault, { recursive: true, force: true }),
    fs.rm(library, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(library, "日语", "N2"), { recursive: true });
  await fs.writeFile(path.join(library, "日语", "N2", "第1课.mp4"), "video");
  return { vault, library };
}

test("视频收藏缺省为空，GET 不会顺手创建派生文件", async (t) => {
  const { vault, library } = await fixture(t);
  assert.deepEqual(await readVideoFavorites(vault, library), { items: [] });
  await assert.rejects(fs.access(videoFavoritesPath(vault)));
});

test("视频收藏只保存片库内的有效视频，重复收藏保持一条", async (t) => {
  const { vault, library } = await fixture(t);
  const first = await addVideoFavorite(vault, library, "日语/N2/第1课.mp4");
  const second = await addVideoFavorite(vault, library, "日语/N2/第1课.mp4");
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].path, "日语/N2/第1课.mp4");
  assert.equal(second.items[0].folder, "日语/N2");
  assert.equal(second.items[0].available, true);
  assert.equal(second.items[0].addedAt, first.items[0].addedAt);
  assert.equal((await fs.stat(videoFavoritesPath(vault))).mode & 0o777, 0o600);
  await assert.rejects(addVideoFavorite(vault, library, "../片库外.mp4"), /越过/);
  await fs.writeFile(path.join(library, "说明.txt"), "not video");
  await assert.rejects(addVideoFavorite(vault, library, "说明.txt"), /不是支持的视频格式/);
});

test("文件移走后收藏仍可见并可取消", async (t) => {
  const { vault, library } = await fixture(t);
  const relative = "日语/N2/第1课.mp4";
  await addVideoFavorite(vault, library, relative);
  await fs.rm(path.join(library, ...relative.split("/")));
  const missing = await readVideoFavorites(vault, library);
  assert.equal(missing.items[0].available, false);
  assert.deepEqual(await removeVideoFavorite(vault, library, relative), { items: [] });
});
