import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

const nativeRoot = new URL('../native/InfansHealthSync/InfansHealthSync/', import.meta.url)

test('开源版原生主界面只保留一对一画布', async () => {
  const root = await readFile(new URL('SecretaryChatRootView.swift', nativeRoot), 'utf8')
  assert.match(root, /if usesPadLandscapeCanvas[\s\S]*padLandscapeCanvas\(geometry: geometry\)/)
  assert.doesNotMatch(root, /padGroupSurface|padGroupConversationColumn|SecretaryGuestStageView|SecretaryGuestStageSnapshot/)
  await assert.rejects(stat(new URL('SecretaryGuestStageView.swift', nativeRoot)), { code: 'ENOENT' })
  await assert.rejects(stat(new URL('SecretaryGuestStageModel.swift', nativeRoot)), { code: 'ENOENT' })
  await assert.rejects(stat(new URL('SecretaryGuestMediaView.swift', nativeRoot)), { code: 'ENOENT' })
  await assert.rejects(stat(new URL('SecretaryGuestMediaClient.swift', nativeRoot)), { code: 'ENOENT' })
})

test('开源版 iPad 横屏只保留单聊侧栏', async () => {
  const root = await readFile(new URL('SecretaryChatRootView.swift', nativeRoot), 'utf8')
  assert.match(root, /enum SecretaryPadSidebar[\s\S]*case conversations[\s\S]*case settings/)
  assert.match(root, /let sidebarWidth = min\(280, max\(220, contentWidth \* 0\.22\)\)/)
  assert.doesNotMatch(root, /padGroupSurface|padGroupConversationColumn|let groupWidth = contentWidth \* 0\.50/)
})

test('开源单聊视频感把头像固定在画面中央', async () => {
  const [root, conversation, list] = await Promise.all([
    readFile(new URL('SecretaryChatRootView.swift', nativeRoot), 'utf8'),
    readFile(new URL('SecretaryConversationView.swift', nativeRoot), 'utf8'),
    readFile(new URL('SecretaryConversationListView.swift', nativeRoot), 'utf8'),
  ])
  assert.match(root, /secretarySpeechImmersion/)
  assert.match(root, /SecretarySpeechImmersionScrim/)
  assert.match(root, /setChatActive/)
  assert.doesNotMatch(root, /SecretaryPadSpeechSpotlight/)
  assert.doesNotMatch(root, /private var speakingMessage/)
  assert.doesNotMatch(root, /左右互换|灵动岛|端侧模型/)
  assert.match(conversation, /SecretaryFixedVideoReply/)
  assert.match(conversation, /SecretarySpeechCaptions\.typedPrefix/)
  assert.match(conversation, /secretaryImmersionFog/)
  assert.doesNotMatch(conversation, /isVideoSpeaking/)
  assert.match(list, /hasUnreadReply/)
  assert.match(list, /有未读回复/)
})

test('开源单聊支持视频感和已读不回', async () => {
  const [conversation, settings, experience] = await Promise.all([
    readFile(new URL('SecretaryConversationView.swift', nativeRoot), 'utf8'),
    readFile(new URL('SecretarySettingsView.swift', nativeRoot), 'utf8'),
    readFile(new URL('SecretaryChatExperience.swift', nativeRoot), 'utf8'),
  ])
  assert.match(conversation, /SecretaryFixedVideoReply/)
  assert.match(conversation, /SecretarySpeechCaptions\.typedPrefix/)
  assert.match(conversation, /已读不回/)
  assert.match(settings, /Section\("视频感"\)/)
  assert.match(settings, /Text\("假装在视频。"\)/)
  assert.ok(settings.indexOf('Section("视频感")') < settings.indexOf('Section("聊天体验")'))
  assert.match(experience, /videoFeelEnabled/)
  assert.match(experience, /secretaryChat\.speech\.videoFeelEnabled/)
})
