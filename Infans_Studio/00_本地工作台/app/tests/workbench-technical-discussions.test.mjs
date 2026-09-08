import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listTechnicalDiscussions, parseTechnicalDiscussionFile, readTechnicalDiscussion } from "../src/server/workbench-technical-discussions.mjs";
import { TECHNICAL_DISCUSSIONS_DIR } from "../src/server/vault-paths.mjs";

const DISCUSSION = `---
description: 供比较和试验的讨论稿
date: 2026-09-05
tags: [收藏夹, 技术讨论, 讨论稿]
status: candidate
---

# 本地图片生成讨论

> 不替代权威原件。

## 方案比较

先做小规模试验。
`;

const READER_GUIDE = `---
description: 给第一次接触系统的人阅读
date: 2026-09-04
tags: [收藏夹, 技术讨论, 面向人说明]
---

# 系统导览
`;

const AUTHORITATIVE_DOCUMENT = `---
description: 现行项目架构
date: 2026-09-05
tags: [技术讨论, 产品架构]
---

# 现行项目架构
`;

test("技术讨论只收讨论稿或面向人说明，不自动收录权威文档", () => {
  const discussion = parseTechnicalDiscussionFile(DISCUSSION, "2026-09-05_本地图片生成讨论.md");
  const guide = parseTechnicalDiscussionFile(READER_GUIDE, "2026-09-04_系统导览.md");
  assert.equal(discussion.summary.id, "2026-09-05_本地图片生成讨论");
  assert.equal(discussion.summary.title, "本地图片生成讨论");
  assert.equal(discussion.summary.description, "供比较和试验的讨论稿");
  assert.equal(discussion.summary.date, "2026-09-05");
  assert.deepEqual(discussion.summary.headings, ["方案比较"]);
  assert.equal(guide.summary.title, "系统导览");
  assert.equal(parseTechnicalDiscussionFile(AUTHORITATIVE_DOCUMENT, "现行项目架构.md"), null);
  assert.equal(parseTechnicalDiscussionFile(DISCUSSION, "README.md"), null);
});

test("技术讨论列表不返回全文，详情按安全 ID 读取同一文档", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-technical-discussions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, TECHNICAL_DISCUSSIONS_DIR);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "2026-09-05_本地图片生成讨论.md"), DISCUSSION),
    fs.writeFile(path.join(directory, "2026-09-04_系统导览.md"), READER_GUIDE),
    fs.writeFile(path.join(directory, "现行项目架构.md"), AUTHORITATIVE_DOCUMENT),
  ]);

  const list = await listTechnicalDiscussions(root);
  assert.equal(list.sourcePath, TECHNICAL_DISCUSSIONS_DIR);
  assert.equal(list.discussions.length, 2);
  assert.equal("markdown" in list.discussions[0], false);

  const detail = await readTechnicalDiscussion(root, "2026-09-05_本地图片生成讨论");
  assert.match(detail.markdown, /先做小规模试验/u);
  await assert.rejects(() => readTechnicalDiscussion(root, "../../AGENTS"), (error) => error.code === "TECHNICAL_DISCUSSION_ID_INVALID");
});
