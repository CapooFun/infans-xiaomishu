import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMPLETED_TASK_BOARD_TTL_MS,
  isProjectTaskVisibleOnBoard,
  buildProjectCards,
  mergeProjectContextAssociations,
  mergeProjectRecentAssociations,
  moduleProgressSignal,
  nextTaskPriority,
  productTreeFromProjectHub,
  projectIdFromName,
  projectPortfolioRank,
  projectPortfolioTier,
  projectFeatureDestinations,
  projectRecentHasFeature,
  projectRecentModuleIds,
  projectHubAssociationMatchesWorkline,
  projectHubAssociationWorklineIds,
  projectTaskFeatureIds,
  projectTaskHasFeature,
  resolveProjectTaskFeatureDestination,
  projectWindowSwipeStep,
  projectWindowWheelStep,
  selectCurrentProjectStep,
} from "../src/project-workbench-model.ts";

test("单任务多功能关联按真实数组匹配且不复制任务", () => {
  const task = { featureId: "health-mind", featureIds: ["health-mind", "health-life"] };
  assert.deepEqual(projectTaskFeatureIds(task), ["health-mind", "health-life"]);
  assert.equal(projectTaskHasFeature(task, "health-mind"), true);
  assert.equal(projectTaskHasFeature(task, "health-life"), true);
  assert.equal(projectTaskHasFeature(task, "health-body"), false);
  assert.deepEqual([task].filter((item) => projectTaskHasFeature(item, "health-mind")), [task]);
  assert.deepEqual([task].filter((item) => projectTaskHasFeature(item, "health-life")), [task]);
});

test("多功能任务跳转按原件关联顺序定位第一个有效功能", () => {
  const tree = {
    modules: [{ id: "health", features: [{ id: "health-mind", points: [] }, { id: "health-life", points: [] }] }],
  };
  assert.deepEqual(resolveProjectTaskFeatureDestination(tree, {
    featureId: "missing",
    featureIds: ["missing", "health-life", "health-mind"],
  }), { moduleId: "health", featureId: "health-life" });
  assert.deepEqual(resolveProjectTaskFeatureDestination(tree, {
    featureId: "health-mind",
    featureIds: [],
  }), { moduleId: "health", featureId: "health-mind" });
});

test("最近完成按显式功能 ID 进入多个功能视图，模块公共关联仍只属于大模块", () => {
  const tree = {
    modules: [
      { id: "assets", features: [{ id: "assets-investments", points: [{ id: "assets-investments-chart", children: [] }] }, { id: "assets-ledger", points: [] }] },
      { id: "tools", features: [{ id: "tools-cron", points: [] }] },
    ],
  };
  const item = { featureIds: ["assets-investments-chart", "tools-cron"], moduleIds: ["assets"] };
  assert.deepEqual(projectFeatureDestinations(tree, item), [
    { moduleId: "assets", featureId: "assets-investments" },
    { moduleId: "tools", featureId: "tools-cron" },
  ]);
  assert.equal(projectRecentHasFeature(tree, item, "assets-investments"), true);
  assert.equal(projectRecentHasFeature(tree, item, "assets-ledger"), false);
  assert.equal(projectRecentHasFeature(tree, { featureIds: [], moduleIds: ["assets"] }, "assets-investments"), false);
  assert.deepEqual(projectRecentModuleIds(tree, item), ["assets", "tools"]);
  const unrelatedAsset = { featureIds: ["assets-ledger"], moduleIds: ["assets"] };
  assert.equal(projectRecentHasFeature(tree, unrelatedAsset, "assets-investments"), false);
  assert.deepEqual(projectRecentModuleIds(tree, unrelatedAsset), ["assets"]);
});

test("同一 recent ID 可合并任务继承与多条 Project Hub 功能关联", () => {
  const merged = mergeProjectRecentAssociations(
    { featureIds: ["direct-feature"], worklineIds: [], moduleIds: [] },
    ["task-feature", "direct-feature"],
    [
      { worklineId: "product", moduleId: "combat", featureId: "solo-trial" },
      { worklineId: "product", moduleId: "combat", featureId: "reward-choice" },
    ],
  );
  assert.deepEqual(merged, {
    featureIds: ["direct-feature", "task-feature", "solo-trial", "reward-choice"],
    worklineIds: ["product"],
    moduleIds: ["combat"],
  });
});

test("阻塞与最近完成可继承关联任务的工作线和多功能范围", () => {
  const merged = mergeProjectContextAssociations(
    { taskIds: ["task-a", "task-b"], worklineIds: ["direct"], moduleIds: [], featureIds: ["direct-feature"] },
    [
      { worklineIds: ["steam"], featureIds: ["store-page"] },
      { worklineIds: ["art"], featureIds: ["capsule", "store-page"] },
    ],
    [{ worklineId: "release", moduleId: "publishing", featureId: "review" }],
  );
  assert.deepEqual(merged, {
    taskIds: ["task-a", "task-b"],
    worklineIds: ["direct", "steam", "art", "release"],
    moduleIds: ["publishing"],
    featureIds: ["direct-feature", "store-page", "capsule", "review"],
  });
});

test("Project Hub 功能和模块关系可向上归属工作线", () => {
  const hub = {
    featureTrees: [{
      worklineId: "board.product",
      modules: [{
        id: "module.story",
        features: [{ id: "feature.new-game", children: [{ id: "feature.new-game.save", children: [] }] }],
      }],
    }],
  };
  assert.deepEqual(projectHubAssociationWorklineIds(hub, { featureIds: ["module.story"] }), ["board.product"]);
  assert.deepEqual(projectHubAssociationWorklineIds(hub, { featureIds: ["feature.new-game.save"], worklineIds: ["board.qa"] }), ["board.qa", "board.product"]);
  assert.equal(projectHubAssociationMatchesWorkline(hub, { moduleIds: ["module.story"] }, "board.product"), true);
  assert.equal(projectHubAssociationMatchesWorkline(hub, { featureIds: ["feature.other"] }, "board.product"), false);
});

test("事业看板的已完成任务最多保留 24 小时，旧任务不伪造完成时间", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  assert.equal(isProjectTaskVisibleOnBoard({ done: false, completedAt: null }, now), true, "未完成始终显示");
  assert.equal(isProjectTaskVisibleOnBoard({ done: true, completedAt: "2026-08-22T11:59:59.999Z" }, now), true, "刚完成显示");
  assert.equal(isProjectTaskVisibleOnBoard({ done: true, completedAt: new Date(now - COMPLETED_TASK_BOARD_TTL_MS).toISOString() }, now), false, "恰好 24 小时隐藏");
  assert.equal(isProjectTaskVisibleOnBoard({ done: true, completedAt: new Date(now - COMPLETED_TASK_BOARD_TTL_MS - 1).toISOString() }, now), false, "超过 24 小时隐藏");
  assert.equal(isProjectTaskVisibleOnBoard({ done: true, completedAt: null }, now), false, "旧任务缺少完成时间时直接隐藏");
});

test("任务列表保留刚完成任务，但统一排在未完成任务之后", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const listStart = projectsPage.indexOf("function ManagedTaskList");
  const listEnd = projectsPage.indexOf("function CurrentProjectStep", listStart);
  const listSource = projectsPage.slice(listStart, listEnd);
  assert.ok(listSource.includes("Number(left.task.done) - Number(right.task.done)"));
  assert.ok(listSource.includes("left.index - right.index"));
  assert.ok(listSource.includes("orderedTasks.map"));
});

test("事业看板与全局壳保持低输入，不再暴露长文本记录表单", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const overlays = readFileSync(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");

  assert.equal(projectsPage.includes("写入目标"), false);
  assert.equal(projectsPage.includes("AddProjectTask"), false);
  assert.equal(main.includes("快速记录"), false);
  assert.equal(main.includes("CaptureModal"), false);
  assert.equal(overlays.includes("capture-modal"), false);
  assert.equal(toolsPage.includes('kind: "capture"'), false);
});

test("项目长列表卡片设置最高高度并在框内纵向滚动", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.ok(projectsPage.includes('scrollable = false'));
  assert.ok((projectsPage.match(/scrollable>/gu) || []).length >= 2);
  assert.match(styles, /\.project-wb-block\.is-scrollable \{[^}]*max-height:min\(520px,65vh\);[^}]*overflow-y:auto;[^}]*overscroll-behavior:contain;/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.project-wb-block\.is-scrollable \{ max-height:min\(460px,62svh\); \}/u);
});

test("小秘书项目主页使用折叠大作战和左工作线右任务的统一母版", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const homeStart = projectsPage.indexOf("function ManagedProjectHome");
  const homeEnd = projectsPage.indexOf("function ExternalSourceNote", homeStart);
  const homeSource = projectsPage.slice(homeStart, homeEnd);

  const battleIndex = homeSource.indexOf("<ExpandableFocusBattle");
  const introIndex = homeSource.indexOf('className="project-hub-intro project-home-intro"');
  const lanesIndex = homeSource.indexOf("<ProjectHomeTaskLaneLayout");
  assert.ok(battleIndex >= 0 && battleIndex < introIndex);
  assert.ok(introIndex < lanesIndex);
  assert.ok(homeSource.includes('name: "功能 Wiki 图"'));
  assert.ok(homeSource.includes('countLabel: `${visibleModules.length} 模块 · ${visibleFeatureCount} 功能`'));
  assert.ok(homeSource.includes('meta: "进入功能 Wiki 图"'));
  assert.equal(homeSource.includes('className="project-hub-status is-stable">范围'), false);
  assert.equal(homeSource.includes("跨项目协作"), false);
  assert.equal(homeSource.includes("权威入口"), false);
  assert.equal(homeSource.includes("项目阻塞"), false);
  assert.match(styles, /\.project-hub-layout \{[^}]*grid-template-columns:minmax\(310px,\.72fr\) minmax\(0,1\.28fr\)/u);
  assert.match(styles, /\.project-hub-workline-grid \{[^}]*grid-template-columns:1fr/u);
});

test("系统设置只保留设置项，不再承载梅凝刷新入口", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");

  assert.equal(toolsPage.includes('className="settings-mode-switch"'), true);
  assert.equal(toolsPage.includes('className="settings-action-button"'), false);
  assert.equal(toolsPage.includes("刷新梅凝"), false);
  assert.equal(toolsPage.includes("检查更新并重新载入页面"), false);
  assert.equal(toolsPage.includes("onReload"), false);
  assert.equal(toolsPage.includes("开启后会发生什么"), false);
  assert.equal(toolsPage.includes("当前保护范围"), false);
  assert.equal(main.includes('!displayMode ? <button type="button" className="ai-button"'), false);
  assert.equal(main.includes("{ai ? <AiPanel"), true);
  assert.equal(main.includes("if (displayMode) return;\n    if (bootstrap)"), false);
  assert.equal(main.includes('className="display-mode-status"'), false);
});

test("iPad 连续触碰头像不会升级为整页缩放或边界回弹", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /html \{[^}]*overscroll-behavior-y: none;/u);
  assert.match(styles, /body \{[^}]*touch-action: manipulation;[^}]*overscroll-behavior-y: none;/u);
  assert.match(styles, /\.sidebar-pet-toggle \{[^}]*touch-action: none;/u);
});

test("网页首页头像按圆心定为 66.6px", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.brand > \.sidebar-pet-toggle \{[^}]*width:\s*66\.6px;[^}]*height:\s*66\.6px;[^}]*margin:\s*calc\(\(52px - 66\.6px\) \/ 2\);/u);
  assert.match(styles, /\.brand-pet \{[^}]*width:\s*66\.6px;[^}]*height:\s*66\.6px;[^}]*border-radius:\s*50%;/u);
  assert.match(styles, /\.brand-pet img \{[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;/u);
});

test("折叠模块递归提示最上层待推进分支，已暂停不进徽章", () => {
  assert.deepEqual(moduleProgressSignal([{
    status: "稳定",
    points: [{ status: "稳定", children: [{ status: "测试中" }] }],
  }]), { kind: "status", label: "测试中", count: 1 });

  assert.deepEqual(moduleProgressSignal([{
    status: "稳定",
    points: [
      { status: "稳定", children: [{ status: "测试中" }] },
      { status: "等待验收" },
      { children: [{ status: "准备开发" }] },
    ],
  }]), { kind: "count", label: "3", count: 3 });

  assert.deepEqual(moduleProgressSignal([{
    status: "开发中",
    points: [{ status: "测试中" }, { status: "等待验收" }],
  }]), { kind: "status", label: "开发中", count: 1 });

  assert.equal(moduleProgressSignal([{
    status: "稳定",
    points: [{ status: "稳定", children: [{ status: "稳定" }] }],
  }]), null);

  assert.equal(moduleProgressSignal([{
    status: "已暂停",
    points: [{ status: "测试中" }],
  }]), null);

  assert.deepEqual(moduleProgressSignal([{
    status: "稳定",
    points: [{ status: "已暂停" }, { status: "测试中" }],
  }]), { kind: "status", label: "测试中", count: 1 });

  assert.deepEqual(moduleProgressSignal([{
    status: "测试中",
  }, {
    status: "已暂停",
  }, {
    status: "等待验收",
  }]), { kind: "count", label: "2", count: 2 });
});

test("SABC selection sets and switches levels; clicking the current level is a no-op", () => {
  assert.equal(nextTaskPriority(null, "S"), "S");
  assert.equal(nextTaskPriority("S", "A"), "A");
  assert.equal(nextTaskPriority("A", "A"), "A");
});

test("当前第一步只跳过有效自动任务，AI 人工票仍进入本人派发顺序", () => {
  const task = (id, section, { done = false, displayText = id, automationMode = "manual", automationContractStatus = "none" } = {}) => ({ id, section, done, displayText, automationMode, automationContractStatus });
  const doing = [
    task("doing-done", "doing", { done: true }),
    task("doing-ai-bound", "doing", { displayText: "AI· 自动核对", automationMode: "automatic", automationContractStatus: "valid" }),
    task("doing-ai-unbound", "doing", { displayText: "AI· 等待执行器" }),
    task("doing-first", "doing"),
    task("doing-second", "doing"),
  ];
  const next = [task("next-ai", "next", { displayText: "AI· 自动复验", automationMode: "automatic", automationContractStatus: "valid" }), task("next-first", "next")];
  assert.deepEqual(selectCurrentProjectStep({ doing, next }), { task: doing[2], source: "doing" });
  assert.deepEqual(selectCurrentProjectStep({ doing: doing.slice(0, 2), next }), { task: next[1], source: "next" });
  assert.equal(selectCurrentProjectStep({ doing: doing.slice(0, 2), next: next.slice(0, 1) }), null);
});

test("项目四种主页都复用同一当前第一步，不建立第二套状态", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.equal(projectsPage.match(/<CurrentProjectStep/g)?.length, 4);
  assert.ok(projectsPage.includes("尚未指定当前第一步"));
  assert.equal(projectsPage.includes("SourceLink"), false);
  assert.equal(projectsPage.includes("setCurrentProjectStep"), false);
});

test("外部项目主页把当前第一步收进项目总看板右侧", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.match(projectsPage, /<section className="project-hub-intro">[\s\S]*?<CurrentProjectStep[\s\S]*?embedded[\s\S]*?<\/section>/u);
  assert.ok(projectsPage.includes('project-current-step${embedded ? " is-embedded" : ""}'));
});

test("小秘书项目主页展示当前第一步，功能 Wiki 不重复展示", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.ok(projectsPage.includes('stableProjectId !== "infans-ai-system"'));
  assert.ok(projectsPage.includes('className="project-workbench is-project-hub is-managed-project-home"'));
  assert.ok(projectsPage.includes("management.warnings.length"));
  assert.equal(projectsPage.match(/<CurrentProjectStep/g)?.length, 4);
});

test("所有事业功能 Wiki 默认折叠，并可在根标题旁一键全部展开或折叠", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(projectsPage.includes("const initial = new Set<string>()"));
  assert.equal(projectsPage.includes("else if (displayModules[0]) initial.add(displayModules[0].id)"), false);
  assert.ok(projectsPage.includes("allModulesExpanded"));
  assert.ok(projectsPage.includes("toggleAllModules"));
  assert.ok(projectsPage.includes("全部折叠${projectDisplayName}功能目录"));
  assert.ok(projectsPage.includes("全部展开${projectDisplayName}功能目录"));
  assert.ok(styles.includes(".project-feature-root-row"));
  assert.ok(styles.includes(".project-feature-root-toggle"));
});

test("Wiki 宽屏锁住框体高度，左右分栏各自滚动", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.match(styles, /@media \(min-width:901px\) \{[\s\S]*?\.page-stack > \.page\.is-active:has\(\.project-workbench\.is-feature-tree\) \{[^}]*overflow:hidden;/u);
  assert.match(styles, /@media \(min-width:901px\) \{[\s\S]*?\.project-feature-tree \{[^}]*overflow-y:auto;[^}]*overscroll-behavior:contain;/u);
  assert.match(styles, /@media \(min-width:901px\) \{[\s\S]*?\.project-feature-detail-body \{[^}]*overflow-y:auto;[^}]*overscroll-behavior:contain;/u);
  assert.match(projectsPage, /className="project-feature-detail-body"/u);
  assert.doesNotMatch(styles, /@media \(min-width:901px\) \{[\s\S]*?\.project-feature-detail-head \{[^}]*position:sticky;/u);
  assert.doesNotMatch(styles, /scroll-margin-top:7rem/u);
  assert.match(styles, /\.project-feature-intro \{[^}]*margin:-8px 0 0;[^}]*flex:0 0 auto;/u);
  assert.match(styles, /@media \(min-width:901px\) \{[\s\S]*?\.project-feature-detail-body \{[^}]*padding-top:8px;[^}]*overflow-y:auto;/u);
  assert.doesNotMatch(styles, /@media \(min-width:901px\) \{[\s\S]*?\.project-feature-intro \{[^}]*margin-top:0;/u);
  assert.match(styles, /@media \(max-width:900px\) \{[\s\S]*?\.project-feature-browser \{ max-height:48dvh;overflow:auto;/u);
});

test("限时大作战在事业页、项目主页和 Wiki 复用同一数据的三种密度", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(projectsPage.includes("PortfolioBattleRail"));
  assert.ok(projectsPage.includes("FocusBattleBoard"));
  assert.ok(projectsPage.includes("CompactFocusBattleStrip"));
  assert.ok(projectsPage.includes("visibleFocusBattles(project"));
  assert.ok(projectsPage.includes("由 Agent 维护项目资料"));
  assert.ok(projectsPage.includes("function ExpandableFocusBattle"));
  assert.ok(projectsPage.includes("const [expanded, setExpanded] = useState(false)"));
  assert.ok(projectsPage.includes('onOpen={() => setExpanded(true)}'));
  assert.ok(projectsPage.includes('onCollapse={() => setExpanded(false)}'));
  assert.equal(projectsPage.includes('<CompactFocusBattleStrip project={project} onOpen={onBack} />'), false);
  assert.ok(styles.includes(".portfolio-battle-rail"));
  assert.ok(styles.includes(".focus-battle-strip"));
  assert.equal(projectsPage.includes("新建大作战"), false);
  assert.equal(projectsPage.includes("删除大作战"), false);
});

test("事业页大作战只保留项目名、名称和百分比，并与游戏卡共用三列宽度", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const railStart = projectsPage.indexOf("function PortfolioBattleRail");
  const railEnd = projectsPage.indexOf("function ProductFeatureBoard", railStart);
  const railSource = projectsPage.slice(railStart, railEnd);
  assert.ok(railSource.includes("managedProjectDisplayName(project)"));
  assert.ok(railSource.includes("battle.name"));
  assert.ok(railSource.includes("progress.percent"));
  assert.equal(railSource.includes("FocusBattleMiniRoute"), false);
  assert.equal(railSource.includes("currentStage"), false);
  assert.match(styles, /\.portfolio-battle-row \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.portfolio-battle-card \{[^}]*min-height:72px/u);
});

test("首页项目窗只响应明确横向手势，纵向滚动和轻微移动不切换", () => {
  assert.equal(projectWindowSwipeStep(-64, 8), 1);
  assert.equal(projectWindowSwipeStep(64, 8), -1);
  assert.equal(projectWindowSwipeStep(32, 2), 0);
  assert.equal(projectWindowSwipeStep(64, 56), 0);
  assert.equal(projectWindowWheelStep(72, 3), 1);
  assert.equal(projectWindowWheelStep(-72, 3), -1);
  assert.equal(projectWindowWheelStep(12, 1), 0);
  assert.equal(projectWindowWheelStep(30, 40), 0);
});

test("projectIdFromName maps featured and ventures", () => {
  assert.equal(projectIdFromName("小秘书"), "demo-secretary");
  assert.equal(projectIdFromName("阳台种植计划"), "demo-balcony-garden");
  assert.equal(projectIdFromName("蛋仔日语"), "venture:%E8%9B%8B%E4%BB%94%E6%97%A5%E8%AF%AD");
});

test("事业页固定按示例项目分层", () => {
  const names = [
    "社区读书会",
    "手作小铺试营业",
    "阳台种植计划",
    "小秘书",
    "周末摄影集",
    "个人作品网站",
  ].sort((a, b) => projectPortfolioRank(a) - projectPortfolioRank(b));

  assert.deepEqual(names, ["小秘书", "阳台种植计划", "周末摄影集", "手作小铺试营业", "个人作品网站", "社区读书会"]);
  assert.equal(projectPortfolioTier("小秘书"), "primary");
  assert.equal(projectPortfolioTier("阳台种植计划"), "focus");
  assert.equal(projectPortfolioTier("周末摄影集"), "focus");
  assert.equal(projectPortfolioTier("手作小铺试营业"), "game");
  assert.equal(projectPortfolioTier("社区读书会"), "media");
});

test("事业页首排是小秘书与两个示例项目", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const homePage = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(projectsPage.includes('className="project-core-grid"'));
  assert.ok(projectsPage.includes('className="project-core-stack"'));
  assert.ok(homePage.includes('const HOME_PROJECT_NAMES = ["小秘书", "阳台种植计划", "周末摄影集"]'));
  assert.match(styles, /\.project-core-grid \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\);[^}]*gap:12px/u);
  assert.match(styles, /\.project-core-grid > \.project-deck-card\.is-featured \{ grid-column:1 \/ 3; \}/u);
  assert.match(styles, /\.project-core-stack \{[^}]*grid-column:3;/u);
  assert.equal(projectsPage.includes('id="project-tier-core">核心事业</span>'), false);
  assert.equal(projectsPage.includes('className="project-primary-grid"'), false);
  assert.equal(projectsPage.includes('className="project-focus-grid"'), false);
});

test("小秘书主卡在空白区汇总功能 Wiki 的全部状态", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(projectsPage.includes("FeatureTreeStatusSummary"));
  for (const status of ["稳定", "待开发", "设计中", "开发中", "测试中", "待验收", "已暂停"]) assert.ok(projectsPage.includes(status));
  assert.ok(projectsPage.includes("primaryProject?.featureTree"));
  assert.ok(styles.includes(".project-wiki-statuses"));
});

test("事业项目卡正文使用整卡宽度，小秘书 Wiki 保持轻量状态带且手机恢复单列", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(projectsPage.includes('className="project-deck-eyebrow"'));
  assert.ok(styles.includes("--project-deck-columns:minmax(0,1.08fr) minmax(320px,.92fr)"));
  assert.match(styles, /\.project-deck-head \{[^}]*grid-template-columns:minmax\(0,1fr\)/u);
  assert.match(styles, /\.project-deck-head p \{[^}]*max-width:none/u);
  assert.match(styles, /\.project-deck-eyebrow \.kicker \{[^}]*text-overflow:ellipsis;white-space:nowrap/u);
  assert.match(styles, /\.project-deck-summary \{[^}]*border-top:1px solid var\(--line\)/u);
  assert.match(styles, /\.project-cards \.project-deck-open \{[^}]*font-size:0/u);
  assert.match(styles, /\.project-deck-card\.is-featured \.project-columns\.is-deck \{[^}]*grid-template-columns:var\(--project-deck-columns\)/u);
  assert.match(styles, /\.project-wiki-statuses \{[^}]*grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/u);
  assert.equal(styles.includes(".project-deck-summary::after"), false);
  assert.doesNotMatch(styles, /\.project-deck-summary \{[^}]*border-left/u);
  assert.match(styles, /@media \(max-width:720px\)[\s\S]*?\.project-deck-card\.is-featured \.project-columns\.is-deck \{ grid-template-columns:1fr/u);
});

test("事业项目卡优先显示注册表里的人话简介", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.ok(projectsPage.includes("project.cardSummary || currentStatus"));
});

test("归档项目显示已归档，不再标为持续推进", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.ok(projectsPage.includes('const tierLabel = card.archived ? "已归档"'));
});

test("等待验收的正式功能在详情标题旁显示紧凑验收入口", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.ok(projectsPage.includes('className="project-feature-accept"'));
  assert.ok(projectsPage.includes('selectedFeature?.status === "等待验收"'));
  assert.ok(projectsPage.includes('kind: "acceptProductFeature"'));
});

test("完整产品项目把功能树放在第一行，其他工作线留在主页右侧展开", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const hubStart = projectsPage.indexOf("function ProjectHubHome");
  const hubEnd = projectsPage.indexOf("function ManagedProjectWorkbenchView", hubStart);
  const hubSource = projectsPage.slice(hubStart, hubEnd);
  assert.ok(projectsPage.includes('className="project-workbench is-project-hub"'));
  assert.ok(projectsPage.includes('backLabel="项目主页"'));
  assert.ok(hubSource.includes('Number(right.workline.view.kind === "featureTree")'));
  assert.ok(hubSource.includes('worklines.find((workline) => workline.view.kind !== "featureTree")'));
  assert.ok(hubSource.includes('if (workline.view.kind === "featureTree") onOpenFeatureTree'));
  assert.ok(hubSource.includes('else {\n                      setSelectedId(workline.id)'));
  assert.ok(hubSource.includes('!selected || projectHubAssociationMatchesWorkline'));
  assert.ok(hubSource.includes('selected ? "当前工作线" : "项目整体"'));
  assert.equal(hubSource.includes("项目阻塞"), false);
  assert.equal(hubSource.includes("权威边界"), false);
  assert.equal(hubSource.includes("薄契约，厚原件"), false);
  assert.match(projectsPage, /const openProjectRoot = \(projectId: string\) => \{[\s\S]*?workline: null[\s\S]*?setOpenId\(projectId\)/u);
  assert.ok(projectsPage.includes("项目目录内资料"));
  assert.equal(projectsPage.includes("externalProjectRoot"), false);
  assert.equal(projectsPage.includes("/api/project-hub?path="), false);
});

test("Project Hub 适配层保留末端 summary、状态与安全相对来源", () => {
  const tree = productTreeFromProjectHub({
    id: "gameplay",
    worklineId: "product",
    title: "玩法",
    description: "玩法树",
    source: null,
    warnings: [],
    modules: [{
      id: "combat",
      name: "战斗",
      status: "stable",
      description: "战斗模块",
      hiddenInDisplayMode: false,
      source: null,
      features: [{
        id: "timing",
        name: "行动时序",
        status: "stable",
        description: "时序机制",
        hiddenInDisplayMode: false,
        source: null,
        children: [{
          id: "precision",
          name: "精准攻击",
          status: "testing",
          description: "前后 0.1 秒触发，伤害乘 1.3。",
          hiddenInDisplayMode: false,
          source: { label: "战斗原件", path: "项目管理/战斗机制.md", externalProjectId: "quit-to-cultivate" },
          children: [],
        }],
      }],
    }],
  }, false);
  const point = tree.modules[0].features[0].points[0];
  assert.equal(point.summary, "前后 0.1 秒触发，伤害乘 1.3。");
  assert.equal(point.status, "测试中");
  assert.deepEqual(point.source, { label: "战斗原件", path: "项目管理/战斗机制.md", externalProjectId: "quit-to-cultivate" });
});

test("首页只负责导航和回顶，刷新由主题胶囊中央圆环单击触发", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const themeStyles = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.equal(main.includes("createBrandRefreshController"), false);
  assert.equal(main.includes("双击或双点刷新"), false);
  assert.equal(main.includes("refreshGestureProps"), false);
  assert.ok(main.includes('aria-label={`${SECRETARY_PRODUCT_BRAND}首页，当前${activeSecretary.name}值班`}'));
  assert.ok(main.includes("<strong>{activeSecretary.name}{SECRETARY_PRODUCT_BRAND}</strong>"));
  assert.ok(main.includes('window.scrollTo({ top: 0, left: 0, behavior: "smooth" })'));
  assert.ok(main.includes("captureCurrentWorkbenchPosition();"));
  assert.equal(main.includes("createDoubleActivationController"), false);
  assert.ok(main.includes('className="theme-reload-ring"'));
  assert.ok(main.includes('onClick={onReload}'));
  assert.ok(main.includes('title="刷新工作台"'));
  assert.ok(main.includes("refreshSection(section)"));
  assert.ok(main.includes("await waitForWorkbenchRefresh(tasks)"));
  assert.ok(main.includes('void loadCalendar({ force: true })'));
  assert.ok(main.includes("WORKBENCH_REFRESH_TIMEOUT_MS = 12_000"));
  assert.ok(main.includes("刷新超时，已停止等待"));
  assert.ok(main.includes("workbenchRefreshFeedbackText(activeSecretary.name)"));
  assert.ok(main.includes("setRouteRefreshRevisions((revisions) => ({"));
  assert.ok(main.includes("[contentPath]: (revisions[contentPath] ?? 0) + 1"));
  assert.ok(main.includes('fetch("/api/frontend-refresh"'));
  assert.ok(main.includes('method: "POST"'));
  assert.ok(main.includes("payload.rebuilt === true"));
  assert.ok(main.includes("frontendBuildNeedsHandoff({"));
  assert.ok(main.includes("serverBuildId: frontendRefresh.buildId"));
  assert.ok(main.includes("loadedBuildId: loadedFrontendBuildId(document)"));
  assert.ok(main.includes("window.location.replace(frontendHandoffUrl(window.location, frontendRefresh.buildId ?? Date.now()))"));
  assert.doesNotMatch(main, /window\.location\.reload/u);
  assert.ok(main.includes("toast.endsWith(WORKBENCH_REFRESH_FEEDBACK_SUFFIX) ? 2350 : 3800"));
  assert.ok(main.includes('toastRefresh ? " reload-feedback"'));
  assert.ok(main.includes('className="reload-feedback-portrait"'));
  assert.ok(main.includes("secretaryRefreshPortraitSrc(activeSecretary)"));
  assert.ok(main.includes('className="reload-feedback-copy"'));
  assert.equal(toolsPage.includes('className="settings-action-button"'), false);
  assert.match(themeStyles, /\.theme-reload-ring \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u);
  const reloadRingVisual = themeStyles.slice(themeStyles.indexOf(".theme-reload-ring::before"), themeStyles.indexOf(".theme-reload-ring svg"));
  assert.equal(reloadRingVisual.includes("var(--gold)"), false);
  assert.equal(reloadRingVisual.includes("var(--teal)"), false);
  assert.ok(main.includes('className={`toast${toastRefresh ? " reload-feedback"'));
  assert.match(styles, /\.reload-feedback-copy \{[\s\S]*?"FZKai-Z03","Kaiti SC","STKaiti","KaiTi"/u);
  assert.ok(main.includes('"隐藏主侧边栏"'));
  assert.ok(main.includes('"显示主侧边栏"'));
  assert.ok(main.includes('window.localStorage.setItem("infans-sidebar-hidden-v1"'));
  assert.equal(main.includes("createSidebarPetDragController"), false);
  assert.ok(main.includes("createSidebarVisibilityGate"));
  assert.ok(main.includes('sidebarHidden ? "显示主侧边栏" : "隐藏主侧边栏"'));
  assert.equal(main.includes("sidebar-pet-toggle-collapsed"), false);
  assert.match(styles, /@media \(min-width: 901px\) \{\s*\.app-shell\.sidebar-hidden > \.sidebar \{ visibility: hidden;/);
  assert.equal(main.includes("onDoubleClick"), false);
});

test("首页重要提醒只读取脱敏支付风险并直达授权单", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(main.includes("data?.paymentGuard"));
  assert.ok(main.includes("paymentGuard?.count"));
  assert.ok(main.includes("重要提醒"));
  assert.ok(main.includes("paymentGuard.summary"));
  assert.ok(main.includes("softNavigate(event, paymentGuard.href)"));
  assert.equal(main.includes("paymentGuard.balance"), false);
  assert.equal(main.includes("paymentGuard.amount"), false);
  assert.ok(styles.includes(".home-important-alert"));
  assert.ok(styles.includes(".home-important-alert.is-critical"));
  assert.ok(styles.includes(".topbar-status.is-alert"));
  assert.ok(styles.includes(".topbar-weather-chip"));
  assert.ok(main.includes("is-alert is-"));
  assert.ok(main.includes("topbar-weather-chip"));
  assert.equal(main.includes("writeWeatherAlertDismiss"), false);
  assert.equal(main.includes("topbar-weather-alert"), false);
  assert.ok(main.includes("href={alert.href}"));
  assert.ok(main.includes("home-intro-greeting"));
  assert.ok(main.includes("home-intro-address"));
  assert.ok(styles.includes(".top-actions .reading-size-control"));
  assert.ok(styles.includes(".home-intro-comma"));
  assert.match(styles, /\.home-intro \{[^}]*flex-direction:row;[^}]*justify-content:flex-start;/, "桌面与 iPad 的首页问候应从顶栏左侧起排，不能在剩余栏位中居中漂移");
  assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]*?\.home-intro \{ justify-content: flex-start; align-items: flex-start; \}/);
  const pagePadding = styles.indexOf(".page { padding: clamp(20px, 3vw, 44px)");
  const ipadSafe = styles.indexOf("padding-bottom:calc(60px + env(safe-area-inset-bottom, 0px));", pagePadding);
  assert.ok(pagePadding >= 0 && ipadSafe > pagePadding, "iPad 底边安全区必须写在通用 page padding 之后，才不会被简写盖掉");
  assert.match(styles.slice(pagePadding), /\.page \{ padding-top:14px; padding-bottom:calc\(60px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
});

test("首页重点项目窗只手动切换并移除每日一句，iPad 与 Mac 只在宽度上分流", () => {
  const home = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const projectWindowStart = home.indexOf("function HomeProjectWindow");
  const nextWindow = home.indexOf("\nfunction ", projectWindowStart + "function HomeProjectWindow".length);
  const projectWindow = home.slice(
    projectWindowStart,
    nextWindow >= 0 ? nextWindow : home.indexOf("export default function HomePage"),
  );

  for (const name of ["阳台种植计划", "周末摄影集"]) assert.ok(home.includes(name));
  assert.equal(projectWindow.includes("secretaryName"), false);
  assert.ok(home.includes('const HOME_PROJECT_NAMES = ["小秘书", "阳台种植计划", "周末摄影集"]'));
  assert.equal(projectWindow.includes("setInterval"), false);
  assert.equal(projectWindow.includes("home-project-controls"), false);
  assert.equal(projectWindow.includes("activeIndex + 1} / {projects.length"), false);
  assert.ok(projectWindow.includes(".slice(0, 3)"));
  assert.ok(projectWindow.includes('event.key !== "ArrowLeft" && event.key !== "ArrowRight"'));
  assert.ok(projectWindow.includes("projectWindowSwipeStep(dx, dy)"));
  assert.equal(home.includes("每日一句"), false);
  assert.equal(home.includes("jp-daily"), false);
  assert.equal(home.includes('pinnedTopics.length || "—"'), false);
  assert.match(styles, /\.jp-source-ledger \{[^}]*?flex:1;[^}]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);

  assert.match(styles, /\.skip-link \{[\s\S]*?clip-path: inset\(50%\)/);
  assert.match(styles, /html\[data-keyboard-navigation="true"\] \.skip-link:focus-visible \{[\s\S]*?clip-path: none/);
  assert.doesNotMatch(styles, /\.skip-link:focus,/);
  assert.ok(main.includes('event.key === "Tab"'));
  assert.ok(main.includes('root.dataset.keyboardNavigation = "true"'));
  assert.ok(main.includes('delete root.dataset.keyboardNavigation'));
  const wideIPadLayoutStart = styles.indexOf("@media (min-width:901px) and (max-width:1366px) and (any-pointer:coarse)");
  const wideIPadLayoutEnd = styles.indexOf("/* 横屏摘要使用紧凑留白", wideIPadLayoutStart);
  const wideIPadLayout = styles.slice(wideIPadLayoutStart, wideIPadLayoutEnd);
  assert.ok(wideIPadLayoutStart >= 0 && wideIPadLayoutEnd > wideIPadLayoutStart);
  assert.match(wideIPadLayout, /\.home-signal-grid \{ grid-template-columns:1\.05fr 1\.1fr \.85fr;gap:8px; \}/);
  assert.match(wideIPadLayout, /\.home-finance-grid \{ grid-template-columns:2fr 1fr 1fr;gap:8px; \}/);
  assert.match(styles, /@media \(min-width:700px\) and \(max-width:900px\) and \(any-pointer:coarse\) \{[\s\S]*?\.home-signal-grid \{ grid-template-columns:1\.05fr 1\.1fr \.85fr;gap:8px; \}[\s\S]*?\.home-finance-grid \{ grid-template-columns:2fr 1fr 1fr;gap:8px; \}/);
  assert.match(styles, /\.home-dashboard \{[\s\S]*?width:min\(1020px,calc\(100% - clamp\(150px,18vw,280px\)\)\)/);
  assert.match(styles, /\.home-pending \{[^}]*?min-height:0;[^}]*?overflow:hidden;/);
  assert.match(styles, /@media \(max-width:1260px\) \{[\s\S]*?\.home-project-window \.home-pending p:nth-of-type\(n\+3\) \{ display:none; \}/);
});

test("首页金融区保持 2:1:1，美股／A股双页复用项目窗手势且整卡站内跳转", () => {
  const home = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const stockWindow = home.slice(home.indexOf("function HomeStockWindow"), home.indexOf("export default function HomePage"));

  assert.ok(stockWindow.includes('title: "美股看板"'));
  assert.ok(stockWindow.includes('title: "A股看板"'));
  assert.ok(stockWindow.includes('eyebrow="股市行情"'));
  assert.ok(stockWindow.includes('className="live-quote-currency"'));
  assert.ok(stockWindow.includes('className="live-quote-amount"'));
  assert.ok(stockWindow.includes("projectWindowSwipeStep(dx, dy)"));
  assert.ok(stockWindow.includes("projectWindowWheelStep(event.deltaX, event.deltaY)"));
  assert.ok(stockWindow.includes('event.key !== "ArrowLeft" && event.key !== "ArrowRight"'));
  assert.ok(stockWindow.includes('className="card-stretch-link"'));
  assert.ok(stockWindow.includes('href="/markets/assets"'));
  assert.ok(stockWindow.includes('softNavigate(event, "/markets/assets")'));
  assert.ok(home.includes("STOCK_BROADCAST_MIN_MS = 20_000"));
  assert.equal(home.includes("热力图"), false);
  assert.ok(home.includes('eyebrow={pageIsFinance ? "市场简报" : "世界资讯"}'));
  assert.ok(home.includes('title={pageIsFinance ? "金融资讯" : page.label}'));
  assert.ok(home.includes("data-lane={page.id}"));
  assert.ok(home.includes("WORLD_BROADCAST_MIN_MS = 15_000"));
  assert.ok(home.includes("BROADCAST_TEXT_DELAY_MS = 3_000"));
  assert.ok(home.includes("HomeBroadcastControls"));
  assert.equal(home.includes("home-broadcast-toggle"), false);
  assert.equal(home.includes("暂停自动轮播"), false);
  assert.ok(home.includes('aria-roledescription="轮播"'));
  assert.ok(home.includes("onFocusCapture={broadcast.onFocusCapture}"));
  assert.ok(home.includes("onBlurCapture={broadcast.onBlurCapture}"));
  assert.ok(home.includes('className="home-broadcast-pages"'));
  assert.ok(home.includes('data-broadcast-active={pageIsActive ? "true" : undefined}'));
  assert.ok(home.includes("copy.scrollWidth + BROADCAST_TEXT_GAP_PX"));
  assert.ok(home.includes("iterations: Infinity"));
  assert.equal(home.includes("(hold + travel) * 2"), false);
  assert.match(styles, /@keyframes home-broadcast-reveal \{ from \{ opacity:\.35; \} to \{ opacity:1; \} \}/);
  assert.match(styles, /\.home-broadcast-pages \{[^}]*flex:1;[^}]*display:grid/);
  assert.match(styles, /\.home-broadcast-pages > \* \{ grid-area:1\/1; \}/);
  assert.match(styles, /\.home-world-copy:not\(\.is-active\),\.home-stock-copy:not\(\.is-active\) \{ visibility:hidden;animation:none; \}/);
  assert.match(styles, /\.home-scrolling-track \{[^}]*display:inline-flex[^}]*gap:32px/);
  assert.match(styles, /\.home-broadcast-controls \{[^}]*order:3[^}]*pointer-events:auto/);
  assert.match(styles, /\.live-quotes \{[^}]*grid-template-columns:minmax\(42px,1fr\) auto minmax\(0,auto\) auto/);
  assert.match(styles, /\.live-quotes > div \{[^}]*grid-template-columns:subgrid/);
  assert.match(styles, /\.live-quotes \.live-quote-currency \{[^}]*font:var\(--text-micro\) var\(--font-data\)/);
  assert.match(styles, /\.live-quotes \.up small \{ color:var\(--chart-green\); \}/);
  assert.match(styles, /\.live-quotes \.down small \{ color:var\(--red\); \}/);
  assert.ok(home.includes("<FxSparkline label={row.label} points={row.trend ?? []} />"));
  assert.ok(home.includes("className=\"fx-rate-row\""));
  assert.ok(home.includes("function smoothSparkPath"));
  assert.match(styles, /\.fx-rate-row \{[^}]*grid-template-columns:minmax\(0,1fr\) 88px/);
  assert.match(styles, /\.fx-rate-row strong \{[^}]*font:400 var\(--text-body\)\/1\.15 var\(--font-data\)/);
  assert.match(styles, /\.market-pulse > \.home-card-heading \{ margin-bottom:10px; \}/);
  assert.match(styles, /\.home-world-copy \.market-top-events li/);
  assert.doesNotMatch(styles, /\.home-world-copy \.market-top-events \{[^}]*margin-top:\s*auto/);
  assert.doesNotMatch(styles, /\.home-world-copy \{[^}]*min-height:\s*148px/);
  assert.match(styles, /@media \(max-width:1260px\) \{[\s\S]*?\.home-finance-grid \{ grid-template-columns:1fr 1fr; \}/);
  assert.match(styles, /@media \(max-width:900px\) \{[\s\S]*?\.home-priority-grid,\.home-finance-grid,\.agenda-todo-split \{ grid-template-columns:1fr; \}/);
});

test("日本阅读默认折成今日 N 级横条，新闻放在阅读下面", () => {
  const world = readFileSync(new URL("../src/pages/world-news-lanes.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const readingsAt = world.indexOf("section className=\"world-readings\"");
  const eventsAt = world.lastIndexOf("section className=\"market-events\"");
  assert.ok(world.includes("今日 {reading.level} 阅读"));
  assert.ok(world.includes("world-reading-fold"));
  assert.ok(world.includes("event.category || \"大事\""));
  assert.ok(readingsAt > 0 && eventsAt > readingsAt);
  assert.match(styles, /\.world-reading-fold > summary \{/);
});

test("手机底栏以七个图标容纳高频入口，并将 iPhone Mac 视图放在身份档案右侧", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const refinements = readFileSync(new URL("../src/workbench-refinements.css", import.meta.url), "utf8");
  const primaryItems = main.slice(main.indexOf("const PRIMARY_NAV_PATHS"), main.indexOf("const PAGE_META"));
  const moreSheet = main.slice(main.indexOf('{moreOpen ? <motion.div key="more-sheet"'), main.indexOf("{identity && data"));

  for (const path of ["/", "/schedule", "/projects", "/health", "/markets", "/languages"]) assert.ok(primaryItems.includes(`"${path}"`));
  assert.ok(main.indexOf('label: "世界资讯"') < main.indexOf('label: "语言学习"'));
  assert.ok(main.includes('{ path: "/markets", label: "世界资讯", icon: Newspaper'));
  assert.match(main, /aria-label=\{item\.label\} title=\{item\.label\}/);
  assert.match(main, /aria-label="更多" title="更多"/);
  assert.match(refinements, /sidebar-nav-mobile\{grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(refinements, /sidebar-nav-mobile a span,[^}]*button\.nav-more span\{display:none\}/);
  for (const label of ["专题研究", "艺术馆藏", "资产管理", "实用工具"]) assert.ok(main.includes(label));
  assert.equal(main.includes("theme-switch-mobile"), true);
  assert.ok(moreSheet.includes("身份档案"));
  assert.ok(moreSheet.includes('className="more-sheet-mac-view"'));
  assert.ok(moreSheet.indexOf("身份档案") < moreSheet.indexOf('className="more-sheet-mac-view"'));
  assert.ok(moreSheet.includes("<ThemeSwitch"));
  assert.ok(moreSheet.includes("refreshing={refreshing}"));
  assert.match(moreSheet, /refreshCurrentPage\(\)\.then\(\(ok\) => \{ if \(shouldCloseMoreSheetAfterRefresh\(ok\)\) setMoreOpen\(false\); \}\)/);
  assert.doesNotMatch(moreSheet, /onReload=\{\(\) => \{ setMoreOpen\(false\); void refreshCurrentPage/);
  assert.ok(main.includes("onReload={() => { void refreshCurrentPage(); }}"));
  const refreshFn = main.slice(main.indexOf("const refreshCurrentPage = async"), main.indexOf("useEffect(() => { void preloadRoute(path"));
  assert.match(refreshFn, /await waitForWorkbenchRefresh\(tasks\);\s*setToast\(workbenchRefreshFeedbackText\(activeSecretary\.name\)\);\s*return true;/);
  assert.match(refreshFn, /catch \(reason\) \{[\s\S]*return false;/);
  assert.doesNotMatch(refreshFn, /catch \(reason\) \{[\s\S]*setMoreOpen/);
  assert.equal(moreSheet.includes("switchTheme(nextTheme)"), false);
  assert.match(styles, /\.more-sheet-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.more-sheet-grid a:last-child:nth-child\(3n \+ 1\) \{ grid-column: 2; \}/);
  assert.match(styles, /\.more-sheet-actions\.has-mac-view \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("教练项目外层卡并列提供控制端与用户端入口，不替换进工作台", () => {
  const projects = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const data = readFileSync(new URL("../src/server/workbench-data.mjs", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(projects.includes('card.id === "life-coach" && coachUrl && coachClientUrl'));
  assert.ok(projects.includes("<CoachPortfolioActions coachUrl={coachUrl} coachClientUrl={coachClientUrl} />"));
  assert.ok(projects.includes('"进入控制端"'));
  assert.ok(projects.includes("进入用户端"));
  assert.ok(projects.includes("openCoachWorkbench(coachUrl)"));
  assert.ok(data.includes('coachClientUrl: "https://infans-coach.github.io/life-coach-client/"'));
  assert.ok(projects.includes("进工作台 <ChevronRight"));
  assert.match(styles, /\.project-deck-card \{[^}]*display:flex;flex-direction:column;/u);
  assert.match(styles, /\.project-experience-row\.is-compact \{ margin-top:auto;/u);
  assert.match(styles, /\.project-core-stack \.project-experience-row\.is-compact \{ margin-top:auto;/u);
});

test("全局搜索完整退出，局部搜索、日本活动提级和最终工具顺序保留", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const overlays = readFileSync(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
  const tools = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const schedule = readFileSync(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  const japanActivities = readFileSync(new URL("../src/pages/tools/JapanActivitiesView.tsx", import.meta.url), "utf8");
  const topics = readFileSync(new URL("../src/pages/TopicsPage.tsx", import.meta.url), "utf8");
  const projects = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const music = readFileSync(new URL("../src/pages/tools/MusicPlayerView.tsx", import.meta.url), "utf8");
  const video = readFileSync(new URL("../src/pages/tools/VideoLibraryView.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  for (const source of [main, routes, overlays, styles]) {
    assert.equal(source.includes("GlobalSearch"), false);
    assert.equal(source.includes("/api/search"), false);
    assert.equal(source.includes("search-panel"), false);
  }
  assert.equal(main.includes("⌘K"), false);
  assert.ok(projects.includes("搜索大模块或小模块"));
  assert.equal(topics.includes('aria-label="专题研究视图"'), false);
  assert.ok(music.includes("在当前文件夹里查找"));
  assert.ok(video.includes("在当前文件夹里查找"));

  const expectedOrder = ["协作记录", "秘书收件箱", "异常雷达", "项目素材库", "设计台", "工具与素材收藏", "游戏数据表现", "音乐", "视频", "相册", "网页收藏", "美食地图", "系统设置", "Token管理", "支付与续约"];
  assert.deepEqual([...tools.matchAll(/name: \"([^\"]+)\"/g)].slice(0, expectedOrder.length).map((match) => match[1]), expectedOrder);
  assert.match(tools, /id: "game-analytics",\s+group: "work",\s+name: "游戏数据表现"/);
  assert.equal(tools.includes('id: "game-dungeon"'), false);
  assert.equal(tools.includes("import JapanActivitiesView"), false);
  assert.ok(schedule.includes("JapanActivitiesView"));
  assert.ok(tools.includes('/schedule?view=japan'));
  assert.ok(tools.includes("RenewalExpiryView"));
  assert.equal(tools.includes("KitchenOrdersView"), false);
  assert.equal(tools.includes("活动组织"), false);
  assert.match(routes, /router\.use\("\/api\/tools\/diary-mode"[\s\S]*?protectAssetResponse\(response\);[\s\S]*?assertPrivateAssetAccess\(request\);/);
  assert.match(routes, /const handleDialogueDiaries = async[\s\S]*?protectAssetResponse\(response\);[\s\S]*?assertPrivateAssetAccess\(request\);/);
  assert.ok(routes.includes('router.use("/api/tools/dialogue-diaries", handleDialogueDiaries);'));
  assert.ok(routes.includes('router.use("/api/tools/dialogue-logs", handleDialogueDiaries);'));
  assert.doesNotMatch(routes, /\/api\/tools\/hosted-activities|\/api\/tools\/kitchen-orders/u);
  assert.equal(japanActivities.includes("hosted-activities-panel"), false);
  assert.equal(japanActivities.includes("GameDungeonGuide"), false);
  assert.ok(japanActivities.includes('import("./JapanActivityGuide")'));
  assert.equal(tools.includes('role="listitem"'), false);
  assert.equal(topics.includes("topics-intro"), false);
  assert.equal(topics.includes("先进入学习专题"), false);
  assert.ok(styles.includes("env(safe-area-inset-top, 0px)"));
  assert.ok(styles.includes("@media (min-width: 901px) and (max-width: 1366px)"));
  assert.ok(styles.includes("overflow-y: auto; -webkit-overflow-scrolling: touch"));
  assert.ok(styles.includes("height: auto; display: grid"));
  assert.ok(styles.includes("calc(27px + env(safe-area-inset-top, 0px))"));
});

test("音乐播放器的进度、播放控制与音量共用同一条对齐轨道", () => {
  const music = readFileSync(new URL("../src/pages/tools/MusicPlayerView.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const controlStart = music.indexOf('className="music-control-row"');
  const controlEnd = music.indexOf('className="music-volume"');

  assert.ok(controlStart >= 0 && controlEnd > controlStart);
  assert.ok(music.slice(controlStart, controlEnd).includes('className="music-control-actions"'));
  assert.equal(music.slice(controlStart, controlEnd).includes('className="music-volume"'), false);
  for (const selector of ["music-progress-row", "music-control-row", "music-volume"]) {
    assert.match(styles, new RegExp(`\\.${selector} \\{[^}]*grid-template-columns:38px minmax\\(100px,1fr\\) 38px`));
  }
  assert.match(styles, /\.music-control-actions \{[^}]*grid-column:2;[^}]*justify-content:center/);
});

test("Project Hub、功能树与工具图标只用双主题语义表面", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const featureTree = styles.slice(styles.indexOf("/* 产品项目 · Wiki 功能树 */"), styles.indexOf("/* NAS 放映室"));
  const projectHub = styles.slice(styles.indexOf(".projects-portfolio"), styles.indexOf(".health-grid"));
  for (const source of [featureTree, projectHub]) {
    assert.equal(source.includes("linear-gradient(180deg,rgba(7,16,19"), false);
    assert.equal(source.includes("linear-gradient(160deg,rgba(16,31,34"), false);
    assert.equal(source.includes("linear-gradient(135deg,rgba(20,39,38"), false);
    assert.ok(source.includes("var(--surface)"));
    assert.ok(source.includes("var(--control-bg)"));
  }
  assert.match(styles, /\.tools-app-icon \{[\s\S]*?background:linear-gradient\(160deg,var\(--teal-soft\),var\(--surface-2\)\)/);
  assert.match(styles, /\.tools-app\.tone-mist \.tools-app-icon \{[\s\S]*?color:var\(--mist-blue\)/);
  assert.match(styles, /\.tools-app\.tone-gold \.tools-app-icon \{[\s\S]*?background:linear-gradient\(160deg,var\(--gold-soft\),var\(--surface-2\)\)/);
});

test("实用工具三系统分类只显示一行小字与细线", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const phoneMedia = styles.slice(styles.indexOf("@media (max-width: 620px) {", styles.indexOf(".schedule-all-todos-list")));
  assert.match(toolsPage, /label: "秘书系统"/);
  assert.match(toolsPage, /label: "工作系统"/);
  assert.match(toolsPage, /label: "生活系统"/);
  assert.deepEqual([...toolsPage.matchAll(/id: "([^"]+)",\s+group: "([^"]+)"/g)].map((match) => [match[1], match[2]]), [
    ["collaboration-records", "secretary"], ["inbox", "secretary"], ["cron", "secretary"],
    ["art-library", "work"], ["native-ui-design", "work"], ["ai-tools", "work"], ["game-analytics", "work"],
    ["music", "life"], ["video", "life"], ["photo", "life"], ["web-bookmarks", "life"], ["food-map", "life"], ["settings", "secretary"], ["agent-observability", "secretary"],
    ["renewals", "life"],
  ]);
  const launchpad = toolsPage.slice(toolsPage.indexOf("function ToolsLaunchpad"), toolsPage.indexOf("function DevelopmentLogView"));
  assert.match(launchpad, /<section className="tools-launch-group" key=\{group\.id\} aria-labelledby=/);
  assert.match(launchpad, /<header><h2 id=/);
  assert.equal(launchpad.includes("<p>"), false);
  assert.match(styles, /\.tools-launch-group \{[^}]*place-items:center/);
  assert.match(styles, /\.tools-launch-group > header::after \{[^}]*height:1px;[^}]*background:var\(--line\)/);
  assert.match(styles, /\.tools-launch-group h2 \{[^}]*font:600 var\(--text-micro\)/);
  assert.match(styles, /\.tools-launch-grid \{[\s\S]*?width:min\(804px,100%\);[\s\S]*?display:flex;[\s\S]*?flex-wrap:wrap/);
  assert.match(styles, /@media \(max-width:1180px\) \{[\s\S]*?\.tools-launch-grid \{ width:min\(662px,100%\);gap:24px 18px/);
  assert.match(phoneMedia, /\.tools-app \{ width:calc\(\(100% - 16px\)\/3\);[\s\S]*?flex:0 0 calc\(\(100% - 16px\)\/3\)/);
  assert.match(phoneMedia, /\.tools-app-icon \{ width:68px;height:68px/);
  assert.equal(toolsPage.includes("data-columns"), false);
});

test("功能 Wiki 前台只显示短功能摘要，不铺开维护明细和施工进度", () => {
  const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.ok(projectsPage.includes("selectedFeature?.summaryPoints?.length"));
  assert.ok(projectsPage.includes("selectedFeaturePresentationPoints.map"));
  assert.equal(projectsPage.includes("wikiVisibleFeaturePoints"), false);
  assert.equal(projectsPage.includes('className="project-feature-progress"'), false);
  assert.equal(projectsPage.includes('<Kicker>开发进度</Kicker>'), false);
});

test("实用工具使用三档版心且四类协作记录共用两列册页", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /--content-width-reading: 960px;/);
  assert.match(styles, /--content-width-standard: 1280px;/);
  assert.match(styles, /--content-width-wide: 1480px;/);
  assert.match(styles, /\.development-log,\.dialogue-log-index,\.meeting-minutes-index \{ width:min\(1080px,100%\)/);
  assert.match(styles, /\.development-log-day-view,\.dialogue-log-reader,\.meeting-minutes-reader \{ width:min\(var\(--content-width-reading\),100%\)/);
  assert.match(styles, /\.development-log-day-list\.collaboration-record-grid,[^{]+\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.collaboration-record-card \{[^}]*height:100%[^}]*grid-template-columns:72px minmax\(0,1fr\) auto/);
  assert.match(styles, /@media \(max-width:720px\) \{[\s\S]*?\.development-log-day-list\.collaboration-record-grid,[^{]+\{ grid-template-columns:1fr;grid-auto-rows:auto; \}/);
  assert.match(styles, /\.development-log-full \{[^}]*background:var\(--surface\)/);
});

test("资产接口只接受本机或经验证的 Serve 身份，页面未按设备类型分权", () => {
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const assetsPage = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  const assetRoutes = routes.slice(routes.indexOf('router.use("/api/assets/unlock"'), routes.indexOf('router.use("/api/tools/development-log"'));

  assert.ok(assetRoutes.includes("assertPrivateAssetAccess(request)"));
  assert.equal(assetRoutes.includes("assertLoopbackOnly(request)"), false);
  assert.ok(routes.includes('request.headers["tailscale-user-login"]'));
  assert.ok(routes.includes('response.setHeader("Cache-Control", "private, no-store, max-age=0")'));
  assert.ok(assetsPage.includes("这台设备尚未授权"));
  assert.equal(assetsPage.includes("window.innerWidth"), false);
  assert.equal(assetsPage.includes("navigator.userAgent"), false);
});

test("buildProjectCards keeps registered items and skips duplicate 小秘书", () => {
  const cards = buildProjectCards({
    items: [
      { name: "小秘书", status: "示例", entry: "总览", entryPath: null },
      { name: "小秘书", status: "示例", entry: "总览", entryPath: null },
      { name: "阳台种植计划", status: "进行中", entry: "入口", entryPath: "a.md", archived: true },
      { name: "公众号「示例手记」", status: "持续更新", entry: "入口", entryPath: "b.md" },
    ],
    flagship: { version: "v0.5.3", focus: "本地工作台", ready: [], pending: [] },
    coaching: { focus: "示例", latest: "跟进中" },
  });
  assert.equal(cards[0]?.id, "flagship");
  assert.equal(cards[0]?.name, "小秘书");
  assert.equal(cards.filter((c) => c.name === "小秘书").length, 1);
  assert.ok(cards.some((c) => c.name === "阳台种植计划" && c.archived));
  assert.equal(cards.find((c) => c.name.includes("示例手记"))?.displayName, "公众号「示例手记」");
});

test("displayProjectName turns book-title marks into corner quotes", async () => {
  const { displayProjectName } = await import("../src/project-workbench-model.ts");
  assert.equal(displayProjectName("公众号《示例手记》"), "公众号「示例手记」");
});
