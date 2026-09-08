import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve("native/InfansHealthSync/InfansHealthSync");
const readNative = (name) => fs.readFile(path.join(nativeRoot, name), "utf8");

test("native inspector shows truthful per-conversation execution", async () => {
  const [store, inspector] = await Promise.all([
    readNative("SecretaryChatStore.swift"),
    readNative("SecretaryConversationInspectorView.swift"),
  ]);
  assert.match(store, /executionMetricsByConversation/u);
  assert.match(store, /executionMetricsByConversation\[turn\.conversationId\]/u);
  assert.match(inspector, /最近模型/u);
  assert.match(inspector, /本次累计 token/u);
  assert.match(inspector, /本次累计费用/u);
  assert.match(inspector, /未知/u);
  assert.match(inspector, /一对一会话/u);
});

test("native send path goes straight from draft to transmit", async () => {
  const store = await readNative("SecretaryChatStore.swift");
  const sendStart = store.indexOf("func sendDraft() async");
  const makeTurn = store.indexOf("PendingSecretaryChatTurn.make", sendStart);
  const appendPending = store.indexOf("pendingTurns.append(turn)", sendStart);
  const transmit = store.indexOf("await transmit(turn", sendStart);
  assert.ok(sendStart >= 0 && makeTurn > sendStart);
  assert.ok(appendPending > makeTurn);
  assert.ok(transmit > appendPending);
});
