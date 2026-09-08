import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readWorkbenchGovernance } from "../src/server/workbench-governance.mjs";

async function fixture(registry) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-governance-"));
  await fs.mkdir(path.join(root, "rules"), { recursive: true });
  await fs.writeFile(path.join(root, "rules", "core.md"), "---\ndescription: 核心规则摘要\n---\n# 核心规则\n");
  await fs.writeFile(path.join(root, "rules", "child.md"), "---\ndescription: 专项规则摘要\n---\n# 专项规则\n");
  await fs.writeFile(path.join(root, "registry.json"), JSON.stringify(registry));
  return root;
}

function baseRegistry(documents) {
  return {
    schemaVersion: 1,
    sourcePolicy: "只做派生导航。",
    profiles: {
      core: { layer: "core", kind: "核心", maintainers: ["维护者"], readers: ["读者"], impacts: ["全局"], notResponsible: "不代替专项规则。" },
      specialty: { layer: "specialty", kind: "专项", maintainers: ["专项维护者"], readers: ["实现者"], impacts: ["模块"], notResponsible: "不覆盖核心规则。" },
    },
    formalDiscovery: [{ root: "rules", extensions: [".md"] }],
    documents,
  };
}

test("治理登记展开默认职责与双向关系", async (t) => {
  const root = await fixture(baseRegistry([
    { id: "core", path: "rules/core.md", profile: "core", status: "current", authorityKey: "core" },
    { id: "child", path: "rules/child.md", profile: "specialty", status: "candidate", parentIds: ["core"], implementsIds: ["core"] },
  ]));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await readWorkbenchGovernance(root, { registryPath: "registry.json" });
  assert.equal(snapshot.issues.length, 0);
  assert.equal(snapshot.documents[0].title, "核心规则");
  assert.deepEqual(snapshot.documents[0].childIds, ["child"]);
  assert.deepEqual(snapshot.documents[0].implementedByIds, ["child"]);
  assert.equal(snapshot.documents[1].notResponsible, "不覆盖核心规则。");
  assert.deepEqual(snapshot.summary.byStatus, { candidate: 1, current: 1 });
});

test("展示模式只移除显式标记项并修剪关联", async (t) => {
  const root = await fixture(baseRegistry([
    { id: "core", path: "rules/core.md", profile: "core", status: "current", authorityKey: "core" },
    { id: "child", path: "rules/child.md", profile: "specialty", status: "candidate", parentIds: ["core"], hiddenInDisplayMode: true },
  ]));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await readWorkbenchGovernance(root, { registryPath: "registry.json", displayMode: true });
  assert.deepEqual(snapshot.documents.map((item) => item.id), ["core"]);
  assert.deepEqual(snapshot.documents[0].childIds, []);
  assert.equal(snapshot.summary.documents, 1);
});

test("检查器发现未登记原件、重复权威、断链与上位循环", async (t) => {
  const root = await fixture(baseRegistry([
    { id: "core", path: "rules/core.md", profile: "core", status: "current", authorityKey: "same", parentIds: ["child"] },
    { id: "child", path: "rules/missing.md", profile: "specialty", status: "current", authorityKey: "same", parentIds: ["core"], implementsIds: ["unknown"] },
  ]));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await readWorkbenchGovernance(root, { registryPath: "registry.json" });
  const codes = new Set(snapshot.issues.map((item) => item.code));
  assert.ok(codes.has("SOURCE_MISSING"));
  assert.ok(codes.has("DUPLICATE_CURRENT_AUTHORITY"));
  assert.ok(codes.has("UNKNOWN_RELATION_TARGET"));
  assert.ok(codes.has("PARENT_CYCLE"));
  assert.ok(codes.has("UNREGISTERED_FORMAL_SOURCE"));
});

test("当前 Vault 的正式规则范围均已登记且关系可解析", async () => {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = path.resolve(appDir, "../..");
  const snapshot = await readWorkbenchGovernance(root);
  assert.equal(snapshot.issues.length, 0, snapshot.issues.map((item) => item.message).join("\n"));
  assert.ok(snapshot.documents.length >= 80);
  assert.ok(snapshot.documents.some((item) => item.id === "vault-agent-entry" && item.sourceExists));
  const displaySnapshot = await readWorkbenchGovernance(root, { displayMode: true });
  assert.equal(displaySnapshot.issues.length, 0, displaySnapshot.issues.map((item) => item.message).join("\n"));
  assert.equal(displaySnapshot.documents.length, snapshot.documents.length - 3);
  assert.ok(!displaySnapshot.documents.some((item) => item.id === "review-group-chat-handoff"));
  assert.ok(!displaySnapshot.documents.some((item) => item.id === "private-experiment-design"));
  assert.ok(!displaySnapshot.documents.some((item) => item.id === "private-experiment-cleanup"));
});

test("小秘书项目主页在展示模式保留只读治理入口", async () => {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const page = await fs.readFile(path.join(appDir, "src/pages/ProjectsPage.tsx"), "utf8");
  const view = await fs.readFile(path.join(appDir, "src/pages/GovernanceMapView.tsx"), "utf8");
  const css = await fs.readFile(path.join(appDir, "src/pages/GovernanceMapView.css"), "utf8");
  assert.match(page, /name: "规则总览"/);
  assert.match(page, /countLabel: "权威文件，仅供只读"/);
  assert.doesNotMatch(page, /只读派生/);
  assert.match(view, /<Kicker>权威文件，仅供只读<\/Kicker>/);
  assert.doesNotMatch(view, /只读派生/);
  assert.doesNotMatch(page, /internalView === "governance" && !displayMode/);
  assert.match(page, /<GovernanceMapView[\s\S]*?displayMode=\{displayMode\}/);
  assert.match(view, /displayMode \? "\?display=1" : ""/);
  assert.match(view, /负责什么/);
  assert.match(view, /不负责什么/);
  assert.match(view, /historical: \{ label: "历史"/);
  assert.doesNotMatch(view, /label: "退场"|label: "仅历史"/);
  assert.match(css, /@media \(max-width:760px\)/);
  assert.match(css, /:focus-visible/);
});
