import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PHONE_MAC_VIEW_STORAGE_KEY,
  PHONE_MAC_HOST_CLIP_STYLE,
  isIPhoneClient,
  isNestedBrowsingContext,
  layoutPhoneMacFrame,
  orientPhoneMacFrameBox,
  phoneMacFrameStyle,
  readPhoneMacView,
  reloadAfterPhoneMacViewChange,
  shouldMountPhoneMacHost,
  writePhoneMacView,
} from "../src/phone-mac-view.ts";

const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" };
const IPAD = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1" };
const MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15" };

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test("Mac 视图入口只属于 iPhone，不因 iPad 的窄屏布局出现", () => {
  assert.equal(isIPhoneClient(IPHONE), true);
  assert.equal(isIPhoneClient(IPAD), false);
  assert.equal(isIPhoneClient(MAC), false);
  const storage = memoryStorage({ [PHONE_MAC_VIEW_STORAGE_KEY]: "on" });
  assert.equal(readPhoneMacView(storage, IPHONE), true);
  assert.equal(readPhoneMacView(storage, IPAD), false);
  assert.equal(readPhoneMacView(storage, MAC), false);
});

test("Mac 视图宿主只在顶层窗口出现，内层 iframe 继续当桌面页", () => {
  const storage = memoryStorage({ [PHONE_MAC_VIEW_STORAGE_KEY]: "on" });
  const top = { self: null, top: null };
  top.self = top;
  top.top = top;
  const nested = { self: null, top };
  nested.self = nested;
  assert.equal(isNestedBrowsingContext(top), false);
  assert.equal(isNestedBrowsingContext(nested), true);
  assert.equal(shouldMountPhoneMacHost(storage, IPHONE, top), true);
  assert.equal(shouldMountPhoneMacHost(storage, IPHONE, nested), false);
  assert.equal(shouldMountPhoneMacHost(memoryStorage(), IPHONE, top), false);
});

test("Mac 视图内层保持 1440 横屏画布并按可用宽度缩小", () => {
  const portrait = layoutPhoneMacFrame({ width: 393, height: 852 });
  const landscape = layoutPhoneMacFrame({ width: 852, height: 393 });
  assert.equal(portrait.width, 1440);
  assert.equal(landscape.width, 1440);
  assert.equal(portrait.scale, 393 / 1440);
  assert.equal(landscape.scale, 852 / 1440);
  assert.equal(portrait.height, Math.round(852 / portrait.scale));
  assert.equal(landscape.height, Math.round(393 / landscape.scale));
  assert.ok(landscape.height < portrait.height);
  assert.match(phoneMacFrameStyle({ width: 852, height: 393 }), /width:1440px/);
  assert.match(phoneMacFrameStyle({ width: 852, height: 393 }), /transform:scale\(0\.59167\)/);
});

test("Mac 模式固定横屏：竖向外层旋转，横向外层直接缩放", () => {
  assert.deepEqual(orientPhoneMacFrameBox({ width: 393, height: 852 }), { box: { width: 852, height: 393 }, rotation: 90 });
  assert.deepEqual(orientPhoneMacFrameBox({ width: 852, height: 393 }), { box: { width: 852, height: 393 }, rotation: 0 });
  assert.match(phoneMacFrameStyle({ width: 393, height: 852 }), /translateX\(393px\) rotate\(90deg\) scale\(0\.59167\)/);
  assert.equal(phoneMacFrameStyle({ width: 852, height: 393 }).includes("rotate("), false);
  assert.match(phoneMacFrameStyle({ width: 393, height: 759 }), /^position:absolute;/);
  assert.match(PHONE_MAC_HOST_CLIP_STYLE, /top:env\(safe-area-inset-top,0px\)/);
  assert.match(PHONE_MAC_HOST_CLIP_STYLE, /bottom:env\(safe-area-inset-bottom,0px\)/);
});

test("关闭 Mac 视图时内层会刷新顶层窗口", () => {
  const storage = memoryStorage();
  writePhoneMacView(true, storage);
  assert.equal(storage.getItem(PHONE_MAC_VIEW_STORAGE_KEY), "on");
  let reloaded = "";
  const top = { self: null, top: null, location: { reload() { reloaded = "top"; } } };
  top.self = top;
  top.top = top;
  const nested = { self: null, top, location: { reload() { reloaded = "self"; } } };
  nested.self = nested;
  reloadAfterPhoneMacViewChange(false, nested);
  assert.equal(reloaded, "top");
  reloadAfterPhoneMacViewChange(true, nested);
  assert.equal(reloaded, "self");
});

test("iPhone 刷新前即恢复 Mac 视口，更多面板与桌面侧栏都有明确切换口", () => {
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../public/site.webmanifest", import.meta.url), "utf8"));
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const boot = readFileSync(new URL("../src/boot.ts", import.meta.url), "utf8");
  const phoneMacViewSource = readFileSync(new URL("../src/phone-mac-view.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(index, /infans-phone-mac-view-v1/);
  assert.match(index, /phoneMacHost/);
  assert.doesNotMatch(index, /createElement\("iframe"\)/);
  assert.doesNotMatch(index, /visualViewport/);
  assert.doesNotMatch(index, /setAttribute\("content", "width=1440/);
  assert.match(index, /src="\/src\/boot\.ts"/);
  assert.equal(Object.hasOwn(manifest, "orientation"), false);
  assert.match(boot, /shouldMountPhoneMacHost/);
  assert.match(boot, /mountPhoneMacHost/);
  assert.doesNotMatch(phoneMacViewSource, /visualViewport/);
  assert.match(phoneMacViewSource, /documentElement\.clientWidth/);
  assert.match(phoneMacViewSource, /ResizeObserver/);
  assert.doesNotMatch(phoneMacViewSource, /orientationchange/);
  assert.doesNotMatch(phoneMacViewSource, /screen\.orientation/);
  assert.doesNotMatch(phoneMacViewSource, /setTimeout/);
  assert.doesNotMatch(phoneMacViewSource, /requestAnimationFrame/);
  assert.match(main, /reloadAfterPhoneMacViewChange/);
  assert.doesNotMatch(main, /className="nav-mac-view"/);
  assert.match(main, /className="more-sheet-mac-view"/);
  assert.match(main, />Mac<\/span>/);
  assert.match(main, />返回手机排版<\/span>/);
  assert.match(main, /more-sheet-actions\$\{isIPhone \? " has-mac-view" : ""\}/);
  assert.match(styles, /\.more-sheet-actions\.has-mac-view \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.phone-mac-view-exit \{/);
  assert.doesNotMatch(styles, /data-phone-mac-host/);
});
