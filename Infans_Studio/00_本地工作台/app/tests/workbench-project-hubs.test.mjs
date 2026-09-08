import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_HUB_MANIFEST_PATH,
  parseProjectHubManifest,
  readExternalProjectHub,
  validateExternalProjectRelativePath,
} from "../src/server/workbench-project-hubs.mjs";

const contractSchema = JSON.parse(await fs.readFile(new URL("../contracts/infans-project-hub.v1.schema.json", import.meta.url), "utf8"));

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    project: {
      id: "garden-demo",
      name: "阳台种植计划",
      status: "active",
      summary: "完整游戏项目；功能与玩法只是其中一条工作线。",
      defaultView: "home",
    },
    worklines: [
      {
        id: "product",
        name: "产品功能与玩法",
        status: "active",
        summary: "从项目主页进入功能树。",
        source: { path: "项目管理/玩法总纲.md", label: "玩法原件" },
        view: { kind: "featureTree", treeId: "gameplay" },
      },
      {
        id: "release",
        name: "Steam 与发行",
        status: "active",
        summary: "发行准备。",
        source: { path: "项目管理/发行计划.md", label: "发行原件" },
      },
    ],
    featureTrees: [
      {
        id: "gameplay",
        worklineId: "product",
        name: "产品功能与玩法",
        summary: "只登记机器需要的功能关系。",
        modules: [
          {
            id: "combat",
            name: "战斗构筑",
            status: "testing",
            features: [
              {
                id: "solo-trial",
                name: "孤身试炼",
                status: "testing",
                source: { path: "项目管理/孤身试炼.md", label: "孤身试炼原件" },
                children: [{
                  id: "reward-choice",
                  name: "层间选择",
                  status: "testing",
                  summary: "每层结束后展示三个候选并选择一个。",
                  source: { path: "项目管理/孤身试炼.md", label: "孤身试炼原件" },
                }],
              },
            ],
          },
        ],
      },
    ],
    taskLinks: [{ taskId: "garden-demo-steam-prep", worklineId: "release" }],
    recentLinks: [
      { recentId: "steam-candidate-build", worklineId: "product", moduleId: "combat", featureId: "solo-trial" },
      { recentId: "steam-candidate-build", worklineId: "product", moduleId: "combat", featureId: "reward-choice" },
    ],
    ...overrides,
  };
}

test("薄契约只读取独立清单并保留项目主页到功能树的显式关系", () => {
  assert.equal(contractSchema.properties.schemaVersion.const, 1);
  assert.match(contractSchema.description, /不约束详细设计正文/u);
  assert.deepEqual(contractSchema.required, ["schemaVersion", "project", "worklines"]);
  const parsed = parseProjectHubManifest(manifest(), { projectId: "garden-demo" });
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.hub.project.defaultView, "home");
  assert.deepEqual(parsed.hub.worklines[0].view, { kind: "featureTree", treeId: "gameplay" });
  assert.equal(parsed.hub.featureTrees[0].modules[0].features[0].children[0].id, "reward-choice");
  assert.equal(parsed.hub.featureTrees[0].modules[0].features[0].children[0].description, "每层结束后展示三个候选并选择一个。");
  assert.equal(parsed.hub.featureTrees[0].modules[0].features[0].children[0].source.path, "项目管理/孤身试炼.md");
  assert.deepEqual(parsed.hub.taskLinks, [{ taskId: "garden-demo-steam-prep", worklineId: "release", moduleId: null, featureId: null }]);
  assert.deepEqual(parsed.hub.recentLinks, [
    { recentId: "steam-candidate-build", worklineId: "product", moduleId: "combat", featureId: "solo-trial" },
    { recentId: "steam-candidate-build", worklineId: "product", moduleId: "combat", featureId: "reward-choice" },
  ]);
});

test("缺默认入口局部降级为项目主页，版本不兼容和重复 ID 明确报错", () => {
  const missingDefault = manifest();
  delete missingDefault.project.defaultView;
  const compatible = parseProjectHubManifest(missingDefault, { projectId: "garden-demo" });
  assert.equal(compatible.hub.project.defaultView, "home");
  assert.equal(compatible.warnings.some((item) => item.code === "PROJECT_HUB_DEFAULT_VIEW_MISSING"), true);

  const unsupported = parseProjectHubManifest({ ...manifest(), schemaVersion: 2 }, { projectId: "garden-demo" });
  assert.equal(unsupported.hub, null);
  assert.equal(unsupported.errors[0].code, "PROJECT_HUB_VERSION_UNSUPPORTED");

  const duplicate = manifest();
  duplicate.worklines[1].id = "product";
  const duplicateResult = parseProjectHubManifest(duplicate, { projectId: "garden-demo" });
  assert.equal(duplicateResult.hub, null);
  assert.equal(duplicateResult.errors.some((item) => item.code === "PROJECT_HUB_ID_DUPLICATE"), true);
});

test("外部项目状态只接受薄契约枚举，不把进度说明当状态", () => {
  const input = manifest();
  input.worklines[0].status = "已施工，等待本人验收";
  const parsed = parseProjectHubManifest(input, { projectId: "garden-demo" });
  assert.equal(parsed.hub.worklines[0].status, "planned");
  assert.equal(parsed.warnings.some((item) => item.code === "PROJECT_HUB_STATUS_INVALID"), true);
});

test("无效工作线、功能树和任务关联只给明确问题，不猜正文标题", () => {
  const input = manifest();
  input.worklines[0].view.treeId = "missing-tree";
  input.taskLinks.push({ taskId: "bad-link", worklineId: "missing-workline" });
  input.recentLinks.push({ recentId: "bad-recent", worklineId: "product", featureId: "missing-feature" });
  const parsed = parseProjectHubManifest(input, { projectId: "garden-demo" });
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.hub.worklines[0].view, { kind: "overview" });
  assert.equal(parsed.warnings.some((item) => item.code === "PROJECT_HUB_FEATURE_TREE_REFERENCE_INVALID"), true);
  assert.equal(parsed.warnings.some((item) => item.code === "PROJECT_HUB_TASK_LINK_INVALID"), true);
  assert.equal(parsed.warnings.some((item) => item.code === "PROJECT_HUB_RECENT_LINK_INVALID"), true);
});

test("外部路径拒绝绝对路径、穿越、反斜杠、凭据、环境文件、Git、缓存和日志", () => {
  const rejected = [
    "/tmp/project.json",
    "C:/project/project.json",
    "../project.json",
    "docs\\project.json",
    ".env",
    ".env.local",
    ".git/config",
    "build/project.json",
    "cache/project.json",
    "logs/run.json",
    "docs/access-token.md",
    "docs/private-key.pem",
    "docs/run.log",
  ];
  for (const value of rejected) assert.throws(() => validateExternalProjectRelativePath(value, { source: true }), undefined, value);
  assert.equal(validateExternalProjectRelativePath("项目管理/玩法总纲.md", { source: true }), "项目管理/玩法总纲.md");
  assert.equal(validateExternalProjectRelativePath(PROJECT_HUB_MANIFEST_PATH, { manifest: true }), PROJECT_HUB_MANIFEST_PATH);
  assert.throws(() => validateExternalProjectRelativePath("another.json", { manifest: true }), /EXTERNAL_PROJECT_MANIFEST_NOT_WHITELISTED/u);
});

test("服务器只按项目 ID 命中白名单根并读取固定清单", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-external-project-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".infans"), { recursive: true });
  await fs.mkdir(path.join(root, "项目管理"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, PROJECT_HUB_MANIFEST_PATH), JSON.stringify(manifest(), null, 2)),
    fs.writeFile(path.join(root, "项目管理/玩法总纲.md"), "# 任意正文结构\n"),
    fs.writeFile(path.join(root, "项目管理/发行计划.md"), "没有强制标题也能作为原件。\n"),
    fs.writeFile(path.join(root, "项目管理/孤身试炼.md"), "正文写法自由。\n"),
  ]);
  const sources = { "garden-demo": { root } };
  const result = await readExternalProjectHub("garden-demo", { sources });
  assert.equal(result.registered, true);
  assert.equal(result.hub.project.name, "阳台种植计划");
  assert.equal(result.hub.worklines[0].source.label, "玩法原件");
  assert.equal(result.hub.worklines[0].source.path, "项目管理/玩法总纲.md");
  assert.equal(path.isAbsolute(result.hub.worklines[0].source.path), false);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(await readExternalProjectHub("not-registered", { sources }), { registered: false, hub: null, warnings: [], errors: [] });
});

test("同一外部项目清单不随设备 User-Agent 裁剪，也不暴露绝对根", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-external-project-ua-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".infans"), { recursive: true });
  await fs.mkdir(path.join(root, "项目管理"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, PROJECT_HUB_MANIFEST_PATH), JSON.stringify(manifest(), null, 2)),
    fs.writeFile(path.join(root, "项目管理/玩法总纲.md"), "# 任意正文结构\n"),
    fs.writeFile(path.join(root, "项目管理/发行计划.md"), "没有强制标题也能作为原件。\n"),
    fs.writeFile(path.join(root, "项目管理/孤身试炼.md"), "正文写法自由。\n"),
  ]);
  const sources = { "garden-demo": { root } };
  const userAgents = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  ];
  const results = await Promise.all(userAgents.map((userAgent) => readExternalProjectHub("garden-demo", { sources, userAgent })));
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(results[0].registered, true);
  assert.equal(results[0].hub?.project.name, "阳台种植计划");
  assert.equal(JSON.stringify(results[0]).includes("/Users/"), false);
  assert.deepEqual(results[0].errors, []);
});

test("外部根或原件不可用时局部降级，符号链接不能逃出白名单", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-external-project-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "infans-external-outside-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(root, ".infans"), { recursive: true });
  await fs.mkdir(path.join(root, "项目管理"), { recursive: true });
  await fs.writeFile(path.join(outside, "outside.md"), "不得读取\n");
  await fs.symlink(path.join(outside, "outside.md"), path.join(root, "项目管理/玩法总纲.md"));
  const input = manifest();
  input.worklines[1].source.path = "项目管理/不存在.md";
  await fs.writeFile(path.join(root, PROJECT_HUB_MANIFEST_PATH), JSON.stringify(input));
  const result = await readExternalProjectHub("garden-demo", { sources: { "garden-demo": { root } } });
  assert.equal(result.hub.worklines[0].source, null);
  assert.equal(result.hub.worklines[1].source, null);
  assert.equal(result.warnings.filter((item) => item.code === "EXTERNAL_PROJECT_SOURCE_UNAVAILABLE").length >= 2, true);

  const missing = await readExternalProjectHub("garden-demo", { sources: { "garden-demo": { root: path.join(root, "不存在") } } });
  assert.equal(missing.hub, null);
  assert.equal(missing.warnings[0].code, "EXTERNAL_PROJECT_HUB_MISSING");
});
