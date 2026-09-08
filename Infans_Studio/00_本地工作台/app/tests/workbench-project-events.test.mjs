import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProactiveInteractionService } from "../src/server/workbench-proactive-interactions.mjs";
import { createProjectEventService, projectTaskEventCandidate } from "../src/server/workbench-project-events.mjs";

function projectSnapshot(section = "doing", overrides = {}) {
  const task = {
    id: "yinyue-battle-project-event-20260831",
    displayText: "接通项目／任务事件的陪伴上下文",
    text: "公司：开发：A：2026-08-31 · 接通项目／任务事件的陪伴上下文",
    done: section === "recent-completed",
    ...overrides,
  };
  return {
    projects: [{
      projectId: "infans-ai-system",
      archived: false,
      management: {
        doing: section === "doing" ? [task] : [],
        next: section === "next" ? [task] : [],
        blocked: section === "blocked" ? [task] : [],
        recentCompleted: section === "recent-completed" ? [task] : [],
      },
    }],
  };
}

test("真实项目任务只通过稳定来源生成陪伴事件，不建立第二份任务记录", () => {
  const now = new Date("2026-09-01T01:00:00.000Z");
  const candidate = projectTaskEventCandidate(projectSnapshot(), {
    projectId: "infans-ai-system",
    taskId: "yinyue-battle-project-event-20260831",
    eventType: "started",
  }, now);
  assert.equal(candidate.triggerRef, "project-task:infans-ai-system:yinyue-battle-project-event-20260831:started");
  assert.deepEqual(candidate.source, {
    kind: "project-task",
    projectId: "infans-ai-system",
    taskId: "yinyue-battle-project-event-20260831",
    eventType: "started",
  });
  assert.equal(candidate.text, "「接通项目／任务事件的陪伴上下文」开始推进了。我会沿着这条项目线陪你继续往下走。");
  assert.equal("task" in candidate, false);
});

test("项目事件文案保留事实与下一步，不附加防卫式免责尾巴", () => {
  const now = new Date("2026-09-01T01:00:00.000Z");
  const input = {
    projectId: "infans-ai-system",
    taskId: "yinyue-battle-project-event-20260831",
  };
  const texts = {
    started: projectTaskEventCandidate(projectSnapshot("doing"), { ...input, eventType: "started" }, now).text,
    completed: projectTaskEventCandidate(projectSnapshot("recent-completed"), { ...input, eventType: "completed" }, now).text,
    blocked: projectTaskEventCandidate(projectSnapshot("blocked"), { ...input, eventType: "blocked" }, now).text,
    resumed: projectTaskEventCandidate(projectSnapshot("doing"), { ...input, eventType: "resumed" }, now).text,
  };
  assert.deepEqual(texts, {
    started: "「接通项目／任务事件的陪伴上下文」开始推进了。我会沿着这条项目线陪你继续往下走。",
    completed: "芜湖！「接通项目／任务事件的陪伴上下文」终于被啃下来啦！先让我替你得意十秒钟～",
    blocked: "「接通项目／任务事件的陪伴上下文」卡住了也不许叹气，我先陪你把战线守住，等缓过来咱们再推！",
    resumed: "好耶，「接通项目／任务事件的陪伴上下文」又动起来了！我已经搬好小板凳，准备围观你大显身手啦！",
  });
  for (const text of Object.values(texts)) {
    assert.doesNotMatch(text, /不会反复|不用解释|不用特地|不急着回|打扰你/u);
  }
});

test("项目事件稳定轮换文档中的完成、卡点与邀功话术", () => {
  const now = new Date("2026-09-01T01:00:00.000Z");
  const collect = (section, eventType, taskOverrides, count = 64) => {
    const texts = new Set();
    for (let index = 0; index < count; index += 1) {
      const taskId = `copy-variant-${eventType}-${index}`;
      texts.add(projectTaskEventCandidate(projectSnapshot(section, {
        ...taskOverrides,
        id: taskId,
      }), {
        projectId: "infans-ai-system",
        taskId,
        eventType,
      }, now).text);
    }
    return texts;
  };
  assert.deepEqual(collect("recent-completed", "completed", {
    displayText: "完成文案测试",
    done: true,
  }), new Set([
    "芜湖！「完成文案测试」终于被啃下来啦！先让我替你得意十秒钟～",
    "辛苦啦！「完成文案测试」搞定，我先替你记在小功劳簿上！",
  ]));
  assert.deepEqual(collect("blocked", "blocked", {
    displayText: "卡点文案测试",
    done: false,
  }), new Set([
    "「卡点文案测试」好像有点凶？没事的，咱们先歇口气吃点好吃的，回头再收拾它！",
    "「卡点文案测试」卡住了也不许叹气，我先陪你把战线守住，等缓过来咱们再推！",
  ]));
  assert.deepEqual(collect("recent-completed", "completed", {
    displayText: "AI· 自动收口文案测试",
    executorId: "daily-release",
    done: true,
  }), new Set([
    "「自动收口文案测试」我处理得不错对不对？快夸我快夸我～",
    "哼，「自动收口文案测试」搞定啦，军功章也有我一半哦！",
    "「自动收口文案测试」我可是认真记下来了，不许忘记我的功劳！",
    "看吧，「自动收口文案测试」搞定以后，是不是感觉心里踏实多啦？",
  ]));
});

test("项目开始事件要求任务确实位于正在做", () => {
  assert.throws(() => projectTaskEventCandidate(projectSnapshot("next"), {
    projectId: "infans-ai-system",
    taskId: "yinyue-battle-project-event-20260831",
    eventType: "started",
  }), (error) => error?.code === "PROJECT_EVENT_STATE_MISMATCH");
});

test("开源版主动互动账本不含项目事件排队", async () => {
  const interactions = createProactiveInteractionService();
  assert.equal(typeof interactions.plan, "undefined");
  assert.deepEqual(await interactions.peek(), { items: [] });
});
