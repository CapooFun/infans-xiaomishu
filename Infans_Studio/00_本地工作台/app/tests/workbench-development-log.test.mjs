import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDailyLogFile, readDevelopmentLog } from "../src/server/workbench-development-log.mjs";
import { DIARY_DIR } from "../src/server/vault-paths.mjs";

const DAY_16 = `---
description: 今日日志——完整的一天
date: 2026-08-16
tags: [日志]
---

# 2026-08-16

## 今日小结

普通段落和 **加粗内容** 都保留。

## 一、开发

- 完成一件事。
`;

const DAY_15 = `---
description: 昨日日志
date: 2026-08-15
tags: [日志]
---

# 2026-08-15

## 今日小结

昨天的全文。
`;

test("一份日记文件解析为一张卡片，并保留完整 Markdown", () => {
  const day = parseDailyLogFile(DAY_16, "2026-08-16.md");
  assert.equal(day.date, "2026-08-16");
  assert.equal(day.description, "今日日志——完整的一天");
  assert.deepEqual(day.headings, ["今日小结", "一、开发"]);
  assert.match(day.markdown, /^# 2026-08-16/);
  assert.match(day.markdown, /普通段落和 \*\*加粗内容\*\* 都保留。/);
  assert.equal(day.sourcePath, "10_日志记录/工作日志/2026-08-16.md");
  assert.equal(parseDailyLogFile(DAY_16, "更新日志.md"), null);
});

test("接口只读取日志目录中的日期文件，并按日期倒序", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-daily-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, DIARY_DIR);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "2026-08-15.md"), DAY_15),
    fs.writeFile(path.join(directory, "2026-08-16.md"), DAY_16),
    fs.writeFile(path.join(directory, "说明.md"), "不应读取"),
  ]);

  const snapshot = await readDevelopmentLog(root);
  assert.equal(snapshot.sourcePath, DIARY_DIR);
  assert.deepEqual(snapshot.days.map((day) => day.date), ["2026-08-16", "2026-08-15"]);
  assert.equal(snapshot.days[0].sourcePath, "10_日志记录/工作日志/2026-08-16.md");
  assert.match(snapshot.updatedAt, /^20\d{2}-/);
});
