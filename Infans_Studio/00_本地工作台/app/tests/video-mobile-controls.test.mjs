import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clampVideoTime,
  formatVideoTime,
  getEffectiveVideoAspectRatio,
  MOBILE_VIDEO_CONTROLS_QUERY,
  requestVideoFullscreen,
} from "../src/pages/tools/video-player-controls.ts";

test("移动播放器快进快退会限定在视频范围内", () => {
  assert.equal(clampVideoTime(20, 100, 15), 35);
  assert.equal(clampVideoTime(8, 100, -15), 0);
  assert.equal(clampVideoTime(95, 100, 15), 100);
});

test("移动播放器时间适配短视频和长视频", () => {
  assert.equal(formatVideoTime(0), "0:00");
  assert.equal(formatVideoTime(65.9), "1:05");
  assert.equal(formatVideoTime(3661), "1:01:01");
});

test("播放器框体按视频自然尺寸与旋转方向计算有效比例", () => {
  assert.equal(getEffectiveVideoAspectRatio(1920, 1080, 0), 16 / 9);
  assert.equal(getEffectiveVideoAspectRatio(1920, 1080, 90), 9 / 16);
  assert.equal(getEffectiveVideoAspectRatio(1920, 1080, 180), 16 / 9);
  assert.equal(getEffectiveVideoAspectRatio(1920, 1080, 270), 9 / 16);
  assert.equal(getEffectiveVideoAspectRatio(0, 0, 90), 9 / 16);
});

test("触屏设备使用左手优先的自定义播放顺序", () => {
  const source = readFileSync(new URL("../src/pages/tools/VideoLibraryView.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const forward = source.indexOf('aria-label="前进 15 秒"');
  const play = source.indexOf('className="video-mobile-play"');
  const back = source.indexOf('aria-label="后退 15 秒"');

  assert.match(MOBILE_VIDEO_CONTROLS_QUERY, /any-pointer: coarse/);
  assert.match(MOBILE_VIDEO_CONTROLS_QUERY, /max-width: 1024px/);
  assert.ok(source.includes("controls={!customVideoControls}"));
  assert.ok(forward >= 0 && forward < play && play < back);
  assert.ok(source.includes("requestVideoFullscreen(video, stage, () => setInAppFullscreen(true))"));
  assert.match(styles, /\.video-mobile-seek \{ width:62px;height:62px/);
});

test("Safari 在用户点击链上直接请求视频全屏", () => {
  const calls = [];
  requestVideoFullscreen(
    { webkitEnterFullscreen: () => calls.push("safari"), webkitSupportsFullscreen: true },
    { requestFullscreen: async () => { calls.push("standard"); } },
    (message) => calls.push(message),
  );
  assert.deepEqual(calls, ["safari"]);
});

test("非 Safari 浏览器把完整播放画幅放入全屏", () => {
  const calls = [];
  requestVideoFullscreen(
    {},
    { requestFullscreen: async () => { calls.push("standard"); } },
    (message) => calls.push(message),
  );
  assert.deepEqual(calls, ["standard"]);
});

test("网页全屏不可用时切换为应用内沉浸全屏", async () => {
  const calls = [];
  requestVideoFullscreen({}, {}, () => calls.push("in-app"));
  assert.deepEqual(calls, ["in-app"]);

  requestVideoFullscreen(
    {},
    { requestFullscreen: async () => { throw new Error("not allowed"); } },
    () => calls.push("rejected-to-in-app"),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["in-app", "rejected-to-in-app"]);
});

test("桌面与触屏端都有明确可见的全屏入口", () => {
  const source = readFileSync(new URL("../src/pages/tools/VideoLibraryView.tsx", import.meta.url), "utf8");
  const stageActions = source.slice(
    source.indexOf('className="video-stage-actions"'),
    source.indexOf('className={`video-stage${selected'),
  );

  assert.match(stageActions, /className="video-fullscreen-button"/);
  assert.match(stageActions, /aria-label="全屏播放"/);
  assert.match(stageActions, />\s*全屏\s*<\/button>/);
  assert.ok(source.includes('aria-label={inAppFullscreen ? "退出全屏" : "全屏播放"}'));
});

test("竖屏 MOV 可旋转画面且控件不跟随旋转", () => {
  const source = readFileSync(new URL("../src/pages/tools/VideoLibraryView.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /顺时针旋转画面/);
  assert.match(source, /videoRotation !== 0/);
  assert.match(source, /video\.videoWidth/);
  assert.match(source, /getEffectiveVideoAspectRatio/);
  assert.match(source, /is-portrait-video/);
  assert.match(source, /is-rotated-\$\{videoRotation\}/);
  assert.match(source, /video-in-app-fullscreen-open/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(styles, /\.video-stage\.is-rotated-90 video \{ width:100cqh;height:100cqw;transform:rotate\(90deg\); \}/);
  assert.match(styles, /aspect-ratio:var\(--video-aspect-ratio,16\/9\)/);
  assert.match(styles, /\.video-library-page\.is-portrait-video \{ grid-template-columns:clamp/);
  assert.match(styles, /\.video-stage\.is-in-app-fullscreen \{ width:100dvw;height:100dvh/);
  assert.match(styles, /html\.video-in-app-fullscreen-open \.workspace,html\.video-in-app-fullscreen-open \.page-stack \{ z-index:12000; \}/);
  assert.match(styles, /html\.video-in-app-fullscreen-open \.page-stack \{ z-index:12000; \}/);
  assert.match(styles, /html\.video-in-app-fullscreen-open \.sidebar/);
});

test("桌面沉浸全屏守住上下边界并完整容纳竖屏画面", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--fullscreen-video-width:min\(100dvw,calc\(100dvh \* var\(--video-aspect-ratio,16 \/ 9\)\)\)/);
  assert.match(styles, /--fullscreen-video-height:min\(100dvh,calc\(100dvw \/ var\(--video-aspect-ratio,16 \/ 9\)\)\)/);
  assert.match(styles, /\.video-stage:fullscreen video,\.video-stage\.is-in-app-fullscreen video \{ width:var\(--fullscreen-video-width\);height:var\(--fullscreen-video-height\);max-width:100dvw;max-height:100dvh; \}/);
  assert.match(styles, /\.video-stage\.is-in-app-fullscreen\.is-rotated-90 video/);
  assert.match(styles, /\.video-stage\.is-in-app-fullscreen\.is-rotated-270 video/);
});

test("沉浸全屏操作区静置隐藏并由鼠标触屏或键盘唤醒", () => {
  const source = readFileSync(new URL("../src/pages/tools/VideoLibraryView.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /immersiveActionsVisible/);
  assert.match(source, /document\.addEventListener\("pointermove", revealImmersiveActions/);
  assert.match(source, /document\.addEventListener\("pointerdown", revealImmersiveActions/);
  assert.match(source, /document\.addEventListener\("keydown", handleFullscreenKey/);
  assert.match(source, /2200/);
  assert.match(source, /video-immersive-actions\$\{immersiveActionsVisible \? "" : " is-hidden"\}/);
  assert.match(styles, /\.video-immersive-actions\.is-hidden \{ opacity:0;pointer-events:none; \}/);
  assert.match(styles, /\.video-immersive-actions\.is-hidden:has\(button:focus-visible\)/);
});
