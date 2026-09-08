import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCodexCommandDeviceAccess,
  assertExcludedWatchCommand,
  classifySecretaryRoute,
  codexCommandTokenMatches,
  createCodexCommandInboxService,
  FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR,
  instanceCodexCommandInboxDir,
  normalizeCodexCommand,
} from "../src/server/workbench-codex-command-inbox.mjs";
import { interpretSecretaryDictation } from "../src/secretary-identity.mjs";

const TOKEN = "a".repeat(64);
const COMMAND = {
  schemaVersion: 1,
  commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
  text: "  记一下明天和某人吃饭  ",
  createdAt: "2026-08-28T01:02:03Z",
  source: "apple_watch_app",
  deviceId: "watch-01",
  route: "auto",
};

async function plantAccepted(dir, command, extra = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const normalized = normalizeCodexCommand(command);
  const row = {
    ...normalized,
    routing: classifySecretaryRoute(interpretSecretaryDictation(normalized.text), command.route),
    receivedAt: extra.receivedAt || "2026-08-28T02:00:00.000Z",
    status: "mac_accepted",
  };
  await fs.appendFile(path.join(dir, "inbox.jsonl"), `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  return createCodexCommandInboxService({ inboxDir: dir });
}

test("小秘书指令令牌定长比较且空配置默认拒绝", () => {
  assert.equal(codexCommandTokenMatches(TOKEN, TOKEN), true);
  assert.equal(codexCommandTokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(codexCommandTokenMatches("", ""), false);
});

test("只接受自然语言原话与最小白名单元数据", () => {
  assert.deepEqual(normalizeCodexCommand({ ...COMMAND, heartRate: 120, location: "x" }), {
    ...COMMAND,
    text: "记一下明天和某人吃饭",
    createdAt: "2026-08-28T01:02:03.000Z",
    conversationKey: "watch-default",
  });
  assert.throws(() => normalizeCodexCommand({ ...COMMAND, text: "" }), /1–4000/);
  assert.throws(() => normalizeCodexCommand({ ...COMMAND, source: "healthkit" }), /来源/);
});

test("统一入口按动作、闲聊与混合分流，普通提问默认由银月回答", () => {
  const calendar = classifySecretaryRoute("记一下明天和某人吃饭");
  assert.deepEqual({
    decision: calendar.decision,
    responseRoute: calendar.responseRoute,
    actionRoute: calendar.actionRoute,
    requiresConfirmation: calendar.requiresConfirmation,
  }, {
    decision: "mixed", responseRoute: "companion", actionRoute: "codex", requiresConfirmation: false,
  });
  assert.equal(calendar.unifiedReminder?.executor, "apple_calendar");
  assert.equal(classifySecretaryRoute("银月我今天有点累").decision, "companion");
  const mixed = classifySecretaryRoute("银月陪我聊聊，再记一下明天交作业");
  assert.deepEqual({
    decision: mixed.decision,
    responseRoute: mixed.responseRoute,
    actionRoute: mixed.actionRoute,
    requiresConfirmation: mixed.requiresConfirmation,
  }, {
    decision: "mixed", responseRoute: "companion", actionRoute: "codex", requiresConfirmation: false,
  });
  assert.equal(mixed.unifiedReminder?.executor, "apple_reminders");
  assert.equal(classifySecretaryRoute("蓝色很好看").decision, "companion");
  assert.equal(classifySecretaryRoute("请 Codex 检查项目").decision, "codex");
  assert.equal(classifySecretaryRoute("帮我付款买这个").requiresConfirmation, true);
  assert.equal(classifySecretaryRoute("运行这个命令").requiresConfirmation, true);
  assert.equal(classifySecretaryRoute("给某人发邮件").requiresConfirmation, true);
  assert.equal(classifySecretaryRoute("帮我付款买这个", "companion").decision, "codex");
});

test("手表来源在落盘前拒绝，不创建共享或实例队列", async () => {
  const vaultA = await fs.mkdtemp(path.join(os.tmpdir(), "infans-codex-inbox-a-"));
  const vaultB = await fs.mkdtemp(path.join(os.tmpdir(), "infans-codex-inbox-b-"));
  const serviceA = createCodexCommandInboxService({ root: vaultA });
  const serviceB = createCodexCommandInboxService({ root: vaultB });
  assert.notEqual(serviceA.inboxDir, serviceB.inboxDir);
  assert.equal(serviceA.inboxDir, instanceCodexCommandInboxDir(vaultA));
  assert.notEqual(serviceA.inboxDir, FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR);
  for (const route of ["auto", "companion", "codex"]) {
    await assert.rejects(
      () => serviceA.accept({ ...COMMAND, route, commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1" }),
      (error) => error?.code === "WATCH_EXCLUDED" && error.status === 404,
    );
    await assert.rejects(
      () => serviceB.accept({ ...COMMAND, source: "apple_watch_siri", route, commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa2" }),
      /手表产品不在公开范围/,
    );
  }
  assert.equal(await fs.access(serviceA.inboxFile).then(() => true, () => false), false);
  assert.equal(await fs.access(serviceB.inboxFile).then(() => true, () => false), false);
  assert.notEqual(path.resolve(serviceA.inboxDir), path.resolve(FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR));
  assert.deepEqual(await serviceA.list(10), []);
  assert.throws(() => createCodexCommandInboxService({}), /数据根/);
  assert.throws(() => assertExcludedWatchCommand(COMMAND), /手表产品/);
});

test("收件箱持久化、并发去重并返回真实回执", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-codex-inbox-"));
  const service = await plantAccepted(root, COMMAND);
  const [first, second] = await Promise.all([
    service.get(COMMAND.commandId),
    service.get(COMMAND.commandId),
  ]);
  assert.equal(first.status, "mac_accepted");
  assert.equal(second.commandId, first.commandId);
  assert.equal(Date.parse(first.deliveryTrace?.watchCreatedAt || COMMAND.createdAt), Date.parse(COMMAND.createdAt));
  const items = await service.list(10);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "记一下明天和某人吃饭");
  assert.equal(items[0].heartRate, undefined);
  assert.equal(items[0].status, "mac_accepted");
  assert.equal(items[0].routing.decision, "mixed");
});

test("普通提问落盘后可追加一次可重放的银月回复", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-secretary-reply-"));
  const command = { ...COMMAND, commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa2", text: "蓝色很好看" };
  const service = await plantAccepted(root, command);
  const result = await service.get(command.commandId);
  assert.equal(result.status, "mac_accepted");
  assert.equal(result.routing.responseRoute, "companion");
  let generated = 0;
  const [first, second] = await Promise.all([
    service.ensureReply(result.commandId, async () => {
      generated += 1;
      return { id: "reply-1", speaker: "yinyue", text: "嗯，是很安静的蓝。" };
    }),
    service.ensureReply(result.commandId, async () => {
      generated += 1;
      return { id: "reply-2", speaker: "yinyue", text: "不该生成第二次。" };
    }),
  ]);
  assert.equal(generated, 1);
  assert.deepEqual(first, second);
  const items = await service.list(10);
  assert.equal(items[0].routing.decision, "companion");
  assert.equal(items[0].reply.text, "嗯，是很安静的蓝。");
  assert.equal(items[0].reply.speakerName, "银月");
  assert.equal(items[0].reply.notificationTitle, "银月");
  assert.equal(items[0].status, "reply_ready");
  assert.ok(items[0].deliveryTrace.replyStartedAt);
  assert.ok(items[0].deliveryTrace.replyCreatedAt);
  assert.equal(items.length, 1);
  await assert.rejects(() => service.accept(command), /手表产品不在公开范围/);
});

test("设备逐跳确认按原指令和设备写入，重复确认保持幂等", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-secretary-delivery-"));
  const service = await plantAccepted(root, { ...COMMAND, phoneReceivedAt: "2026-08-28T03:00:01.000Z" });
  const receipt = await service.get(COMMAND.commandId);
  await service.ensureReply(receipt.commandId, async () => ({ id: "reply-delivery-1", speaker: "yinyue", text: "我在。" }));
  const phone = await service.acknowledgeDelivery({
    commandId: receipt.commandId,
    deviceId: COMMAND.deviceId,
    stage: "phone_reply_received",
  });
  const watch = await service.acknowledgeDelivery({
    commandId: receipt.commandId,
    deviceId: COMMAND.deviceId,
    stage: "watch_reply_persisted",
  });
  const replay = await service.acknowledgeDelivery({
    commandId: receipt.commandId,
    deviceId: COMMAND.deviceId,
    stage: "watch_reply_persisted",
  });
  assert.equal(phone.status, "phone_reply_received");
  assert.equal(watch.status, "watch_reply_persisted");
  assert.equal(replay.deliveryTrace.watchReplyPersistedAt, watch.deliveryTrace.watchReplyPersistedAt);
  assert.equal((await service.list(1))[0].deliveryTrace.phoneReceivedAt, "2026-08-28T03:00:01.000Z");
});

test("回复中的动作只公开确认摘要，确认后幂等执行一次", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-secretary-confirm-"));
  const command = { ...COMMAND, commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa4" };
  const service = await plantAccepted(root, command);
  const receipt = await service.get(command.commandId);
  const reply = await service.ensureReply(receipt.commandId, async () => ({
    id: "reply-action-1",
    speaker: "yinyue",
    text: "我整理好了，确认后再记。",
    pendingAction: {
      kind: "addTodo",
      scope: "today",
      text: "明天和某人吃饭",
      label: "新增今天/本周待办",
      summary: "明天和某人吃饭",
    },
  }));
  assert.equal(reply.pendingAction, undefined);
  assert.equal(reply.confirmation.state, "pending");
  assert.equal((await service.list(1))[0].reply.pendingAction.kind, "addTodo");

  let applied = 0;
  const request = {
    commandId: receipt.commandId,
    confirmationId: reply.confirmation.id,
    deviceId: COMMAND.deviceId,
    decision: "confirm",
  };
  const first = await service.confirmAction(request, async (action) => {
    applied += 1;
    assert.equal(action.text, "明天和某人吃饭");
    return { summary: "已写入待办" };
  });
  const second = await service.confirmAction(request, async () => {
    applied += 1;
    return { summary: "不该再次执行" };
  });
  assert.equal(applied, 1);
  assert.equal(first.reply.confirmation.state, "completed");
  assert.equal(second.reply.confirmation.result, "已写入待办");
});

test("原生提醒确认后等待 iPhone 真实执行结果，不提前冒充完成", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-native-reminder-confirm-"));
  const commandId = "88cfe608-17e8-4d0d-a4ad-21ab20955aa8";
  const service = await plantAccepted(root, { ...COMMAND, commandId, text: "明天三点提醒我交水电费" });
  const receipt = await service.get(commandId);
  const reply = await service.ensureReply(receipt.commandId, async () => ({
    id: "reply-native-action-1",
    speaker: "yinyue",
    text: "我整理好了，确认后交给 iPhone 创建。",
    pendingAction: {
      kind: "unifiedReminder",
      schemaVersion: 1,
      actionID: commandId,
      executor: "apple_reminders",
      operation: "create",
      title: "交水电费",
      timeZone: "Asia/Tokyo",
      fireAt: "2026-09-02T06:00:00.000Z",
      label: "创建 Apple 提醒事项",
      summary: "交水电费",
    },
  }));
  assert.match(reply.confirmation.summary, /Apple 提醒事项/u);
  assert.match(reply.confirmation.summary, /时间：/u);
  assert.match(reply.confirmation.summary, /15:00/u);
  const request = {
    commandId,
    confirmationId: reply.confirmation.id,
    deviceId: COMMAND.deviceId,
    decision: "confirm",
  };
  const deferred = await service.confirmAction(request, async (action) => ({
    nativeAction: Object.fromEntries(Object.entries(action).filter(([key]) => !["kind", "label", "summary"].includes(key))),
  }));
  assert.equal(deferred.actionApplied, false);
  assert.equal(deferred.reply.confirmation.state, "pending");
  assert.equal(deferred.nativeAction.executor, "apple_reminders");

  const completed = await service.completeNativeAction({
    schemaVersion: 1,
    commandId,
    confirmationId: reply.confirmation.id,
    deviceId: COMMAND.deviceId,
    success: true,
    result: { summary: "已创建 Apple 提醒事项：交水电费", nativeID: "eventkit-1" },
  });
  assert.equal(completed.actionApplied, true);
  assert.equal(completed.reply.confirmation.state, "completed");
  assert.match(completed.reply.confirmation.result, /Apple 提醒事项/u);

  const replay = await service.completeNativeAction({
    schemaVersion: 1,
    commandId,
    confirmationId: reply.confirmation.id,
    deviceId: COMMAND.deviceId,
    success: true,
    result: { summary: "不应覆盖" },
  });
  assert.equal(replay.reply.confirmation.result, completed.reply.confirmation.result);

  const nextCommandId = "88cfe608-17e8-4d0d-a4ad-21ab20955ab0";
  await plantAccepted(root, { ...COMMAND, commandId: nextCommandId, text: "取消刚才那个提醒" });
  const target = await service.findRecentNativeActionTarget(nextCommandId);
  assert.equal(target.actionID, commandId);
  assert.equal(target.executor, "apple_reminders");
  assert.equal(target.operation, "create");
  assert.equal(target.nativeID, "eventkit-1");
  assert.equal(target.title, "交水电费");
  assert.equal(target.fireAt, "2026-09-02T06:00:00.000Z");
  assert.ok(Date.parse(target.completedAt));
});

test("二十条连续消息、失败重试和 Mac 服务重启都保持同 ID 去重", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-secretary-restart-matrix-"));
  const commands = Array.from({ length: 20 }, (_, index) => ({
    ...COMMAND,
    commandId: `88cfe608-17e8-4d0d-a4ad-${String(index + 1).padStart(12, "0")}`,
    text: `连续消息 ${index + 1}`,
    createdAt: index < 10 ? "2026-09-01T14:59:50.000Z" : "2026-09-01T15:00:10.000Z",
    conversationKey: "watch-cross-midnight",
  }));
  for (const command of commands) await plantAccepted(root, command);
  const firstService = createCodexCommandInboxService({ inboxDir: root });
  await assert.rejects(
    firstService.ensureReply(commands[0].commandId, async () => { throw new Error("模拟模型暂时失败"); }),
    /模拟模型暂时失败/u,
  );

  const restarted = createCodexCommandInboxService({ inboxDir: root });
  const recovered = await restarted.ensureReply(commands[0].commandId, async () => ({ speaker: "yinyue", text: "重启后恢复。" }));
  assert.equal(recovered.text, "重启后恢复。");
  for (const command of commands.slice(1)) {
    await restarted.ensureReply(command.commandId, async () => ({ speaker: "yinyue", text: `收到 ${command.text}` }));
  }
  for (const command of commands) {
    await assert.rejects(() => restarted.accept(command), /手表产品不在公开范围/);
  }
  const rows = await restarted.list(100);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((row) => row.commandId)).size, 20);
  assert.equal(rows.every((row) => row.reply?.text), true);
});


test("原生设备写入同时要求独立令牌与可信 Tailscale 身份", () => {
  const base = {
    headers: {
      host: "mailbox.example.invalid",
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "tailscale-user-login": "capoo@example.com",
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.doesNotThrow(() => assertCodexCommandDeviceAccess(base, "capoo@example.com", TOKEN));
  assert.throws(
    () => assertCodexCommandDeviceAccess({ ...base, headers: { ...base.headers, authorization: "Bearer wrong" } }, "capoo@example.com", TOKEN),
    /未配对/,
  );
  assert.throws(() => assertCodexCommandDeviceAccess(base, "other@example.com", TOKEN), /Tailscale/);
});
