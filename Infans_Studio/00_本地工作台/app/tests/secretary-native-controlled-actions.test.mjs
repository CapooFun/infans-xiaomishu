import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const nativeRoot = new URL('../native/InfansHealthSync/InfansHealthSync/', import.meta.url)

const readNative = (name) => readFile(new URL(name, nativeRoot), 'utf8')

test('native controlled-action models keep only the public preview and tolerate future cards', async () => {
  const source = await readNative('SecretaryChatModels.swift')
  const modelStart = source.indexOf('struct SecretaryChatControlledAction:')
  const modelEnd = source.indexOf('enum SecretaryChatActionQueue', modelStart)
  const publicModels = source.slice(modelStart, modelEnd)
  assert.ok(modelStart >= 0 && modelEnd > modelStart)
  assert.match(publicModels, /targetLabel: String/)
  assert.match(publicModels, /targetPath: String\?/)
  assert.match(publicModels, /requiresConfirm: Bool/)
  assert.doesNotMatch(publicModels, /\btoken\b|rawAction|commitUrl|commitURL|\bcontent:/)
  assert.match(source, /controlledAction = try\? SecretaryChatControlledAction\(from: decoder\)/)

  const requestStart = source.indexOf('struct SecretaryChatActionDecisionRequest:')
  const requestEnd = source.indexOf('struct SecretaryChatActionDecisionResponse:', requestStart)
  const request = source.slice(requestStart, requestEnd)
  assert.match(request, /protocolVersion: Int/)
  assert.match(request, /conversationId: String/)
  assert.match(request, /generationId: String/)
  assert.match(request, /decision: String/)
  assert.doesNotMatch(request, /token|raw|path|content|commit/i)
})

test('native client lists actions, sends the strict decision body, and surfaces stale 409', async () => {
  const source = await readNative('SecretaryChatClient.swift')
  assert.match(source, /conversationPath\(conversationId\) \+ "\/actions"/)
  assert.match(source, /controlledActionDecisionBasePath \+ "\/\\\(actionId\)\/decision"/)
  assert.match(source, /request\.httpBody = try JSONEncoder\(\)\.encode\(payload\)/)
  assert.match(source, /http\.statusCode == 409/)
  assert.match(source, /stale\.stale/)
})

test('native store treats Mac as authority and blocks sends while a confirmation is pending', async () => {
  const source = await readNative('SecretaryChatStore.swift')
  assert.match(source, /reconcileControlledActionsFromMac/)
  assert.match(source, /SecretaryChatActionQueue\.replacingConversation/)
  assert.match(source, /event\.card\?\.controlledAction/)
  assert.match(source, /event\.actions/)
  assert.match(source, /guard canSendCurrentDraft else/)
  assert.match(source, /预览已更新，请重新确认/)
  assert.match(source, /decision == "confirm" \|\| decision == "cancel"/)
  assert.equal(source.includes("private func sendAutomaticGroupContinuation() async"), false)
  assert.equal(source.includes("continueAutomaticGroupIfNeeded"), false)
})

test('native confirmation UI shows the public target, diff, explicit decisions, and retained history', async () => {
  const [confirmation, conversation, root, composer] = await Promise.all([
    readNative('SecretaryChatActionConfirmationView.swift'),
    readNative('SecretaryConversationView.swift'),
    readNative('SecretaryChatRootView.swift'),
    readNative('SecretaryMessageComposer.swift'),
  ])
  assert.match(confirmation, /preview\.targetLabel/)
  assert.match(confirmation, /preview\.targetPath/)
  assert.match(confirmation, /preview\.summary/)
  assert.match(confirmation, /DisclosureGroup\(isExpanded: \$showsBefore\)/)
  assert.match(confirmation, /DisclosureGroup\(isExpanded: \$showsAfter\)/)
  assert.match(confirmation, /Text\("取消"\)/)
  assert.match(confirmation, /Text\("确认写入"\)/)
  assert.match(confirmation, /struct SecretaryChatActionHistoryCard/)
  assert.match(conversation, /SecretaryChatActionHistoryCard/)
  assert.match(root, /SecretaryChatActionConfirmationView\(store: store\)/)
  assert.match(composer, /store\.canSendCurrentDraft/)
})

test('native chat identifies the user as 我 without changing character forms of address', async () => {
  const [models, conversation, inspector] = await Promise.all([
    readNative('SecretaryChatModels.swift'),
    readNative('SecretaryConversationView.swift'),
    readNative('SecretaryConversationInspectorView.swift'),
  ])
  const localUserStart = models.indexOf('static func localUserMessage')
  const localUserEnd = models.indexOf('extension SecretaryChatConversation', localUserStart)
  const localUser = models.slice(localUserStart, localUserEnd)
  assert.match(localUser, /displayName: "我"/)
  assert.doesNotMatch(localUser, /displayName: "前辈"|displayName: "Capoo"/)
  assert.match(inspector, /memberRow\(name: "我", characterId: "self"/)
  assert.match(conversation, /if !message\.isFromCapoo[\s\S]*Text\(message\.sender\.displayName\)/)
})
