import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";

import { WorkbenchWriteError } from "./workbench-errors.mjs";

const DEFAULT_CODEX_COMMAND = "/Applications/ChatGPT.app/Contents/Resources/codex";
const TASK_TITLE = "性能诊断／Codex 安全清理";
const SECTION_NAME = "工作区";
const TASK_TIMEOUT_MS = 2 * 60 * 60_000;

export function buildCodexCleanupPrompt() {
  return [
    "这是 Capoo 从小秘书「异常雷达」明确发起的一次本机安全清理任务。请先诊断，再只处理你能证明安全且可恢复的项目；本次点击仅授权下述窄范围，不是全盘删除授权。",
    "",
    "允许范围：过期且可再生的临时文件、构建残留、预览产物、明确无用的缓存与轮转日志。执行前重新解析每个目标的真实绝对路径、类型、大小、最近修改时间和是否为符号链接；不要使用未解析环境变量、宽泛通配符或覆盖大目录的递归命令。",
    "",
    "禁止范围：Infans_Vault 原件及其 Git 工作区、任何项目源码或未提交改动、本人文档/照片/音视频、凭据与钥匙串、浏览器与聊天记录、应用数据库、系统文件、已挂载 NAS 及其任何原件。不要结束终端、服务或普通应用进程；进程处置必须另行获得本人确认。",
    "",
    "处置规则：不确定就保留；能恢复时只移入 macOS 废纸篓，不永久删除。若需要越出当前工作区，必须通过 Codex 自己的权限请求与自动审批复核，不得绕过沙箱。遇到审批拒绝就保持原样，并在结果里说明。",
    "",
    "完成后请用简短中文报告：检查了什么、实际移动了哪些类别和总大小、哪些因不确定或权限原因保留、是否仍有 CPU/写盘异常线索。不要在报告中暴露凭据、完整私人路径或完整命令行。若没有足够安全的候选项，明确回复本次未清理任何内容。",
  ].join("\n");
}

function cleanError(value, fallback = "Codex 任务暂时没有启动") {
  return String(value || fallback).replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
}

function sectionRows(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.sections)) return result.sections;
  return [];
}

export function resolveWorkbenchSectionId(result, name = SECTION_NAME) {
  const matches = sectionRows(result).filter((section) => String(section?.name || "").trim() === name);
  return matches.length === 1 ? String(matches[0].id || matches[0].sectionId || "") : "";
}

function defaultSnapshot() {
  return {
    ok: true,
    status: "idle",
    title: TASK_TITLE,
    threadId: null,
    requestedAt: null,
    updatedAt: null,
    message: "需要时一键交给 Codex；网页本身没有扫描、移动或删除能力。",
  };
}

export function createCodexCleanupService(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const codexCommand = options.codexCommand || process.env.INFANS_CODEX_BIN || DEFAULT_CODEX_COMMAND;
  const spawnProcess = options.spawnProcess;
  let latest = defaultSnapshot();
  let active = null;
  let dispatching = null;

  function read() {
    return { ...latest };
  }

  async function dispatchOne() {
    if (active && (latest.status === "starting" || latest.status === "running")) {
      return { ...latest, duplicate: true };
    }

    const requestedAt = new Date().toISOString();
    latest = {
      ...defaultSnapshot(),
      status: "starting",
      requestedAt,
      updatedAt: requestedAt,
      message: "正在把任务交给 Codex…",
    };

    const child = spawnProcess
      ? spawnProcess(codexCommand, ["app-server", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(codexCommand, ["app-server", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const connection = new EventEmitter();
    const pending = new Map();
    let nextId = 1;
    let stderr = "";
    let finished = false;

    const closePending = (error) => {
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    };

    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message || "Codex App Server 返回错误"));
        else request.resolve(message.result);
        return;
      }
      if (message.method === "turn/completed" && message.params?.turn?.id === active?.turnId) {
        finished = true;
        const status = String(message.params.turn.status || "completed");
        latest = {
          ...latest,
          status: status === "completed" ? "completed" : "failed",
          updatedAt: new Date().toISOString(),
          message: status === "completed" ? "Codex 已完成这次安全清理，请到任务里看结果。" : `Codex 任务已结束：${cleanError(status)}`,
        };
        connection.emit("completed");
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on("error", (error) => {
      closePending(error);
      if (!finished) {
        latest = { ...latest, status: "failed", updatedAt: new Date().toISOString(), message: cleanError(error.message) };
      }
      connection.emit("failed", error);
    });
    child.on("exit", (code, signal) => {
      const error = new Error(cleanError(stderr, `Codex App Server 已退出（${signal || code || "未知"}）`));
      closePending(error);
      if (!finished && latest.status !== "completed") {
        latest = { ...latest, status: "failed", updatedAt: new Date().toISOString(), message: error.message };
      }
      active = null;
      connection.emit("exit");
    });

    const timer = setTimeout(() => {
      if (active?.child !== child || finished) return;
      latest = { ...latest, status: "failed", updatedAt: new Date().toISOString(), message: "Codex 任务超过两小时，已停止本次连接；请到任务里核对实际状态。" };
      child.kill("SIGTERM");
    }, options.timeoutMs || TASK_TIMEOUT_MS);
    timer.unref?.();
    connection.once("exit", () => clearTimeout(timer));

    try {
      await rpc("initialize", { clientInfo: { name: "infans_workbench", title: "Infans 小秘书", version: "1.0.0" } });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

      const sectionResult = await rpc("threadSection/list", { limit: 100 });
      const sectionId = resolveWorkbenchSectionId(sectionResult);
      if (!sectionId) throw new Error("Codex 侧没有唯一的“工作区”分区，任务没有发起");

      const threadResult = await rpc("thread/start", {
        cwd: root,
        ephemeral: false,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        serviceName: "infans_performance_diagnosis",
      });
      const threadId = String(threadResult?.thread?.id || "");
      if (!threadId) throw new Error("Codex 没有返回任务编号");
      await rpc("thread/name/set", { threadId, name: TASK_TITLE });
      await rpc("thread/section/move", { threadId, sectionId });
      const turnResult = await rpc("turn/start", {
        threadId,
        input: [{ type: "text", text: buildCodexCleanupPrompt() }],
      });
      const turnId = String(turnResult?.turn?.id || "");
      if (!turnId) throw new Error("Codex 没有确认开始处理");
      active = { child, threadId, turnId, connection };
      latest = {
        ok: true,
        status: "running",
        title: TASK_TITLE,
        threadId,
        requestedAt,
        updatedAt: new Date().toISOString(),
        message: "已交给 Codex，任务正在“工作区”里处理。",
      };
      return { ...latest, duplicate: false };
    } catch (error) {
      child.stdin.end();
      child.kill("SIGTERM");
      latest = { ...latest, status: "failed", updatedAt: new Date().toISOString(), message: cleanError(error.message) };
      throw new WorkbenchWriteError(latest.message, 503, "CODEX_TASK_DISPATCH_FAILED");
    }
  }

  async function dispatch() {
    if (dispatching) {
      try { await dispatching; } catch { /* 返回同一次失败，不再重复创建任务。 */ }
      if (latest.status === "running") return { ...latest, duplicate: true };
      throw new WorkbenchWriteError(latest.message, 503, "CODEX_TASK_DISPATCH_FAILED");
    }
    if (active && (latest.status === "starting" || latest.status === "running")) return { ...latest, duplicate: true };
    dispatching = dispatchOne();
    try { return await dispatching; }
    finally { dispatching = null; }
  }

  function dispose() {
    if (active?.child && !active.child.killed) active.child.kill("SIGTERM");
    active = null;
  }

  return { dispatch, read, dispose };
}
