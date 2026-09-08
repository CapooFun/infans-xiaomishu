import assert from "node:assert/strict";
import test from "node:test";
import { remarkVaultWikiLinks, stripDisplayFrontmatter, vaultMarkdownUrlTransform } from "../src/markdown-display.mjs";

test("普通用户正文默认去掉 frontmatter，不改变后续 Markdown", () => {
  const source = `---\ndescription: 私人说明\ndate: 2026-08-21\ntags: [日志]\nsensitivity: S2\n---\n\n# 正文\n\n保留内容。`;
  assert.equal(stripDisplayFrontmatter(source), "\n# 正文\n\n保留内容。");
  assert.match(source, /sensitivity: S2/);
});

test("双链显示为可读标题和 Obsidian 后台入口", () => {
  const tree = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "查看 [[30_事业顺利/游戏开发/项目_总览|项目主页]] 和 [[训练日志#本周]]。" }] }],
  };
  remarkVaultWikiLinks({ sourcePath: "10_日志记录/工作日志/2026-08-21.md" })(tree);
  const children = tree.children[0].children;
  assert.deepEqual(children.filter((node) => node.type === "link").map((node) => node.children[0].value), ["项目主页", "训练日志 · 本周"]);
  assert.match(children[1].url, /^obsidian:\/\/open\?vault=Infans_Vault&file=/);
  assert.equal(decodeURIComponent(children[1].url.split("file=")[1]), "30_事业顺利/游戏开发/项目_总览");
});

test("同文件章节双链可打开当前原件，代码中的双链保持原样", () => {
  const tree = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "[[#今日小结]]" }] },
      { type: "inlineCode", value: "[[原样示例]]" },
    ],
  };
  remarkVaultWikiLinks({ sourcePath: "10_日志记录/工作日志/2026-08-21.md" })(tree);
  assert.equal(tree.children[0].children[0].children[0].value, "今日小结");
  assert.equal(decodeURIComponent(tree.children[0].children[0].url.split("file=")[1]), "10_日志记录/工作日志/2026-08-21");
  assert.equal(tree.children[1].value, "[[原样示例]]");
});

test("只放行工作台文档入口与 React Markdown 原有安全链接", () => {
  assert.match(vaultMarkdownUrlTransform("obsidian://open?vault=Infans_Vault&file=A"), /^obsidian:/);
  assert.equal(vaultMarkdownUrlTransform("infans-doc:abc"), "infans-doc:abc");
  assert.equal(vaultMarkdownUrlTransform("https://example.com"), "https://example.com");
  assert.equal(vaultMarkdownUrlTransform("javascript:alert(1)"), "");
});
