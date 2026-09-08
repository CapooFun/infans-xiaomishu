import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("普通页面不再暴露 Obsidian 原件入口", () => {
  const pages = [
    "../src/pages/SchedulePage.tsx",
    "../src/pages/ProjectsPage.tsx",
    "../src/pages/Reader.tsx",
    "../src/pages/BodyPanel.tsx",
    "../src/pages/GovernanceMapView.tsx",
    "../src/pages/LibraryPage.tsx",
    "../src/pages/languages/ConjugationBoard.tsx",
    "../src/pages/languages/LanguageReactorLibrary.tsx",
    "../src/pages/topics/DomainResearchView.tsx",
    "../src/pages/tools/DevelopmentLogDay.tsx",
    "../src/pages/tools/MeetingMinutesView.tsx",
    "../src/shell/WorkbenchOverlays.tsx",
  ].map(read).join("\n");

  assert.doesNotMatch(pages, /SourceLink|obsidianHref|obsidian:\/\/|在 Obsidian|打开[^\n<]{0,20}原件/u);
});

test("原件式 wiki 链接降级为站内纯文本", () => {
  const markdown = read("../src/markdown-display.mjs");
  assert.doesNotMatch(markdown, /obsidianDocumentHref|在 Obsidian 后台打开/u);
  assert.match(markdown, /nodes\.push\(\{ type: "text", value: label \}\)/u);
});

test("主页行情留在小秘书，新闻证据使用折叠来源", () => {
  const home = read("../src/pages/HomePage.tsx");
  const markets = read("../src/pages/MarketsPage.tsx");
  const world = read("../src/pages/world-news-lanes.tsx");

  assert.doesNotMatch(home, /MARKET_HEATMAP_URL|label="打开汇率行情全景"/u);
  assert.match(home, /href="\/markets\/assets"/u);
  assert.match(markets, /ExternalSourceDisclosure/u);
  assert.match(world, /ExternalSourceDisclosure/u);
  assert.doesNotMatch(world, /brief\.calendar\.map\(\(event\) => <a\b/u);
});
