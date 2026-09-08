import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nativeRoot = new URL("../native/InfansHealthSync/InfansHealthSync/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, nativeRoot), "utf8");
}

test("native composer stages real photo and whitelisted file selections without selection-time upload", async () => {
  const [composer, store, info] = await Promise.all([
    source("SecretaryMessageComposer.swift"),
    source("SecretaryChatStore.swift"),
    source("Info.plist"),
  ]);
  assert.match(composer, /SecretaryCameraPicker\(/);
  assert.match(composer, /UIImagePickerController\.isSourceTypeAvailable\(\.camera\)/);
  assert.match(composer, /AVCaptureDevice\.authorizationStatus\(for:\s*\.video\)/);
  assert.match(composer, /AVCaptureDevice\.requestAccess\(for:\s*\.video\)/);
  assert.match(composer, /case \.denied, \.restricted:/);
  assert.match(composer, /picker\.sourceType\s*=\s*\.camera/);
  assert.match(composer, /image\.jpegData\(compressionQuality:\s*0\.92\)/);
  assert.match(info, /<key>NSCameraUsageDescription<\/key>/);
  assert.match(composer, /PhotosPicker\(/);
  assert.match(composer, /\.fileImporter\(/);
  assert.match(composer, /SecretaryAttachmentMIME\.importedContentTypes/);
  assert.match(composer, /store\.currentAttachmentDrafts/);
  assert.match(composer, /removeAttachmentDraft/);
  assert.match(store, /SecretaryAttachmentSelectionPolicy\.canAccept/);

  const selectionSection = store.slice(store.indexOf("func addPhoto("), store.indexOf("func updateScrollAnchor"));
  assert.doesNotMatch(selectionSection, /uploadAttachment\(/);
  assert.match(selectionSection, /stagePhoto/);
  assert.match(selectionSection, /stageImportedFile/);
});

test("native picker failures are visible while user cancellation stays silent", async () => {
  const [composer, store] = await Promise.all([
    source("SecretaryMessageComposer.swift"),
    source("SecretaryChatStore.swift"),
  ]);

  assert.match(composer, /try await item\.loadTransferable\(type: Data\.self\)/u);
  assert.match(composer, /guard let data = try await item\.loadTransferable\(type: Data\.self\) else \{[\s\S]*?transferError = "照片读取失败，请换一张再试"/u);
  assert.match(composer, /catch is CancellationError \{[\s\S]*?continue[\s\S]*?\} catch \{[\s\S]*?transferError = "照片读取失败：/u);
  assert.match(composer, /if let transferError \{[\s\S]*?store\.reportAttachmentDraftError\(transferError\)/u);

  assert.match(composer, /case let \.failure\(error\):[\s\S]*?guard !isUserCancellation\(error\) else \{ return \}[\s\S]*?store\.reportAttachmentDraftError\("文件选择失败：/u);
  assert.match(composer, /error is CancellationError/u);
  assert.match(composer, /cocoaError\.code == NSUserCancelledError/u);

  assert.match(composer, /onFailure: \{[\s\S]*?store\.reportAttachmentDraftError\("相机照片处理失败/u);
  assert.match(composer, /guard let image = info\[\.originalImage\] as\? UIImage,[\s\S]*?image\.jpegData\(compressionQuality: 0\.92\) else \{[\s\S]*?parent\.onFailure\(\)/u);
  assert.match(composer, /imagePickerControllerDidCancel[\s\S]*?parent\.onCancel\(\)/u);
  assert.match(store, /func reportAttachmentDraftError\(_ message: String\) \{[\s\S]*?attachmentDraftError = message/u);
});

test("native attachment staging is private and HEIC normalization writes clean JPEG pixels", async () => {
  const staging = await source("SecretaryAttachmentDraftStore.swift");
  assert.match(staging, /startAccessingSecurityScopedResource/);
  assert.match(staging, /ApplicationSupportDirectory|applicationSupportDirectory/i);
  assert.match(staging, /isExcludedFromBackup = true/);
  assert.match(staging, /completeFileProtection/);
  assert.match(staging, /posixPermissions: 0o700/);
  assert.match(staging, /posixPermissions: 0o600/);
  assert.match(staging, /kCGImageSourceCreateThumbnailWithTransform: true/);
  assert.match(staging, /UTType\.jpeg\.identifier/);
  assert.doesNotMatch(staging, /kCGImagePropertyGPSDictionary\s*:/);
  assert.doesNotMatch(staging, /kCGImagePropertyExifDictionary\s*:/);
});

test("native upload keeps binary attachments on Mac while NAS voice delivery uses transcript metadata", async () => {
  const [client, models, store] = await Promise.all([
    source("SecretaryChatClient.swift"),
    source("SecretaryChatModels.swift"),
    source("SecretaryChatStore.swift"),
  ]);
  assert.match(client, /api\/secretary-mobile\/attachments/);
  assert.match(client, /X-Infans-Attachment-Id/);
  assert.match(client, /X-Infans-Filename/);
  assert.match(client, /request\.httpBody = try Data\(contentsOf:/);
  assert.doesNotMatch(client, /multipart\/form-data/);
  assert.match(models, /attachments: attachments\.compactMap/);
  assert.match(models, /var mailboxRequest:[\s\S]*attachments: attachments\.map[\s\S]*resourcePath: attachment\.uploadedAttachment\?\.resourcePath \?\? "local-draft:/u);
  assert.match(models, /autoChat \? \[\] : attachments/);

  const transcriptGate = store.indexOf("guard await transcribePendingVoiceIfNeeded");
  const uploadGate = store.indexOf("guard await uploadPendingAttachmentsIfNeeded", transcriptGate);
  const mailboxGate = store.indexOf("client.persistToMailbox", uploadGate);
  const mailboxSync = store.indexOf("syncMailbox(conversationId: turn.conversationId)", mailboxGate);
  const streamStart = store.indexOf("client.streamTurn", mailboxSync);
  assert.ok(transcriptGate >= 0 && uploadGate > transcriptGate && mailboxGate > uploadGate && mailboxSync > mailboxGate && streamStart > mailboxSync);
  assert.match(store, /includesAudio:\s*!usesMailbox/u);
  assert.match(store, /conversation\.type == "direct"/u);
  assert.match(store, /A timed-out accept may already be durable on the NAS[\s\S]*never fall through to direct Mac generation/u);
  assert.match(store, /uploadedAttachment == nil/);
  assert.match(store, /\$0\.uploadedAttachment == nil && \(includesAudio \|\| \$0\.kind != "audio"\)/u);
  assert.match(store, /guard turn\.isReadyForMailbox else \{/);
  assert.match(store, /filter \{ \$0\.kind != "audio" \}/u);
});

test("sent audio keeps its private local draft and only falls back to a Mac resource when needed", async () => {
  const [store, view, models] = await Promise.all([
    source("SecretaryChatStore.swift"),
    source("SecretaryAttachmentView.swift"),
    source("SecretaryChatModels.swift"),
  ]);

  const resolver = store.slice(
    store.indexOf("func localAttachmentURL(for attachment:"),
    store.indexOf("func pendingCount(for conversationId:")
  );
  assert.match(resolver, /SecretaryAttachmentPlaybackSourcePolicy\.preferredSource/u);
  assert.match(resolver, /attachmentDraftStore\.loadAll\(\)[\s\S]*storedDrafts\?\.first/u);
  assert.match(resolver, /case \.localDraft/u);
  assert.match(resolver, /case \.remoteResource/u);
  assert.match(resolver, /SecretaryAttachmentCache\.shared\.localURL/u);
  assert.match(models, /enum SecretaryAttachmentPlaybackSourcePolicy/u);

  const resolvedURL = view.slice(
    view.indexOf("private func resolvedURL()"),
    view.indexOf("private func loadIfNeeded()")
  );
  assert.match(resolvedURL, /FileManager\.default\.fileExists\(atPath:\s*localURL\.path\)/u);
  assert.match(resolvedURL, /self\.localURL = nil/u);
});
