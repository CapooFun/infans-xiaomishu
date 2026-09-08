import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { classifyUnifiedReminderIntent } from "./workbench-unified-reminder-router.mjs";
import { DEFAULT_SECRETARY_ID, interpretSecretaryDictation, normalizeSecretaryId, secretaryProfileById } from "../secretary-identity.mjs";

const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXCLUDED_WATCH_SOURCES = new Set(["apple_watch_app", "apple_watch_siri"]);
const ALLOWED_SOURCES = new Set(["apple_watch_app", "apple_watch_siri"]);
const ALLOWED_ROUTES = new Set(["auto", "codex", "companion"]);
const ALLOWED_ACTION_KINDS = new Set(["addTodo", "journal", "calendarCreate", "editFile", "unifiedReminder", "secretaryMonitor"]);
const DEVICE_DELIVERY_STAGES = new Set(["phone_reply_received", "watch_reply_persisted", "watch_reply_available", "user_seen"]);
const DELIVERY_STAGE_RANK = new Map([
  ["reply_ready", 0],
  ["phone_reply_received", 1],
  ["watch_reply_persisted", 2],
  ["watch_reply_available", 3],
  ["user_seen", 4],
]);
const CONVERSATION_KEY = /^[a-z0-9._-]{1,80}$/u;
const HIGH_IMPACT = /付款|支付|购买|下单|删除|清空|提交|推送|发给|发(?:消息|邮件)|发送(?:消息|邮件)|转账|汇款|(?:执行|运行)[^\n]{0,12}(?:命令|脚本)/u;
const ACTION_INTENT = /记(?:一下|下来)|安排|待办|日程|提醒|修改|更改|查询(?:任务|待办|项目|进度)|继续(?:刚才|上次)|创建|新增|整理|执行|运行|处理|办(?:一下|理)/u;
const COMPANION_INTENT = /银月|在吗|想你|陪我|聊聊|难过|开心|烦|累了|心情|晚安|早安|谢谢你/u;
const EXPLICIT_CODEX_INTENT = /(?:^|[\s，。！？、])(?:交给|让|请)?\s*codex(?:[\s，。！？、]|$)/iu;

export function classifySecretaryRoute(text, requestedRoute = "auto") {
  const highImpact = HIGH_IMPACT.test(text);
  const explicitCodex = EXPLICIT_CODEX_INTENT.test(text);
  const action = highImpact || ACTION_INTENT.test(text) || explicitCodex;
  const companion = COMPANION_INTENT.test(text);
  const reminderIntent = classifyUnifiedReminderIntent(text);
  const reminderRouting = reminderIntent ? { unifiedReminder: reminderIntent } : {};
  if (highImpact) {
    return { decision: "codex", responseRoute: "codex", actionRoute: "codex", requiresConfirmation: true, ...reminderRouting };
  }
  if (requestedRoute === "codex" || requestedRoute === "companion") {
    return { decision: requestedRoute, responseRoute: requestedRoute, actionRoute: requestedRoute === "codex" ? "codex" : null, requiresConfirmation: false, ...reminderRouting };
  }
  if (explicitCodex) {
    return { decision: "codex", responseRoute: "codex", actionRoute: "codex", requiresConfirmation: false, ...reminderRouting };
  }
  if (action && companion) {
    return { decision: "mixed", responseRoute: "companion", actionRoute: "codex", requiresConfirmation: false, ...reminderRouting };
  }
  if (action) return { decision: "mixed", responseRoute: "companion", actionRoute: "codex", requiresConfirmation: false, ...reminderRouting };
  if (companion) return { decision: "companion", responseRoute: "companion", actionRoute: null, requiresConfirmation: false, ...reminderRouting };
  // Apple Watch 的主入口是与银月对话；没有明确动作意图时由她回答。
  return { decision: "companion", responseRoute: "companion", actionRoute: null, requiresConfirmation: false, ...reminderRouting };
}

/** 历史共享队列路径。开源版不得再回落到这里。 */
export const FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "com.ifans.secretary",
  "codex-command-inbox",
);

export function instanceCodexCommandInboxDir(vaultRoot) {
  const root = String(vaultRoot || "").trim();
  if (!root) {
    throw new WorkbenchWriteError("指令队列必须绑定数据根", 500, "CODEX_COMMAND_INBOX_ROOT_REQUIRED");
  }
  return path.join(path.resolve(root), "00_本地工作台", "派生数据", "codex-command-inbox");
}

export function assertExcludedWatchCommand(input) {
  const source = String(input?.source || "").trim();
  if (EXCLUDED_WATCH_SOURCES.has(source)) {
    throw new WorkbenchWriteError("手表产品不在公开范围", 404, "WATCH_EXCLUDED");
  }
}

export function codexCommandTokenMatches(supplied, expected) {
  const left = Buffer.from(String(supplied || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length >= 43 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function assertCodexCommandDeviceAccess(request, allowedLogins, expectedToken, options = {}) {
  const contentType = String(request.headers?.["content-type"] || "");
  if (options.requireJson !== false && !contentType.startsWith("application/json")) {
    throw new WorkbenchWriteError("指令请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
  }
  const authorization = String(request.headers?.authorization || "");
  const suppliedToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!codexCommandTokenMatches(suppliedToken, expectedToken)) {
    throw new WorkbenchWriteError("小秘书指令设备未配对", 403, "CODEX_COMMAND_DEVICE_DENIED");
  }
  const host = String(request.headers?.host || "");
  const origin = String(request.headers?.origin || "");
  const peer = String(request.socket?.remoteAddress || "");
  const loopbackPeer = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (/^127\.0\.0\.1:\d{2,5}$/u.test(host)) {
    const chromeExtensionOrigin = options.allowChromeExtensionOrigin === true
      && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin);
    if (!loopbackPeer || (origin && origin !== `http://${host}` && !chromeExtensionOrigin)) {
      throw new WorkbenchWriteError("小秘书指令没有通过本机身份校验", 403, "CODEX_COMMAND_ACCESS_DENIED");
    }
    return;
  }
  const hostname = host.split(":")[0].toLowerCase();
  const login = String(request.headers?.["tailscale-user-login"] || "").trim().toLowerCase();
  const allowlist = new Set(String(allowedLogins || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const trusted = hostname === "mailbox.example.invalid"
    && host === hostname
    && loopbackPeer
    && (!origin || origin === `https://${host}`)
    && login.length > 0
    && login.length <= 512
    && !/[\r\n]/u.test(login)
    && allowlist.size > 0
    && allowlist.has(login);
  if (!trusted) {
    throw new WorkbenchWriteError("小秘书指令没有通过 Tailscale 身份校验", 403, "CODEX_COMMAND_ACCESS_DENIED");
  }
}

export function normalizeCodexCommand(input) {
  const commandId = String(input?.commandId || "").trim().toLowerCase();
  const text = String(input?.text || "").trim();
  const createdAt = String(input?.createdAt || "").trim();
  const source = String(input?.source || "").trim();
  const deviceId = String(input?.deviceId || "").trim().toLowerCase();
  const route = String(input?.route || "auto").trim().toLowerCase();
  const conversationKey = String(input?.conversationKey || "watch-default").trim().toLowerCase();
  const phoneReceivedAt = String(input?.phoneReceivedAt || "").trim();
  if (Number(input?.schemaVersion) !== 1) {
    throw new WorkbenchWriteError("指令版本不受支持", 400, "CODEX_COMMAND_SCHEMA_INVALID");
  }
  if (!COMMAND_ID.test(commandId)) {
    throw new WorkbenchWriteError("指令 ID 不合法", 400, "CODEX_COMMAND_ID_INVALID");
  }
  if (!text || text.length > 4_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    throw new WorkbenchWriteError("指令正文必须是 1–4000 个可读字符", 400, "CODEX_COMMAND_TEXT_INVALID");
  }
  const created = new Date(createdAt);
  if (!createdAt || Number.isNaN(created.getTime())) {
    throw new WorkbenchWriteError("指令时间不合法", 400, "CODEX_COMMAND_TIME_INVALID");
  }
  if (!ALLOWED_SOURCES.has(source)) {
    throw new WorkbenchWriteError("指令来源不在白名单", 400, "CODEX_COMMAND_SOURCE_INVALID");
  }
  if (!deviceId || deviceId.length > 128 || !/^[a-z0-9._-]+$/u.test(deviceId)) {
    throw new WorkbenchWriteError("设备标识不合法", 400, "CODEX_COMMAND_DEVICE_INVALID");
  }
  if (!ALLOWED_ROUTES.has(route)) {
    throw new WorkbenchWriteError("指令路由不受支持", 400, "CODEX_COMMAND_ROUTE_INVALID");
  }
  if (!CONVERSATION_KEY.test(conversationKey)) {
    throw new WorkbenchWriteError("对话标识不合法", 400, "CODEX_COMMAND_CONVERSATION_INVALID");
  }
  const phoneReceived = phoneReceivedAt ? new Date(phoneReceivedAt) : null;
  if (phoneReceivedAt && Number.isNaN(phoneReceived?.getTime())) {
    throw new WorkbenchWriteError("iPhone 收件时间不合法", 400, "CODEX_COMMAND_PHONE_TIME_INVALID");
  }
  return {
    schemaVersion: 1,
    commandId,
    text,
    createdAt: created.toISOString(),
    source,
    deviceId,
    route,
    conversationKey,
    ...(phoneReceived ? { phoneReceivedAt: phoneReceived.toISOString() } : {}),
  };
}

function materializeRows(events) {
  const commands = new Map();
  const order = [];
  for (const event of events) {
    const commandId = String(event?.commandId || "");
    if (!commandId) continue;
    if (event.eventType === "assistant_reply") {
      const command = commands.get(commandId);
      if (command) {
        command.reply = event.reply;
        command.status = "reply_ready";
        command.deliveryTrace = { ...command.deliveryTrace, replyCreatedAt: event.at || event.reply?.createdAt };
        command.lastError = null;
      }
      continue;
    }
    if (event.eventType === "assistant_action_state") {
      const command = commands.get(commandId);
      if (command?.reply?.confirmation?.id === event.confirmation?.id) {
        command.reply.confirmation = { ...command.reply.confirmation, ...event.confirmation };
      }
      continue;
    }
    if (event.eventType === "assistant_native_action_result") {
      const command = commands.get(commandId);
      if (command) command.nativeActionResult = event.result;
      continue;
    }
    if (event.eventType === "delivery_state") {
      const command = commands.get(commandId);
      if (command) {
        command.status = event.status;
        command.deliveryTrace = { ...command.deliveryTrace, ...(event.traceKey ? { [event.traceKey]: event.at } : {}) };
        command.lastError = event.error || null;
      }
      continue;
    }
    if (!commands.has(commandId)) order.push(commandId);
    commands.set(commandId, {
      ...event,
      deliveryTrace: {
        watchCreatedAt: event.createdAt,
        ...(event.phoneReceivedAt ? { phoneReceivedAt: event.phoneReceivedAt } : {}),
        macAcceptedAt: event.receivedAt,
      },
    });
  }
  return order.map((commandId) => commands.get(commandId)).filter(Boolean);
}

function publicReplyFor(reply) {
  if (!reply) return null;
  const { pendingAction: _pendingAction, ...safe } = reply;
  return safe;
}

function confirmationSummaryFor(action) {
  if (action.kind === "secretaryMonitor") return String(action.summary || "监控边界不完整，不能执行");
  if (action.kind === "calendarCreate") {
    const when = action.allDay
      ? `${action.start || "时间待确定"}（全天）`
      : `${action.start || "开始时间待确定"} 至 ${action.end || "结束时间待确定"}`;
    return `日程：${action.title || "未命名"}\n日历：${action.calendar || "默认"}\n时间：${when}`;
  }
  if (action.kind === "addTodo") {
    const scope = action.scope === "project" ? `项目 ${action.projectId || "待确定"}` : action.scope === "longTerm" ? "长期待办" : "今天/本周待办";
    return `${scope}：${action.text || action.summary || "内容待确定"}`;
  }
  if (action.kind === "unifiedReminder") {
    const destination = {
      apple_reminders: "Apple 提醒事项",
      apple_calendar: "Apple 日历",
      alarmkit_alarm: "强提醒",
      alarmkit_timer: "计时器",
    }[action.executor] || "系统提醒";
    const when = action.durationSeconds
      ? `${Math.round(Number(action.durationSeconds) / 60)} 分钟后`
      : action.fireAt
        ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: action.timeZone || "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(action.fireAt))
        : "时间待确定";
    const operation = {
      create: "创建",
      update: "修改",
      cancel: "取消",
      complete: "完成",
      snooze: "稍后提醒",
    }[action.operation] || "执行";
    const safeguard = Array.isArray(action.safeguardExecutors) && action.safeguardExecutors.includes("apple_reminders")
      ? "\n防漏：同时写入 Apple 提醒事项"
      : "";
    return `${operation}${destination}：${action.title || "标题待确定"}\n时间：${when}${safeguard}`;
  }
  if (action.kind === "journal") {
    return `今天日记：${action.text || action.summary || "内容待确定"}`;
  }
  if (action.kind === "editFile") {
    const change = action.newText || action.content || action.summary || "修改内容待确定";
    return `文件：${action.path || "路径待确定"}\n修改：${change}`;
  }
  return String(action.summary || "确认执行这项写入");
}

function receiptFor(row, duplicate) {
  const deliveryTrace = row.deliveryTrace || {
    watchCreatedAt: row.createdAt,
    ...(row.phoneReceivedAt ? { phoneReceivedAt: row.phoneReceivedAt } : {}),
    macAcceptedAt: row.receivedAt,
  };
  return {
    ok: true,
    duplicate,
    commandId: row.commandId,
    status: row.status || "received",
    receivedAt: row.receivedAt,
    conversationKey: row.conversationKey || "watch-default",
    routing: row.routing,
    expectsReply: row.routing?.responseRoute === "companion",
    deliveryTrace,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.reply ? { reply: publicReplyFor(row.reply) } : {}),
  };
}

function normalizeReply(input, command, now = new Date()) {
  const speaker = normalizeSecretaryId(input?.speaker) || DEFAULT_SECRETARY_ID;
  const profile = secretaryProfileById(speaker) || secretaryProfileById(DEFAULT_SECRETARY_ID);
  const text = String(input?.text || "").trim();
  if (!text || text.length > 6_000) {
    throw new WorkbenchWriteError(`${profile.name}回复正文不合法`, 500, "CODEX_COMMAND_REPLY_INVALID");
  }
  const reply = {
    id: String(input?.id || crypto.randomUUID()).slice(0, 80),
    conversationKey: command.conversationKey || "watch-default",
    commandId: command.commandId,
    speaker,
    speakerName: String(input?.speakerName || profile.name).trim().slice(0, 40),
    notificationTitle: String(input?.notificationTitle || profile.notificationTitle || profile.name).trim().slice(0, 80),
    text,
    createdAt: String(input?.createdAt || now.toISOString()),
  };
  if (["cursor", "codex-subscription"].includes(input?.generation?.backend)) {
    const source = input.generation;
    reply.generation = { backend: source.backend, fallback: source.fallback === true };
    for (const key of ["requestedModel", "reportedModel", "authentication", "fallbackReason"]) {
      if (typeof source[key] === "string") reply.generation[key] = source[key].slice(0, 120);
    }
    for (const key of ["inputTokens", "outputTokens"]) {
      if (Number.isSafeInteger(source[key]) && source[key] >= 0) reply.generation[key] = source[key];
    }
  }
  if (input?.pendingAction && ALLOWED_ACTION_KINDS.has(String(input.pendingAction.kind || ""))) {
    const encoded = JSON.stringify(input.pendingAction);
    if (encoded.length > 24_000) {
      throw new WorkbenchWriteError("待确认动作过大", 500, "CODEX_COMMAND_ACTION_INVALID");
    }
    const pendingAction = JSON.parse(encoded);
    reply.pendingAction = pendingAction;
    reply.confirmation = {
      id: String(input?.confirmationId || crypto.randomUUID()),
      kind: String(pendingAction.kind),
      label: String(pendingAction.label || "确认执行").slice(0, 80),
      summary: confirmationSummaryFor(pendingAction).slice(0, 320),
      state: "pending",
    };
  }
  return reply;
}

export function createCodexCommandInboxService(options = {}) {
  const inboxDir = path.resolve(options.inboxDir || instanceCodexCommandInboxDir(options.root));
  if (inboxDir === path.resolve(FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR)) {
    throw new WorkbenchWriteError("指令队列不能使用共享 HOME 目录", 500, "CODEX_COMMAND_INBOX_SHARED_FORBIDDEN");
  }
  const inboxFile = path.join(inboxDir, "inbox.jsonl");
  let serial = Promise.resolve();
  const replyOperations = new Map();
  const actionOperations = new Map();

  async function ensureInbox() {
    await fs.mkdir(inboxDir, { recursive: true, mode: 0o700 });
    await fs.chmod(inboxDir, 0o700).catch(() => {});
  }

  async function rows() {
    try {
      return (await fs.readFile(inboxFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function acceptUnlocked(input, now = new Date()) {
    assertExcludedWatchCommand(input);
    const command = normalizeCodexCommand(input);
    await ensureInbox();
    const existing = materializeRows(await rows()).find((row) => row.commandId === command.commandId);
    if (existing) {
      return receiptFor(existing, true);
    }
    const row = {
      ...command,
      routing: classifySecretaryRoute(interpretSecretaryDictation(command.text), command.route),
      receivedAt: now.toISOString(),
      status: "mac_accepted",
    };
    await fs.appendFile(inboxFile, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(inboxFile, 0o600).catch(() => {});
    return receiptFor(row, false);
  }

  async function findCommand(commandId) {
    return materializeRows(await rows()).find((row) => row.commandId === commandId) || null;
  }

  async function ensureReply(commandId, generateReply, now = new Date()) {
    const key = String(commandId || "").toLowerCase();
    if (!COMMAND_ID.test(key)) {
      throw new WorkbenchWriteError("指令 ID 不合法", 400, "CODEX_COMMAND_ID_INVALID");
    }
    const existingOperation = replyOperations.get(key);
    if (existingOperation) return existingOperation;
    const operation = (async () => {
      await ensureInbox();
      const command = await findCommand(key);
      if (!command) throw new WorkbenchWriteError("找不到该指令", 404, "CODEX_COMMAND_NOT_FOUND");
      if (command.reply) return publicReplyFor(command.reply);
      await appendDeliveryState(key, "reply_generating", "replyStartedAt", new Date());
      try {
        const reply = normalizeReply(await generateReply(command), command, now);
        await fs.appendFile(inboxFile, `${JSON.stringify({
          eventType: "assistant_reply",
          commandId: key,
          at: new Date().toISOString(),
          reply,
        })}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(inboxFile, 0o600).catch(() => {});
        return publicReplyFor(reply);
      } catch (error) {
        await appendDeliveryState(
          key,
          "failed",
          "replyFailedAt",
          new Date(),
          String(error instanceof Error ? error.message : "回复生成失败").slice(0, 240),
        );
        throw error;
      }
    })();
    replyOperations.set(key, operation);
    try {
      return await operation;
    } finally {
      replyOperations.delete(key);
    }
  }

  async function appendActionState(commandId, confirmation) {
    await fs.appendFile(inboxFile, `${JSON.stringify({
      eventType: "assistant_action_state",
      commandId,
      confirmation,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(inboxFile, 0o600).catch(() => {});
  }

  async function appendDeliveryState(commandId, status, traceKey, now = new Date(), error = null) {
    await ensureInbox();
    await fs.appendFile(inboxFile, `${JSON.stringify({
      eventType: "delivery_state",
      commandId,
      status,
      traceKey,
      at: now.toISOString(),
      ...(error ? { error } : {}),
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(inboxFile, 0o600).catch(() => {});
  }

  async function receipt(commandId, deviceId) {
    const key = String(commandId || "").trim().toLowerCase();
    const normalizedDeviceId = String(deviceId || "").trim().toLowerCase();
    if (!COMMAND_ID.test(key) || !normalizedDeviceId) {
      throw new WorkbenchWriteError("回复查询不完整", 400, "CODEX_COMMAND_REPLY_QUERY_INVALID");
    }
    const command = await findCommand(key);
    if (!command || command.deviceId !== normalizedDeviceId) {
      throw new WorkbenchWriteError("找不到该设备的指令", 404, "CODEX_COMMAND_NOT_FOUND");
    }
    return receiptFor(command, true);
  }

  async function acknowledgeDelivery(input, now = new Date()) {
    const commandId = String(input?.commandId || "").trim().toLowerCase();
    const deviceId = String(input?.deviceId || "").trim().toLowerCase();
    const stage = String(input?.stage || "").trim().toLowerCase();
    if (!COMMAND_ID.test(commandId) || !deviceId || !DEVICE_DELIVERY_STAGES.has(stage)) {
      throw new WorkbenchWriteError("逐跳确认不完整", 400, "CODEX_COMMAND_DELIVERY_ACK_INVALID");
    }
    const command = await findCommand(commandId);
    if (!command || command.deviceId !== deviceId || !command.reply) {
      throw new WorkbenchWriteError("找不到可确认的设备回复", 404, "CODEX_COMMAND_DELIVERY_ACK_NOT_FOUND");
    }
    const traceKey = {
      phone_reply_received: "phoneReplyReceivedAt",
      watch_reply_persisted: "watchReplyPersistedAt",
      watch_reply_available: "watchReplyAvailableAt",
      user_seen: "userSeenAt",
    }[stage];
    if (!command.deliveryTrace?.[traceKey]) {
      const currentRank = DELIVERY_STAGE_RANK.get(command.status) ?? -1;
      const nextStatus = (DELIVERY_STAGE_RANK.get(stage) ?? -1) >= currentRank ? stage : command.status;
      await appendDeliveryState(commandId, nextStatus, traceKey, now);
    }
    return receipt(commandId, deviceId);
  }

  async function confirmAction(input, applyAction) {
    const commandId = String(input?.commandId || "").trim().toLowerCase();
    const confirmationId = String(input?.confirmationId || "").trim();
    const deviceId = String(input?.deviceId || "").trim().toLowerCase();
    const decision = input?.decision === "cancel" ? "cancel" : input?.decision === "confirm" ? "confirm" : "";
    if (!COMMAND_ID.test(commandId) || !confirmationId || !deviceId || !decision) {
      throw new WorkbenchWriteError("确认请求不完整", 400, "CODEX_COMMAND_CONFIRMATION_INVALID");
    }
    const operationKey = `${commandId}:${confirmationId}`;
    const existingOperation = actionOperations.get(operationKey);
    if (existingOperation) return existingOperation;
    const operation = (async () => {
      const command = await findCommand(commandId);
      if (!command || command.deviceId !== deviceId) {
        throw new WorkbenchWriteError("找不到该设备的待确认动作", 404, "CODEX_COMMAND_CONFIRMATION_NOT_FOUND");
      }
      const reply = command.reply;
      if (!reply?.pendingAction || reply.confirmation?.id !== confirmationId) {
        throw new WorkbenchWriteError("待确认动作已经失效", 409, "CODEX_COMMAND_CONFIRMATION_EXPIRED");
      }
      if (["completed", "cancelled"].includes(reply.confirmation.state)) {
        return { ok: true, actionApplied: reply.confirmation.state === "completed", reply: publicReplyFor(reply) };
      }
      if (decision === "cancel") {
        await appendActionState(commandId, { id: confirmationId, state: "cancelled", decidedAt: new Date().toISOString() });
        const updated = await findCommand(commandId);
        return { ok: true, actionApplied: false, reply: publicReplyFor(updated.reply) };
      }
      try {
        const result = await applyAction(reply.pendingAction, command);
        if (result?.nativeAction) {
          return {
            ok: true,
            actionApplied: false,
            nativeAction: result.nativeAction,
            reply: publicReplyFor(reply),
          };
        }
        await appendActionState(commandId, {
          id: confirmationId,
          state: "completed",
          decidedAt: new Date().toISOString(),
          result: String(result?.summary || "已完成").slice(0, 240),
        });
        const updated = await findCommand(commandId);
        return { ok: true, actionApplied: true, reply: publicReplyFor(updated.reply) };
      } catch (error) {
        await appendActionState(commandId, {
          id: confirmationId,
          state: "failed",
          decidedAt: new Date().toISOString(),
          error: String(error instanceof Error ? error.message : "执行失败").slice(0, 240),
        });
        const updated = await findCommand(commandId);
        return { ok: true, actionApplied: false, reply: publicReplyFor(updated.reply) };
      }
    })();
    actionOperations.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      actionOperations.delete(operationKey);
    }
  }

  async function completeNativeAction(input) {
    const commandId = String(input?.commandId || "").trim().toLowerCase();
    const confirmationId = String(input?.confirmationId || "").trim();
    const deviceId = String(input?.deviceId || "").trim().toLowerCase();
    const success = input?.success === true;
    if (Number(input?.schemaVersion) !== 1 || !COMMAND_ID.test(commandId) || !confirmationId || !deviceId) {
      throw new WorkbenchWriteError("本机执行结果不完整", 400, "CODEX_COMMAND_NATIVE_RESULT_INVALID");
    }
    const command = await findCommand(commandId);
    if (!command || command.deviceId !== deviceId || command.reply?.confirmation?.id !== confirmationId) {
      throw new WorkbenchWriteError("找不到该设备的本机提醒动作", 404, "CODEX_COMMAND_NATIVE_RESULT_NOT_FOUND");
    }
    if (["completed", "cancelled"].includes(command.reply.confirmation.state)) {
      return { ok: true, actionApplied: command.reply.confirmation.state === "completed", reply: publicReplyFor(command.reply) };
    }
    const result = input?.result && typeof input.result === "object" ? input.result : null;
    const warningText = Array.isArray(result?.warnings)
      ? result.warnings.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 2).join("；")
      : "";
    const summary = `${String(result?.summary || "已在 iPhone 完成").trim()}${warningText ? `；注意：${warningText}` : ""}`.slice(0, 240);
    const error = String(input?.error || "iPhone 本机执行失败").trim().slice(0, 240);
    if (success && result) {
      const pendingAction = command.reply.pendingAction;
      const nativeResult = {
        schemaVersion: 1,
        actionID: String(result.actionID || pendingAction.actionID || "").slice(0, 160),
        executor: String(result.executor || pendingAction.executor || "").slice(0, 80),
        operation: String(result.operation || pendingAction.operation || "").slice(0, 40),
        nativeID: String(result.nativeID || "").slice(0, 512),
        title: String(pendingAction.title || "").slice(0, 160),
        ...(pendingAction.fireAt ? { fireAt: String(pendingAction.fireAt) } : {}),
        ...(pendingAction.endAt ? { endAt: String(pendingAction.endAt) } : {}),
        ...(Array.isArray(pendingAction.safeguardExecutors) ? { safeguardExecutors: pendingAction.safeguardExecutors.slice(0, 4) } : {}),
        completedAt: String(result.completedAt || new Date().toISOString()),
      };
      if (nativeResult.actionID && nativeResult.executor && nativeResult.operation && nativeResult.nativeID) {
        await fs.appendFile(inboxFile, `${JSON.stringify({
          eventType: "assistant_native_action_result",
          commandId,
          result: nativeResult,
        })}\n`, { encoding: "utf8", mode: 0o600 });
      }
    }
    await appendActionState(commandId, success
      ? { id: confirmationId, state: "completed", decidedAt: new Date().toISOString(), result: summary }
      : { id: confirmationId, state: "failed", decidedAt: new Date().toISOString(), error });
    const updated = await findCommand(commandId);
    return { ok: true, actionApplied: success, reply: publicReplyFor(updated.reply) };
  }

  async function findRecentNativeActionTarget(commandId) {
    const key = String(commandId || "").trim().toLowerCase();
    const all = materializeRows(await rows());
    const currentIndex = all.findIndex((row) => row.commandId === key);
    if (currentIndex < 0) return null;
    const current = all[currentIndex];
    const latestByAction = new Map();
    for (const row of all.slice(0, currentIndex)) {
      const result = row.nativeActionResult;
      if (!result?.actionID || row.deviceId !== current.deviceId || row.conversationKey !== current.conversationKey) continue;
      latestByAction.set(result.actionID, result);
    }
    const active = [...latestByAction.values()].filter((result) => result.nativeID && !["cancel", "complete"].includes(result.operation));
    if (!active.length) return null;
    const text = interpretSecretaryDictation(current.text).replace(/\s+/gu, "");
    const titleMatches = active.filter((result) => {
      const title = String(result.title || "").replace(/\s+/gu, "");
      return title.length >= 2 && text.includes(title);
    });
    const target = titleMatches.at(-1)
      || (/刚才|上一个|上一条|那个|这条|它/u.test(text) ? active.at(-1) : null)
      || (active.length === 1 ? active[0] : null);
    return target ? { ...target } : null;
  }

  return {
    inboxDir,
    inboxFile,
    accept(input, now) {
      const operation = serial.then(() => acceptUnlocked(input, now));
      serial = operation.catch(() => {});
      return operation;
    },
    get(commandId) {
      return findCommand(String(commandId || "").toLowerCase());
    },
    ensureReply,
    receipt,
    acknowledgeDelivery,
    confirmAction,
    completeNativeAction,
    findRecentNativeActionTarget,
    async list(limit = 20) {
      const safeLimit = Math.max(1, Math.min(100, Number(limit)) || 20);
      return materializeRows(await rows()).slice(-safeLimit).reverse();
    },
  };
}
