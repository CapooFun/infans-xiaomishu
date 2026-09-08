import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readProductFeatureTree } from "../src/server/workbench-product-features.mjs";
import { externalProjectSourceIds, readExternalProjectHub } from "../src/server/workbench-project-hubs.mjs";
import { readProjectManagement } from "../src/server/workbench-project-management.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const PRODUCT_TREE_PATH = "00_本地工作台/10_设计/小秘书_产品功能树.md";
const CANONICAL_MODULE_HEADER = "| 小模块 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |";
const NON_BLOCKING_MIGRATION_WARNING_CODES = new Set([
  "EXECUTOR_WITHOUT_AUTOMATION_CONTRACT",
]);

function countFeatureNode(node) {
  return 1 + (node.children || []).reduce((total, child) => total + countFeatureNode(child), 0);
}

function formatIssues(issues) {
  return issues.map((item) => `${item.code}: ${item.message}`).join("\n");
}

const productTree = await readProductFeatureTree(VAULT_ROOT, PRODUCT_TREE_PATH);
if (!productTree) throw new Error("找不到小秘书产品功能树。");
if (productTree.warnings.length) throw new Error(`小秘书产品功能树存在契约问题：\n${formatIssues(productTree.warnings)}`);

const projectManagement = await readProjectManagement(VAULT_ROOT);
const blockingProjectWarnings = projectManagement.warnings.filter(
  (item) => !NON_BLOCKING_MIGRATION_WARNING_CODES.has(item.code),
);
const migrationProjectWarnings = projectManagement.warnings.filter(
  (item) => NON_BLOCKING_MIGRATION_WARNING_CODES.has(item.code),
);
if (blockingProjectWarnings.length) {
  throw new Error(`事业注册表或项目管理原件存在契约问题：\n${formatIssues(blockingProjectWarnings)}`);
}

for (const module of productTree.modules) {
  if (!module.sourcePath) throw new Error(`模块“${module.name}”缺少原件路径。`);
  const markdown = await fs.readFile(path.join(VAULT_ROOT, module.sourcePath), "utf8");
  if (!markdown.includes(CANONICAL_MODULE_HEADER)) {
    throw new Error(`模块“${module.name}”未使用标准七列功能表：${module.sourcePath}`);
  }
}

let externalHubCount = 0;
let externalTreeCount = 0;
let externalNodeCount = 0;
for (const projectId of externalProjectSourceIds()) {
  const result = await readExternalProjectHub(projectId);
  const issues = [...result.errors, ...result.warnings];
  if (issues.length) throw new Error(`外部项目“${projectId}”存在契约问题：\n${formatIssues(issues)}`);
  if (!result.hub) throw new Error(`外部项目“${projectId}”缺少可用 Project Hub。`);
  externalHubCount += 1;
  externalTreeCount += result.hub.featureTrees.length;
  externalNodeCount += result.hub.featureTrees.reduce((treeTotal, tree) => treeTotal + tree.modules.reduce(
    (moduleTotal, module) => moduleTotal + 1 + module.features.reduce((featureTotal, feature) => featureTotal + countFeatureNode(feature), 0),
    0,
  ), 0);
}

const localFeatureCount = productTree.modules.reduce((total, module) => total + module.features.length, 0);
const activeProjectCount = projectManagement.projects.filter((project) => !project.archived).length;
const archivedProjectCount = projectManagement.projects.length - activeProjectCount;
process.stdout.write(`事业项目契约检查通过：事业注册表 ${activeProjectCount} 个当前项目／${archivedProjectCount} 个归档项目；小秘书 ${productTree.modules.length} 个模块／${localFeatureCount} 个小模块；外部 ${externalHubCount} 份 Project Hub／${externalTreeCount} 棵功能树／${externalNodeCount} 个节点。\n`);
if (migrationProjectWarnings.length) {
  process.stdout.write(`兼容迁移提示 ${migrationProjectWarnings.length} 条（不阻断）：${[...new Set(migrationProjectWarnings.map((item) => item.code))].join("、")}。\n`);
}
