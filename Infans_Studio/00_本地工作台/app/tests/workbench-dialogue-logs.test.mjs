import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDialogueLogDays, parseDialogueLogThread, readDialogueLogDay } from "../src/server/workbench-dialogue-logs.mjs";
import { PRIVATE_DIALOGUE_DIARY_DIR } from "../src/server/vault-paths.mjs";

const SAMPLE = `---
description: 一次完整的聊天
date: 2026-08-28
tags: [日志, 对话日志]
---

# 2026-08-28

## 给未来 AI 的阅读说明（不是日记正文）

这段说明不应冒充聊天消息。

## 第一部分：晚上的对话

### 对话片段 01

**Capoo：** 我今天挺开心。

**Codex AI：** 那就把开心好好留下来。

第二行仍属于同一条回答。

### 对话片段 02

**Capoo：** 嗯。
`;

test("对话日志只把带角色的原话转成左右消息，并保留部分分隔", () => {
  const items = parseDialogueLogThread(SAMPLE);
  assert.deepEqual(items.map((item) => item.kind), ["divider", "message", "message", "message"]);
  assert.equal(items[0].label, "第一部分：晚上的对话");
  assert.equal(items[1].role, "user");
  assert.equal(items[2].role, "assistant");
  assert.match(items[2].markdown, /第二行仍属于同一条回答/);
  assert.equal(items.some((item) => item.kind === "message" && item.markdown.includes("不应冒充")), false);
});

test("对话日志按天列卡片，点开时才返回当天完整消息", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-dialogue-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, PRIVATE_DIALOGUE_DIARY_DIR);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "2026-08-28.md"), SAMPLE);

  const list = await listDialogueLogDays(root);
  assert.equal(list.logs.length, 1);
  assert.equal(list.logs[0].date, "2026-08-28");
  assert.equal(list.logs[0].messageCount, 3);
  assert.equal(list.logs[0].userCount, 2);
  assert.equal("items" in list.logs[0], false);

  const detail = await readDialogueLogDay(root, "2026-08-28");
  assert.equal(detail.items.filter((item) => item.kind === "message").length, 3);
  await assert.rejects(() => readDialogueLogDay(root, "2026-08-29"), (error) => error.code === "DIALOGUE_LOG_NOT_FOUND");
});
