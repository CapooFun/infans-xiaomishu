import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Readable } from "node:stream";
import test from "node:test";
import { createProactiveInteractionService } from "../src/server/workbench-proactive-interactions.mjs";
import { assertCodexCommandDeviceAccess } from "../src/server/workbench-codex-command-inbox.mjs";

test("真实轻回应路由重试的模型、转写、聊天写入调用次数均为零", async () => {
  const source = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  // Execute the actual registered handler without starting unrelated background workers.
  const block = source.slice(source.indexOf('  router.use("/api/proactive-interactions/reaction"'), source.indexOf('  router.use("/api/proactive-interactions/project-event"'));
  assert.ok(block.length > 100);
  const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), "reaction-route-"));
  const service = createProactiveInteractionService({ ledgerDir });
  const p = await service.plan({ kind: "relationship", topicKey: "hello", triggerRef: "hello", text: "来挥挥手" });
  const interactionId = p.interaction.interactionId;
  const counts = { model: 0, transcription: 0, chat: 0 };
  const forbidden = (key) => () => { counts[key]++; throw new Error(`Forbidden ${key}`); };
  let handler;
  vm.runInNewContext(block, {
    router: { use: (_path, fn) => { handler = fn; } }, proactiveInteractions: service,
    assertCodexCommandDeviceAccess, remoteWriteLogins: "", codexCommandToken: "qa-only-token-0123456789012345678901234567890123456789",
    readJson: async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); },
    send: (res, data, status = 200) => { res.data = data; res.status = status; },
    sendError: (res, error) => { res.status = error.status || 400; },
    streamCursor: forbidden("model"), generateReply: forbidden("model"),
    transcribe: forbidden("transcription"), saveChat: forbidden("chat"),
  });
  for (let i = 0; i < 10; i++) {
    const req = Readable.from([Buffer.from(JSON.stringify({ interactionId, reactionId: `reaction-${interactionId}`, reactionType: "pat", deviceId: "watch-qa", deviceTime: "2026-09-05T00:00:00Z" }))]);
    req.method = "POST";
    req.headers = { "content-type": "application/json", host: "127.0.0.1:5173", authorization: "Bearer qa-only-token-0123456789012345678901234567890123456789" };
    req.socket = { remoteAddress: "127.0.0.1" };
    const res = {};
    await handler(req, res);
    assert.equal(res.status, 200);
    assert.equal(res.data.deliveryBoundary, "mac_persisted");
  }
  assert.deepEqual(counts, { model: 0, transcription: 0, chat: 0 });
  assert.equal((await service.list()).length, 1);
  const serviceSource = await fs.readFile(new URL("../src/server/workbench-proactive-interactions.mjs", import.meta.url), "utf8");
  const imports = [...serviceSource.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto", "node:fs/promises", "node:os", "node:path", "../secretary-identity.mjs", "./workbench-errors.mjs"]);
});

test("Watch 与手机轻回应在聊天分派前结束，无录音或生成回退", async () => {
  const phone = await fs.readFile(new URL("../native/InfansHealthSync/InfansHealthSync/PhoneCommandBridge.swift", import.meta.url), "utf8");
  const branch = phone.slice(phone.indexOf('if payload["kind"] as? String == "proactiveReaction"'), phone.indexOf('if (payload["kind"] as? String) == "codexReplyPoll"'));
  assert.match(branch, /reactionOutbox.enqueue/u);
  assert.match(branch, /flushLightReactions/u);
  assert.match(branch, /return\s*\}/u);
  assert.doesNotMatch(branch, /flushPending|rawVoicePipeline|CodexCommand\.from|submit\(/u);
  const sender = phone.slice(phone.indexOf("func sendLightReaction("), phone.indexOf("func pullProactive("));
  assert.match(sender, /api\/proactive-interactions\/reaction/u);
  assert.doesNotMatch(sender, /api\/ai|transcrib|generate|fallback/u);
  await assert.rejects(
    fs.stat(new URL("../native/InfansHealthSync/InfansHealthSyncWatch", import.meta.url)),
    { code: "ENOENT" },
  );
});
