import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectRegistryError, readRegisteredExperience, readRegisteredProject, registeredProjectEnvironment } from "../src/server/project-registry.mjs";

async function fixture(overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "infans-project-registry-"));
  const vaultRoot = path.join(base, "vault");
  const projectRoot = path.join(base, "life-coach");
  const dataRoot = path.join(base, "coaching-data");
  const scripts = path.join(projectRoot, "scripts");
  await Promise.all([
    mkdir(path.join(vaultRoot, "00_本地工作台"), { recursive: true }),
    mkdir(scripts, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
  ]);
  for (const name of ["start-local.sh", "launch-chrome-coach.sh"]) {
    const script = path.join(scripts, name);
    await writeFile(script, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(script, 0o755);
  }
  const entry = {
    root: projectRoot,
    dataRoot,
    url: "http://127.0.0.1:5174/",
    startScript: "scripts/start-local.sh",
    launchScript: "scripts/launch-chrome-coach.sh",
    allowedHosts: ["private.example"],
    ...overrides,
  };
  await writeFile(
    path.join(vaultRoot, "00_本地工作台", "project-registry.local.json"),
    JSON.stringify({ version: 1, projects: { "life-coach": entry } }),
    "utf8",
  );
  return { vaultRoot, projectRoot, dataRoot };
}

test("稳定 ID 解析为已验证的本机项目，但环境变量不返回前端", async () => {
  const { vaultRoot, projectRoot, dataRoot } = await fixture();
  const project = await readRegisteredProject(vaultRoot, "life-coach");
  assert.equal(project.root, await realpath(projectRoot));
  assert.equal(project.dataRoot, await realpath(dataRoot));
  assert.equal(project.url, "http://127.0.0.1:5174/");
  assert.deepEqual(registeredProjectEnvironment(project, {}).COACHING_ALLOWED_HOSTS, "private.example");
});

test("缺少注册文件时失败关闭", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "infans-project-registry-missing-"));
  await assert.rejects(
    readRegisteredProject(base, "life-coach"),
    (error) => error instanceof ProjectRegistryError && error.code === "REGISTRY_MISSING" && !error.message.includes(base),
  );
});

test("拒绝项目根之外的脚本", async () => {
  const { vaultRoot } = await fixture({ startScript: "../outside.sh" });
  await assert.rejects(
    readRegisteredProject(vaultRoot, "life-coach"),
    (error) => error instanceof ProjectRegistryError && error.code === "PROJECT_START_SCRIPT_INVALID",
  );
});

test("拒绝非回环项目网址", async () => {
  const { vaultRoot } = await fixture({ url: "https://example.com/" });
  await assert.rejects(
    readRegisteredProject(vaultRoot, "life-coach"),
    (error) => error instanceof ProjectRegistryError && error.code === "PROJECT_URL_INVALID",
  );
});

test("拒绝用符号链接把启动脚本逃逸到项目根之外", async () => {
  const { vaultRoot, projectRoot } = await fixture();
  const outside = path.join(path.dirname(projectRoot), "outside.sh");
  await writeFile(outside, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await chmod(outside, 0o755);
  const linked = path.join(projectRoot, "scripts", "linked.sh");
  await symlink(outside, linked);
  const registry = path.join(vaultRoot, "00_本地工作台", "project-registry.local.json");
  await writeFile(registry, JSON.stringify({
    version: 1,
    projects: {
      "life-coach": {
        root: projectRoot,
        dataRoot: path.join(path.dirname(projectRoot), "coaching-data"),
        url: "http://127.0.0.1:5174/",
        startScript: "scripts/linked.sh",
        launchScript: "scripts/launch-chrome-coach.sh",
      },
    },
  }), "utf8");
  await assert.rejects(
    readRegisteredProject(vaultRoot, "life-coach"),
    (error) => error instanceof ProjectRegistryError && error.code === "PROJECT_START_SCRIPT_UNAVAILABLE",
  );
});

test("拒绝把网址或端口伪装成允许主机名", async () => {
  const { vaultRoot } = await fixture({ allowedHosts: ["https://private.example:8443"] });
  await assert.rejects(
    readRegisteredProject(vaultRoot, "life-coach"),
    (error) => error instanceof ProjectRegistryError && error.code === "PROJECT_ALLOWED_HOSTS_INVALID",
  );
});

test("本地网页体验只接受登记过的启动方式和固定回环端口", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "infans-game-experience-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultRoot = path.join(base, "vault");
  const webRoot = path.join(base, "web-game");
  await mkdir(path.join(vaultRoot, "00_本地工作台"), { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, "package.json"), "{}", "utf8");
  await writeFile(path.join(vaultRoot, "00_本地工作台", "project-registry.local.json"), JSON.stringify({
    version: 1,
    projects: {
      "web-game": { root: webRoot, experience: { type: "web-dev", manager: "npm", port: 5182 } },
    },
  }), "utf8");
  const experience = await readRegisteredExperience(vaultRoot, "web-game");
  assert.equal(experience.url, "http://127.0.0.1:5182/");
  assert.deepEqual(experience.args.slice(-2), ["5182", "--strictPort"]);
  await assert.rejects(
    readRegisteredExperience(vaultRoot, "missing"),
    (error) => error instanceof ProjectRegistryError && error.code === "EXPERIENCE_NOT_REGISTERED",
  );
});
