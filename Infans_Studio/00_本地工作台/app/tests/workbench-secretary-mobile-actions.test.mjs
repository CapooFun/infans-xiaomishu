import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecretaryMobileActionService } from "../src/server/workbench-secretary-mobile-actions.mjs";

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-mobile-actions-"));
  const directory = path.join(root, "actions");
  const previews = [];
  const commits = [];
  let serial = 0;
  const create = (runtimeId = `runtime-${serial++}`) => createSecretaryMobileActionService(root, {
    directory,
    runtimeId,
    previewAction: async (action) => {
      const token = `secret-token-${previews.length + 1}`;
      previews.push(action);
      return {
        authority: "write",
        preview: {
          token,
          kind: action.kind,
          targetPath: options.absolutePath ? "${INFANS_VAULT_ROOT:-$HOME/Infans_Studio}/private.md" : "30_事业顺利/demo.md",
          targetLabel: options.absolutePath ? "${INFANS_VAULT_ROOT:-$HOME/Infans_Studio}/private.md" : "演示项目",
          summary: action.summary || "摘要",
          before: "之前",
          after: "之后",
          expiresAt: "2026-09-03T10:00:00.000Z",
          requiresConfirm: !["journal", "calendarCreate"].includes(action.kind),
        },
      };
    },
    commitPreview: async (_authority, token) => {
      commits.push(token);
      if (options.commitErrorOnce && commits.length === 1) {
        const error = new Error("源文件已被其他工具修改");
        error.code = "WRITE_CONFLICT";
        throw error;
      }
      return { ok: true };
    },
  });
  return { root, directory, previews, commits, create };
}

const binding = { conversationId: "conversation_001", generationId: "generation_001" };
const pendingActions = [
  { kind: "editFile", path: "30_事业顺利/demo.md", content: "secret raw content", label: "修改文件", summary: "修改摘要" },
  { kind: "relationshipMemory", secretaryId: "yinyue", operation: "append", text: "第二项", label: "补充关系记忆", summary: "关系摘要", requiresConfirm: true },
];

test("stable action ids persist raw actions privately while public records expose only safe previews", async (t) => {
  const f = await fixture({ absolutePath: true });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const service = f.create();
  const first = await service.register({ ...binding, assistantMessageId: "reply-generation_001", actions: [pendingActions[0]] });
  const second = await service.register({ ...binding, assistantMessageId: "reply-generation_001", actions: [pendingActions[0]] });
  assert.equal(first.actions[0].actionId, second.actions[0].actionId);
  assert.equal(first.actions[0].publicPreview.targetPath, null);
  const publicJson = JSON.stringify(first);
  assert.doesNotMatch(publicJson, /secret-token|secret raw content|commitUrl|\/Users\/Capoo/u);
  const persisted = await fs.readFile(path.join(f.directory, `${first.actions[0].actionId}.json`), "utf8");
  assert.match(persisted, /secret-token-1/u);
  assert.match(persisted, /secret raw content/u);
});

test("confirm and cancel are idempotent, concurrent confirms commit once, and bindings are enforced", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const service = f.create();
  const registered = await service.register({ ...binding, assistantMessageId: "reply-generation_001", actions: pendingActions });
  const firstId = registered.actions[0].actionId;
  await assert.rejects(() => service.decide(firstId, { ...binding, conversationId: "conversation_999", decision: "confirm" }), /不匹配/u);
  const [left, right] = await Promise.all([
    service.decide(firstId, { ...binding, decision: "confirm" }),
    service.decide(firstId, { ...binding, decision: "confirm" }),
  ]);
  assert.equal(left.action.state, "completed");
  assert.equal(right.action.state, "completed");
  assert.equal(f.commits.length, 1);
  const duplicate = await service.decide(firstId, { ...binding, decision: "confirm" });
  assert.equal(duplicate.duplicate, true);
  const cancelled = await service.decide(registered.actions[1].actionId, { ...binding, decision: "cancel" });
  assert.equal(cancelled.action.state, "cancelled");
});

test("multiple actions must be decided in model order", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const service = f.create();
  const registered = await service.register({ ...binding, assistantMessageId: "reply-generation_001", actions: pendingActions });
  await assert.rejects(
    () => service.decide(registered.actions[1].actionId, { ...binding, decision: "confirm" }),
    (error) => error.code === "NATIVE_CHAT_ACTION_ORDER_REQUIRED",
  );
});

test("stale target and process restart both refresh public preview and require a second confirmation", async (t) => {
  const conflict = await fixture({ commitErrorOnce: true });
  t.after(() => fs.rm(conflict.root, { recursive: true, force: true }));
  const service = conflict.create("runtime-a");
  const registered = await service.register({ ...binding, assistantMessageId: "reply-generation_001", actions: [pendingActions[0]] });
  const stale = await service.decide(registered.actions[0].actionId, { ...binding, decision: "confirm" });
  assert.equal(stale.stale, true);
  assert.equal(stale.action.state, "pending");
  const confirmed = await service.decide(registered.actions[0].actionId, { ...binding, decision: "confirm" });
  assert.equal(confirmed.action.state, "completed");

  const restart = await fixture();
  t.after(() => fs.rm(restart.root, { recursive: true, force: true }));
  const before = restart.create("runtime-a");
  const row = await before.register({ ...binding, assistantMessageId: "reply-generation_001", actions: [pendingActions[0]] });
  const after = restart.create("runtime-b");
  const refreshed = await after.decide(row.actions[0].actionId, { ...binding, decision: "confirm" });
  assert.equal(refreshed.stale, true);
  assert.equal(restart.commits.length, 0);
  assert.equal((await after.list(binding.conversationId)).actions[0].state, "pending");
});

test("shared direct-write policy applies to mobile and empty actions produce zero records", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const service = f.create();
  const direct = await service.register({
    ...binding,
    assistantMessageId: "reply-generation_001",
    actions: [{ kind: "journal", text: "已授权直写", label: "记日志", summary: "日志" }],
  });
  assert.equal(direct.actions[0].state, "completed");
  assert.equal(f.commits.length, 1);
  const calendar = await service.register({
    conversationId: "conversation_003",
    generationId: "generation_003",
    assistantMessageId: "reply-generation_003",
    actions: [{ kind: "calendarCreate", title: "直写日程", label: "新建日程", summary: "日程", requiresConfirm: false }],
  });
  assert.equal(calendar.actions[0].state, "completed");
  assert.equal(f.commits.length, 2);
  const emptyResult = await service.register({
    conversationId: "conversation_002",
    generationId: "generation_002",
    assistantMessageId: "reply-generation_002",
    actions: [],
  });
  assert.deepEqual(emptyResult.actions, []);
  assert.deepEqual((await service.list("conversation_002")).actions, []);
});
