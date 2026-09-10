import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum SecretaryKeyboard {
    static let dismissNotification = Notification.Name("SecretaryKeyboard.dismiss")

    @MainActor
    static func resign() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        NotificationCenter.default.post(name: dismissNotification, object: nil)
    }
}

struct SecretaryMessageComposer: View {
    @ObservedObject var store: SecretaryChatStore
    var accessoryActions: SecretaryComposerAccessoryActions = .unavailable
    @StateObject private var voiceInput = SecretaryVoiceInputStore()
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isCameraPresented = false
    @State private var cameraError: String?
    @State private var isFileImporterPresented = false
    @State private var usesHoldToTalk = false
    @State private var showsMoreActions = false
    @State private var showsEmojiPicker = false
    @AppStorage("secretary.debugMode") private var debugMode = false
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            if debugMode, store.pendingCount > 0 {
                HStack {
                    Text("还有 \(store.pendingCount) 句话没传过去")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.secretaryAmber)
                    Spacer()
                    Button("再试一次") { Task { await store.retryPending() } }
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(Color.secretaryIvory)
                }
                .padding(.horizontal, 4)
            }

            if let action = store.nextPendingControlledAction {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.shield.fill")
                    Text("先确认「\(action.label)」，再继续发消息")
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button("查看确认") { store.presentControlledAction(action.actionId) }
                }
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
                .padding(.horizontal, 4)
            } else if let notice = store.actionDecisionNotice {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(notice).lineLimit(2)
                    Spacer(minLength: 4)
                }
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
                .padding(.horizontal, 4)
            }

            if !store.currentAttachmentDrafts.isEmpty {
                attachmentDraftList(store.currentAttachmentDrafts, failed: false)
            }

            if !store.failedAttachmentDrafts.isEmpty {
                attachmentDraftList(store.failedAttachmentDrafts, failed: true)
            }

            if let error = store.attachmentDraftError {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(error).lineLimit(2)
                    Spacer(minLength: 4)
                    Button("知道了") { store.clearAttachmentDraftError() }
                }
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
                .padding(.horizontal, 4)
            }

            if let cameraError {
                HStack(spacing: 8) {
                    Image(systemName: "camera.fill")
                    Text(cameraError).lineLimit(2)
                    Spacer(minLength: 4)
                    Button("知道了") { self.cameraError = nil }
                }
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
                .padding(.horizontal, 4)
            }

            HStack(alignment: .center, spacing: 7) {
                Button {
                    usesHoldToTalk.toggle()
                    showsMoreActions = false
                    setComposerFocused(!usesHoldToTalk)
                } label: {
                    ZStack {
                        if voiceInput.phase == .queueing {
                            ProgressView()
                                .tint(Color.secretaryIvory)
                        } else {
                            Image(systemName: usesHoldToTalk ? "keyboard" : "mic.fill")
                        }
                    }
                    .frame(width: 40, height: 44)
                }
                .buttonStyle(SecretaryComposerIconButtonStyle(active: voiceInput.isRecording))
                .disabled(voiceInput.isBusy || voiceInput.isRecording)
                .accessibilityLabel(usesHoldToTalk ? "切换到键盘输入" : "切换到按住说话")

                if usesHoldToTalk {
                    SecretaryHoldToTalkSurface(
                        isRecording: voiceInput.isRecording,
                        enabled: !voiceInput.isBusy,
                        limitCountdown: voiceInput.recordingLimitCountdown,
                        onPressBegan: {
                            Task { await voiceInput.beginHoldRecording() }
                        },
                        onPressEnded: { cancelled in
                            Task { await voiceInput.endHoldRecording(cancelled: cancelled) }
                        },
                        onAccessibilityToggle: {
                            Task { await voiceInput.toggleRecording() }
                        }
                    )
                } else {
                    TextField(
                        store.composerStatusPlaceholder,
                        text: Binding(
                            get: { store.draft },
                            set: { store.updateDraft($0) }
                        ),
                        axis: .vertical
                    )
                    .focused($focused)
                    .font(.system(size: 16, weight: .regular, design: .rounded))
                    .foregroundStyle(Color.secretaryIvory)
                    .lineLimit(1...5)
                    .submitLabel(.send)
                    .onSubmit { Task { await store.sendDraft() } }
                    .onKeyPress(.return, phases: .down) { keyPress in
                        if keyPress.modifiers.contains(.shift) || keyPress.modifiers.contains(.option) {
                            return .ignored
                        }
                        Task { await store.sendDraft() }
                        return .handled
                    }
                    .onKeyPress(.escape, phases: .down) { _ in
                        setComposerFocused(false)
                        return .handled
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color.secretaryInputJade, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(focused ? Color.secretaryJade.opacity(0.36) : Color.secretaryHairline, lineWidth: 1)
                    }
                }

                Button {
                    showsEmojiPicker = true
                    showsMoreActions = false
                    setComposerFocused(false)
                } label: {
                    Image(systemName: "face.smiling")
                        .frame(width: 40, height: 44)
                }
                .buttonStyle(SecretaryComposerIconButtonStyle())
                .accessibilityLabel("打开表情面板")

                if store.isStreaming {
                    Button {
                        Task { await store.stopGenerating() }
                    } label: {
                        Image(systemName: "stop.fill")
                            .frame(width: 42, height: 44)
                    }
                    .buttonStyle(SecretarySendButtonStyle(enabled: true, destructive: true))
                    .accessibilityLabel("停止回复")
                } else if canSend {
                    Button {
                        Task { await store.sendDraft() }
                    } label: {
                        ZStack {
                            if store.isUploadingAttachments {
                                ProgressView().tint(Color(red: 0.015, green: 0.11, blue: 0.09))
                            } else {
                                Image(systemName: "arrow.up")
                            }
                        }
                        .frame(width: 42, height: 44)
                    }
                    .buttonStyle(SecretarySendButtonStyle(enabled: canSend, destructive: false))
                    .disabled(!canSend)
                    .accessibilityLabel("发送给\(store.activeSecretaryName)")
                } else {
                    Button {
                        withAnimation(.easeOut(duration: 0.16)) {
                            showsMoreActions.toggle()
                            setComposerFocused(false)
                        }
                    } label: {
                        Image(systemName: "plus")
                            .rotationEffect(.degrees(showsMoreActions ? 45 : 0))
                            .frame(width: 40, height: 44)
                    }
                    .buttonStyle(SecretaryComposerIconButtonStyle(active: showsMoreActions))
                    .accessibilityLabel(showsMoreActions ? "收起更多操作" : "更多操作")
                }
            }

            if showsMoreActions {
                moreActionsTray
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background {
            Color.secretaryPanelJade.opacity(surfaceOpacity)
                .ignoresSafeArea(edges: .bottom)
        }
        .overlay(alignment: .top) {
            Rectangle().fill(Color.secretaryHairline).frame(height: 1)
        }
        .task {
            await voiceInput.start()
            await SecretaryLegacyVoiceComposerDataCleanup.shared.runOnce()
        }
        .onChange(of: voiceInput.captureRequest?.id) { _, requestID in
            guard requestID != nil, let request = voiceInput.captureRequest else { return }
            Task {
                let queued = await store.queueVoiceRecording(request.recording, fileURL: request.fileURL)
                if queued {
                    await voiceInput.markQueued(recordingID: request.recording.recordingId)
                } else {
                    await voiceInput.markQueueFailed(
                        recordingID: request.recording.recordingId,
                        message: store.attachmentDraftError ?? "原声还没放进对话，可以重试"
                    )
                }
            }
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            selectedPhotos = []
            showsMoreActions = false
            Task {
                var transferError: String?
                for item in items {
                    do {
                        guard let data = try await item.loadTransferable(type: Data.self) else {
                            transferError = "照片读取失败，请换一张再试"
                            continue
                        }
                        let type = item.supportedContentTypes.first
                        let suggestedName = "照片.\(type?.preferredFilenameExtension ?? "jpg")"
                        await store.addPhoto(
                            data: data,
                            sourceTypeIdentifier: type?.identifier,
                            suggestedName: suggestedName
                        )
                    } catch is CancellationError {
                        continue
                    } catch {
                        transferError = "照片读取失败：\(error.localizedDescription)"
                    }
                }
                if let transferError {
                    store.reportAttachmentDraftError(transferError)
                }
            }
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: SecretaryAttachmentMIME.importedContentTypes,
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                Task { await store.addImportedFiles(urls) }
            case let .failure(error):
                guard !isUserCancellation(error) else { return }
                store.reportAttachmentDraftError("文件选择失败：\(error.localizedDescription)")
            }
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            SecretaryCameraPicker(
                onCapture: { data in
                    isCameraPresented = false
                    Task {
                        await store.addPhoto(
                            data: data,
                            sourceTypeIdentifier: UTType.jpeg.identifier,
                            suggestedName: "相机照片.jpg"
                        )
                    }
                },
                onFailure: {
                    isCameraPresented = false
                    store.reportAttachmentDraftError("相机照片处理失败，请重新拍摄")
                },
                onCancel: { isCameraPresented = false }
            )
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showsEmojiPicker) {
            SecretaryEmojiPicker(
                onPick: appendEmoji,
                onOpenKeyboard: {
                    showsEmojiPicker = false
                    usesHoldToTalk = false
                    setComposerFocused(true)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onReceive(NotificationCenter.default.publisher(for: SecretaryKeyboard.dismissNotification)) { _ in
            focused = false
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
            focused = false
        }
    }

    private var moreActionsTray: some View {
        HStack(alignment: .top, spacing: 22) {
            PhotosPicker(
                selection: $selectedPhotos,
                maxSelectionCount: max(1, store.remainingAttachmentSlots),
                matching: .images
            ) {
                composerActionTile(systemImage: "photo", label: "照片")
            }
            .disabled(store.remainingAttachmentSlots == 0 || store.isUploadingAttachments)
            .accessibilityLabel("选择照片")

            Button {
                showsMoreActions = false
                Task { await openCamera() }
            } label: {
                composerActionTile(systemImage: "camera", label: "拍摄")
            }
            .buttonStyle(.plain)
            .disabled(
                !UIImagePickerController.isSourceTypeAvailable(.camera)
                    || store.remainingAttachmentSlots == 0
                    || store.isUploadingAttachments
            )
            .accessibilityLabel("拍照")

            Button {
                showsMoreActions = false
                isFileImporterPresented = true
            } label: {
                composerActionTile(systemImage: "doc", label: "文件")
            }
            .buttonStyle(.plain)
            .disabled(store.remainingAttachmentSlots == 0 || store.isUploadingAttachments)
            .accessibilityLabel("选择文件")

            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 4) {
                Text("\(store.currentAttachmentDrafts.count)/\(SecretaryAttachmentDraft.maximumCount)")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.secretaryIvory.opacity(0.48))
                if store.isUploadingAttachments {
                    ProgressView().tint(Color.secretaryAmber)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 12)
        .padding(.bottom, 5)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.secretaryHairline).frame(height: 1)
        }
    }

    private func composerActionTile(systemImage: String, label: String) -> some View {
        VStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(Color.secretaryIvory.opacity(0.9))
                .frame(width: 54, height: 54)
                .background(Color.secretaryIvory.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color.secretaryHairline, lineWidth: 1)
                }
            Text(label)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.62))
        }
    }

    private func attachmentDraftList(_ drafts: [SecretaryAttachmentDraft], failed: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(drafts) { draft in
                    attachmentDraftCard(draft, failed: failed)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private func attachmentDraftCard(_ draft: SecretaryAttachmentDraft, failed: Bool) -> some View {
        HStack(spacing: 8) {
            attachmentThumbnail(draft)
            VStack(alignment: .leading, spacing: 2) {
                Text(draft.name)
                    .lineLimit(1)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                Text(ByteCountFormatter.string(fromByteCount: Int64(draft.sizeBytes), countStyle: .file))
                    .font(.system(size: 10, weight: .regular, design: .rounded))
                    .foregroundStyle(failed ? Color.secretaryAmber : Color.secretaryIvory.opacity(0.58))
            }
            Button {
                Task {
                    if failed {
                        await store.removeFailedPendingAttachment(draft.id)
                    } else {
                        await store.removeAttachmentDraft(draft.id)
                    }
                }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(Color.secretaryIvory.opacity(0.62))
            }
            .accessibilityLabel("移除\(draft.name)")
        }
        .foregroundStyle(Color.secretaryIvory)
        .padding(8)
        .background(Color.secretaryDeepJade.opacity(0.72), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(failed ? Color.secretaryAmber.opacity(0.45) : Color.secretaryHairline, lineWidth: 1)
        }
        .frame(maxWidth: 230)
    }

    @ViewBuilder
    private func attachmentThumbnail(_ draft: SecretaryAttachmentDraft) -> some View {
        let url = SecretaryAttachmentDraftStore.defaultDirectoryURL()
            .appendingPathComponent(draft.localFileName, isDirectory: false)
        if draft.kind == "image", let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 38, height: 38)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            Image(systemName: draft.kind == "image" ? "photo" : "doc.text.fill")
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 38, height: 38)
                .background(Color.secretaryIvory.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    @MainActor
    private func openCamera() async {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            cameraError = "这台设备没有可用相机"
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            isCameraPresented = true
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .video) {
                isCameraPresented = true
            } else {
                cameraError = "相机权限没有开启，请到系统“设置”里允许小秘书使用相机"
            }
        case .denied, .restricted:
            cameraError = "相机权限没有开启，请到系统“设置”里允许小秘书使用相机"
        @unknown default:
            cameraError = "暂时无法读取相机权限，请稍后再试"
        }
    }

    private var canSend: Bool {
        (!store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !store.currentAttachmentDrafts.isEmpty)
            && !store.isUploadingAttachments
            && store.canSendCurrentDraft
    }

    private func appendEmoji(_ emoji: String) {
        if usesHoldToTalk { usesHoldToTalk = false }
        store.updateDraft(store.draft + emoji)
        setComposerFocused(true)
    }

    private func setComposerFocused(_ next: Bool) {
        focused = next
        if !next {
            SecretaryKeyboard.resign()
        }
    }

    private func isUserCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let cocoaError = error as NSError
        return cocoaError.domain == NSCocoaErrorDomain
            && cocoaError.code == NSUserCancelledError
    }
}

private struct SecretaryEmojiPicker: View {
    @Environment(\.dismiss) private var dismiss
    let onPick: (String) -> Void
    let onOpenKeyboard: () -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 8)
    private let sections: [(String, [String])] = [
        ("常用", ["😀", "😃", "😄", "😁", "😊", "🥰", "😍", "😘", "😋", "😎", "🤩", "🥳", "😂", "🤣", "🥲", "😭", "😤", "😴", "🤔", "🫡", "🫶", "✨", "❤️", "💚"]),
        ("表情", ["🙂", "🙃", "😉", "😌", "😏", "😒", "🙄", "😬", "😮‍💨", "🤐", "🫠", "🫣", "🫢", "🤭", "🤫", "😶", "😐", "😑", "😯", "😲", "🤯", "😱", "😨", "😰"]),
        ("手势", ["👍", "👎", "👌", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "✋", "🤚", "🖐️", "👋", "👏", "🙌", "👐", "🤲", "🙏", "💪"]),
        ("心意", ["❤️", "🩷", "🧡", "💛", "💚", "🩵", "💙", "💜", "🤎", "🖤", "🩶", "🤍", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "💌", "💐"]),
        ("生活", ["☀️", "🌙", "⭐️", "🌈", "🔥", "🎉", "🎁", "🎂", "☕️", "🍵", "🍚", "🍜", "🍣", "🍰", "🍎", "🥑", "🌸", "🌿", "🐈", "🐕", "🎮", "🎧", "📚", "📷"]),
        ("符号", ["✅", "❌", "⚠️", "❗️", "❓", "💯", "💬", "💡", "📌", "📎", "📝", "📅", "⏰", "🔔", "🔒", "🔑", "🎯", "🚀", "♻️", "➕", "➖", "➡️", "⬅️", "🔍"]),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(section.0)
                                .font(.headline)
                                .foregroundStyle(Color.secretaryIvory.opacity(0.78))
                            LazyVGrid(columns: columns, spacing: 10) {
                                ForEach(section.1, id: \.self) { emoji in
                                    Button {
                                        onPick(emoji)
                                    } label: {
                                        Text(emoji)
                                            .font(.system(size: 27))
                                            .frame(maxWidth: .infinity, minHeight: 42)
                                            .background(Color.secretaryIvory.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("插入表情 \(emoji)")
                                }
                            }
                        }
                    }

                    Button {
                        onOpenKeyboard()
                    } label: {
                        Label("更多表情请用系统键盘的地球键", systemImage: "globe")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.secretaryJade)
                    .background(Color.secretaryDeepJade.opacity(0.72), in: RoundedRectangle(cornerRadius: 12))
                }
                .padding(18)
            }
            .background(Color.secretaryBarJade.ignoresSafeArea())
            .navigationTitle("表情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(Color.secretaryJade)
                }
            }
        }
    }
}

private struct SecretaryHoldToTalkSurface: View {
    let isRecording: Bool
    let enabled: Bool
    let limitCountdown: Int?
    let onPressBegan: () -> Void
    let onPressEnded: (Bool) -> Void
    let onAccessibilityToggle: () -> Void

    @State private var isPressing = false
    @State private var isCancellationArmed = false

    var body: some View {
        Text(surfaceLabel)
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(isCancellationArmed ? Color.white : (isPressing || isRecording ? Color.secretaryJade : Color.secretaryIvory))
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(
                isCancellationArmed
                    ? Color.red.opacity(0.72)
                    : (isPressing || isRecording ? Color.secretaryJade.opacity(0.18) : Color.secretaryDeepJade.opacity(0.72)),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(
                        isCancellationArmed
                            ? Color.red.opacity(0.72)
                            : (isPressing || isRecording ? Color.secretaryJade.opacity(0.58) : Color.secretaryHairline),
                        lineWidth: isPressing || isRecording ? 1.5 : 1
                    )
            }
            .scaleEffect(isPressing ? 0.985 : 1)
            .animation(.easeOut(duration: 0.09), value: isPressing)
            .animation(.easeOut(duration: 0.12), value: isCancellationArmed)
            .overlay {
                SecretaryHoldToTalkTouchTarget(
                    enabled: enabled,
                    cancellationDistance: 70,
                    onPressBegan: {
                        guard !isPressing else { return }
                        isPressing = true
                        isCancellationArmed = false
                        onPressBegan()
                    },
                    onCancellationChanged: { armed in
                        guard isPressing else { return }
                        isCancellationArmed = armed
                    },
                    onPressEnded: { cancelled in
                        guard isPressing else { return }
                        isPressing = false
                        isCancellationArmed = false
                        onPressEnded(cancelled)
                    }
                )
                .accessibilityHidden(true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(isRecording ? "停止原声录音" : "按住说话")
            .accessibilityHint("按住录音，上滑后松开可以取消；旁白用户双击可开始或停止")
            .accessibilityAction { onAccessibilityToggle() }
    }

    private var surfaceLabel: String {
        if isCancellationArmed { return "松开取消" }
        if isPressing || isRecording {
            if let limitCountdown { return "松开发送 · \(limitCountdown)" }
            return "松开发送"
        }
        return "按住说话"
    }
}

/// SwiftUI 的零距离 DragGesture 在手指完全不移动时可能到抬手才开始识别。
/// 用 UIControl 的原生触摸阶段保证按下立即录音、抬手立即发送。
private struct SecretaryHoldToTalkTouchTarget: UIViewRepresentable {
    let enabled: Bool
    let cancellationDistance: CGFloat
    let onPressBegan: () -> Void
    let onCancellationChanged: (Bool) -> Void
    let onPressEnded: (Bool) -> Void

    func makeUIView(context: Context) -> HoldControl {
        let control = HoldControl()
        control.backgroundColor = .clear
        control.isExclusiveTouch = true
        control.isAccessibilityElement = false
        control.accessibilityElementsHidden = true
        return control
    }

    func updateUIView(_ control: HoldControl, context: Context) {
        control.isEnabled = enabled
        control.cancellationDistance = cancellationDistance
        control.onPressBegan = onPressBegan
        control.onCancellationChanged = onCancellationChanged
        control.onPressEnded = onPressEnded
    }

    final class HoldControl: UIControl {
        var cancellationDistance: CGFloat = 70
        var onPressBegan: (() -> Void)?
        var onCancellationChanged: ((Bool) -> Void)?
        var onPressEnded: ((Bool) -> Void)?

        private var initialY: CGFloat?
        private var cancellationArmed = false
        private let pressFeedback = UIImpactFeedbackGenerator(style: .heavy)

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { pressFeedback.prepare() }
        }

        override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
            guard isEnabled else { return false }
            initialY = touch.location(in: self).y
            cancellationArmed = false
            pressFeedback.impactOccurred(intensity: 1.0)
            pressFeedback.prepare()
            onPressBegan?()
            return true
        }

        override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
            guard let initialY else { return false }
            let next = touch.location(in: self).y - initialY < -cancellationDistance
            if next != cancellationArmed {
                cancellationArmed = next
                onCancellationChanged?(next)
            }
            return true
        }

        override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
            guard initialY != nil else { return }
            let cancelled = cancellationArmed
            resetTracking()
            onPressEnded?(cancelled)
        }

        override func cancelTracking(with event: UIEvent?) {
            guard initialY != nil else { return }
            resetTracking()
            onPressEnded?(true)
        }

        private func resetTracking() {
            initialY = nil
            cancellationArmed = false
            onCancellationChanged?(false)
        }
    }
}

private struct SecretaryCameraPicker: UIViewControllerRepresentable {
    let onCapture: (Data) -> Void
    let onFailure: () -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let parent: SecretaryCameraPicker

        init(parent: SecretaryCameraPicker) {
            self.parent = parent
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.92) else {
                parent.onFailure()
                return
            }
            parent.onCapture(data)
        }
    }
}

private actor SecretaryLegacyVoiceComposerDataCleanup {
    static let shared = SecretaryLegacyVoiceComposerDataCleanup()

    private let completionKey = "secretary.legacy-voice-composer-data-cleanup.v1"

    func runOnce() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: completionKey),
              let applicationSupport = FileManager.default.urls(
                  for: .applicationSupportDirectory,
                  in: .userDomainMask
              ).first else { return }
        let legacyDirectory = applicationSupport
            .appendingPathComponent("SecretaryVoiceComposer", isDirectory: true)
        do {
            if FileManager.default.fileExists(atPath: legacyDirectory.path) {
                try FileManager.default.removeItem(at: legacyDirectory)
            }
            defaults.set(true, forKey: completionKey)
        } catch {
            // Retry on the next composer appearance if data protection or I/O
            // temporarily prevents deleting this experiment-only directory.
        }
    }
}

private struct SecretaryComposerIconButtonStyle: ButtonStyle {
    var active = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(Color.secretaryIvory.opacity(configuration.isPressed ? 0.58 : 0.9))
            .background(
                active ? Color.secretaryIvory.opacity(0.10) : Color.clear,
                in: Circle()
            )
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

struct SecretaryComposerAccessoryActions {
    var choosePhoto: (() -> Void)?
    var chooseFile: (() -> Void)?
    var beginHoldToTalk: (() -> Void)?

    static let unavailable = SecretaryComposerAccessoryActions(
        choosePhoto: nil,
        chooseFile: nil,
        beginHoldToTalk: nil
    )

    var hasAvailableAction: Bool {
        choosePhoto != nil || chooseFile != nil || beginHoldToTalk != nil
    }
}

private struct SecretarySendButtonStyle: ButtonStyle {
    let enabled: Bool
    let destructive: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(destructive ? Color.secretaryIvory : Color(red: 0.015, green: 0.11, blue: 0.09))
            .background(
                destructive ? Color.red.opacity(0.68) : Color.secretaryJade.opacity(enabled ? 0.92 : 0.30),
                in: Circle()
            )
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}
