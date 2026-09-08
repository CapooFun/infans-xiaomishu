import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_REGISTRY_RELATIVE = path.join("00_本地工作台", "project-registry.local.json");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const GODOT_BINARY = "/Applications/Godot.app/Contents/MacOS/Godot";
const WEB_MANAGERS = new Set(["npm", "pnpm"]);

export class ProjectRegistryError extends Error {
  constructor(code, publicMessage = "外接项目尚未正确配置。") {
    super(code);
    this.name = "ProjectRegistryError";
    this.code = code;
    this.status = 503;
    this.publicMessage = publicMessage;
  }
}

function requireAbsoluteDirectory(value, code) {
  const candidate = String(value || "").trim();
  if (!candidate || !path.isAbsolute(candidate)) throw new ProjectRegistryError(code);
  return path.resolve(candidate);
}

async function requireReadableDirectory(candidate, code) {
  try {
    const [real, stats] = await Promise.all([fs.realpath(candidate), fs.stat(candidate)]);
    if (!stats.isDirectory()) throw new Error("not-directory");
    await fs.access(real, fsConstants.R_OK);
    return real;
  } catch {
    throw new ProjectRegistryError(code);
  }
}

function resolveProjectScript(projectRoot, value, code) {
  const relativeScript = String(value || "").trim();
  if (!relativeScript || path.isAbsolute(relativeScript)) throw new ProjectRegistryError(code);
  const script = path.resolve(projectRoot, relativeScript);
  const relative = path.relative(projectRoot, script);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ProjectRegistryError(code);
  return script;
}

function requireLoopbackUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error("not-loopback");
    return parsed.toString();
  } catch {
    throw new ProjectRegistryError("PROJECT_URL_INVALID");
  }
}

function requireAllowedHosts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProjectRegistryError("PROJECT_ALLOWED_HOSTS_INVALID");
  return value.map((host) => String(host || "").trim()).filter(Boolean).map((host) => {
    if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.endsWith(".")) {
      throw new ProjectRegistryError("PROJECT_ALLOWED_HOSTS_INVALID");
    }
    return host;
  });
}

async function requireProjectScript(projectRoot, candidate, code) {
  try {
    const [real, stats] = await Promise.all([fs.realpath(candidate), fs.stat(candidate)]);
    const relative = path.relative(projectRoot, real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !stats.isFile()) {
      throw new Error("script-outside-project");
    }
    await fs.access(real, fsConstants.X_OK);
    return real;
  } catch {
    throw new ProjectRegistryError(code);
  }
}

function registryFile(vaultRoot, environment) {
  const configured = String(environment.INFANS_PROJECT_REGISTRY || "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new ProjectRegistryError("REGISTRY_PATH_NOT_ABSOLUTE");
    return path.resolve(configured);
  }
  return path.join(path.resolve(vaultRoot), DEFAULT_REGISTRY_RELATIVE);
}

async function readRegistryDocument(vaultRoot, environment) {
  let document;
  try {
    document = JSON.parse(await fs.readFile(registryFile(vaultRoot, environment), "utf8"));
  } catch (error) {
    if (error instanceof ProjectRegistryError) throw error;
    throw new ProjectRegistryError(error?.code === "ENOENT" ? "REGISTRY_MISSING" : "REGISTRY_INVALID");
  }
  if (document?.version !== 1 || !document.projects || typeof document.projects !== "object") {
    throw new ProjectRegistryError("REGISTRY_SCHEMA_INVALID");
  }
  return document;
}

export async function readRegisteredProject(vaultRoot, projectId, options = {}) {
  const environment = options.environment || process.env;
  const document = await readRegistryDocument(vaultRoot, environment);
  const entry = document.projects[projectId];
  if (!entry || typeof entry !== "object") throw new ProjectRegistryError("PROJECT_NOT_REGISTERED", "该项目尚未注册。");

  const configuredRoot = requireAbsoluteDirectory(entry.root, "PROJECT_ROOT_INVALID");
  const configuredDataRoot = requireAbsoluteDirectory(entry.dataRoot, "PROJECT_DATA_ROOT_INVALID");
  const root = await requireReadableDirectory(configuredRoot, "PROJECT_ROOT_UNAVAILABLE");
  const dataRoot = await requireReadableDirectory(configuredDataRoot, "PROJECT_DATA_ROOT_UNAVAILABLE");
  const configuredStartScript = resolveProjectScript(configuredRoot, entry.startScript, "PROJECT_START_SCRIPT_INVALID");
  const configuredLaunchScript = resolveProjectScript(configuredRoot, entry.launchScript, "PROJECT_LAUNCH_SCRIPT_INVALID");
  const startScript = await requireProjectScript(root, configuredStartScript, "PROJECT_START_SCRIPT_UNAVAILABLE");
  const launchScript = await requireProjectScript(root, configuredLaunchScript, "PROJECT_LAUNCH_SCRIPT_UNAVAILABLE");

  return Object.freeze({
    id: projectId,
    root,
    dataRoot,
    url: requireLoopbackUrl(entry.url),
    startScript,
    launchScript,
    allowedHosts: requireAllowedHosts(entry.allowedHosts),
  });
}

export async function readRegisteredExperience(vaultRoot, projectId, options = {}) {
  const environment = options.environment || process.env;
  const document = await readRegistryDocument(vaultRoot, environment);
  const entry = document.projects[projectId];
  if (!entry?.experience || typeof entry.experience !== "object") {
    throw new ProjectRegistryError("EXPERIENCE_NOT_REGISTERED", "这个项目还没有登记本地启动器。");
  }

  const root = await requireReadableDirectory(requireAbsoluteDirectory(entry.root, "PROJECT_ROOT_INVALID"), "PROJECT_ROOT_UNAVAILABLE");
  const type = String(entry.experience.type || "").trim();
  if (type === "godot") {
    try {
      await Promise.all([
        fs.access(GODOT_BINARY, fsConstants.X_OK),
        fs.access(path.join(root, "project.godot"), fsConstants.R_OK),
      ]);
    } catch {
      throw new ProjectRegistryError("GODOT_EXPERIENCE_UNAVAILABLE", "Godot 或项目入口现在不可用。");
    }
    return Object.freeze({ id: projectId, type, root, command: GODOT_BINARY, args: ["--path", root], url: null });
  }

  if (type === "web-dev") {
    const manager = String(entry.experience.manager || "").trim();
    const port = Number(entry.experience.port);
    if (!WEB_MANAGERS.has(manager) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new ProjectRegistryError("WEB_EXPERIENCE_INVALID", "网页试玩启动器配置不完整。");
    }
    try {
      await fs.access(path.join(root, "package.json"), fsConstants.R_OK);
    } catch {
      throw new ProjectRegistryError("WEB_EXPERIENCE_UNAVAILABLE", "网页试玩工程现在不可用。");
    }
    return Object.freeze({
      id: projectId,
      type,
      root,
      command: manager,
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      url: `http://127.0.0.1:${port}/`,
    });
  }

  throw new ProjectRegistryError("EXPERIENCE_TYPE_INVALID", "这个项目的启动方式还不支持。");
}

export function registeredProjectEnvironment(project, environment = process.env) {
  return {
    ...environment,
    COACHING_VAULT_ROOT: project.dataRoot,
    COACHING_ALLOWED_HOSTS: project.allowedHosts.join(","),
  };
}

export async function launchRegisteredProject(vaultRoot, projectId, mode = "start", options = {}) {
  const project = await readRegisteredProject(vaultRoot, projectId, options);
  const script = mode === "chrome" ? project.launchScript : project.startScript;
  const child = spawn("/bin/bash", [script], {
    cwd: project.root,
    detached: true,
    stdio: "ignore",
    env: registeredProjectEnvironment(project, options.environment || process.env),
  });
  child.unref();
  return { id: project.id, url: project.url, mode };
}

export async function launchRegisteredExperience(vaultRoot, projectId, options = {}) {
  const experience = await readRegisteredExperience(vaultRoot, projectId, options);
  const child = spawn(experience.command, experience.args, {
    cwd: experience.root,
    detached: true,
    stdio: "ignore",
    env: options.environment || process.env,
  });
  child.unref();
  return { id: experience.id, type: experience.type, url: experience.url };
}
