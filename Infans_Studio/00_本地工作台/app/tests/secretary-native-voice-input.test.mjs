import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(appRoot, "native", "InfansHealthSync");

async function source(name) {
  return fs.readFile(path.join(nativeRoot, "InfansHealthSync", name), "utf8");
}

test("native iPhone and iPad voice input records AAC mono for at most sixty seconds", async () => {
  const recorder = await source("SecretaryVoiceRecorder.swift");
  assert.match(recorder, /requestRecordPermission/u);
  assert.match(recorder, /kAudioFormatMPEG4AAC/u);
  assert.match(recorder, /AVNumberOfChannelsKey:\s*1/u);
  assert.match(recorder, /maximumDuration:\s*TimeInterval\s*=\s*60/u);
  assert.match(recorder, /record\(forDuration:\s*Self\.maximumDuration\)/u);
  assert.match(recorder, /guard self\.recorder === recorder else \{ return \}/u);
  assert.match(recorder, /onMaximumDurationReached\?\(Self\.maximumDuration\)/u);
});

test("native transcript prefers runtime-probed on-device speech and keeps the private Mac route as fallback", async () => {
  const [client, store] = await Promise.all([
    source("SecretaryVoiceTranscriptionClient.swift"),
    source("SecretaryChatStore.swift"),
  ]);
  assert.match(client, /api\/secretary-mobile\/transcription/u);
  assert.match(client, /X-Infans-Recording-Id/u);
  assert.match(client, /X-Infans-Duration-Ms/u);
  assert.match(client, /X-Infans-Proper-Noun-Hints/u);
  assert.match(client, /makeRequest\([\s\S]*connection:\s*connection/u);
  assert.match(client, /SpeechTranscriber\.isAvailable/u);
  assert.match(client, /SpeechTranscriber\.supportedLocale/u);
  assert.match(client, /DictationTranscriber\.supportedLocale/u);
  assert.match(client, /AssetInventory\.assetInstallationRequest/u);
  assert.match(client, /contextualStrings\[\.general\]/u);
  assert.match(client, /struct SecretaryOnDeviceTranscriptionBenchmark/u);
  assert.match(client, /realTimeFactor:\s*Double\(processingDurationMs\) \/ Double\(normalizedAudioDuration\)/u);
  assert.match(store, /onDeviceVoiceTranscriber\.benchmark\([\s\S]*audioDurationMs:\s*durationMs[\s\S]*voiceClient\.transcribe/u);
  assert.match(store, /SecretaryOnDeviceASR[\s\S]*engine=[\s\S]*locale=[\s\S]*processingMs=[\s\S]*rtf=/u);
  assert.match(store, /voiceRecognitionHintsCache\s*=\s*\["银月"\]/u);
  assert.match(store, /let hints = voiceRecognitionHintsCache[\s\S]*onDeviceVoiceTranscriber\.benchmark/u);
  assert.match(store, /catch \{[\s\S]*let connection = try connection\(\)[\s\S]*voiceClient\.transcribe/u);
  assert.match(store, /client\.voiceCorrections\(connection:\s*connection\)\.hints/u);
  assert.match(store, /voiceRecognitionHintsCache = Array\(Set\(\["银月"\] \+ shared\)\)\.sorted\(\)/u);
  assert.doesNotMatch(`${client}\n${store}`, /SFSpeechRecognizer/u);
});

test("voice release queues one original-audio message while files stay private until success or deletion", async () => {
  const [composer, voiceInput, attachmentStore, client, info, project] = await Promise.all([
    source("SecretaryMessageComposer.swift"),
    source("SecretaryVoiceInputStore.swift"),
    source("SecretaryAttachmentDraftStore.swift"),
    source("SecretaryVoiceTranscriptionClient.swift"),
    source("Info.plist"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync.xcodeproj", "project.pbxproj"), "utf8"),
  ]);
  assert.match(composer, /Image\(systemName:\s*usesHoldToTalk\s*\?\s*"keyboard"\s*:\s*"mic\.fill"\)/u);
  assert.match(composer, /SecretaryHoldToTalkSurface\(/u);
  assert.match(composer, /SecretaryHoldToTalkTouchTarget\(/u);
  assert.match(composer, /final class HoldControl:\s*UIControl/u);
  assert.match(composer, /override func beginTracking/u);
  assert.match(composer, /override func continueTracking/u);
  assert.match(composer, /override func endTracking/u);
  assert.match(composer, /UIImpactFeedbackGenerator\(style:\s*\.heavy\)/u);
  assert.match(composer, /impactOccurred\(intensity:\s*1\.0\)/u);
  assert.match(composer, /Color\.secretaryJade\.opacity\(0\.18\)/u);
  assert.match(composer, /touch\.location\(in:\s*self\)\.y\s*-\s*initialY\s*<\s*-cancellationDistance/u);
  assert.doesNotMatch(composer, /DragGesture\(minimumDistance:\s*0\)/u);
  assert.match(composer, /voiceInput\.beginHoldRecording\(\)/u);
  assert.match(composer, /voiceInput\.endHoldRecording\(cancelled:\s*cancelled\)/u);
  assert.match(voiceInput, /func beginHoldRecording\(\) async/u);
  assert.match(voiceInput, /func endHoldRecording\(cancelled:\s*Bool\) async/u);
  const queueHandler = composer.match(/\.onChange\(of:\s*voiceInput\.captureRequest\?\.id\)[\s\S]*?\n\s*\}/u)?.[0] || "";
  assert.match(queueHandler, /store\.queueVoiceRecording/u);
  assert.match(queueHandler, /voiceInput\.markQueued/u);
  assert.match(composer, /voiceInput\.markQueueFailed/u);
  assert.doesNotMatch(`${composer}\n${voiceInput}`, /transcriptForDraft|store\.updateDraft\(.*transcript/u);
  assert.match(attachmentStore, /func stageVoice\(/u);
  assert.match(attachmentStore, /id:\s*recording\.recordingId/u);
  assert.match(`${attachmentStore}\n${client}`, /isExcludedFromBackup\s*=\s*true/u);
  assert.match(`${attachmentStore}\n${client}`, /completeFileProtection/u);
  assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/u);
  const mainSources = project.match(/\n\s*100000000000000000000020 \/\* Sources \*\/ = \{[\s\S]*?runOnlyForDeploymentPostprocessing = 0;/u)?.[0] || "";
  const watchSources = project.match(/\n\s*120000000000000000000020 \/\* Sources \*\/ = \{[\s\S]*?runOnlyForDeploymentPostprocessing = 0;/u)?.[0] || "";
  assert.match(mainSources, /SecretaryVoiceRecorder\.swift in Sources/u);
  assert.match(mainSources, /SecretaryVoiceInputStore\.swift in Sources/u);
  assert.doesNotMatch(watchSources, /SecretaryVoice(?:Recorder|InputStore|TranscriptionClient)\.swift/u);
});

test("native voice recovery polls NAS quietly, formats duration from milliseconds and retries only failed stable IDs", async () => {
  const [composer, conversation, attachment, settings, root, store, models, sharedConfiguration, commandSettings] = await Promise.all([
    source("SecretaryMessageComposer.swift"),
    source("SecretaryConversationView.swift"),
    source("SecretaryAttachmentView.swift"),
    source("SecretarySettingsView.swift"),
    source("SecretaryChatRootView.swift"),
    source("SecretaryChatStore.swift"),
    source("SecretaryChatModels.swift"),
    source("SecretarySharedConfiguration.swift"),
    source("CodexCommandSettings.swift"),
  ]);
  assert.match(composer, /@AppStorage\("secretary\.debugMode"\)[\s\S]*if debugMode, store\.pendingCount > 0/u);
  assert.match(settings, /DisclosureGroup\("维护与诊断"[\s\S]*Toggle\("显示详细发送状态", isOn: \$debugMode\)/u);
  assert.match(settings, /@State private var showsMaintenance = false/u);
  assert.match(settings, /if showsMaintenance \{[\s\S]*TextField\("NAS 信箱 HTTPS 地址", text: \$commandSettings\.mailboxServerURL\)/u);
  assert.match(sharedConfiguration, /mailboxServerURLKey = "secretary\.mailboxServerURL"[\s\S]*fallbackMailboxServerURL = ""/u);
  assert.match(commandSettings, /@Published var mailboxServerURL: String/u);
  assert.match(conversation, /store\.retryPending\(messageId: message\.id\)/u);
  assert.match(conversation, /Text\("未送达 · 点一下重试"\)/u);
  assert.match(conversation, /if debugMode, let pendingError/u);
  assert.match(attachment, /attachment\.presentationKind == \.audio, let durationMs = attachment\.durationMs[\s\S]*Double\(durationMs\) \/ 1_000[\s\S]*"语音 · %d:%02d"/u);
  assert.match(attachment, /setCategory\(\.playback, mode:\s*\.spokenAudio, options:\s*\[\.duckOthers\]\)/u);
  assert.match(conversation, /@State private var correctionTarget:\s*SecretaryVoiceCorrectionTarget\?/u);
  assert.match(conversation, /onCorrectVoice:\s*\{ messageId, attachment in[\s\S]*correctionTarget = SecretaryVoiceCorrectionTarget/u);
  assert.match(conversation, /\.sheet\(item:\s*\$correctionTarget\)/u);
  assert.match(conversation, /TextEditor\(text:\s*\$editedTranscript\)/u);
  assert.match(conversation, /Text\("修改后会记住这次纠正，不会重新发消息。"\)/u);
  assert.match(conversation, /savedCorrection == nil \? \[\.medium, \.large\] : \[\.height\(360\)\]/u);
  assert.match(conversation, /ToolbarItem\(placement:\s*\.confirmationAction\)[\s\S]*Button\("关闭"\)/u);
  assert.doesNotMatch(conversation, /SecretaryTranscriptSelectionView|NSRange|UITextView/u);
  assert.match(root, /\.task\(id: scenePhase\)[\s\S]*recoverPendingWhileVisible\(\)/u);
  assert.match(store, /func recoverPendingWhileVisible\(\) async[\s\S]*while !Task\.isCancelled[\s\S]*pendingTransmissionTask == nil[\s\S]*syncMailbox\(conversationId: conversationId\)[\s\S]*state == \.failedRetryPending[\s\S]*automaticallyRetriedMessageIDs\.insert\(refreshed\.messageId\)\.inserted[\s\S]*schedulePendingTransmission\(messageId: refreshed\.messageId\)[\s\S]*await pendingTransmissionTask\?\.value/u);
  assert.doesNotMatch(root, /recoveryTrigger/u);
  assert.match(store, /func retryPending\(messageId: String\) async[\s\S]*syncMailbox\(conversationId: initial\.conversationId\)[\s\S]*\$0\.messageId == messageId && \$0\.needsTransmission[\s\S]*schedulePendingTransmission\(messageId: refreshed\.messageId\)[\s\S]*await pendingTransmissionTask\?\.value/u);
  assert.match(models, /case \.failedRetryPending: return "未送达"/u);
});

test("hold to talk stays visually minimal and consecutive voice clips enter one ordered worker", async () => {
  const [composer, voiceInput, store, models] = await Promise.all([
    source("SecretaryMessageComposer.swift"),
    source("SecretaryVoiceInputStore.swift"),
    source("SecretaryChatStore.swift"),
    source("SecretaryChatModels.swift"),
  ]);

  assert.doesNotMatch(composer, /if let status = voiceInput\.statusText/u);
  assert.doesNotMatch(composer, /private func voiceStatusRow/u);
  assert.match(composer, /limitCountdown:\s*voiceInput\.recordingLimitCountdown/u);
  assert.match(composer, /if let limitCountdown[\s\S]*"\u677e\u5f00\u53d1\u9001 · \\\(limitCountdown\)"/u);
  assert.match(voiceInput, /var recordingLimitCountdown:\s*Int\?[\s\S]*elapsedSeconds >= 50/u);

  const queueVoice = store.slice(
    store.indexOf("func queueVoiceRecording("),
    store.indexOf("func correctVoiceTranscript(")
  );
  assert.doesNotMatch(queueVoice, /guard\s+!isStreaming,\s*!isUploadingAttachments/u);
  assert.match(queueVoice, /schedulePendingTransmission\(messageId:\s*turn\.messageId\)/u);
  assert.match(store, /private var pendingTransmissionMessageIDs:\s*\[String\]/u);
  assert.match(store, /private var pendingTransmissionTask:\s*Task<Void, Never>\?/u);
  assert.match(store, /voiceQueueAdmission\.perform\(messageID:\s*messageId\)/u);
  assert.match(store, /SecretaryChatTransmissionOrder\.nextMessageID/u);
  assert.match(store, /var failedAttachmentDrafts:[\s\S]*\.filter \{ \$0\.kind != "audio" \}/u);
  assert.match(models, /actor SecretaryVoiceQueueAdmission[\s\S]*inFlight\[messageID\][\s\S]*return await existing\.value/u);
  assert.match(models, /enum SecretaryChatTransmissionOrder/u);
});

test("Watch raw voice uses the same on-device transcriber with the private Mac provider as fallback", async () => {
  const bridge = await source("PhoneCommandBridge.swift");
  assert.doesNotMatch(bridge, /import WatchConnectivity|WCSession|rawVoiceRetryAccepted/u);
  assert.doesNotMatch(bridge, /func retryPending\(\)/u);
});

test("device token preserves its value while migrating only the app keychain accessibility", async () => {
  const [keychain, app, bridge] = await Promise.all([
    source("CodexCommandTokenKeychain.swift"), source("InfansHealthSyncApp.swift"), source("PhoneCommandBridge.swift"),
  ]);
  assert.match(keychain, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/u);
  assert.doesNotMatch(keychain, /SecItemDelete|kSecAttrAccessibleAlways|UserDefaults|print\(/u);
  const migration = keychain.split("static func migrateLegacyItemIfNeeded()")[1].split("private static var accessGroup")[0];
  assert.match(migration, /SecItemUpdate\(lookup\(accessGroup: accessGroup\)/u);
  assert.match(migration, /status == errSecItemNotFound/u);
  assert.match(migration, /try save\(legacy, accessGroup: accessGroup\)/u);
  assert.match(keychain, /add\.merge\(attributes\)/u);
  assert.match(app, /applicationProtectedDataDidBecomeAvailable[\s\S]*prepareBackgroundCredential\(\)/u);
  assert.doesNotMatch(app, /PhoneCommandBridge\.shared\.retryPending\(\)/u);
  assert.doesNotMatch(bridge, /func retryPending\(\)/u);
});

test("iPhone 空桥仍可应答轻回应轮询，Watch App 源码不在开源树", async () => {
  const bridge = await source("PhoneCommandBridge.swift");
  await assert.rejects(fs.stat(path.join(nativeRoot, "InfansHealthSyncWatch")), { code: "ENOENT" });
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /WATCH_EXCLUDED/u);
  assert.doesNotMatch(bridge, /codexReplyPollAccepted|WCSession/u);
});
