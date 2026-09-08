import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const themeStyles = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const nightAsset = new URL("../public/theme/workbench-mountain-window-night.v1.avif", import.meta.url);
const dayAsset = new URL("../public/theme/workbench-mountain-window-day.v1.avif", import.meta.url);

test("山窗素材同时服务桌面侧栏和手机静态壁纸", () => {
  assert.equal(existsSync(nightAsset), true);
  assert.equal(existsSync(dayAsset), true);
  assert.ok(statSync(nightAsset).size > 10_000);
  assert.ok(statSync(dayAsset).size > 10_000);
  assert.match(themeStyles, /--workbench-mountain-window:\s*url\("\/theme\/workbench-mountain-window-night\.v1\.avif"\)/u);
  assert.match(themeStyles, /:root\[data-theme="day"\][\s\S]*?--workbench-mountain-window:\s*url\("\/theme\/workbench-mountain-window-day\.v1\.avif"\)/u);
  assert.match(themeStyles, /@media \(min-width: 901px\) and \(min-height: 840px\)[\s\S]*?\.sidebar::after/u);
  assert.match(themeStyles, /@media \(max-width: 900px\)[\s\S]*?\.workspace-backdrop-scene[\s\S]*?background-image:\s*var\(--workbench-mountain-window\)/u);
  const sidebarWindow = themeStyles.slice(themeStyles.indexOf(".sidebar::after"), themeStyles.indexOf(':root[data-theme="day"] .sidebar::after'));
  assert.match(sidebarWindow, /background-image:\s*var\(--workbench-mountain-window\)/u);
  assert.match(sidebarWindow, /opacity:\s*\.52/u);
  assert.match(sidebarWindow, /-webkit-mask-image:\s*radial-gradient\(ellipse 68% 84% at 50% 50%,[\s\S]*?transparent 60%\)/u);
  assert.match(sidebarWindow, /mask-image:\s*radial-gradient\(ellipse 68% 84% at 50% 50%,[\s\S]*?transparent 60%\)/u);
  assert.doesNotMatch(sidebarWindow, /border(?:-radius)?:|box-shadow/u);
});
