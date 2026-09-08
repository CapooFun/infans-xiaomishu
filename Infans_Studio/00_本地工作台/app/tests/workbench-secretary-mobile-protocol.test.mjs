import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { readSecretaryChat, saveSecretaryChat } from "../src/server/workbench-secretary-chats.mjs";
import { saveSecretaryAttachment } from "../src/server/workbench-secretary-attachments.mjs";
import { CURSOR_HIGH_MODEL, DEFAULT_MODEL, readSecretaryAiRuntimeStatus } from "../src/server/workbench-ai.mjs";
import {
  SECRETARY_MOBILE_PROTOCOL_ID,
  createSecretaryMobileProtocolService,
} from "../src/server/workbench-secretary-mobile-protocol.mjs";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const GENERATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function tempRoot(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function attachmentRequest(body, headers = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = headers;
  return stream;
}

function aiStatus() {
  return {
    installed: true,
    loggedIn: true,
    model: DEFAULT_MODEL,
    label: "Cursor 已登录",
    ordinary: { backend: "", available: false, model: "", label: "模型未配置" },
    group: { backend: "", available: false, model: "", label: "模型未配置" },
    groupOptions: {},
    usage: {
      openrouter: { available: true, readOnly: true, scope: "api-key-account", currency: "USD", usageUsd: 1.25, limitUsd: 10, limitRemainingUsd: 8.75 },
      cursor: { available: false, readOnly: true, reason: "not-reported-by-runtime" },
    },
  };
}

function turn(overrides = {}) {
  return {
    protocolVersion: 1,
    conversationId: "native_yingning_default",
    messageId: USER_ID,
    generationId: GENERATION_ID,
    createdAt: "2026-09-02T10:00:00+09:00",
    text: "银月在吗？",
    ...overrides,
  };
}

test("shared AI runtime status is the single read-only model and usage authority", async () => {
  const status = await readSecretaryAiRuntimeStatus("/tmp/unused", {
    cursorStatus: async () => ({ installed: true, loggedIn: true, model: DEFAULT_MODEL, label: "Cursor 已登录" }),
    openRouterStatus: async () => ({ available: true, model: "aion-labs/aion-3.0", label: "Aion 可用", usageUsd: null, limitUsd: null, limitRemainingUsd: null }),
  });
  assert.equal(status.ordinary.backend, "");
  assert.equal(status.ordinary.available, false);
  assert.equal(status.ordinary.model, "");
  assert.equal(status.usage.openrouter.readOnly, true);
  assert.equal(status.usage.openrouter.available, false);
});

test("bootstrap derives product, characters, assets and recent conversations from existing authorities", async () => {
  const root = await tempRoot("native-chat-bootstrap");
  const service = createSecretaryMobileProtocolService(root, {
    serviceVersion: "1.15.0",
    readActiveSecretary: async () => ({ activeSecretaryId: "yinyue" }),
    readAiStatus: async () => aiStatus(),
  });
  const data = await service.bootstrap();
  assert.equal(data.protocol.id, SECRETARY_MOBILE_PROTOCOL_ID);
  assert.equal(data.protocol.version, 1);
  assert.equal(data.service.version, "1.15.0");
  assert.equal(data.product.name, "小秘书");
  assert.equal(data.activeSecretaryId, "yinyue");
  assert.equal(data.defaultConversationId, "native_yinyue_default");
  assert.deepEqual(data.characters.map((item) => item.id), ["yinyue", "meining"]);
  assert.equal(data.characters.find((item) => item.id === "yinyue")?.assets.avatar, "/theme/avatar-yinyue-public.svg");
  assert.equal(data.assets.manifestAvailable, false);
  assert.equal(data.features.textChat, true);
  assert.equal(data.features.attachments, true);
  assert.equal(data.protocol.authentication.credential, "existing-device-token");
  assert.equal(data.protocol.resume.partialDeltaReplay, false);
  assert.equal(data.protocol.endpoints.streamTurn, "POST /api/secretary-mobile/turns/stream");
  assert.equal(data.protocol.endpoints.createConversation, "POST /api/secretary-mobile/conversations");
  assert.equal(data.protocol.endpoints.updateConversation, "PATCH /api/secretary-mobile/conversations/:id");
  assert.equal(data.protocol.endpoints.deleteConversation, "DELETE /api/secretary-mobile/conversations/:id");
  assert.equal(data.protocol.endpoints.uploadAttachment, "POST /api/secretary-mobile/attachments");
  assert.equal(data.protocol.endpoints.attachment, "GET /api/secretary-mobile/attachments/:id");
  assert.equal(data.protocol.endpoints.attachmentContent, "GET /api/secretary-mobile/attachments/:id/content");
  assert.equal(data.protocol.attachments.maximumPerTurn, 4);
  assert.equal(data.protocol.attachments.maximumBytes.image, 8 * 1024 * 1024);
  assert.equal(data.protocol.attachments.maximumDurationMs.audio, 90_000);
  assert.ok(data.protocol.attachments.allowedMimeTypes.includes("image/png"));
  assert.equal(data.protocol.conversationMutation.expectedVersionField, "expectedConversationVersion");
  assert.equal(data.protocol.conversationMutation.membershipField, undefined);
  assert.equal(data.protocol.replySpeakerControl, undefined);
  assert.deepEqual(data.protocol.conversationMutation.allowedPrivacy, ["standard"]);
  assert.deepEqual(data.protocol.conversationMutation.allowedOrdinaryBackends, []);
  assert.deepEqual(data.protocol.conversationMutation.conflict, { status: 409, type: "resync_required" });
  assert.equal(data.features.conversationCreate, true);
  assert.equal(data.features.conversationStateControl, true);
  assert.equal(data.features.conversationDelete, true);
  assert.equal(data.features.modelSelection, true);
  assert.equal(data.modelRuntime.ordinary.selected, "");
  assert.equal(data.usage.openrouter.usageUsd, 1.25);
});

test("conversation list is complete while bootstrap keeps only the recent window", async () => {
  const root = await tempRoot("native-chat-complete-list");
  const service = createSecretaryMobileProtocolService(root);
  for (let index = 0; index < 32; index += 1) {
    await service.createConversation({
      protocolVersion: 1,
      conversationId: `native_list_${String(index).padStart(4, "0")}`,
    });
  }
  const listed = await service.listConversations();
  const bootstrap = await service.bootstrap();
  assert.equal(listed.complete, true);
  assert.equal(listed.conversations.length, 32);
  assert.equal(bootstrap.recentConversations.length, 30);
});

test("controlled actions are additive V1 cards, recoverable, and decision payloads reject editable fields", async () => {
  const root = await tempRoot("native-chat-controlled-actions");
  const card = {
    actionId: "action_11111111111111111111111111111111",
    conversationId: "native_yingning_default",
    generationId: GENERATION_ID,
    assistantMessageId: `reply-${GENERATION_ID}`,
    order: 0,
    label: "修改文件",
    publicPreview: { kind: "editFile", targetLabel: "演示文件", targetPath: "30_事业顺利/demo.md", summary: "摘要", before: "旧", after: "新", expiresAt: "2026-09-03T10:00:00.000Z", requiresConfirm: true },
    state: "pending",
  };
  const registered = [];
  const decisions = [];
  const actionService = {
    register: async (input) => { registered.push(input); return { actions: [card] }; },
    list: async () => ({ actions: [card] }),
    decide: async (id, input) => { decisions.push({ id, ...input }); return { stale: false, action: { ...card, state: "cancelled" } }; },
  };
  const service = createSecretaryMobileProtocolService(root, {
    actionService,
    generateReply: async (_payload, hooks) => {
      const actions = [{ kind: "editFile", path: "30_事业顺利/demo.md", content: "server only", label: "修改文件", summary: "摘要" }];
      hooks.onActions(actions);
      return { ok: true, answer: "回复仍然正常保存", actions };
    },
  });
  const bootstrap = await service.bootstrap();
  assert.equal(bootstrap.protocol.version, 1);
  assert.equal(bootstrap.features.controlledActions, true);
  assert.equal(bootstrap.protocol.endpoints.controlledActions, "GET /api/secretary-mobile/conversations/:id/actions");
  assert.equal(bootstrap.protocol.endpoints.controlledActionDecision, "POST /api/secretary-mobile/actions/:id/decision");
  const events = [];
  const result = await service.streamTurn(turn(), (event) => events.push(event));
  assert.equal(result.ok, true);
  assert.equal(registered.length, 1);
  assert.equal(events.find((event) => event.type === "attachment")?.card.actionId, card.actionId);
  assert.equal(events.find((event) => event.type === "completed")?.actions[0].actionId, card.actionId);
  assert.doesNotMatch(JSON.stringify(events), /server only|token|commitUrl/u);
  assert.deepEqual((await service.listActions("native_yingning_default")).actions, [card]);
  await assert.rejects(
    service.decideAction(card.actionId, { protocolVersion: 1, conversationId: card.conversationId, generationId: GENERATION_ID, decision: "confirm", content: "overwrite" }),
    (error) => error?.status === 400 && error?.code === "NATIVE_CHAT_ACTION_DECISION_FIELD_UNSUPPORTED",
  );
  const cancelled = await service.decideAction(card.actionId, { protocolVersion: 1, conversationId: card.conversationId, generationId: GENERATION_ID, decision: "cancel" });
  assert.equal(cancelled.action.state, "cancelled");
  assert.equal(decisions.length, 1);
});

test("action persistence failure never discards an already saved assistant reply", async () => {
  const root = await tempRoot("native-chat-action-failure-reply");
  const service = createSecretaryMobileProtocolService(root, {
    actionService: {
      register: async () => { throw new Error("action store unavailable"); },
      list: async () => ({ actions: [] }),
      decide: async () => ({ stale: false }),
    },
    generateReply: async () => ({
      ok: true,
      answer: "回复不能因为动作卡失败而丢失",
      actions: [{ kind: "relationshipMemory", secretaryId: "yinyue", operation: "append", text: "候选", label: "关系记忆", summary: "候选", requiresConfirm: true }],
    }),
  });
  const events = [];
  const result = await service.streamTurn(turn(), (event) => events.push(event));
  assert.equal(result.ok, true);
  assert.equal(events.at(-1).type, "completed");
  const stored = await readSecretaryChat(root, "native_yingning_default");
  assert.equal(stored.messages.at(-1).content, "回复不能因为动作卡失败而丢失");
});

test("direct conversation creation uses a client-stable id and can target a secretary seat idempotently", async () => {
  const root = await tempRoot("native-chat-create-conversation");
  const service = createSecretaryMobileProtocolService(root, {
    readActiveSecretary: async () => ({ activeSecretaryId: "yinyue" }),
  });
  const first = await service.createConversation({
    protocolVersion: 1,
    conversationId: "native_direct_0001",
    title: "新的对话",
  });
  assert.equal(first.created, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.conversation.id, "native_direct_0001");
  assert.equal(first.conversation.activeSecretaryId, "yinyue");
  assert.equal(first.conversation.type, "direct");
  assert.equal(first.conversation.messageCount, 0);
  assert.deepEqual(Object.keys(first.conversation.chatState).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);

  const retry = await service.createConversation({
    protocolVersion: 1,
    conversationId: "native_direct_0001",
    title: "新的对话",
  });
  assert.equal(retry.created, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.conversation.version, first.conversation.version);

  const meining = await service.createConversation({
    protocolVersion: 1,
    conversationId: "native_direct_meining_0001",
    title: "和梅凝聊聊",
    activeSecretaryId: "meining",
  });
  assert.equal(meining.created, true);
  assert.equal(meining.conversation.activeSecretaryId, "meining");

  await assert.rejects(
    service.createConversation({
      protocolVersion: 1,
      conversationId: "native_direct_guest_0001",
      activeSecretaryId: "unknown-guest",
    }),
    (error) => error?.code === "NATIVE_CHAT_CHARACTER_INVALID",
  );
});

test("conversation patch 只改一对一标题，多余旧字段会被丢掉", async () => {
  const root = await tempRoot("native-chat-update-conversation");
  const service = createSecretaryMobileProtocolService(root);
  const created = await service.createConversation({ protocolVersion: 1, conversationId: "native_direct_0001" });
  const updated = await service.updateConversation("native_direct_0001", {
    protocolVersion: 1,
    expectedConversationVersion: created.conversation.version,
    title: "银月工作会话",
    chatState: { privacy: "standard" },
  });
  assert.equal(updated.conversation.title, "银月工作会话");
  assert.equal(updated.conversation.type, "direct");
  assert.deepEqual(Object.keys(updated.conversation.chatState).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);
  assert.equal(updated.conversation.privacy, "standard");
  await assert.rejects(
    service.updateConversation("native_direct_0001", {
      protocolVersion: 1,
      expectedConversationVersion: created.conversation.version,
      title: "旧版本覆盖",
    }),
    (error) => error?.status === 409
      && error?.code === "NATIVE_CHAT_VERSION_CONFLICT"
      && error?.type === "resync_required"
      && error?.currentVersion === updated.conversation.version,
  );
});

test("conversation state keeps a one-on-one seat", async () => {
  const root = await tempRoot("native-chat-state-validation");
  const service = createSecretaryMobileProtocolService(root);
  const current = (await service.createConversation({ protocolVersion: 1, conversationId: "native_validate_0001" })).conversation;
  const updated = await service.updateConversation(current.id, {
    protocolVersion: 1,
    expectedConversationVersion: current.version,
    chatState: {
      privacy: "standard",
    },
  });
  assert.equal(updated.conversation.type, "direct");
  assert.equal(updated.conversation.privacy, "standard");
  assert.equal(updated.conversation.chatState.activeSecretaryId, "yinyue");
});

test("一对一发送只走值班秘书", async () => {
  const root = await tempRoot("native-chat-reply-duty");
  await saveSecretaryChat(root, {
    id: "native_lights_0001",
    chatState: {
      activeSecretaryId: "yinyue",
    },
    messages: [{ id: "reply-lights-seed-0001", role: "user", content: "先坐下吧" }],
  });
  let generations = 0;
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async (payload) => {
      generations += 1;
      assert.equal(payload.activeSecretaryId, "yinyue");
      return { ok: true, replies: [{ speaker: "yinyue", content: "这轮我来接话。" }] };
    },
  });
  const sent = await service.streamTurn(turn({
    conversationId: "native_lights_0001",
    messageId: "reply-lights-user-0001",
    generationId: "reply-lights-generation-0001",
  }), () => undefined);
  assert.equal(sent.ok, true);
  assert.equal(generations, 1);
  const stored = await readSecretaryChat(root, "native_lights_0001");
  assert.equal(stored.chatState.privacy, "standard");
  assert.equal(stored.messages.at(-1).speaker, "yinyue");
});

test("开源移动端只提供一对一会话入口", async () => {
  const root = await tempRoot("native-chat-group-gate");
  const service = createSecretaryMobileProtocolService(root);
  await service.createConversation({ protocolVersion: 1, conversationId: "native_gate_0001" });
  const bootstrap = await service.bootstrap();
});

test("conversation delete requires the current version and uses the existing archive deletion boundary", async () => {
  const root = await tempRoot("native-chat-delete-conversation");
  const service = createSecretaryMobileProtocolService(root);
  const created = await service.createConversation({ protocolVersion: 1, conversationId: "native_delete_0001" });
  await assert.rejects(
    service.deleteConversation(created.conversation.id, {
      protocolVersion: 1,
      expectedConversationVersion: "stale-version",
    }),
    (error) => error?.code === "NATIVE_CHAT_VERSION_CONFLICT" && error?.type === "resync_required",
  );
  const deleted = await service.deleteConversation(created.conversation.id, {
    protocolVersion: 1,
    expectedConversationVersion: created.conversation.version,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.id, created.conversation.id);
  await assert.rejects(service.readConversation(created.conversation.id), (error) => error?.code === "CHAT_NOT_FOUND");
});

test("a text turn persists before generation, streams typed events, and retries idempotently", async () => {
  const root = await tempRoot("native-chat-turn");
  let generations = 0;
  const service = createSecretaryMobileProtocolService(root, {
    readActiveSecretary: async () => ({ activeSecretaryId: "yinyue" }),
    readRelationshipMemory: async () => ({ content: "已确认：称呼是前辈。" }),
    generateReply: async (payload, hooks) => {
      generations += 1;
      assert.equal(payload.activeSecretaryId, "yinyue");
      assert.equal(payload.taskWindowId, "native_yingning_default");
      assert.match(hooks.extraContexts[0].text, /已确认：称呼是前辈/u);
      hooks.onChunk("好");
      hooks.onChunk("呀");
      return { ok: true, answer: "好呀" };
    },
  });
  const events = [];
  const first = await service.streamTurn(turn(), (event) => events.push(event));
  assert.equal(first.ok, true);
  assert.equal(generations, 1);
  assert.deepEqual(events.map((event) => event.type), ["started", "delta", "delta", "completed"]);
  assert.equal(events[0].deliveryStage, "mac_persisted");
  assert.deepEqual(events.map((event) => event.cursor), [1, 2, 3, 4]);
  assert.equal(events.at(-1).messages[0].text, "好呀");

  const stored = await readSecretaryChat(root, "native_yingning_default");
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[0].id, USER_ID);
  assert.equal(stored.messages[0].createdAt, "2026-09-02T01:00:00.000Z");
  assert.equal(stored.messages[1].id, `reply-${GENERATION_ID}`);
  assert.equal(stored.messages[1].speaker, "yinyue");
  const detail = await service.readConversation("native_yingning_default");
  assert.equal(detail.messages[0].sender.displayName, "我");
  assert.notEqual(detail.messages[0].sender.displayName, "哥哥");
  assert.equal(detail.messages[0].deliveryStage, "device_available");
  assert.equal(detail.messages[1].deliveryStage, "device_available");

  const retryEvents = [];
  const retry = await service.streamTurn(turn(), (event) => retryEvents.push(event));
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(generations, 1);
  assert.deepEqual(retryEvents.map((event) => event.type), ["started", "completed"]);
  assert.equal(retryEvents[1].duplicate, true);
});

test("read conversation marks a waiting user message unread until an assistant reply exists", async () => {
  const root = await tempRoot("native-chat-read-receipt");
  await saveSecretaryChat(root, {
    id: "native_yingning_default",
    chatState: { activeSecretaryId: "yinyue" },
    messages: [
      { id: USER_ID, role: "user", content: "在吗", createdAt: "2026-09-07T00:00:00.000Z" },
    ],
  });
  const service = createSecretaryMobileProtocolService(root, {
    readActiveSecretary: async () => ({ activeSecretaryId: "yinyue" }),
  });
  const waiting = await service.readConversation("native_yingning_default");
  assert.equal(waiting.messages[0].deliveryStage, "mac_persisted");

  await saveSecretaryChat(root, {
    id: "native_yingning_default",
    chatState: { activeSecretaryId: "yinyue" },
    messages: [
      { id: USER_ID, role: "user", content: "在吗", createdAt: "2026-09-07T00:00:00.000Z" },
      { id: `reply-${GENERATION_ID}`, role: "assistant", speaker: "yinyue", content: "在。", createdAt: "2026-09-07T00:00:01.000Z" },
    ],
  });
  const replied = await service.readConversation("native_yingning_default");
  assert.equal(replied.messages[0].deliveryStage, "device_available");
  assert.equal(replied.messages[1].deliveryStage, "device_available");
});

test("native generation uses an eight-message model view while preserving a long archive and full reply", async () => {
  const root = await tempRoot("native-chat-long-archive");
  const history = Array.from({ length: 1000 }, (_, index) => ({ id: `history-${index}`, role: "user", content: `历史${index}` }));
  await saveSecretaryChat(root, { id: "native_yingning_default", chatState: { activeSecretaryId: "yinyue" }, messages: history });
  const answer = `${"完整回复🌿".repeat(5000)}结束`;
  let generations = 0;
  const service = createSecretaryMobileProtocolService(root, {
    readActiveSecretary: async () => ({ activeSecretaryId: "yinyue" }),
    generateReply: async (payload, hooks) => {
      generations += 1;
      assert.deepEqual(payload.history, history.slice(-8).map(({ role, content }) => ({ role, content })));
      const persisted = await readSecretaryChat(root, "native_yingning_default");
      assert.equal(persisted.messages.length, 1001);
      assert.equal(persisted.messages.at(-1).id, USER_ID);
      hooks.onChunk(answer.slice(0, 21000));
      hooks.onChunk(answer.slice(21000));
      return { ok: true, answer };
    },
  });
  const events = [];
  assert.equal((await service.streamTurn(turn(), (event) => events.push(event))).ok, true);
  const stored = await readSecretaryChat(root, "native_yingning_default");
  assert.deepEqual(stored.messages.slice(0, 1000), history);
  assert.equal(stored.messages.length, 1002);
  assert.equal(stored.messages.at(-1).content, answer);
  const disk = JSON.parse(await fs.readFile(path.join(root, stored.path), "utf8"));
  assert.deepEqual(disk.messages, stored.messages);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.text).join(""), answer);
  assert.equal(events.at(-1).messages[0].text, answer);
  assert.equal((await service.streamTurn(turn(), () => {})).duplicate, true);
  assert.equal(generations, 1);
  assert.equal((await readSecretaryChat(root, "native_yingning_default")).messages.length, 1002);
});

test("an attachment-only turn resolves authoritative metadata, persists once and reaches generation", async () => {
  const root = await tempRoot("native-chat-attachment-turn");
  const uploaded = await saveSecretaryAttachment(root, attachmentRequest("voice-bytes", {
    "content-type": "audio/webm",
    "x-infans-filename": encodeURIComponent("问候.webm"),
    "x-infans-duration-ms": "1200",
    "x-infans-attachment-id": "native_voice_00000001",
  }));
  let generations = 0;
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async (payload) => {
      generations += 1;
      assert.deepEqual(payload.attachments, [uploaded.id]);
      assert.equal(payload.voiceTranscript, "银月在吗");
      assert.equal(payload.ordinaryBackend, "");
      return { ok: true, answer: "我听见啦。", model: "", backend: "", usage: { total_tokens: 12, cost: 0.001 } };
    },
  });
  const payload = turn({
    text: "",
    attachments: [{ id: uploaded.id, transcript: "银月在吗" }],
  });
  const events = [];
  const first = await service.streamTurn(payload, (event) => events.push(event));
  assert.equal(first.ok, true);
  assert.equal(generations, 1);
  const started = events.find((event) => event.type === "started");
  assert.equal(started.userMessage.fallbackText, "发送了一段录音");
  assert.equal(started.userMessage.attachments[0].id, uploaded.id);
  assert.equal(started.userMessage.attachments[0].size, uploaded.size);
  assert.equal(started.userMessage.attachments[0].sha256, uploaded.sha256);
  assert.match(started.userMessage.attachments[0].resourcePath, /\/api\/secretary-mobile\/attachments\/native_voice_00000001\/content$/u);
  const completed = events.find((event) => event.type === "completed");
  assert.equal(completed.inputAttachments[0].id, uploaded.id);
  assert.deepEqual(completed.execution, {
    backend: null,
    model: null,
    usage: { total_tokens: 12, cost: 0.001 },
  });

  const stored = await readSecretaryChat(root, payload.conversationId);
  assert.equal(stored.messages[0].content, "");
  assert.equal(stored.messages[0].attachments[0].id, uploaded.id);
  assert.equal(stored.messages[0].attachments[0].size, uploaded.size);
  assert.equal(stored.messages[0].attachments[0].sha256, uploaded.sha256);
  assert.equal(stored.messages[0].attachments[0].transcript, "银月在吗");
  const detail = await service.readConversation(payload.conversationId);
  assert.equal(detail.messages[0].fallbackText, "发送了一段录音");
  assert.equal(detail.messages[0].attachments.length, 1);

  const retry = await service.streamTurn(payload, () => undefined);
  assert.equal(retry.duplicate, true);
  assert.equal(generations, 1);
  assert.equal((await readSecretaryChat(root, payload.conversationId)).messages.length, 2);
});

test("an internal NAS voice turn preserves its stable voice identity without requiring Mac audio bytes", async () => {
  const root = await tempRoot("native-chat-mailbox-voice-source");
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async (payload) => {
      assert.equal(payload.question, "莹莹帮我记一下");
      assert.equal(payload.voiceTranscript, "");
      return { ok: true, answer: "听见了。" };
    },
  });
  const payload = turn({
    conversationId: "native_mailbox_voice_source",
    messageId: "msg-ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    generationId: "gen-ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    text: "莹莹帮我记一下",
    attachments: [],
  });

  const result = await service.streamTurn(payload, () => undefined, {
    voiceSources: [{
      id: "ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      mime: "audio/mp4",
      durationMs: 4_200,
      transcript: "莹莹帮我记一下",
    }],
  });

  assert.equal(result.ok, true);
  const stored = await readSecretaryChat(root, payload.conversationId);
  assert.deepEqual(stored.messages[0].voiceSources, [{
    id: "ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    mime: "audio/mp4",
    durationMs: 4_200,
    transcript: "莹莹帮我记一下",
  }]);
  assert.deepEqual(stored.messages[0].attachments, undefined);
});

test("missing, excessive or changed attachment references fail before polluting a conversation", async () => {
  const root = await tempRoot("native-chat-attachment-failure");
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async () => ({ ok: true, answer: "不应调用" }),
  });
  for (const [messageId, attachments, code] of [
    ["attach-missing-00000001", [{ id: "missing_asset_00000001" }], "ATTACHMENT_NOT_FOUND"],
    ["attach-too-many-0000001", Array.from({ length: 5 }, (_, index) => ({ id: `missing_many_${index + 10000000}` })), "NATIVE_CHAT_ATTACHMENTS_INVALID"],
  ]) {
    const events = [];
    const result = await service.streamTurn(turn({
      conversationId: `native_${messageId}`,
      messageId,
      generationId: `generation-${messageId}`,
      text: "",
      attachments,
    }), (event) => events.push(event));
    assert.equal(result.ok, false);
    assert.equal(events.at(-1).code, code);
    await assert.rejects(service.readConversation(`native_${messageId}`), (error) => error?.code === "CHAT_NOT_FOUND");
  }

  const firstAttachment = await saveSecretaryAttachment(root, attachmentRequest("one", {
    "content-type": "image/png",
    "x-infans-attachment-id": "native_image_00000001",
  }));
  const secondAttachment = await saveSecretaryAttachment(root, attachmentRequest("two", {
    "content-type": "image/png",
    "x-infans-attachment-id": "native_image_00000002",
  }));
  const base = turn({ attachments: [{ id: firstAttachment.id }] });
  await service.streamTurn(base, () => undefined);
  const conflictEvents = [];
  const conflict = await service.streamTurn({ ...base, attachments: [{ id: secondAttachment.id }] }, (event) => conflictEvents.push(event));
  assert.equal(conflict.ok, false);
  assert.equal(conflictEvents.at(-1).code, "NATIVE_CHAT_IDEMPOTENCY_CONFLICT");
  assert.equal((await readSecretaryChat(root, base.conversationId)).messages[0].attachments[0].id, firstAttachment.id);
});

test("开源转发一对一会话时模型位保持未配置", async () => {
  const root = await tempRoot("native-chat-runtime-state");
  await saveSecretaryChat(root, {
    id: "native_runtime_direct",
    chatState: {
      activeSecretaryId: "yinyue",
      ordinaryBackend: "cursor",
      cursorModel: CURSOR_HIGH_MODEL,
    },
    messages: [{ id: "runtime-seed-0001", role: "user", content: "继续" }],
  });
  let forwarded;
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async (payload) => {
      forwarded = payload;
      return {
        ok: true,
        answer: "继续吧。",
        model: "",
      };
    },
  });
  const result = await service.streamTurn(turn({
    conversationId: "native_runtime_direct",
  }), () => {});
  assert.equal(result.ok, true);
  assert.equal(forwarded.cursorModel, "");
  assert.notEqual(forwarded.ordinaryBackend, "cursor");
});

test("automatic continuation is rejected in one-on-one chat", async () => {
  const root = await tempRoot("native-chat-auto-rejected");
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async () => ({ ok: true, answer: "不该走到这里" }),
  });
  const events = [];
  const result = await service.streamTurn(turn({ autoChat: true, text: "internal-auto-continue" }), (event) => events.push(event));
  assert.equal(result.ok, false);
  assert.equal(events.at(-1).code, "NATIVE_CHAT_AUTO_MODE_INVALID");
});

test("explicit cancellation aborts the in-flight generator and emits cancelled", async () => {
  const root = await tempRoot("native-chat-cancel");
  let generatorStarted;
  const started = new Promise((resolve) => { generatorStarted = resolve; });
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async (_payload, hooks) => new Promise((_resolve, reject) => {
      generatorStarted();
      hooks.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const events = [];
  const running = service.streamTurn(turn(), (event) => events.push(event));
  await started;
  const receipt = service.cancel({ conversationId: "native_yingning_default", generationId: GENERATION_ID });
  assert.equal(receipt.cancelled, true);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(events.at(-1).type, "cancelled");
  const stored = await readSecretaryChat(root, "native_yingning_default");
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].id, USER_ID);
});

test("an in-flight conversation cannot be deleted", async () => {
  const root = await tempRoot("native-chat-delete-busy");
  let generatorStarted;
  const started = new Promise((resolve) => { generatorStarted = resolve; });
  const service = createSecretaryMobileProtocolService(root, {
    generateReply: async (_payload, hooks) => new Promise((_resolve, reject) => {
      generatorStarted();
      hooks.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const running = service.streamTurn(turn(), () => undefined);
  await started;
  const current = await service.readConversation("native_yingning_default");
  await assert.rejects(
    service.deleteConversation(current.id, {
      protocolVersion: 1,
      expectedConversationVersion: current.version,
    }),
    (error) => error?.status === 409 && error?.code === "NATIVE_CHAT_CONVERSATION_BUSY",
  );
  service.cancel({ conversationId: current.id, generationId: GENERATION_ID });
  await running;
});

test("the shared route stays a thin authenticated adapter with conversation and attachment endpoints", async () => {
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const start = routes.indexOf('router.use("/api/secretary-mobile"');
  const end = routes.indexOf('router.use("/api/secretary-attachments"', start);
  assert.ok(start > 0 && end > start);
  const block = routes.slice(start, end);
  assert.match(block, /assertCodexCommandDeviceAccess\(request, remoteWriteLogins, codexCommandToken\)/u);
  assert.match(block, /request\.method === "GET" && sub === "\/bootstrap"/u);
  assert.match(block, /request\.method === "GET" && sub\.startsWith\("\/conversations\/"\)/u);
  assert.match(block, /secretaryMobile\.listActions\(id\)/u);
  assert.match(block, /secretaryMobile\.decideAction\(id/u);
  assert.match(block, /request\.method === "POST" && sub === "\/conversations"/u);
  assert.match(block, /request\.method === "PATCH" && sub\.startsWith\("\/conversations\/"\)/u);
  assert.match(block, /request\.method === "DELETE" && sub\.startsWith\("\/conversations\/"\)/u);
  assert.match(block, /error\?\.type === "resync_required"/u);
  assert.match(block, /currentVersion: error\.currentVersion/u);
  assert.match(block, /request\.method === "POST" && sub === "\/turns\/stream"/u);
  assert.match(block, /request\.method === "POST" && sub === "\/turns\/cancel"/u);
  assert.doesNotMatch(block, /group-session\/enter/u);
  assert.doesNotMatch(block, /guest-media/u);
  assert.match(block, /request\.method === "POST" && sub === "\/attachments"/u);
  assert.match(block, /request\.method === "GET" && sub\.startsWith\("\/attachments\/"\)/u);
  assert.match(block, /requireJson: false/u);
  assert.match(block, /application\/x-ndjson/u);
  assert.match(block, /secretaryMobile\.streamTurn\(payload, write\)/u);
});
