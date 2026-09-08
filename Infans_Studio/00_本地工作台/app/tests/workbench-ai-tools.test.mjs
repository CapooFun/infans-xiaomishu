import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { aiToolCatalogPath, aiToolUsagePath, readAiTools, readWebBookmarks, recordAiToolUse, recordWebBookmarkUse, webBookmarkCatalogPath, webBookmarkUsagePath } from "../src/server/workbench-ai-tools.mjs";
import { AI_TOOL_QUARTERLY_REPORT_DIR } from "../src/server/vault-paths.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-ai-tools-"));
  const catalogPath = aiToolCatalogPath(root);
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(catalogPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-31T00:00:00+09:00",
    tools: [
      { id: "used", name: "Used", url: "https://used.example/", category: "coding", summary: "used tool", origin: "recommendation", discoveryStatus: "baseline" },
      { id: "fresh", name: "Fresh", url: "https://fresh.example/", category: "art", summary: "fresh tool", origin: "recommendation", discoveryStatus: "recent" },
      { id: "saved", name: "Saved", url: "https://saved.example/", category: "model", summary: "saved tool", origin: "bookmark", browserSources: ["chrome"], discoveryStatus: "baseline" },
    ],
  }));
  const bookmarkPath = webBookmarkCatalogPath(root);
  await fs.mkdir(path.dirname(bookmarkPath), { recursive: true });
  await fs.writeFile(bookmarkPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-09-01T00:00:00+09:00",
    bookmarks: [
      { id: "reading", name: "Reading", url: "https://reading.example/", category: "interesting", summary: "saved reading", origin: "bookmark", browserSources: ["safari"] },
    ],
  }));
  return root;
}

test("最近发现不会因时间自动沉入待体验", async () => {
  const root = await fixture();
  const snapshot = await readAiTools(root, new Date("2030-01-01T00:00:00Z"));
  assert.equal(snapshot.tools.find((tool) => tool.id === "fresh").status, "recently-discovered");
  assert.equal(snapshot.tools.find((tool) => tool.id === "saved").status, "to-try");
});

test("工具接口下发本地 Logo，字母头像只作加载失败兜底", async () => {
  const root = await fixture();
  const snapshot = await readAiTools(root);
  assert.equal(snapshot.tools.find((tool) => tool.id === "used").logoPath, "/ai-tools/icons/used.png");
  assert.equal(snapshot.tools.find((tool) => tool.id === "used").logoText, "US");
});

test("正式目录的每张工具卡都有可读取的 128px 本地 Logo", async () => {
  const appRoot = path.resolve(import.meta.dirname, "..");
  const catalog = JSON.parse(await fs.readFile(path.resolve(appRoot, "../../85_收藏夹/AI工具库/AI工具目录.json"), "utf8"));
  const bookmarkCatalog = JSON.parse(await fs.readFile(path.resolve(appRoot, "../../85_收藏夹/网页收藏/网页收藏目录.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, "public/ai-tools/icons/manifest.json"), "utf8"));
  const entries = [...catalog.tools, ...bookmarkCatalog.bookmarks];
  assert.equal(manifest.iconCount, entries.length);
  assert.deepEqual(new Set(manifest.entries.map((entry) => entry.id)), new Set(entries.map((tool) => tool.id)));
  for (const tool of entries) {
    const metadata = await sharp(path.join(appRoot, `public/ai-tools/icons/${tool.id}.png`)).metadata();
    assert.equal(metadata.width, 128, tool.id);
    assert.equal(metadata.height, 128, tool.id);
  }
});

test("工具与素材和网页收藏按内容性质拆分", async () => {
  const appRoot = path.resolve(import.meta.dirname, "..");
  const catalog = JSON.parse(await fs.readFile(path.resolve(appRoot, "../../85_收藏夹/AI工具库/AI工具目录.json"), "utf8"));
  const bookmarkCatalog = JSON.parse(await fs.readFile(path.resolve(appRoot, "../../85_收藏夹/网页收藏/网页收藏目录.json"), "utf8"));
  assert.equal(catalog.tools.length, 2);
  assert.equal(bookmarkCatalog.bookmarks.length, 2);
  assert.deepEqual(new Set(bookmarkCatalog.bookmarks.map((tool) => tool.category)), new Set(["interesting", "course"]));
  assert.ok(catalog.tools.every((tool) => String(tool.summary || "").includes("虚构") || String(tool.summary || "").includes("示例")));
});

test("网页收藏独立记录最近使用，不写入工具与素材记录", async () => {
  const root = await fixture();
  const snapshot = await readWebBookmarks(root, new Date("2026-09-01T00:00:00Z"));
  assert.equal(snapshot.tools.find((tool) => tool.id === "reading").status, "to-try");
  const used = await recordWebBookmarkUse(root, { id: "reading" }, new Date("2026-09-01T01:00:00Z"));
  assert.equal(used.tools.find((tool) => tool.id === "reading").status, "recently-used");
  assert.equal((await fs.stat(webBookmarkUsagePath(root))).mode & 0o777, 0o600);
  await assert.rejects(fs.access(aiToolUsagePath(root)));
});

test("使用记录一旦建立就永久保留，只在最近与以前之间切换", async () => {
  const root = await fixture();
  await recordAiToolUse(root, { id: "used", note: "实际用过" }, new Date("2026-08-01T00:00:00Z"));
  const recent = await readAiTools(root, new Date("2026-08-10T00:00:00Z"));
  const later = await readAiTools(root, new Date("2027-08-10T00:00:00Z"));
  assert.equal(recent.tools.find((tool) => tool.id === "used").status, "recently-used");
  assert.equal(later.tools.find((tool) => tool.id === "used").status, "used-before");
  assert.equal(later.tools.find((tool) => tool.id === "used").usage.everUsed, true);
  assert.equal((await fs.stat(aiToolUsagePath(root))).mode & 0o777, 0o600);
});

test("顶部横幅只读取已完成的真实季度报告", async () => {
  const root = await fixture();
  const reportDir = path.resolve(root, AI_TOOL_QUARTERLY_REPORT_DIR);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "2026-Q2.md"), "---\nreportStatus: placeholder\nperiod: 2026-Q2\n---\n\n## 本季要看\n\n- 占位符\n");
  assert.equal((await readAiTools(root)).quarterlyReport, null);
  await fs.writeFile(path.join(reportDir, "2026-Q3.md"), "---\nreportStatus: complete\nperiod: 2026-Q3\ntitle: 第三季度更新\nsummary: 有两件事需要看\ngeneratedAt: 2026-10-01T09:30:00+09:00\n---\n\n## 本季要看\n\n- Cursor 发布了重要版本\n- 某工具价格改变\n");
  const report = (await readAiTools(root)).quarterlyReport;
  assert.equal(report.period, "2026-Q3");
  assert.equal(report.highlights.length, 2);
});
