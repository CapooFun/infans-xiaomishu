import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanTaskTitle, readCodexFeatureTasks } from "../src/server/workbench-codex-feature-tasks.mjs";

test("功能 Wiki 返回明确关联的 Codex 与 Cursor 窗口，Cursor 不伪造跳转", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-codex-feature-tasks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "00_本地工作台/派生数据");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "agent-observability-index.json"), JSON.stringify({
    updatedAt: "2026-09-02T00:00:00Z",
    tasks: {
      "01a05df5-4d68-7501-b3cf-50cfe9d032a2": {
        kind: "codex",
        title: "小秘书／朗读与任务跳转",
        reference: "D032A2",
        sourceUpdatedAt: "2026-09-02T01:00:00Z",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 100 }],
      },
      "cursor-conversation:11111111-2222-4333-8444-555555555555": {
        kind: "cursor",
        title: "工作上下文关联Cursor",
        reference: "555555",
        sourceUpdatedAt: "2026-09-07T01:00:00Z",
        featureMatches: [
          { id: "assistant-tts", projectId: "infans-ai-system", relevance: 50, basis: "verified" },
          { id: "projects-feature-tree", projectId: "infans-ai-system", relevance: 50, basis: "verified" },
        ],
      },
      "cursor-account:should-not-appear": {
        kind: "cursor",
        title: "账户汇总不是窗口",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 100, basis: "verified" }],
      },
      "01a05df5-4d68-7501-b3cf-50cfe9d032a4": {
        kind: "codex",
        title: "The following is the Codex agent history whose request action you are assessing",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 100 }],
      },
      "01a05df5-4d68-7501-b3cf-50cfe9d032a5": {
        kind: "codex",
        title: "只有很弱的语义猜测",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 12 }],
      },
      "01a05df5-4d68-7501-b3cf-50cfe9d032a6": {
        kind: "codex",
        title: "中文内部审批名也不能进入 Wiki",
        thread_source: "guardian_review",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 100 }],
      },
      "01a05df5-4d68-7501-b3cf-50cfe9d032a7": {
        kind: "codex",
        title: "已核实的跨功能任务",
        sourceUpdatedAt: "2026-09-02T02:00:00Z",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 50, basis: "verified" }],
      },
      "01a05df5-4d68-7501-b3cf-50cfe9d032a8": {
        kind: "codex",
        title: "第四项应被丢掉",
        sourceUpdatedAt: "2026-09-08T00:00:00Z",
        featureMatches: [{ id: "assistant-tts", projectId: "infans-ai-system", relevance: 40, basis: "verified" }],
      },
    },
  }));

  const result = await readCodexFeatureTasks(root, { projectId: "infans-ai-system", featureId: "assistant-tts" });
  assert.deepEqual(result.tasks.map((task) => task.title), [
    "小秘书／朗读与任务跳转",
    "工作上下文关联Cursor",
    "已核实的跨功能任务",
  ]);
  assert.equal(result.tasks[0].relevance, 100);
  assert.equal(result.tasks[1].agent, "Cursor");
  assert.equal(result.tasks[1].kind, "cursor");
  assert.equal(result.tasks[1].url, null);
  assert.equal(result.tasks[2].title, "已核实的跨功能任务");
  assert.equal(result.tasks[2].relevance, 50);
  assert.deepEqual(result.tasks[0], {
    id: "01a05df5-4d68-7501-b3cf-50cfe9d032a2",
    title: "小秘书／朗读与任务跳转",
    agent: "Codex",
    kind: "codex",
    reference: "D032A2",
    updatedAt: "2026-09-02T01:00:00.000Z",
    relevance: 100,
    url: "codex://threads/01a05df5-4d68-7501-b3cf-50cfe9d032a2",
  });

  const otherFeature = await readCodexFeatureTasks(root, { projectId: "infans-ai-system", featureId: "projects-feature-tree" });
  assert.deepEqual(otherFeature.tasks.map((task) => task.title), ["工作上下文关联Cursor"]);
});

test("异常长标题只取首行并截短，不把会话正文带进 Wiki", () => {
  const title = cleanTaskTitle(`正常窗口名\n>>> TRANSCRIPT START ${"机密正文".repeat(60)}`);
  assert.equal(title, "正常窗口名");
  assert.ok(cleanTaskTitle("很长".repeat(50)).length <= 72);
});
