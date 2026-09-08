import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getNextTheme, getPageScene, PAGE_SCENES_BY_THEME, SECRETARY_HOME_SCENES_BY_THEME, THEME_IDS, THEME_META, WORKBENCH_THEMES } from "../src/workbench-theme.ts";

import { BASE_THEME_TOKENS } from "../src/workbench-theme-tokens.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(testDir, "../public");
const routes = ["/", "/schedule", "/projects", "/health", "/languages", "/topics", "/library", "/markets", "/markets/assets", "/tools"];
const styles = readFileSync(resolve(testDir, "../src/styles.css"), "utf8");
const themeStyles = readFileSync(resolve(testDir, "../src/theme.css"), "utf8");
const homePage = readFileSync(resolve(testDir, "../src/pages/HomePage.tsx"), "utf8");
const css = `${styles}\n${themeStyles}`;

test("主题注册表的每一项都覆盖全部一级路由，且场景资源存在", () => {
  for (const theme of THEME_IDS) {
    assert.deepEqual(Object.keys(PAGE_SCENES_BY_THEME[theme]).sort(), [...routes].sort());
    for (const route of routes) {
      const scene = PAGE_SCENES_BY_THEME[theme][route];
      const assetPath = scene.image.split("?")[0].replace(/^\//, "");
      assert.ok(existsSync(resolve(publicDir, assetPath)), `${theme} ${route} 缺少 ${assetPath}`);
      assert.equal(scene.position, "50% 50%", `${theme} ${route} 的默认构图应由图片承担`);
    }
  }
});

test("开源候选页面场景使用公开 SVG，不依赖私人日景摄影", () => {
  for (const theme of THEME_IDS) {
    for (const route of ["/languages", "/markets", "/markets/assets", "/tools"]) {
      assert.match(PAGE_SCENES_BY_THEME[theme][route].image, /\/theme\/avatar-[\w-]+-public\.svg/);
    }
  }
});

test("首页背景跟随当前值班秘书，其他页场景不受影响", () => {
  for (const theme of THEME_IDS) {
    for (const secretaryId of ["yinyue", "meining"]) {
      const scene = getPageScene(theme, "/", secretaryId);
      assert.equal(scene, SECRETARY_HOME_SCENES_BY_THEME[theme][secretaryId]);
      const assetPath = scene.image.split("?")[0].replace(/^\//, "");
      assert.ok(existsSync(resolve(publicDir, assetPath)), `${theme} ${secretaryId} 缺少 ${assetPath}`);
    }
    assert.notEqual(getPageScene(theme, "/", "yinyue").image, getPageScene(theme, "/", "meining").image);
    assert.equal(getPageScene(theme, "/projects", "meining"), PAGE_SCENES_BY_THEME[theme]["/projects"]);
  }
});

test("主题名称与浏览器主题色固定", () => {
  assert.deepEqual(THEME_META.night, { name: "玄夜", fullName: "玄夜仙境 · 玉夜冷青", color: BASE_THEME_TOKENS.night["--bg"], colorScheme: "dark", icon: "moon", cssSelector: ":root" });
  assert.deepEqual(THEME_META.day, { name: "晴岚", fullName: "晴岚仙境 · 云白玉青", color: BASE_THEME_TOKENS.day["--bg"], colorScheme: "light", icon: "sun", cssSelector: ':root[data-theme="day"]' });
});

test("主题切换顺序从注册表派生并能循环", () => {
  assert.deepEqual(THEME_IDS, WORKBENCH_THEMES.map((theme) => theme.id));
  for (const [index, theme] of THEME_IDS.entries()) {
    assert.equal(getNextTheme(theme), THEME_IDS[(index + 1) % THEME_IDS.length]);
  }
});

test("刷新时的页面占位保持静止，不在中间内容区循环闪烁", () => {
  const skeleton = cssBlock(styles, ".route-skeleton");
  assert.doesNotMatch(skeleton, /border|background|animation|box-shadow/);
  assert.doesNotMatch(styles, /@keyframes\s+route-shimmer/);
});

test("刷新准备阶段冻结背景合成层，触屏设备不移动萤火层", () => {
  assert.match(themeStyles, /\.app-shell\.is-booting \.workspace-backdrop-scene,[\s\S]*?animation:none !important;[\s\S]*?transform:none !important;/);
  assert.match(styles, /@media \(any-pointer:coarse\) \{[\s\S]*?\.workspace-backdrop-fireflies::after[\s\S]*?animation:none !important;[\s\S]*?transform:none !important;/);
});

const REQUIRED_SEMANTIC_TOKENS = [
  "--bg", "--bg-2", "--surface", "--surface-2", "--line", "--line-strong",
  "--ink", "--muted", "--quiet", "--text-disabled", "--text-placeholder",
  "--control-bg", "--control-bg-hover", "--control-border", "--control-border-focus",
  "--focus-ring", "--shadow-soft", "--book-cover-paper", "--writing-cover-paper",
  "--progress-track", "--progress-idle", "--recovery-cell-bg", "--recovery-water", "--recovery-wave", "--recovery-wave-opacity",
  "--media-card-bg", "--record-body", "--record-groove", "--record-label", "--record-ring", "--record-shadow",
  "--investment-scope-bg", "--investment-account-surface", "--investment-overview-bg", "--usage-primary", "--usage-secondary", "--on-accent",
  "--gold", "--gold-soft", "--teal", "--teal-soft", "--mist-blue", "--red",
];

function cssBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `找不到主题 CSS 块：${selector}`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`主题 CSS 块没有结束：${selector}`);
}

test("每个主题都声明完整的语义令牌", () => {
  for (const theme of WORKBENCH_THEMES) {
    const block = cssBlock(css, theme.cssSelector);
    for (const token of REQUIRED_SEMANTIC_TOKENS) {
      assert.ok(block.includes(`${token}:`), `${theme.name} 缺少 ${token}`);
    }
  }
});

test("全局排版契约不随主题切换，首页同级卡片共用标题组件", () => {
  for (const token of [
    "--font-title", "--font-body", "--font-data",
    "--type-label-size", "--type-meta-size", "--type-body-size",
    "--type-card-title-size", "--type-card-title-lead-size", "--type-page-title-size",
  ]) {
    assert.match(styles, new RegExp(`${token}:`), `缺少全局排版令牌 ${token}`);
  }
  assert.match(styles, /\.home-card-heading h2 \{[\s\S]*?font:var\(--type-weight-title\) var\(--home-title-size\)\/1\.25 var\(--font-title\);/u);
  assert.match(styles, /\.home-card-heading\.is-lead h2 \{[^}]*font-size:var\(--home-lead-title-size\);/u);
  assert.match(homePage, /function HomeCardHeading\(/u);
  assert.match(homePage, /<HomeCardHeading[\s\S]*?title="日程安排"[\s\S]*?lead/u);
  assert.match(homePage, /<HomeCardHeading eyebrow="语言学习" title="日语 · N2备考" \/>/u);
  assert.match(homePage, /<HomeCardHeading eyebrow="身心 · 今日"/u);
  assert.doesNotMatch(homePage, /<h3>/u);
  assert.doesNotMatch(homePage, /className="card-title"/u);
  assert.match(themeStyles, /:root\[data-theme="day"\] \.home-signal-grid \.home-quiet \.home-card-heading h2/u);
  assert.match(themeStyles, /:root\[data-theme="day"\] \.home-map-current strong,[\s\S]*?\.jp-source-ledger strong \{ color: var\(--ink\); \}/u);
  assert.match(themeStyles, /:root\[data-theme="day"\] \.home-finance-grid \.home-aux \.market-top-events \.market-signal-tag/u);
});

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexToken(block, token) {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `${token} 必须用六位十六进制色值，方便自动检查`);
  return match[1];
}

test("主要可读文字在各主题基础底上至少达到 4.5:1", () => {
  const backgroundTokens = ["--bg", "--bg-2", "--surface-2"];
  const textTokens = ["--ink", "--muted", "--quiet", "--gold", "--teal", "--red"];
  for (const theme of WORKBENCH_THEMES) {
    const block = cssBlock(css, theme.cssSelector);
    for (const textToken of textTokens) {
      const foreground = hexToken(block, textToken);
      for (const backgroundToken of backgroundTokens) {
        const background = hexToken(block, backgroundToken);
        assert.ok(contrastRatio(foreground, background) >= 4.5, `${theme.name} ${textToken} / ${backgroundToken} 对比度不足`);
      }
    }
  }
});

// 图形对比与文字对比独立检查，防止新主题只适配了正文。
test("晴岚的进度与用量图形保持可辨识度", () => {
  const day = cssBlock(css, ':root[data-theme="day"]');
  for (const color of ["--teal", "--gold"]) {
    assert.ok(contrastRatio(hexToken(day, color), hexToken(day, "--progress-track")) >= 3);
  }
  const primary = hexToken(day, "--usage-primary");
  const secondary = hexToken(day, "--usage-secondary");
  for (const color of [primary,secondary]) assert.ok(contrastRatio(color,hexToken(day,"--progress-track")) >= 3, "用量色与轨道对比不足");
  const channels=hex=>hex.match(/[a-f\d]{2}/gi).map(v=>parseInt(v,16));
  assert.ok(Math.hypot(...channels(primary).map((v,i)=>v-channels(secondary)[i])) >= 100, "两种用量色过于接近");
  for (const background of ["--media-card-bg", "--investment-account-surface", "--investment-overview-bg"]) {
    for (const foreground of ["--ink", "--quiet", "--gold", "--teal"]) {
      assert.ok(contrastRatio(hexToken(day, foreground), hexToken(day, background)) >= 4.5, `${foreground} 在 ${background} 上不清晰`);
    }
  }
});


test("投资选中按钮在两个主题中保持可读", () => {
  for (const theme of WORKBENCH_THEMES) {
    const block = cssBlock(css, theme.cssSelector);
    for (const background of ["--gold", "--teal"]) {
      assert.ok(contrastRatio(hexToken(block, "--on-accent"), hexToken(block, background)) >= 4.5, `${theme.name} ${background} 上的文字对比不足`);
    }
  }
});
