import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

test("native conversation drawer filters locally by title, preview and member display name", async () => {
  const source = await fs.readFile(path.join(nativeRoot, "SecretaryConversationListView.swift"), "utf8");

  assert.match(source, /@State private var searchQuery = ""/u);
  assert.match(source, /TextField\("搜索会话", text: \$searchQuery\)/u);
  assert.match(source, /ForEach\(filteredConversationSummaries\)/u);
  assert.match(source, /private func conversationButton[\s\S]*contentShape\(RoundedRectangle\(cornerRadius: 13, style: \.continuous\)\)/u);
  assert.match(source, /accessibilityHint\("打开这条会话"\)/u);
  assert.match(source, /displayedConversationTitle\(conversation\),[\s\S]*conversation\.title,[\s\S]*conversation\.lastMessage\?\.fallbackText \?\? "",[\s\S]*memberNames/u);
  assert.match(source, /if memberId == "capoo" \{ return "我" \}/u);
  assert.match(source, /bootstrap\?\.characters\.first\(where: \{ \$0\.id == memberId \}\)\?\.displayName/u);
  assert.match(source, /localizedCaseInsensitiveContains/u);
  assert.match(source, /displayedConversationTitle\(conversation\)/u);
  assert.match(source, /SecretaryConversationDisplayTitle\.listTitle/u);
  assert.match(source, /guard !terms\.isEmpty else \{ return visibleConversationSummaries \}/u);
  assert.match(source, /SecretaryConversationVisibilityPolicy\.phoneConversations/u);
  assert.match(source, /\.scrollIndicators\(\.hidden\)/u);
});

test("native conversation search reports an honest empty state and can restore the full list", async () => {
  const [source, store] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "SecretaryConversationListView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8"),
  ]);

  assert.match(source, /else if filteredConversationSummaries\.isEmpty \{[\s\S]*searchEmptyState/u);
  assert.match(source, /没找到匹配的会话/u);
  assert.match(source, /换个标题、消息关键词或成员名/u);
  assert.match(source, /accessibilityLabel\("清空会话搜索"\)/u);
  assert.match(source, /Button\("清空搜索"\) \{ searchQuery = "" \}/u);
  assert.match(source, /await store\.createConversation/u);
  assert.match(source, /await store\.renameCurrentConversation/u);
  assert.match(source, /deleteTarget = conversation[\s\S]*showsDeleteConfirmation = true/u);
  assert.match(source, /store\.deleteConversation\(conversation\)/u);
  assert.doesNotMatch(source, /Button\(role: \.destructive\)[\s\S]{0,180}selectConversation/u);
  assert.match(store, /func deleteConversation\(_ summary: SecretaryChatConversationSummary\)/u);
  assert.match(store, /if deletesCurrentConversation \{/u);
  assert.match(source, /await store\.selectConversation/u);
});

test("native conversation drawer creates directly with a secretary-name title and keeps settings inside the drawer", async () => {
  const source = await fs.readFile(path.join(nativeRoot, "SecretaryConversationListView.swift"), "utf8");

  assert.doesNotMatch(source, /alert\("新建会话"|TextField\("标题（可选）"/u);
  assert.match(source, /createConversationWithoutNamingPrompt\(secretary: secretary\)/u);
  assert.match(source, /newConversationRail[\s\S]*conversationSearchField[\s\S]*ScrollView/u);
  assert.match(source, /ScrollView\(\.horizontal\)[\s\S]*ForEach\(store\.availableSecretaries\)[\s\S]*secretarySeatButton/u);
  assert.match(source, /SecretarySeatAvatar[\s\S]*clipShape\(Circle\(\)\)/u);
  assert.match(source, /Image\(systemName: "plus"\)[\s\S]*frame\(width: 16, height: 16\)[\s\S]*background\(Color\.secretaryJade, in: Circle\(\)\)/u);
  assert.match(source, /ScrollView\(\.horizontal\)[\s\S]*frame\(height: 52\)/u);
  assert.doesNotMatch(source, /Text\("新建会话"\)/u);
  assert.match(source, /accessibilityLabel\("和\\\(secretary\.displayName\)新建会话"\)/u);
  assert.doesNotMatch(source, /值班秘书|Text\("值班 ·/u);
  const header = source.match(/private var listHeader:[\s\S]*?private var newConversationRail/u)?.[0] ?? "";
  assert.doesNotMatch(header, /systemName: "plus"/u);
  assert.match(source, /SecretaryConversationDisplayTitle\.nextStoredTitle/u);
  assert.match(source, /secretaryName: secretary\.displayName/u);
  assert.match(source, /store\.createConversation\(title: title, secretaryId: secretary\.id\)/u);
  assert.match(source, /SecretaryAvatarView\(/u);
  assert.doesNotMatch(source, /日 · 和\\\(secretary\.displayName\)聊聊/u);
  assert.match(source, /utilityEntry\("设置"/u);
  assert.match(source, /onOpenSettings/u);
  assert.match(source, /contextMenu[\s\S]*Label\("重命名"[\s\S]*Label\("删除"/u);
  assert.match(source, /\.alert\([\s\S]*删除“\\\(deleteTarget\.map\(displayedConversationTitle\)[\s\S]*“\\\(displayedConversationTitle\(conversation\)\)”会从 Mac 删除/u);
});
