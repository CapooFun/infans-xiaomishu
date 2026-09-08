import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listMeetingMinutes, parseMeetingMinuteFile, readMeetingMinute } from "../src/server/workbench-meeting-minutes.mjs";
import { MEETING_MINUTES_DIR } from "../src/server/vault-paths.mjs";

const SAMPLE = `---
description: 一次正式讨论形成的已确认会议纪要
date: 2026-09-02
tags: [本地工作台, 会议纪要]
---

# 银月内容入口与协作记忆架构

## 核心结论

保留三种独立记录。

## 本次决议项

| 编号 | 决议 |
|---|---|
| YN-MIN-20260902-05 | 合并入口，不合并原件。 |
`;

test("会议纪要只从稳定文件名提取原件标题、简介和小节", () => {
  const minute = parseMeetingMinuteFile(SAMPLE, "2026-09-02_银月内容入口与协作记忆架构.md");
  assert.equal(minute.summary.id, "2026-09-02_银月内容入口与协作记忆架构");
  assert.equal(minute.summary.title, "银月内容入口与协作记忆架构");
  assert.equal(minute.summary.description, "一次正式讨论形成的已确认会议纪要");
  assert.deepEqual(minute.summary.headings, ["核心结论", "本次决议项"]);
  assert.match(minute.markdown, /YN-MIN-20260902-05/u);
  assert.equal(parseMeetingMinuteFile(SAMPLE, "README.md"), null);
});

test("会议纪要列表不返回全文，点开时按稳定 ID 读取同一原件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-meeting-minutes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, MEETING_MINUTES_DIR);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "2026-09-02_银月内容入口与协作记忆架构.md"), SAMPLE),
    fs.writeFile(path.join(directory, "README.md"), "不进入会议纪要列表"),
  ]);

  const list = await listMeetingMinutes(root);
  assert.equal(list.sourcePath, MEETING_MINUTES_DIR);
  assert.equal(list.minutes.length, 1);
  assert.equal("markdown" in list.minutes[0], false);

  const detail = await readMeetingMinute(root, list.minutes[0].id);
  assert.match(detail.markdown, /保留三种独立记录/u);
  await assert.rejects(() => readMeetingMinute(root, "../../AGENTS"), (error) => error.code === "MEETING_MINUTE_ID_INVALID");
});
