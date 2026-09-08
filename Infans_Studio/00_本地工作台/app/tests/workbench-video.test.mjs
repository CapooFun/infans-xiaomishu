import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetMediaDirectoryCacheForTests } from "../src/server/workbench-media-directory-cache.mjs";
import { DEFAULT_VIDEO_LIBRARY_DIR, normalizeVideoPath, readVideoDirectory, streamVideoFile } from "../src/server/workbench-video.mjs";

test("视频库默认不指向任何私人挂载路径", () => {
  assert.equal(DEFAULT_VIDEO_LIBRARY_DIR, "");
});

test("视频库按文件夹逐层读取，目录在前且忽略隐藏和非视频文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-cache-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(cacheDir, { recursive: true, force: true })]));
  await fs.mkdir(path.join(root, "系列", "第一季"), { recursive: true });
  await fs.writeFile(path.join(root, "第2集.mp4"), "video-two");
  await fs.writeFile(path.join(root, "第10集.mkv"), "video-ten");
  await fs.writeFile(path.join(root, "说明.txt"), "ignore");
  await fs.writeFile(path.join(root, ".hidden.mp4"), "ignore");
  await fs.writeFile(path.join(root, "系列", "第一季", "第1集.mov"), "nested");

  const top = await readVideoDirectory(root, "", { cacheDir });
  assert.deepEqual(top.entries.map((entry) => [entry.kind, entry.name]), [
    ["directory", "系列"],
    ["video", "第2集.mp4"],
    ["video", "第10集.mkv"],
  ]);
  assert.equal(top.entries[1].browserReady, true);
  assert.equal(top.entries[2].browserReady, false);

  const nested = await readVideoDirectory(root, "系列/第一季", { cacheDir });
  assert.deepEqual(nested.breadcrumbs, ["系列", "第一季"]);
  assert.equal(nested.entries[0].path, "系列/第一季/第1集.mov");
});

test("视频库拒绝绝对路径、反斜杠和上级越界", () => {
  assert.equal(normalizeVideoPath("系列/第一季"), "系列/第一季");
  assert.throws(() => normalizeVideoPath("../other"), /越过/);
  assert.throws(() => normalizeVideoPath("/tmp/video.mp4"), /不合法/);
  assert.throws(() => normalizeVideoPath("folder\\video.mp4"), /不合法/);
});

test("视频分段 HEAD 请求返回 206 和精确字节范围", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-range-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "sample.mp4"), "0123456789");
  const headers = new Map();
  const response = {
    statusCode: 0,
    ended: false,
    setHeader(name, value) { headers.set(name, String(value)); },
    end() { this.ended = true; },
  };
  await streamVideoFile({ method: "HEAD", headers: { range: "bytes=2-5" } }, response, root, "sample.mp4");
  assert.equal(response.statusCode, 206);
  assert.equal(headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(headers.get("Content-Length"), "4");
  assert.equal(response.ended, true);
});

test("视频目录缓存支持明确重扫，并在 NAS 断开时保留最近成功快照", async (t) => {
  resetMediaDirectoryCacheForTests();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-cache-library-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-video-cache-store-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(`${root}-offline`, { recursive: true, force: true }), fs.rm(cacheDir, { recursive: true, force: true })]));
  await fs.writeFile(path.join(root, "第一集.mp4"), "one");
  const first = await readVideoDirectory(root, "", { cacheDir });
  assert.deepEqual(first.entries.map((entry) => entry.name), ["第一集.mp4"]);
  await fs.writeFile(path.join(root, "第二集.mp4"), "two");
  const refreshed = await readVideoDirectory(root, "", { cacheDir, force: true });
  assert.deepEqual(refreshed.entries.map((entry) => entry.name).sort(), ["第一集.mp4", "第二集.mp4"].sort());

  resetMediaDirectoryCacheForTests();
  await fs.rename(root, `${root}-offline`);
  const cached = await readVideoDirectory(root, "", { cacheDir, now: () => Date.now() + 60_000 });
  assert.equal(cached.stale, true);
  assert.equal(cached.entries.length, 2);
});
