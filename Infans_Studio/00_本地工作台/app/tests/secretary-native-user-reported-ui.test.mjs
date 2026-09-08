import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "..");
const nativeRoot = path.join(appRoot, "native/InfansHealthSync/InfansHealthSync");

async function source(name) {
  return fs.readFile(path.join(nativeRoot, name), "utf8");
}

test("NATIVE-0903-02 keeps app media copy Chinese and leaves system pickers system-owned", async () => {
  const [composer, project] = await Promise.all([
    source("SecretaryMessageComposer.swift"),
    fs.readFile(
      path.join(appRoot, "native/InfansHealthSync/InfansHealthSync.xcodeproj/project.pbxproj"),
      "utf8",
    ),
  ]);

  assert.match(project, /developmentRegion = zh-Hans;/u);
  assert.match(project, /knownRegions = \(Base, "zh-Hans",\);/u);
  assert.match(composer, /label: "照片"/u);
  assert.match(composer, /label: "拍摄"/u);
  assert.match(composer, /label: "文件"/u);
  assert.match(composer, /照片读取失败/u);
  assert.match(composer, /文件选择失败/u);
  assert.match(composer, /相机权限没有开启/u);
  assert.match(composer, /PhotosPicker\(/u);
  assert.match(composer, /\.fileImporter\(/u);
  assert.match(composer, /UIImagePickerController/u);
  assert.doesNotMatch(composer, /AppleLanguages|UserDefaults\.standard\.set/u);
});

test("NATIVE-0903-03 gives both settings entries a full-width hit shape and clear gear", async () => {
  const [root, list] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretaryConversationListView.swift"),
  ]);
  const phoneEntry = list.slice(
    list.indexOf("private var settingsAndConnectionEntry"),
    list.indexOf("private var emptyState"),
  );
  const padEntry = root.slice(
    root.indexOf("Button {\n                    togglePadSidebar(.settings)"),
    root.indexOf("case .settings:"),
  );

  for (const entry of [phoneEntry, padEntry]) {
    assert.match(entry, /gearshape\.fill/u);
    assert.match(entry, /frame\(maxWidth: \.infinity, minHeight: 64, alignment: \.leading\)/u);
    assert.match(entry, /contentShape\((?:Rectangle|RoundedRectangle)/u);
    assert.match(entry, /accessibilityLabel\("打开设置与连接"\)/u);
  }
  assert.match(
    root,
    /openSettingsFromConversationDrawer\(\)[\s\S]*Task \{ @MainActor in[\s\S]*showsSettings = true/u,
  );
});

test("NATIVE-0903-04 keeps the ordinary settings title inside system navigation margins", async () => {
  const settings = await source("SecretarySettingsView.swift");
  assert.match(
    settings,
    /navigationTitle\("设置"\)\s*\.navigationBarTitleDisplayMode\(\.inline\)/u,
  );
});

test("NATIVE-0903-07 lets the composer background own the bottom safe area", async () => {
  const [root, composer] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretaryMessageComposer.swift"),
  ]);
  const standardColumn = root.slice(
    root.indexOf("private func standardChatColumn"),
    root.indexOf("private func standardConversationDrawer"),
  );

  assert.match(standardColumn, /SecretaryMessageComposer\(store: store\)/u);
  assert.doesNotMatch(standardColumn, /\.clipped\(\)/u);
  assert.match(composer, /Color\.secretaryPanelJade\.opacity\(surfaceOpacity\)\s*\.ignoresSafeArea\(edges: \.bottom\)/u);
  assert.match(root, /Color\.secretaryBarJade\.ignoresSafeArea\(\)/u);
});

test("NATIVE-0904-15 keeps connection diagnostics out of the management alert", async () => {
  const [root, store] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretaryChatStore.swift"),
  ]);
  const loadFailure = store.slice(
    store.indexOf("private func recordLoadFailure"),
    store.indexOf("private func updateCurrentConversation"),
  );
  const managementFailure = store.slice(
    store.indexOf("private func handleManagementFailure"),
    store.indexOf("private func normalizedOptionalText"),
  );

  assert.match(loadFailure, /updateConnectionState\(for: error\)/u);
  assert.doesNotMatch(loadFailure, /managementError\s*=/u);
  assert.match(managementFailure, /updateConnectionState\(for: error, offlineMessage: offlineMessage\)/u);
  assert.doesNotMatch(managementFailure, /managementError\s*=/u);
  assert.match(root, /store\.connectionState\.label/u);
  assert.match(root, /\.alert\("会话没有完成操作", isPresented: managementErrorBinding\)/u);
});
