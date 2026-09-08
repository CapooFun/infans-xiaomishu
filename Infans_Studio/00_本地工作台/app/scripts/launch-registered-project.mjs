#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchRegisteredProject, ProjectRegistryError } from "../src/server/project-registry.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = path.resolve(process.env.INFANS_VAULT_ROOT || path.join(appRoot, "../.."));
const mode = process.argv[2] === "chrome" ? "chrome" : "start";
const projectId = String(process.argv[3] || "").trim();

if (!projectId) {
  process.stderr.write("缺少外接项目 ID。\n");
  process.exit(2);
}

try {
  await launchRegisteredProject(vaultRoot, projectId, mode);
} catch (error) {
  process.stderr.write(`${error instanceof ProjectRegistryError ? error.publicMessage : "外接项目启动失败。"}\n`);
  process.exit(1);
}
