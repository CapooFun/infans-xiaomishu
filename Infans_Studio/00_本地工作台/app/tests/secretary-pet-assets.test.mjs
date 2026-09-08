import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const assetRoot = new URL("../native/secretary-pet/", import.meta.url);
const nativeSourceUrl = new URL("../native/SecretaryApp.swift", import.meta.url);
const atlasBuilderUrl = new URL("../scripts/build-secretary-pet-assets.py", import.meta.url);
const videoFrameBuilderUrl = new URL("../scripts/build-secretary-pet-video-frames.py", import.meta.url);

test("native Secretary pet is displayed at 70 percent of its original desktop size", async () => {
  const source = await readFile(nativeSourceUrl, "utf8");
  assert.match(source, /private let petWindowScale: CGFloat = 0\.7/);
  assert.match(source, /width: 168 \* petWindowScale/);
  assert.match(source, /height: 182 \* petWindowScale/);
});

test("native Secretary pet atlas matches its 16-column animation contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("animation-manifest.json", assetRoot), "utf8"));
  const png = await readFile(new URL("secretary-pet-atlas.png", assetRoot));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 3072);
  assert.equal(png.readUInt32BE(20), 1248);
  assert.deepEqual(
    Object.fromEntries(manifest.animations.map((item) => [item.id, item.frameCount])),
    {
      idle: 16,
      hover: 12,
      launching: 16,
      talking: 16,
      "dragging-right": 12,
      "dragging-left": 12,
    },
  );
  for (const animation of manifest.animations) {
    assert.equal(animation.durationsMs.length, animation.frameCount);
    assert.ok(animation.durationsMs.every((duration) => duration >= 60));
  }
  const idle = manifest.animations.find((animation) => animation.id === "idle");
  assert.equal(idle?.source?.kind, "codex-look-row");
  assert.equal(idle?.source?.row, 10);
  assert.equal(idle?.source?.frames, 8);
  assert.equal(idle?.pingPong, true);
});

test("native Yinyue pet uses authored poses with an anchored baseline", async () => {
  const atlasBuilder = await readFile(atlasBuilderUrl, "utf8");
  const videoFrameBuilder = await readFile(videoFrameBuilderUrl, "utf8");

  assert.match(atlasBuilder, /amplitude=0,/u);
  assert.match(videoFrameBuilder, /"sourceRow": 10, "sourceFrames": 8, "pingPong": True/u);
  assert.doesNotMatch(videoFrameBuilder, /animated = secondary_motion\(pose/u);
});

test("native Secretary pet ships a complete transparent 30fps video set", async () => {
  const videoRoot = new URL("video/", assetRoot);
  const manifest = JSON.parse(await readFile(new URL("video-manifest.json", videoRoot), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.canvasWidth, 384);
  assert.equal(manifest.canvasHeight, 416);
  assert.equal(manifest.fps, 30);

  const clips = Object.fromEntries(manifest.clips.map((clip) => [clip.id, clip]));
  assert.deepEqual(Object.keys(clips).sort(), [
    "dragging-left",
    "dragging-right",
    "hover",
    "idle",
    "launching",
    "talking",
  ]);
  assert.equal(clips.launching.loop, false);
  for (const [id, clip] of Object.entries(clips)) {
    if (id !== "launching") assert.equal(clip.loop, true);
    assert.equal(clip.fps, 30);
    assert.ok(clip.frameCount >= 24);
    const url = new URL(clip.file, videoRoot);
    const info = await stat(url);
    const mov = await readFile(url);
    assert.ok(info.size > 50_000, `${clip.file} should contain encoded video data`);
    assert.equal(mov.subarray(4, 8).toString("ascii"), "ftyp");
  }
});
