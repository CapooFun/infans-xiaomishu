import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildProjectRelationIndex,
  parseCentralTasks,
  parseProjectManagementDocument,
  parseProjectRegistry,
  parseTaskDate,
  parseTaskLine,
  readProjectManagement,
  replaceTaskPriority,
  isTaskInNearTerm,
  isAiOwnedTask,
  isAiExecutableTask,
  isUserAcceptanceTask,
  isUserBlockedTask,
  parseProjectFocusBattles,
  taskDisplayText,
} from "../src/server/workbench-project-management.mjs";

test("全项目关系索引从原件显式 ID 派生多对多范围和跨项目任务边", () => {
  const task = (id, projectId, extra = {}) => ({
    id,
    projectId,
    worklineIds: [],
    featureIds: [],
    dependencyIds: [],
    relatedTaskIds: [],
    parentId: null,
    ...extra,
  });
  const projects = [
    {
      projectId: "alpha",
      archived: false,
      management: {
        doing: [task("alpha-task", "alpha", { worklineIds: ["alpha.release"], dependencyIds: ["beta-task"] })],
        next: [],
        blocked: [],
        blockers: [{ id: "alpha-blocker", taskIds: ["alpha-task", "beta-task"], worklineIds: [], moduleIds: [], featureIds: [] }],
        recentCompleted: [{ id: "alpha-done", taskIds: ["alpha-task"], worklineIds: [], moduleIds: [], featureIds: ["alpha.feature"] }],
      },
    },
    {
      projectId: "beta",
      archived: false,
      management: {
        doing: [task("beta-task", "beta")],
        next: [],
        blocked: [],
        blockers: [],
        recentCompleted: [],
      },
    },
  ];
  const index = buildProjectRelationIndex(projects);
  assert.ok(index.edges.some((edge) => edge.type === "depends_on" && edge.source.id === "alpha-task" && edge.target.id === "beta-task" && edge.target.projectId === "beta"));
  assert.equal(index.edges.filter((edge) => edge.type === "blocks" && edge.source.id === "alpha-blocker").length, 2);
  assert.equal(index.edges.filter((edge) => edge.type === "recent_for" && edge.source.id === "alpha-done").length, 1);
  assert.ok(index.edges.some((edge) => edge.type === "scoped_to_feature" && edge.source.id === "alpha-done" && edge.target.id === "alpha.feature"));
  assert.ok(index.edges.some((edge) => edge.type === "scoped_to_project" && edge.source.id === "alpha-done" && edge.target.id === "alpha"));
  assert.deepEqual(index.issues, []);
});

const PROJECT_PATH = "30_事业顺利/示例卡牌游戏/项目进度与待办.md";

function registry(rows = [
  `| **示例卡牌游戏** | 打磨中 | [[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览|示例卡牌游戏_总览]] | nointerest | [[${PROJECT_PATH.slice(0, -3)}|项目进度与待办]] |`,
]) {
  return `# 事业顺利\n\n## 当前重点\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n${rows.join("\n")}\n\n## 归档\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n`;
}

function projectMarkdown(tasks = `- [ ] 游戏：细节：A：8/21 · 核对首轮反馈｜ID：nointerest-feedback｜功能：release-feedback\n- [ ] 补齐无日期任务｜ID：nointerest-undated\n- [x] 游戏：节点：S：12/31 · 保留完成前等级｜ID：nointerest-done`) {
  return `---\ndescription: test\ntags: [事业顺利, 项目管理]\n---\n# 示例卡牌游戏\n\n## 当前状态\n\n可玩纵切已完成，正在打磨首轮发行。\n\n## 正在做\n\n${tasks}\n\n## 下一步\n\n- [ ] 游戏：节点：C：12/30–1/5 做跨年复盘｜ID：nointerest-cross-year｜依赖：nointerest-feedback\n\n## 阻塞\n\n- 无\n\n## 最近完成\n\n- 2026-08-19 · 完成真实验收。\n\n## 权威入口\n\n- 项目总览：[[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览]]\n`;
}

async function fixture({ project = projectMarkdown(), todo } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-project-management-"));
  await fs.mkdir(path.join(root, "30_事业顺利/示例卡牌游戏"), { recursive: true });
  await fs.writeFile(path.join(root, "30_事业顺利/事业顺利_总览.md"), registry());
  if (project != null) await fs.writeFile(path.join(root, PROJECT_PATH), project);
  await fs.writeFile(path.join(root, "待办事项与长期规划.md"), todo ?? `# 待办\n\n## 最近两天\n\n- [ ] 治理：节点：S：8/20 · 今天已挑选｜ID：central-picked\n- [ ] 治理：节点：8/20 · 已到期但未挑选｜ID：central-ungraded\n\n## 长期在推\n\n- [ ] 游戏：节点：S：10/31 · 只进甘特｜ID：web-10-nointerest\n`);
  return root;
}

test("注册表保持前三列并读取项目 ID 与完整管理文件双链", () => {
  const parsed = parseProjectRegistry(registry());
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(parsed.projects[0], {
    projectId: "nointerest",
    name: "示例卡牌游戏",
    status: "打磨中",
    cardSummary: "",
    entryPath: "30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览.md",
    archived: false,
    migrated: true,
    managementPath: PROJECT_PATH,
    managementLabel: "项目进度与待办",
    experience: null,
  });
});

test("事业项目注册表可给项目卡提供一句人话简介", () => {
  const rows = [
    `| **示例卡牌游戏** | 打磨中 | [[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览|示例卡牌游戏_总览]] | nointerest | [[${PROJECT_PATH.slice(0, -3)}|项目进度与待办]] | 官网试玩：[打开](https://www.ifansstudio.com/games/no-interest/) | 官网已有公开 Alpha，新版还没有更新到正式站。 |`,
  ];
  const parsed = parseProjectRegistry(registry(rows));
  assert.equal(parsed.projects[0].cardSummary, "官网已有公开 Alpha，新版还没有更新到正式站。");
  assert.equal(parsed.projects[0].experience?.url, "https://www.ifansstudio.com/games/no-interest/");
});

test("事业项目卡读取官网试玩与本地启动入口", () => {
  const rows = [
    `| **示例卡牌游戏** | 打磨中 | [[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览|示例卡牌游戏_总览]] | nointerest | [[${PROJECT_PATH.slice(0, -3)}|项目进度与待办]] | 官网试玩：[打开](https://www.ifansstudio.com/games/no-interest/) |`,
    `| **修仙小队** | 本地 Demo | [[30_事业顺利/修仙小队/修仙小队_总览]] | cultivation-squad | [[30_事业顺利/修仙小队/项目进度与待办|项目进度与待办]] | 本地启动：\`cultivation-squad\` |`,
  ];
  const parsed = parseProjectRegistry(registry(rows));
  assert.deepEqual(parsed.projects[0].experience, {
    kind: "external",
    label: "官网试玩",
    url: "https://www.ifansstudio.com/games/no-interest/",
    launcherId: null,
  });
  assert.deepEqual(parsed.projects[1].experience, {
    kind: "launcher",
    label: "启动本地试玩",
    url: null,
    launcherId: "cultivation-squad",
  });
});

test("归档项目可保留项目 ID 并用破折号表示没有管理文件", () => {
  const archived = registry([]).replace(
    "## 归档\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n",
    "## 归档\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n| 历史项目 | 已结束 | [[历史项目_总览]] | history-project | — |\n",
  );
  const parsed = parseProjectRegistry(archived);
  assert.equal(parsed.projects.find((project) => project.projectId === "history-project")?.migrated, false);
  assert.equal(parsed.warnings.some((item) => item.code === "MANAGEMENT_LINK_INVALID"), false);
});

test("项目文件解析管理区、功能关联、等级、完成态和跨年日期", () => {
  const parsed = parseProjectManagementDocument(projectMarkdown(), {
    sourcePath: PROJECT_PATH,
    projectId: "nointerest",
    projectName: "示例卡牌游戏",
    todayKey: "2026-08-20",
  });
  assert.equal(parsed.currentStatus.includes("可玩纵切"), true);
  assert.equal(parsed.dashboardSummary, "可玩纵切已完成，正在打磨首轮发行。");
  assert.equal(parsed.doing.length, 3);
  assert.equal(parsed.doing[0].priority, "A");
  assert.equal(parsed.doing[0].sourcePath, PROJECT_PATH);
  assert.equal(parsed.doing[0].featureId, "release-feedback");
  assert.deepEqual(parsed.doing[0].featureIds, ["release-feedback"]);
  assert.equal(parsed.doing[1].date, null);
  assert.equal(parsed.doing[2].done, true);
  assert.equal(parsed.doing[2].completedAt, null);
  assert.equal(parsed.doing[2].priority, "S");
  assert.deepEqual(parsed.next[0].date, { start: "2026-12-30", end: "2027-01-05", label: "12/30–1/5" });
  assert.deepEqual(parsed.next[0].dependencyIds, ["nointerest-feedback"]);
  assert.deepEqual(parsed.blockers, []);
  assert.deepEqual(parsed.recentCompleted, [{ id: null, text: "2026-08-19 · 完成真实验收。", taskIds: [], worklineIds: [], moduleIds: [], featureIds: [] }]);
  assert.equal(parsed.authoritativeEntries[0].path.endsWith("示例卡牌游戏_总览.md"), true);
  assert.equal(parsed.warnings.length, 0);
});

test("持续起始日进入今明事项，截止日前缀不冒充开始日", () => {
  assert.deepEqual(parseTaskDate("治理：节点：S：2026-08-22 起 · 逐条审核全库事项", "2026-08-29"), {
    start: "2026-08-22",
    end: "9999-12-31",
    label: "2026-08-22 起",
  });
  assert.equal(isTaskInNearTerm({ date: parseTaskDate("2026-08-22 起 · 持续事项", "2026-08-29") }, "2026-08-29"), true);
  assert.equal(parseTaskDate("7/27 前 · 提交材料", "2026-08-29"), null);
  assert.equal(taskDisplayText("2026-08-22 起 · 逐条审核全库事项"), "逐条审核全库事项");
});

test("AI 定时任务标题去掉时间且不残留分钟", () => {
  assert.equal(
    taskDisplayText("8/28 · AI· 06:00 验证首次自然版本收口并留下真实结果｜ID：release｜执行器：daily-release"),
    "AI· 验证首次自然版本收口并留下真实结果",
  );
});

test("项目总看板只取当前状态首段并限制为 96 个字符", () => {
  const firstParagraph = "这是只该出现在总看板里的当前短结论。".repeat(8);
  const markdown = projectMarkdown().replace(
    "可玩纵切已完成，正在打磨首轮发行。",
    `${firstParagraph}\n\n第二段是详细进展，仍保留在项目原件和完整当前状态中。`,
  );
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  assert.equal(Array.from(parsed.dashboardSummary).length, 96);
  assert.equal(parsed.dashboardSummary.endsWith("…"), true);
  assert.equal(parsed.dashboardSummary.includes("第二段"), false);
  assert.equal(parsed.currentStatus.includes("第二段是详细进展"), true);
});

test("独立总看板摘要不会改短 Wiki 使用的完整当前状态", () => {
  const markdown = projectMarkdown().replace(
    "\n## 正在做",
    "\n## 总看板摘要\n\n只给总看板看的短句。\n\n## 正在做",
  );
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  assert.equal(parsed.dashboardSummary, "只给总看板看的短句。");
  assert.equal(parsed.currentStatus, "可玩纵切已完成，正在打磨首轮发行。");
});

test("项目任务的功能字段兼容单值并解析逗号分隔的多值", () => {
  const single = parseTaskLine("- [ ] 复查反馈｜ID：single｜功能：release-feedback", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest" });
  const multiple = parseTaskLine("- [ ] 复查指标｜ID：multiple｜功能：health-mind,health-life,health-mind", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "secretary" });
  assert.equal(single.featureId, "release-feedback");
  assert.deepEqual(single.featureIds, ["release-feedback"]);
  assert.equal(multiple.featureId, "health-mind");
  assert.deepEqual(multiple.featureIds, ["health-mind", "health-life"]);
});

test("限时大作战从项目唯一原件派生当前日、阶段关系和验收门", () => {
  const markdown = projectMarkdown(`- [ ] 8/30 · 完成最小闭环｜ID：battle-task-d1｜功能：assistant-cyber-life
- [ ] 8/31 · 接通项目事件｜ID：battle-task-d2｜功能：projects-relation-graph`).replace(
    "## 正在做",
    `## 限时大作战

### 变成有钱人七日大作战｜ID：battle-yinyue-birth-7d-20260830
- 状态：已启用
- 起止：2026-08-30—2026-09-05
- 总目标：一周内接通绝大多数养成能力。
- 最终完成门：完成正常使用综合验收。
- 风险：无
- 复盘：待复盘

| 节点 ID | 最晚验收 | 节点 | 今日重点 | 关联任务 | 关联功能 | 依赖 | 交付物 | 完成门 | 门状态 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|
| battle-yinyue-birth-7d-20260830-d1 | 2026-08-30 | 正式出生 | 最小闭环 | battle-task-d1 | assistant-cyber-life,assistant-watch-companion | — | 出生闭环 | 真实呼叫与回复 | 待验收 | — |
| battle-yinyue-birth-7d-20260830-d2 | 2026-08-31 | 项目事件 | 真实事件 | battle-task-d2 | projects-relation-graph | battle-yinyue-birth-7d-20260830-d1 | 事件闭环 | 同一事件只处理一次 | 待验收 | — |

## 正在做`,
  );
  const parsed = parseProjectManagementDocument(markdown, {
    sourcePath: PROJECT_PATH,
    projectId: "nointerest",
    projectName: "示例卡牌游戏",
    todayKey: "2026-08-30",
  });
  assert.equal(parsed.focusBattles.length, 1);
  assert.equal(parsed.focusBattles[0].phase, "active");
  assert.equal(parsed.focusBattles[0].currentDay, 1);
  assert.equal(parsed.focusBattles[0].todayStageId, "battle-yinyue-birth-7d-20260830-d1");
  assert.deepEqual(parsed.focusBattles[0].stages[1].dependencyIds, ["battle-yinyue-birth-7d-20260830-d1"]);
  assert.deepEqual(parsed.focusBattles[0].stages[0].featureIds, ["assistant-cyber-life", "assistant-watch-companion"]);
  assert.equal(parsed.warnings.some((item) => item.code.startsWith("FOCUS_")), false);
});

test("限时大作战到期后退出进行态，缺失真实任务会明确报警", () => {
  const section = {
    lines: [
      { line: "### 七日试验｜ID：battle-seven-days", lineNumber: 1 },
      { line: "- 状态：已启用", lineNumber: 2 },
      { line: "- 起止：2026-08-01—2026-08-07", lineNumber: 3 },
      { line: "| 节点 ID | 最晚验收 | 节点 | 关联任务 | 门状态 |", lineNumber: 4 },
      { line: "|---|---|---|---|---|", lineNumber: 5 },
      { line: "| battle-seven-days-d1 | 2026-08-01 | 首日 | missing-task | 待验收 |", lineNumber: 6 },
    ],
  };
  const parsed = parseProjectFocusBattles(section, {
    sourcePath: PROJECT_PATH,
    projectId: "nointerest",
    projectName: "示例卡牌游戏",
    todayKey: "2026-08-08",
    knownTaskIds: new Set(),
  });
  assert.equal(parsed.battles[0].phase, "expired");
  assert.equal(parsed.warnings.some((item) => item.code === "FOCUS_STAGE_TASK_MISSING" && item.taskId === "missing-task"), true);
});

test("AI 前缀和执行器都不能冒充自动资格，必须有有效显式契约", () => {
  const automatic = `自动推进：${JSON.stringify({ version: 1, mode: "automatic", authorization: ["vault:read", "task:writeback"], lifecycle: 1, selfScheduleReview: false, triggers: [{ id: "due", type: "time", at: "2026-08-21T09:00:00+09:00" }] })}`;
  const bound = parseTaskLine("- [ ] 8/21 · AI· 核对同步｜ID：ai-bound｜执行器：codex-ai-acceptance", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest", details: [automatic] });
  const legacyBound = parseTaskLine("- [ ] 8/21 · AI· 旧绑定｜ID：ai-legacy｜执行器：codex-ai-acceptance", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest" });
  const unbound = parseTaskLine("- [ ] 8/21 · AI· 只是待办｜ID：ai-unbound", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest" });
  assert.equal(bound.executorId, "codex-ai-acceptance");
  assert.equal(isAiExecutableTask(bound), true);
  assert.equal(isAiExecutableTask(legacyBound), false);
  assert.equal(isAiExecutableTask(unbound), false);
  assert.equal(unbound.automationMode, "manual");
  assert.equal(bound.displayText, "AI· 核对同步");
});

test("自动任务从同一原件区分未运行、已运行未通过与阻塞待确认", () => {
  const markdown = projectMarkdown(`- [ ] 8/21 · AI· 未运行票｜ID：ai-not-run｜执行器：codex-ai-acceptance
- [ ] 8/21 · AI· 失败票｜ID：ai-failed｜执行器：codex-ai-acceptance
  - 2026-08-21 自动验收结果：未通过。
  - 进展时间：2026-08-21 12:30
  - 当前状态：自动验收已运行，等待本人确认开关。
  - 下一步：本人确认后复验开关。
- [x] 8/21 · AI· 复验通过票｜ID：ai-passed｜执行器：codex-ai-acceptance｜完成时间：2026-08-21T12:00:00+09:00
  - 2026-08-20 自动验收结果：未通过。
  - 2026-08-21 自动复验通过：完成门满足。
- [ ] 8/21 · AI· 局部检查通过但总体失败｜ID：ai-mixed｜执行器：workbench-daily-release
  - 2026-08-21 06:00 自然运行：pnpm check 与构建通过；全量测试仍有 2 失败，因此未升版、未重启。
  - 进展时间：2026-08-21 06:12
  - 当前状态：本轮门禁未通过，版本保持不变。
  - 下一步：修复两项失败后于次日 06:00 复验。`).replace(
    "## 阻塞\n\n- 无",
    "## 阻塞\n\n- [ ] 公司：阻塞：A：8/21 · 待 Capoo 确认开关｜ID：ai-failed-blocker｜父级：ai-failed",
  );
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  assert.equal(parsed.doing.find((item) => item.id === "ai-not-run")?.aiExecutionStatus, "not-run");
  assert.equal(parsed.doing.find((item) => item.id === "ai-failed")?.aiExecutionStatus, "blocked");
  assert.equal(parsed.doing.find((item) => item.id === "ai-passed")?.aiExecutionStatus, "ran-passed");
  assert.equal(parsed.doing.find((item) => item.id === "ai-mixed")?.aiExecutionStatus, "ran-failed");
  assert.equal(parsed.doing.find((item) => item.id === "ai-mixed")?.aiProgressUpdatedAt, "2026-08-20T21:12:00.000Z");
  assert.equal(parsed.doing.find((item) => item.id === "ai-mixed")?.aiCurrentState, "本轮门禁未通过，版本保持不变。");
  assert.equal(parsed.doing.find((item) => item.id === "ai-mixed")?.aiNextAction, "修复两项失败后于次日 06:00 复验。");
  assert.deepEqual(parsed.doing.find((item) => item.id === "ai-failed")?.blockedByTaskIds, ["ai-failed-blocker"]);
  assert.equal(parsed.blocked[0]?.section, "blocked");
  assert.equal(parsed.warnings.some((item) => item.code === "AI_PROGRESS_INCOMPLETE"), false);
});

test("自动任务失败后缺少滚动进展会明确报警", () => {
  const automatic = `自动推进：${JSON.stringify({ version: 1, mode: "automatic", authorization: ["vault:read", "task:writeback"], lifecycle: 1, selfScheduleReview: false, triggers: [{ id: "due", type: "time", at: "2026-08-21T09:00:00+09:00" }] })}`;
  const parsed = parseProjectManagementDocument(projectMarkdown(`- [ ] 8/21 · AI· 失败但没计划｜ID：ai-stale-failure｜执行器：codex-ai-acceptance
  - ${automatic}
  - 2026-08-21 自动验收结果：未通过。`), { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  assert.equal(parsed.doing[0]?.aiExecutionStatus, "ran-failed");
  assert.equal(parsed.warnings.some((item) => item.code === "AI_PROGRESS_INCOMPLETE" && item.taskId === "ai-stale-failure"), true);
});

test("自动任务可显式登记新的复验时间", () => {
  const parsed = parseTaskLine("- [ ] 8/30 · AI· 复验｜ID：ai-review｜执行器：codex-ai-acceptance｜复验时间：2026-08-30 15:15", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest" });
  assert.equal(parsed.reviewAt, "2026-08-30T06:15:00.000Z");
});

test("AI 人工票不因缺执行器报警；显式自动票缺执行器才失败关闭", () => {
  const parsed = parseProjectManagementDocument(projectMarkdown("- [ ] 8/21 · AI· 只是待办｜ID：ai-unbound"), {
    sourcePath: PROJECT_PATH,
    projectId: "nointerest",
    projectName: "示例卡牌游戏",
  });
  assert.equal(parsed.warnings.some((item) => item.taskId === "ai-unbound"), false);
  const automatic = `自动推进：${JSON.stringify({ version: 1, mode: "automatic", authorization: ["vault:read", "task:writeback"], lifecycle: 1, selfScheduleReview: false, triggers: [{ id: "due", type: "time", at: "2026-08-21T09:00:00+09:00" }] })}`;
  const invalid = parseProjectManagementDocument(projectMarkdown(`- [ ] 8/21 · AI· 自动但没执行器｜ID：ai-auto-unbound
  - ${automatic}`), { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  assert.equal(invalid.warnings.some((item) => item.code === "AUTOMATION_EXECUTOR_MISSING" && item.taskId === "ai-auto-unbound"), true);
});

test("最近完成可关联一个或多个大模块，展示文字不带技术尾注", () => {
  const parsed = parseProjectManagementDocument(projectMarkdown().replace(
    "完成真实验收。",
    "完成真实验收。｜模块：release,tools",
  ));
  assert.deepEqual(parsed.recentCompleted, [{ id: null, text: "2026-08-19 · 完成真实验收。", taskIds: [], worklineIds: [], moduleIds: ["release", "tools"], featureIds: [] }]);
});

test("最近完成支持多功能显式关联，并可按相同稳定 ID 继承任务关联", () => {
  const markdown = projectMarkdown(`- [x] 公司：开发：交付投资复盘｜ID：investment-delivery｜功能：assets-investments,assets-overview`).replace(
    "- 2026-08-19 · 完成真实验收。",
    "- 2026-08-19 · 完成投资复盘。｜ID：investment-delivery｜模块：assets｜功能：assets-ledger,assets-investments",
  );
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "secretary", projectName: "小秘书" });
  assert.deepEqual(parsed.recentCompleted, [{
    id: "investment-delivery",
    text: "2026-08-19 · 完成投资复盘。",
    taskIds: [],
    worklineIds: [],
    moduleIds: ["assets"],
    featureIds: ["assets-ledger", "assets-investments", "assets-overview"],
  }]);
});

test("阻塞与最近完成通过任务 ID 建立多对多关联，且缩进证据不冒充独立记录", () => {
  const markdown = projectMarkdown(`- [ ] 开发：节点：处理任务甲｜ID：task-a｜功能：assistant-diary-mode
- [ ] 开发：节点：处理任务乙｜ID：task-b｜功能：assistant-chat`).replace(
    "- 无\n\n## 最近完成",
    `- [ ] 公司：阻塞：等待共同依赖｜ID：blocker-one｜关联任务：task-a,task-b
  - 这里只是阻塞证据，不是第二条阻塞。
- [ ] 公司：阻塞：等待本人确认｜ID：blocker-two｜关联任务：task-a
- [x] 公司：阻塞：已经关闭不再展示｜ID：blocker-closed｜关联任务：task-b

## 最近完成`,
  ).replace(
    "- 2026-08-19 · 完成真实验收。",
    `- 2026-08-19 · 完成共同底座。｜ID：recent-one｜关联任务：task-a,task-b
  - 这里只是完成证据，不是第二条最近完成。
- 2026-08-18 · 完成日记入口。｜ID：recent-two｜关联任务：task-a`,
  );
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "secretary", projectName: "小秘书" });

  assert.equal(parsed.blockers.length, 2);
  assert.deepEqual(parsed.blockers[0].taskIds, ["task-a", "task-b"]);
  assert.deepEqual(parsed.blockers[0].featureIds, ["assistant-diary-mode", "assistant-chat"]);
  assert.deepEqual(parsed.blockers[1].taskIds, ["task-a"]);
  assert.deepEqual(parsed.blockers[1].featureIds, ["assistant-diary-mode"]);
  assert.equal(parsed.blockers.some((item) => item.id === "blocker-closed"), false);
  assert.equal(parsed.recentCompleted.length, 2);
  assert.deepEqual(parsed.recentCompleted[0].taskIds, ["task-a", "task-b"]);
  assert.deepEqual(parsed.recentCompleted[0].featureIds, ["assistant-diary-mode", "assistant-chat"]);
  assert.deepEqual(parsed.recentCompleted[1].taskIds, ["task-a"]);
  assert.deepEqual(parsed.recentCompleted[1].featureIds, ["assistant-diary-mode"]);
});

test("权威入口允许不带双链的可读登记说明", () => {
  const markdown = projectMarkdown().replace(
    "- 项目总览：[[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览]]",
    "- 项目总览：[[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览]]\n- 工程入口：NoInterest 本机项目登记",
  );
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  assert.deepEqual(parsed.authoritativeEntries.at(-1), { label: "工程入口：NoInterest 本机项目登记", path: null });
  assert.equal(parsed.warnings.some((item) => item.code === "AUTHORITATIVE_LINK_INVALID"), false);
});

test("缺章节、空段、错误勾选格式、缺 ID 和异常双链只产生人话警告", () => {
  const markdown = `# 错误样例\n\n## 当前状态\n\n## 正在做\n\n- [ ] 没有 ID\n- [q] 格式错｜ID：bad-format\n\n## 下一步\n\n## 阻塞\n\n- 无\n\n## 权威入口\n\n- 坏链：[[没闭合\n`;
  const parsed = parseProjectManagementDocument(markdown, { sourcePath: PROJECT_PATH, projectId: "nointerest", projectName: "示例卡牌游戏" });
  const codes = new Set(parsed.warnings.map((item) => item.code));
  for (const code of ["PROJECT_SECTION_MISSING", "PROJECT_SECTION_EMPTY", "TASK_FORMAT_INVALID", "TASK_ID_MISSING", "WIKILINK_MALFORMED", "AUTHORITATIVE_LINK_INVALID"]) assert.equal(codes.has(code), true, code);
  assert.equal(parsed.doing.length, 1);
  assert.equal(parsed.doing[0].writable, false);
});

test("日期解析覆盖显式年、月末、无日期和非法日期", () => {
  assert.deepEqual(parseTaskDate("2027/1/15 · 决策", "2026-08-20"), { start: "2027-01-15", end: "2027-01-15", label: "2027/1/15" });
  assert.deepEqual(parseTaskDate("2027年2月末完成", "2026-08-20"), { start: "2027-02-28", end: "2027-02-28", label: "2027年2月末" });
  assert.equal(parseTaskDate("无日期任务", "2026-08-20"), null);
  assert.equal(parseTaskDate("2/30 · 不存在", "2026-08-20"), null);
});

test("今日事项收逾期与今明任务，普通待办缺省按 C，AI 承诺保持独立", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, PROJECT_PATH);
  const project = await fs.readFile(projectPath, "utf8");
  await fs.writeFile(projectPath, project.replace(
    "- [ ] 补齐无日期任务｜ID：nointerest-undated",
    "- [ ] 补齐无日期任务｜ID：nointerest-undated\n- [ ] 游戏：验收：8/21 · AI· 核对无人值守同步｜ID：nointerest-ai-sync｜执行器：codex-ai-acceptance",
  ));
  const result = await readProjectManagement(root, { todayKey: "2026-08-20" });
  assert.deepEqual(result.currentTodos.map((item) => item.id), ["central-picked", "central-ungraded", "nointerest-feedback", "nointerest-ai-sync"]);
  assert.equal(result.currentTodos.find((item) => item.id === "nointerest-ai-sync")?.priority, null);
  assert.equal(isAiOwnedTask(result.currentTodos.find((item) => item.id === "nointerest-ai-sync")), true);
  assert.equal(result.currentTodos.find((item) => item.id === "central-ungraded")?.priority, null);
  assert.equal(result.currentTodos.some((item) => item.id === "web-10-nointerest"), false);
  assert.equal(result.currentTodos.some((item) => item.id === "nointerest-undated"), false);
  assert.equal(result.currentTodos.some((item) => item.id === "nointerest-done"), false);
  assert.equal(result.currentTodos.some((item) => item.id === "nointerest-cross-year"), false);
  assert.equal(result.currentTodos.find((item) => item.id === "nointerest-feedback")?.projectName, "示例卡牌游戏");
});

test("有可信完成时刻的任务保留 24 小时供看板恢复", async (t) => {
  const project = projectMarkdown(`- [x] 游戏：细节：B：8/20 · 刚完成的事项｜ID：nointerest-recent｜完成时间：2026-08-20T01:00:00.000Z`);
  const root = await fixture({ project });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const visible = await readProjectManagement(root, { todayKey: "2026-08-20", now: new Date("2026-08-20T12:00:00.000Z") });
  assert.equal(visible.currentTodos.some((item) => item.id === "nointerest-recent" && item.done), true);
  const crossDay = await readProjectManagement(root, { todayKey: "2026-08-21", now: new Date("2026-08-21T00:00:00.000Z") });
  assert.equal(crossDay.currentTodos.some((item) => item.id === "nointerest-recent" && item.done), true);
  const expired = await readProjectManagement(root, { todayKey: "2026-08-21", now: new Date("2026-08-21T02:00:00.000Z") });
  assert.equal(expired.currentTodos.some((item) => item.id === "nointerest-recent"), false);
});

test("无日期和远期任务即使已设 SABC 也不提醒", async (t) => {
  const project = projectMarkdown(`- [ ] 游戏：细节：B：补齐无日期结果｜ID：nointerest-undated-picked\n- [ ] 游戏：验收：AI· 无日期跟进｜ID：nointerest-ai-undated｜执行器：codex-ai-acceptance\n- [ ] 游戏：验收：9/18 · AI· 远期跟进｜ID：nointerest-ai-future｜执行器：codex-ai-acceptance`);
  const root = await fixture({ project });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await readProjectManagement(root, { todayKey: "2026-08-20" });
  assert.equal(result.currentTodos.some((item) => item.id === "nointerest-undated-picked"), false);
  assert.equal(result.currentTodos.some((item) => item.id === "nointerest-ai-undated"), false);
  assert.equal(result.currentTodos.some((item) => item.id === "nointerest-ai-future"), false);
  assert.equal(isTaskInNearTerm({ date: { start: "2026-09-18", end: "2026-09-18" } }, "2026-08-20"), false);
});

test("所有逾期任务保留到完成，不再只保留 AI、本人验收与阻塞", async (t) => {
  const project = projectMarkdown(`- [ ] 游戏：验收：8/18 · AI· 复查自动链路｜ID：ai-overdue｜执行器：codex-ai-acceptance\n- [ ] 游戏：验收：A：8/18 · Capoo 确认手感｜ID：acceptance-overdue\n- [ ] 游戏：阻塞：S：8/18 · 待 Capoo 拍板唯一口径｜ID：blocked-overdue\n- [ ] 游戏：细节：A：8/18 · 普通逾期事项｜ID：ordinary-overdue`);
  const root = await fixture({ project });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await readProjectManagement(root, { todayKey: "2026-08-20" });
  assert.equal(result.currentTodos.some((item) => item.id === "ai-overdue"), true);
  assert.equal(result.currentTodos.some((item) => item.id === "acceptance-overdue"), true);
  assert.equal(result.currentTodos.some((item) => item.id === "blocked-overdue"), true);
  assert.equal(result.currentTodos.some((item) => item.id === "ordinary-overdue"), true);
  assert.equal(isUserAcceptanceTask(result.currentTodos.find((item) => item.id === "acceptance-overdue")), true);
  assert.equal(isUserBlockedTask(result.currentTodos.find((item) => item.id === "blocked-overdue")), true);
});

test("重复全局 ID 明确报警并只展示一次", async (t) => {
  const duplicateProject = projectMarkdown(`- [ ] 游戏：细节：A：8/20 · 项目里的重复｜ID：central-picked`);
  const root = await fixture({ project: duplicateProject });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await readProjectManagement(root, { todayKey: "2026-08-20" });
  assert.equal(result.currentTodos.filter((item) => item.id === "central-picked").length, 1);
  assert.equal(result.warnings.some((item) => item.code === "DUPLICATE_TASK_ID" && item.taskId === "central-picked"), true);
});

test("已归档项目即使保留管理文件也不进今日事项", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const overviewPath = path.join(root, "30_事业顺利/事业顺利_总览.md");
  const archivedRegistry = registry([]).replace(
    "## 归档\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n",
    `## 归档\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n| **示例卡牌游戏** | 已归档 | [[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览|示例卡牌游戏_总览]] | nointerest | [[${PROJECT_PATH.slice(0, -3)}|项目进度与待办]] |\n`,
  );
  await fs.writeFile(overviewPath, archivedRegistry);
  const result = await readProjectManagement(root);
  assert.equal(result.projects.find((project) => project.projectId === "nointerest")?.archived, true);
  assert.equal(result.projects.find((project) => project.projectId === "nointerest")?.management, null);
  assert.equal(result.currentTodos.some((task) => task.projectId === "nointerest"), false);
});

test("缺文件不让整张事业页失败", async (t) => {
  const root = await fixture({ project: null });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await readProjectManagement(root);
  assert.equal(result.projects.length, 1);
  assert.deepEqual(result.projects[0].management.doing, []);
  assert.equal(result.warnings.some((item) => item.code === "PROJECT_FILE_MISSING"), true);
});

test("技术尾注不会泄露到展示标题，底层仍兼容等级设置、切换与移除", () => {
  const text = "游戏：细节：A：8/22 · 验证发行｜ID：nointerest-release｜父级：web-10｜功能：release-page";
  assert.equal(taskDisplayText(text), "验证发行");
  assert.equal(replaceTaskPriority(text, "C").includes("细节：C：8/22"), true);
  assert.equal(replaceTaskPriority(text, null).includes("细节：8/22"), true);
  assert.equal(replaceTaskPriority("游戏：细节：8/22 · 验证｜ID：x", "S").includes("细节：S：8/22"), true);
  assert.equal(replaceTaskPriority("游戏：细节：无日期验证｜ID：y", "A"), "游戏：细节：A：无日期验证｜ID：y");
  assert.equal(replaceTaskPriority("补齐截图｜ID：z", "B"), "B：补齐截图｜ID：z");
  const completed = parseTaskLine("- [x] 游戏：细节：B：验证｜ID：x", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest" });
  assert.equal(completed.done, true);
  assert.equal(completed.priority, "B");
  const timestamped = parseTaskLine("- [x] 游戏：细节：B：验证｜ID：x｜完成时间：2026-08-22T01:02:03.000Z", { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "nointerest" });
  assert.equal(timestamped.completedAt, "2026-08-22T01:02:03.000Z");
  assert.equal(timestamped.displayText, "验证");
});

test("SABC 标题隐藏计划和状态尾注，进展时间不冒充排期", () => {
  const planned = parseTaskLine(
    "- [ ] 公司：验收：A：确认规则总览名称与左侧布局｜ID：workbench-document-governance-ui-acceptance-20260905｜功能：projects-document-governance｜父级：workbench-document-governance-map-20260904｜计划：2026-09-05",
    { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "secretary", todayKey: "2026-09-06" },
  );
  assert.equal(planned.displayText, "确认规则总览名称与左侧布局");
  assert.deepEqual(planned.date, { start: "2026-09-05", end: "2026-09-05", label: "2026-09-05" });

  const progressing = parseTaskLine(
    "- [ ] 公司：开发：素材库提示词与生成记录轻量闭环｜ID：tools-art-generation-lineage-20260904｜功能：tools-art-library｜状态：进行中｜进展时间：2026-09-06",
    { sourcePath: PROJECT_PATH, sourceKind: "project", projectId: "secretary", todayKey: "2026-09-06" },
  );
  assert.equal(progressing.displayText, "素材库提示词与生成记录轻量闭环");
  assert.equal(progressing.date, null);
  assert.equal(progressing.text.includes("状态：进行中｜进展时间：2026-09-06"), true);
});

test("中央旧标题可兼容，但长期在推不混入当前任务", () => {
  const parsed = parseCentralTasks(`# 待办\n\n## 今天 / 本周\n\n- [ ] A：无日期兼容\n\n## 长期在推\n\n- [ ] S：里程碑｜ID：milestone`);
  assert.equal(parsed.current.length, 1);
  assert.equal(parsed.current[0].priority, "A");
  assert.equal(parsed.current[0].idKind, "derived");
  assert.equal(parsed.longTerm[0].id, "milestone");
});

test("项目通过权威入口读取产品功能树，并把任务关联到功能", async (t) => {
  const productTreePath = "30_事业顺利/示例卡牌游戏/产品功能树.md";
  const project = projectMarkdown().replace(
    "- 项目总览：[[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览]]",
    `- 项目总览：[[30_事业顺利/示例卡牌游戏/示例卡牌游戏_总览]]\n- 产品功能树：[[${productTreePath.slice(0, -3)}]]`,
  );
  const root = await fixture({ project });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, productTreePath), `# 示例卡牌游戏 · 产品功能树\n\n## 发行｜ID：release\n\n> 对外发布与反馈。\n\n| 功能 | 状态 | 说明 | 当前进度 | 原件 | ID |\n|---|---|---|---|---|---|\n| 反馈回收 | 开发中 | 收集首轮反馈。 | 当前：等待反馈 | [[反馈记录]] | release-feedback |\n`);
  const result = await readProjectManagement(root, { todayKey: "2026-08-20" });
  const registered = result.projects[0];
  assert.equal(registered.featureTree.modules[0].features[0].id, "release-feedback");
  assert.equal(registered.management.doing[0].featureId, "release-feedback");
  assert.deepEqual(registered.management.doing[0].featureIds, ["release-feedback"]);
  assert.equal(result.warnings.some((item) => item.code === "FEATURE_TREE_FILE_MISSING"), false);
});
