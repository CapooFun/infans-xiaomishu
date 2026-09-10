import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

async function source(name) {
  return fs.readFile(path.join(nativeRoot, name), "utf8");
}

test("iPhone 一对一模型在设置聊天体验里用空壳列表，顶栏不要入口", async () => {
  const [root, settings, store, models] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretarySettingsView.swift"),
    source("SecretaryChatStore.swift"),
    source("SecretaryChatModels.swift"),
  ]);
  const header = root.slice(
    root.indexOf("struct SecretaryChatHeader"),
    root.indexOf("private struct SecretaryHeaderButtonStyle"),
  );
  const experienceStart = settings.indexOf('Section("聊天体验")');
  const experienceEnd = settings.indexOf('Section("分享送达")');
  const experience = settings.slice(experienceStart, experienceEnd > experienceStart ? experienceEnd : experienceStart + 900);
  const list = settings.slice(settings.indexOf("private struct SecretaryOrdinaryModelSettingsList"));

  assert.match(root, /showsOrdinaryModelList: usesPhoneFrontend/u);
  assert.doesNotMatch(header, /showsOrdinaryModelSwitch|chooseOrdinaryBackend|ordinaryModelSwitch|Aion|不读记忆|缨宁|cursor-grok/u);

  assert.match(experience, /SecretaryOrdinaryModelSettingsList\(store: chatStore\)/u);
  assert.match(experience, /Toggle\("秘书回复完后自动朗读"/u);
  assert.ok(experience.indexOf("SecretaryOrdinaryModelSettingsList") < experience.indexOf('Toggle("秘书回复完后自动朗读"'));
  assert.doesNotMatch(experience, /ForEach\(store\.ordinaryChannelSwitchBackends/u);
  assert.match(list, /Picker\(SecretaryOrdinaryChannelSwitch\.listTitle/u);
  assert.match(list, /\.pickerStyle\(\.navigationLink\)/u);
  assert.match(list, /ForEach\(store\.ordinaryChannelSwitchBackends/u);
  assert.match(list, /SecretaryOrdinaryChannelSwitch\.entryLabel/u);
  assert.match(list, /chooseOrdinaryBackend/u);
  assert.doesNotMatch(list, /allowedCursorModels|Cursor 模型|option\.label|cursor-grok|aion-labs|Aion|不读记忆|缨宁/u);
  assert.doesNotMatch(list, /OPENAI_REALTIME|HYBRID_REALTIME|边说边回|openai-realtime/u);
  assert.doesNotMatch(settings, /showsOrdinaryModelSwitch/u);

  assert.match(store, /func chooseOrdinaryBackend\(_ backend: String\) async/u);
  const choose = store.slice(
    store.indexOf("func chooseOrdinaryBackend"),
    store.indexOf("var currentExecutionMetrics"),
  );
  assert.match(choose, /开源模型位只留空壳/u);
  assert.doesNotMatch(choose, /cursorModel:/u);
  assert.doesNotMatch(choose, /groupBackend:/u);
  assert.doesNotMatch(choose, /群聊请用会话控制里的模型/u);
  assert.doesNotMatch(choose, /Aion|Cursor|缨宁|不读记忆/u);
  assert.doesNotMatch(store, /这个 Cursor 模型|cursor-grok|aion-labs|不读记忆/u);

  assert.match(models, /enum SecretaryOrdinaryChannelSwitch/u);
  assert.match(models, /static let listTitle = "一对一模型"/u);
  assert.match(models, /return "未配置"/u);
  assert.match(models, /unconfiguredBackend/u);
  const channel = models.slice(
    models.indexOf("enum SecretaryOrdinaryChannelSwitch"),
    models.indexOf("struct SecretaryChatUsage"),
  );
  assert.doesNotMatch(channel, /Aion|不读记忆|cursor-grok|缨宁|Cursor/u);
});

test("iPad 设置里不另做第二套群聊模型", async () => {
  const [root, inspector, settings] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretaryConversationInspectorView.swift"),
    source("SecretarySettingsView.swift"),
  ]);
  const padSettings = root.slice(
    root.indexOf("case .settings:"),
    root.indexOf("private func togglePadSidebar"),
  );
  assert.doesNotMatch(inspector, /群聊模型|群聊服务/u);
  assert.doesNotMatch(inspector, /showsOrdinaryModelList|SecretaryOrdinaryModelSettingsList|chooseOrdinaryBackend/u);
  assert.doesNotMatch(inspector, /Cursor 模型/u);
  assert.match(inspector, /未配置/u);
  assert.doesNotMatch(padSettings, /showsOrdinaryModelList: true/u);
  assert.doesNotMatch(padSettings, /showsOrdinaryModelList: usesPhoneFrontend/u);
  assert.match(settings, /showsOrdinaryModelList, let chatStore/u);
});
