import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMusicPlaylist, musicPlaylistsPath, readMusicPlaylists, updateMusicPlaylist } from "../src/server/workbench-music-playlists.mjs";
import { resetMediaDirectoryCacheForTests } from "../src/server/workbench-media-directory-cache.mjs";
import { DEFAULT_MUSIC_LIBRARY_DIR, normalizeMusicPath, parseByteRange, readDefaultMusicQueue, readMusicDirectory } from "../src/server/workbench-music.mjs";

async function fixture(t) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "infans-music-vault-"));
  const library = await fs.mkdtemp(path.join(os.tmpdir(), "infans-music-library-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-music-cache-"));
  t.after(() => Promise.all([fs.rm(vault, { recursive: true, force: true }), fs.rm(library, { recursive: true, force: true }), fs.rm(`${library}-offline`, { recursive: true, force: true }), fs.rm(cacheDir, { recursive: true, force: true })]));
  await fs.mkdir(path.join(library, "示例专辑"), { recursive: true });
  await fs.writeFile(path.join(library, "示例专辑", "01_示例曲.m4a"), Buffer.alloc(16));
  await fs.writeFile(path.join(library, "示例专辑", "02_第二首.mp3"), Buffer.alloc(20));
  await fs.writeFile(path.join(library, "说明.txt"), "ignore");
  return { vault, library, cacheDir };
}

test("音乐库默认不指向任何私人挂载路径", () => {
  assert.equal(DEFAULT_MUSIC_LIBRARY_DIR, "");
});

test("NAS 音乐库支持多层文件夹并忽略非音乐文件", async (t) => {
  const { library, cacheDir } = await fixture(t);
  const root = await readMusicDirectory(library, "", { cacheDir });
  assert.deepEqual(root.entries.map((entry) => [entry.kind, entry.name]), [["directory", "示例专辑"]]);
  const album = await readMusicDirectory(library, "示例专辑", { cacheDir });
  assert.deepEqual(album.entries.map((entry) => [entry.kind, entry.title, entry.format]), [
    ["track", "示例曲", "M4A"],
    ["track", "第二首", "MP3"],
  ]);
});

test("默认播放会使用找到的第一首曲子并带上同文件夹队列", async (t) => {
  const { library, cacheDir } = await fixture(t);
  const result = await readDefaultMusicQueue(library, { cacheDir });
  assert.equal(result.selectedPath, "示例专辑/01_示例曲.m4a");
  assert.equal(result.tracks.length, 2);
  assert.equal(result.directory.path, "示例专辑");
});

test("顶栏音乐按钮是两倍宽并原地切换播放暂停", async () => {
  const [main, styles] = await Promise.all([
    fs.readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/workbench-personalization.css", import.meta.url), "utf8"),
  ]);
  const handler = main.slice(main.indexOf("const toggleHeaderMusic"), main.indexOf("const openIdentity"));
  assert.match(handler, /toggleMusicPlayback\(\)/u);
  assert.doesNotMatch(handler, /navigate\(/u);
  assert.match(main, /onClick=\{toggleHeaderMusic\}/u);
  assert.match(main, /aria-pressed=\{musicPlayer\.playing\}/u);
  assert.match(main, /musicPlayer\.playing \? "暂停" : "听歌"/u);
  assert.match(styles, /\.top-actions>\.header-music-button \{[^}]*width:calc\(var\(--header-action-size\) \* 2\);[^}]*min-width:calc\(var\(--header-action-size\) \* 2\);/u);
});

test("同一音乐控件首次播放、再次暂停并能继续播放", async (t) => {
  const previous = {
    Audio: globalThis.Audio,
    fetch: globalThis.fetch,
    window: globalThis.window,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });

  class FakeAudio extends EventTarget {
    paused = true;
    src = "";
    preload = "";
    volume = 1;
    currentTime = 0;
    duration = 283;
    load() {}
    async play() {
      this.paused = false;
      this.dispatchEvent(new Event("play"));
    }
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }

  const storage = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  };
  globalThis.Audio = FakeAudio;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => ({
        available: true,
        selectedPath: "示例专辑/01_示例曲.m4a",
        tracks: [{ kind: "track", id: "demo-1", name: "01_示例曲.m4a", title: "示例曲", path: "示例专辑/01_示例曲.m4a", folder: "示例专辑", bytes: 16, modifiedAt: "", format: "M4A", browserReady: true, duration: 180 }],
      }),
    };
  };

  const player = await import(`../src/secretary-music-player.ts?header-toggle=${Date.now()}`);
  await player.toggleMusicPlayback();
  assert.equal(player.getMusicPlayerSnapshot().playing, true);
  assert.equal(requests, 1);
  await player.toggleMusicPlayback();
  assert.equal(player.getMusicPlayerSnapshot().playing, false);
  await player.toggleMusicPlayback();
  assert.equal(player.getMusicPlayerSnapshot().playing, true);
  assert.equal(requests, 1);
});

test("音乐路径拒绝绝对路径、反斜杠与越界", () => {
  assert.equal(normalizeMusicPath("动漫/专辑/歌曲.m4a"), "动漫/专辑/歌曲.m4a");
  assert.throws(() => normalizeMusicPath("../歌曲.m4a"), /越过/);
  assert.throws(() => normalizeMusicPath("动漫\\歌曲.m4a"), /不合法/);
  assert.throws(() => normalizeMusicPath("/tmp/歌曲.m4a"), /不合法/);
});

test("我的歌单可新增歌曲并保存自定义顺序", async (t) => {
  const { vault, library } = await fixture(t);
  assert.deepEqual(await readMusicPlaylists(vault, library), { playlists: [] });
  await assert.rejects(fs.access(musicPlaylistsPath(vault)));
  let snapshot = await createMusicPlaylist(vault, library, "晚间歌单");
  const playlistId = snapshot.playlists[0].id;
  snapshot = await updateMusicPlaylist(vault, library, { playlistId, action: "add", path: "示例专辑/01_示例曲.m4a" });
  snapshot = await updateMusicPlaylist(vault, library, { playlistId, action: "add", path: "示例专辑/02_第二首.mp3" });
  snapshot = await updateMusicPlaylist(vault, library, { playlistId, action: "move", path: "示例专辑/02_第二首.mp3", toIndex: 0 });
  assert.deepEqual(snapshot.playlists[0].tracks.map((track) => track.title), ["第二首", "示例曲"]);
  assert.equal((await fs.stat(musicPlaylistsPath(vault))).mode & 0o777, 0o600);
});

test("音频分段范围支持首段、开放结尾与尾段", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(parseByteRange("bytes=1000-1001", 1000), false);
  assert.equal(parseByteRange("items=0-1", 1000), false);
});

test("音乐目录把最近成功结果保存为 0600 快照，NAS 断开后仍可回退", async (t) => {
  resetMediaDirectoryCacheForTests();
  const { library, cacheDir } = await fixture(t);
  const first = await readMusicDirectory(library, "示例专辑", { cacheDir });
  assert.equal(first.entries.length, 2);
  const cacheFile = path.join(cacheDir, "nas-media-directories.json");
  assert.equal((await fs.stat(cacheFile)).mode & 0o777, 0o600);

  resetMediaDirectoryCacheForTests();
  await fs.rename(library, `${library}-offline`);
  const cached = await readMusicDirectory(library, "示例专辑", { cacheDir, now: () => Date.now() + 60_000 });
  assert.equal(cached.stale, true);
  assert.deepEqual(cached.entries.map((entry) => entry.title), ["示例曲", "第二首"]);
});
