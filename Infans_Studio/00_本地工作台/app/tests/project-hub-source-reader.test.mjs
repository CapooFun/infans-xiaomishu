import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalHubSourcePath,
  collectProjectHubSourceTargets,
  projectHubSourceBodyMatches,
  resolveProjectHubSourceHref,
} from "../src/pages/project-hub-source-reader.ts";

const GARDEN_HUB = {
  worklines: [
    { id: "garden-plan", name: "总计划", source: { path: "docs/项目实施总计划.md" }, view: { kind: "overview" } },
    { id: "garden-play", name: "功能", source: { path: "docs/功能Wiki.md" }, view: { kind: "featureTree" } },
    { id: "garden-wiki", name: "功能Wiki全文", source: { path: "docs/功能Wiki.md" }, view: { kind: "overview" } },
    { id: "garden-delivery", name: "试种与检查点", source: { path: "README.md" }, view: { kind: "overview" } },
    { id: "garden-evidence", name: "换盆证据", source: { path: "evidence/2026-09-08-repot/review.md" }, view: { kind: "overview" } },
    { id: "garden-rules", name: "项目规则", source: { path: "AGENTS.md" }, view: { kind: "overview" } },
    { id: "garden-collab", name: "协作入口", source: { path: "docs/协作接入说明.md" }, view: { kind: "overview" } },
  ],
  featureTrees: [
    {
      id: "garden-features",
      source: { path: "docs/功能Wiki.md" },
      modules: [
        {
          id: "garden-home",
          source: { path: "docs/功能Wiki.md" },
          features: [{ id: "garden-water", source: { path: "docs/功能Wiki.md" }, children: [] }],
        },
      ],
    },
  ],
};

const SOURCES = collectProjectHubSourceTargets(GARDEN_HUB);
const PLAN = "docs/项目实施总计划.md";
const WIKI = "docs/功能Wiki.md";

test("清单收集七条工作线，功能Wiki优先可阅读工作线而不是功能树", () => {
  assert.equal(SOURCES.filter((item) => item.rank === 0 || item.rank === 1).length, 7);
  const wiki = resolveProjectHubSourceHref("功能Wiki.md", { sourcePath: PLAN, sources: SOURCES });
  assert.deepEqual(wiki, { kind: "registered", objectId: "garden-wiki", path: "docs/功能Wiki.md" });
});

test("总计划正文里已登记的相对链都对上同一项目 object，不带 path 查询", () => {
  const cases = [
    ["功能Wiki.md", "garden-wiki", "docs/功能Wiki.md"],
    ["协作接入说明.md", "garden-collab", "docs/协作接入说明.md"],
    ["../AGENTS.md", "garden-rules", "AGENTS.md"],
    ["../README.md", "garden-delivery", "README.md"],
    ["../evidence/2026-09-08-repot/review.md", "garden-evidence", "evidence/2026-09-08-repot/review.md"],
  ];
  for (const [href, objectId, path] of cases) {
    assert.deepEqual(resolveProjectHubSourceHref(href, { sourcePath: PLAN, sources: SOURCES }), {
      kind: "registered",
      objectId,
      path,
    });
  }
});

test("Wiki 与试种说明也能回到已登记原件", () => {
  assert.equal(resolveProjectHubSourceHref("../README.md", { sourcePath: WIKI, sources: SOURCES }).objectId, "garden-delivery");
  assert.equal(resolveProjectHubSourceHref("docs/功能Wiki.md", { sourcePath: "README.md", sources: SOURCES }).objectId, "garden-wiki");
  assert.equal(resolveProjectHubSourceHref("docs/协作接入说明.md", { sourcePath: "README.md", sources: SOURCES }).objectId, "garden-collab");
});

test("未登记本地路径、.app、绝对路径保持不可点", () => {
  const blocked = [
    "../builds/阳台种植计划.app",
    "2026-09-08_下一阶段计划_待确认.md",
    "/Users/demo/Infans_Studio/30_事业顺利/阳台种植计划/项目进度与待办.md",
    "/Users/demo/Downloads/02_给园艺总负责人_复核与总实施计划.md",
    "../../../../etc/passwd",
    "obsidian://open?vault=Infans_Studio&file=AGENTS",
    "file:///Users/demo/garden-demo/AGENTS.md",
  ];
  for (const href of blocked) {
    const decision = resolveProjectHubSourceHref(href, { sourcePath: PLAN, sources: SOURCES });
    assert.equal(decision.kind, "plain", href);
    assert.ok(!("objectId" in decision));
  }
});

test("HTTP(S) 与 mailto 按安全网页链接放行，javascript 与协议相对地址不放行", () => {
  assert.deepEqual(resolveProjectHubSourceHref("https://example.com/a", { sourcePath: PLAN, sources: SOURCES }), {
    kind: "web",
    href: "https://example.com/a",
  });
  assert.deepEqual(resolveProjectHubSourceHref("http://127.0.0.1/health", { sourcePath: PLAN, sources: SOURCES }), {
    kind: "web",
    href: "http://127.0.0.1/health",
  });
  assert.deepEqual(resolveProjectHubSourceHref("mailto:capoo@example.com", { sourcePath: PLAN, sources: SOURCES }), {
    kind: "web",
    href: "mailto:capoo@example.com",
  });
  assert.equal(resolveProjectHubSourceHref("javascript:alert(1)", { sourcePath: PLAN, sources: SOURCES }).kind, "plain");
  assert.equal(resolveProjectHubSourceHref("//example.com", { sourcePath: PLAN, sources: SOURCES }).kind, "plain");
});

test("正文返回必须同时核对 projectId 与 objectId，避免串篇", () => {
  assert.equal(projectHubSourceBodyMatches({ projectId: "garden-demo", objectId: "garden-plan" }, "garden-demo", "garden-plan"), true);
  assert.equal(projectHubSourceBodyMatches({ projectId: "garden-demo", objectId: "garden-plan" }, "garden-demo", "garden-wiki"), false);
  assert.equal(projectHubSourceBodyMatches({ projectId: "other", objectId: "garden-plan" }, "garden-demo", "garden-plan"), false);
  assert.equal(projectHubSourceBodyMatches(null, "garden-demo", "garden-plan"), false);
});

test("规范化不把项目相对路径当成库根", () => {
  assert.equal(canonicalHubSourcePath("docs/功能Wiki.md"), "docs/功能Wiki.md");
  assert.equal(canonicalHubSourcePath("./docs/../AGENTS.md#开工入口"), "AGENTS.md");
});

test("资料短入口函数不得再出现，阅读器解析留下", () => {
  const source = readFileSync(new URL("../src/pages/project-hub-source-reader.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /isProjectHubDocumentHome|documentHomeEntryLabel|defaultDocumentHomeSelection|partitionProjectHubDocumentNav|projectHubShouldShowRelatedLane|RTC3D_DOCUMENT_HOME_/);
  assert.match(source, /export function collectProjectHubSourceTargets/);
});
