import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(appRoot, "native/InfansHealthSync/InfansHealthSync");

async function read(rel) {
  return readFile(path.join(appRoot, rel), "utf8");
}

test("开源树没有房间页", async () => {
  await assert.rejects(stat(path.join(appRoot, "src/secretary-room")), { code: "ENOENT" });
  const main = await read("src/main.tsx");
  assert.doesNotMatch(main, /secretary-room|SecretaryRoom|secretary-life-core|group-chat\.css|onOpenRoom|打开.*房间/u);
});

test("开源网页聊天使用公开一对一会话键", async () => {
  const overlays = await read("src/shell/WorkbenchOverlays.tsx");
  const session = await read("src/opensource-chat-session.mjs");
  assert.match(session, /infans-oss-ai-thread-v1/u);
  assert.match(overlays, /PUBLIC_THREAD_KEY|infans-oss-ai-thread-v1/u);
  assert.equal(overlays.includes("activatePrivateOverlay"), false);
});

test("开源设计台只保留一对一画布", async () => {
  const [model, lab] = await Promise.all([
    read("src/pages/tools/native-ui-design-model.ts"),
    read("src/pages/tools/NativeUiDesignLab.tsx"),
  ]);
  assert.equal(model.includes("group-stage"), false);
  assert.equal(lab.includes("GuestStage"), false);
  assert.equal(lab.includes("CandidateIpadGroupStage"), false);
});

test("开源 iOS 检查器只介绍一对一会话", async () => {
  const inspector = await readFile(path.join(nativeRoot, "SecretaryConversationInspectorView.swift"), "utf8");
  assert.match(inspector, /一对一会话/);
});

test("载入失败要收掉确认框，空存档不给点，别把人卡在换不了对话的界面上", async () => {
  const overlays = await read("src/shell/WorkbenchOverlays.tsx");
  const styles = await read("src/styles.css");
  const applyLoaded = overlays.slice(
    overlays.indexOf("const applyLoadedChat = async (id: string) => {"),
    overlays.indexOf("useEffect(() => {", overlays.indexOf("const applyLoadedChat = async (id: string) => {")),
  );
  const catchAt = applyLoaded.indexOf("} catch (error) {");
  assert.ok(catchAt >= 0);
  assert.match(applyLoaded.slice(catchAt), /setPendingLoad\(null\);[\s\S]*onToast\(/);

  const request = overlays.slice(
    overlays.indexOf("const requestLoadChat = (item: SecretaryChatListItem) => {"),
    overlays.indexOf("const confirmLoadChat ="),
  );
  assert.match(request, /item\.messageCount <= 0/);

  const confirmLoad = overlays.slice(
    overlays.indexOf("const confirmLoadChat = async () => {"),
    overlays.indexOf("const beginRenameChat ="),
  );
  assert.match(confirmLoad, /setPendingLoad\(null\);[\s\S]*onToast\([\s\S]*return;/);
  assert.match(confirmLoad, /这份聊天在别处也改过，先点保存另存一份，再换/);

  assert.match(overlays, /const isEmpty = item\.messageCount <= 0;/);
  assert.match(overlays, /disabled=\{busy \|\| isEmpty\}/);
  assert.match(overlays, /isEmpty \? " empty" : ""/);
  assert.match(styles, /\.ai-archive-item\.empty/);
  assert.doesNotMatch(overlays, /visibleGroupUiActive|GuestStage|群聊晴岚/);
});
