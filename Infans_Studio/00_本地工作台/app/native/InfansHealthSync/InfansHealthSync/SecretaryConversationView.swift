import SwiftUI
import UIKit

private struct SecretaryChatLandscapeBackgroundKey: EnvironmentKey {
    static let defaultValue = false
}

private struct SecretarySpeechImmersionKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var secretaryChatUsesLandscapeBackground: Bool {
        get { self[SecretaryChatLandscapeBackgroundKey.self] }
        set { self[SecretaryChatLandscapeBackgroundKey.self] = newValue }
    }

    var secretarySpeechImmersion: Bool {
        get { self[SecretarySpeechImmersionKey.self] }
        set { self[SecretarySpeechImmersionKey.self] = newValue }
    }
}

extension View {
    func secretaryImmersionFog(_ active: Bool) -> some View {
        blur(radius: active ? 5 : 0)
    }
}

struct SecretarySpeechImmersionScrim: View {
    var body: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .opacity(0.78)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct SecretaryConversationBottomOffsetKey: PreferenceKey {
    static var defaultValue = CGFloat.infinity

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct SecretaryConversationScrollSnapshot: Equatable {
    let conversationID: String?
    let messageIDs: [String]
    let lastMessageIsFromCapoo: Bool
    let lastMessageText: String?
}

/// 铺满容器时保持原图比例，只裁切、不拉伸。默认图已按 iPad 横屏切成 4:3。
private struct SecretaryFillAlignedArtwork: View {
    let uiImage: UIImage

    var body: some View {
        GeometryReader { geo in
            Image(uiImage: uiImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
                .clipped()
        }
    }
}

struct SecretaryChatBackground: View {
    @ObservedObject private var characterPhotos = SecretaryCharacterPhotos.shared
    let secretaryID: String?
    @Environment(\.secretaryChatUsesLandscapeBackground) private var usesLandscapeImage
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity

    private var bundledBackgroundName: String {
        SecretaryBundledArt.backgroundAssetName(for: secretaryID, landscape: usesLandscapeImage)
    }

    var body: some View {
        ZStack {
            artwork
            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.08 + (surfaceOpacity - 0.64) * 0.30)

            LinearGradient(
                colors: [.black.opacity(0.34), .black.opacity(0.10), .black.opacity(0.16), .black.opacity(0.44)],
                startPoint: .top,
                endPoint: .bottom
            )

            LinearGradient(
                colors: [.black.opacity(0.18), .clear, .black.opacity(0.08)],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var artwork: some View {
        if let image = resolvedArtworkImage {
            SecretaryFillAlignedArtwork(uiImage: image)
        } else {
            Color.secretaryDeepJade.opacity(0.92)
        }
    }

    private var resolvedArtworkImage: UIImage? {
        if let image = characterPhotos.image(for: .background, subjectID: secretaryID) {
            return image
        }
        return UIImage(named: bundledBackgroundName)
    }
}

struct SecretaryConversationView: View {
    @ObservedObject var store: SecretaryChatStore
    var onOpenConnectionHelp: (() -> Void)?
    @ObservedObject private var speech = SecretarySpeechController.shared
    @Environment(\.secretarySpeechImmersion) private var immersiveSpeechActive
    @State private var isNearBottom = true
    @State private var correctionTarget: SecretaryVoiceCorrectionTarget?

    private let bottomAnchorID = "secretary-conversation-bottom"
    private let bottomFollowDistance: CGFloat = 96

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        if store.messages.isEmpty {
                            emptyState
                                .secretaryImmersionFog(immersiveSpeechActive)
                        } else {
                            ForEach(store.messages) { message in
                                SecretaryMessageRow(
                                    store: store,
                                    speech: speech,
                                    message: message,
                                    avatarURL: store.avatarURL(for: message.sender.id),
                                    pendingError: store.pendingTurns.first(where: { $0.messageId == message.id })?.lastError,
                                    onCorrectVoice: { messageId, attachment in
                                        correctionTarget = SecretaryVoiceCorrectionTarget(
                                            messageId: messageId,
                                            attachment: attachment
                                        )
                                    }
                                )
                                .id(message.id)

                                ForEach(store.controlledActions(forAssistantMessageID: message.id)) { action in
                                    SecretaryChatActionHistoryCard(store: store, action: action)
                                        .padding(.leading, 40)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .id("controlled-action-\(action.actionId)")
                                        .secretaryImmersionFog(immersiveSpeechActive)
                                }
                            }
                        }

                        ForEach(store.unanchoredControlledActions) { action in
                            SecretaryChatActionHistoryCard(store: store, action: action)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id("controlled-action-\(action.actionId)")
                                .secretaryImmersionFog(immersiveSpeechActive)
                        }

                        if store.showsTypingIndicator {
                            SecretaryTypingRow(
                                name: store.typingIndicatorName,
                                avatarURL: store.typingIndicatorAvatarURL,
                                subjectID: store.typingIndicatorSubjectID
                            )
                            .id("secretary-typing")
                            .secretaryImmersionFog(immersiveSpeechActive)
                        }

                        Color.clear
                            .frame(height: 1)
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(
                                        key: SecretaryConversationBottomOffsetKey.self,
                                        value: geometry.frame(in: .named("secretary-conversation-scroll")).maxY
                                    )
                                }
                            }
                            .id(bottomAnchorID)
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                    .padding(.top, 24)
                    .padding(.bottom, 18)
                }
                .coordinateSpace(name: "secretary-conversation-scroll")
                .scrollPosition(
                    id: Binding(
                        get: { store.scrollAnchor },
                        set: { store.updateScrollAnchor($0) }
                    )
                )
                .scrollDismissesKeyboard(.interactively)
                .scrollIndicators(.hidden)
                .onPreferenceChange(SecretaryConversationBottomOffsetKey.self) { bottomOffset in
                    isNearBottom = bottomOffset <= viewport.size.height + bottomFollowDistance
                }
                .onChange(of: scrollSnapshot) { oldValue, newValue in
                    let wasNearBottom = isNearBottom
                    guard oldValue.conversationID == newValue.conversationID else { return }

                    let appendedMessages = newValue.messageIDs.count > oldValue.messageIDs.count
                        && newValue.messageIDs.starts(with: oldValue.messageIDs)
                    if appendedMessages {
                        guard newValue.lastMessageIsFromCapoo || wasNearBottom else { return }
                        scrollToBottom(using: proxy, animated: true)
                        return
                    }

                    let streamedLastMessageChanged = newValue.messageIDs == oldValue.messageIDs
                        && newValue.lastMessageText != oldValue.lastMessageText
                    if streamedLastMessageChanged && wasNearBottom {
                        scrollToBottom(using: proxy, animated: false)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !isNearBottom {
                        Button {
                            scrollToBottom(using: proxy, animated: true)
                        } label: {
                            Label("回到底部", systemImage: "arrow.down")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.secretaryIvory)
                        .background(.ultraThinMaterial, in: Capsule())
                        .overlay {
                            Capsule().stroke(Color.secretaryJade.opacity(0.28), lineWidth: 1)
                        }
                        .shadow(color: .black.opacity(0.24), radius: 8, y: 3)
                        .padding(.trailing, 14)
                        .padding(.bottom, 12)
                        .accessibilityLabel("回到最新消息")
                        .secretaryImmersionFog(immersiveSpeechActive)
                    }
                }
            }
            .allowsHitTesting(!immersiveSpeechActive)
            .overlay {
                if immersiveSpeechActive,
                   let message = store.messages.first(where: { $0.id == speech.speakingMessageID && !$0.isFromCapoo }) {
                    SecretaryFixedVideoReply(store: store, speech: speech, message: message)
                }
            }
        }
        .overlay(alignment: .top) {
            if store.connectionState.detail != nil {
                Button {
                    onOpenConnectionHelp?()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10, weight: .semibold))
                        Text(connectionNoticeText)
                            .lineLimit(1)
                        if onOpenConnectionHelp != nil {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .bold))
                        }
                    }
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.secretaryAmber)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 7)
                    .background(.black.opacity(0.58), in: Capsule())
                    .overlay {
                        Capsule().stroke(Color.secretaryAmber.opacity(0.18), lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .disabled(onOpenConnectionHelp == nil)
                .padding(.top, 8)
                .padding(.horizontal, 20)
                .accessibilityHint(store.connectionState.detail ?? "")
            }
        }
        .sheet(item: $correctionTarget) { target in
            SecretaryVoiceCorrectionSheet(store: store, target: target)
        }
    }

    private var scrollSnapshot: SecretaryConversationScrollSnapshot {
        SecretaryConversationScrollSnapshot(
            conversationID: store.currentConversationId,
            messageIDs: store.messages.map(\.id),
            lastMessageIsFromCapoo: store.messages.last?.isFromCapoo == true,
            lastMessageText: store.messages.last?.text
        )
    }

    private func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
        let operation = { proxy.scrollTo(bottomAnchorID, anchor: .bottom) }
        if animated {
            withAnimation(.easeOut(duration: 0.22), operation)
        } else {
            operation()
        }
    }

    private var connectionNoticeText: String {
        switch store.connectionState {
        case .needsPairing:
            return onOpenConnectionHelp == nil ? "需要重新配对" : "需要重新配对 · 点此查看"
        case .offline:
            return "连接较弱 · 消息会先留在 iPhone"
        default:
            return store.connectionState.label
        }
    }

    private var emptyState: some View {
        HStack(alignment: .top, spacing: 9) {
            SecretaryAvatarView(
                url: store.activeSecretaryAvatarURL,
                name: store.activeSecretaryName,
                size: 48,
                subjectID: store.displaySecretaryID
            )
            VStack(alignment: .leading, spacing: 5) {
                Text(store.activeSecretaryName)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.secretaryJade.opacity(0.78))
                    .padding(.leading, 3)
                Text("你好，\(store.activeSecretaryName)在呢～")
                    .font(.system(size: 16, weight: .regular, design: .rounded))
                    .foregroundStyle(Color.secretaryIvory.opacity(0.94))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.secretaryDeepJade.opacity(0.92))
                            .overlay {
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(Color.secretaryJade.opacity(0.17), lineWidth: 1)
                            }
                    }
            }
            Spacer(minLength: 54)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 44)
    }
}

private struct SecretaryMessageRow: View {
    @ObservedObject var store: SecretaryChatStore
    @ObservedObject var speech: SecretarySpeechController
    let message: SecretaryChatMessage
    let avatarURL: URL?
    let pendingError: String?
    let onCorrectVoice: (String, SecretaryChatAttachment) -> Void
    @AppStorage("secretary.debugMode") private var debugMode = false
    @AppStorage("secretary.appearanceTheme") private var appearanceThemeRaw = SecretaryAppearanceTheme.night.rawValue
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity
    @Environment(\.secretarySpeechImmersion) private var immersiveSpeechActive

    var body: some View {
        regularLayout
            .secretaryImmersionFog(immersiveSpeechActive)
    }

    private var displayedSpokenText: String { message.spokenText }

    private var regularLayout: some View {
        HStack(alignment: .top, spacing: 9) {
            if message.isFromCapoo { Spacer(minLength: 54) }
            if !message.isFromCapoo {
                VStack(spacing: 2) {
                    SecretaryAvatarView(
                        url: avatarURL,
                        name: message.sender.displayName,
                        size: 48,
                        subjectID: message.sender.id
                    )
                    if !message.spokenText.isEmpty {
                        speechToggleButton
                    }
                }
                .frame(width: 48)
            }
            messageColumn
            if message.isFromCapoo {
                SecretaryAvatarView(
                    url: nil,
                    name: "我",
                    size: 48,
                    assetName: "UserChatAvatar"
                )
            } else {
                Spacer(minLength: 54)
            }
        }
    }

    private var messageColumn: some View {
        VStack(alignment: message.isFromCapoo ? .trailing : .leading, spacing: 5) {
            if !message.spokenText.isEmpty {
                spokenBubble
            }
            if showsSpeechRetry {
                speechRetryRow
            }

            ForEach(message.attachments) { attachment in
                attachmentRow(attachment)
            }

            if message.isFromCapoo {
                receiptRow
            }

            if debugMode, let pendingError, deliveryState == .failedRetryPending {
                Text(pendingError)
                    .font(.caption2)
                    .foregroundStyle(Color.secretaryAmber.opacity(0.84))
                    .lineLimit(2)
                    .frame(maxWidth: 280, alignment: .trailing)
            }
        }
    }

    private var spokenBubble: some View {
        spokenText(displayedSpokenText)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(bubbleBackground)
    }

    private func spokenText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 16, weight: .regular, design: .rounded))
            .foregroundStyle(message.isFromCapoo ? Color.secretaryUserBubbleInk : Color.secretaryIvory.opacity(0.94))
            .textSelection(.enabled)
    }

    private var speechToggleButton: some View {
        Button { speech.toggle(message) } label: {
            Image(systemName: speechToggleSymbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(speechToggleColor)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(speechToggleLabel)
        .accessibilityIdentifier("secretary-message-speech-toggle")
    }

    private var speechToggleColor: Color {
        SecretaryAppearanceTheme.normalized(appearanceThemeRaw) == .day
            ? Color.white
            : Color.secretaryJade.opacity(0.82)
    }

    private var speechToggleSymbol: String {
        guard speech.speakingMessageID == message.id else { return "speaker.wave.2" }
        return speech.phase == .paused ? "play.circle.fill" : "stop.circle.fill"
    }

    private var speechToggleLabel: String {
        guard speech.speakingMessageID == message.id else {
            return "朗读\(message.sender.displayName)的回复"
        }
        return speech.phase == .paused ? "继续朗读" : "停止朗读"
    }

    private var showsSpeechRetry: Bool {
        !message.isFromCapoo
            && speech.binding.messageID == message.id
            && speech.binding.canRetry
    }

    private var speechRetryRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(speech.binding.statusText ?? "暂不可朗读，文字仍在")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
            Button { speech.retry() } label: {
                Text("再试一次")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.secretaryJade)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("重新朗读")
            .accessibilityIdentifier("secretary-message-speech-retry")
        }
        .padding(.horizontal, 14)
        .background(bubbleBackground)
    }

    @ViewBuilder
    private var receiptRow: some View {
        if deliveryState == .failedQuarantined {
            Label("信箱未处理，原消息已保留；请修改后重新发送", systemImage: "exclamationmark.triangle")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
                .fixedSize(horizontal: false, vertical: true)
        } else if deliveryState == .failedRetryPending {
            Button {
                Task { await store.retryPending(messageId: message.id) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                    Text("未送达 · 点一下重试")
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("消息未送达，点一下重试")
            .font(.system(size: 10, weight: .medium, design: .rounded))
            .foregroundStyle(Color.secretaryAmber)
        } else if displayedDeliveryState == .replyUnavailable {
            Text("已读不回")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.secretarySignalRed)
        } else if let text = displayedDeliveryState?.userFacingText, !text.isEmpty {
            Text(text)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.42))
        }
    }

    private var deliveryState: SecretaryChatLocalDeliveryState? {
        SecretaryChatLocalDeliveryState(rawValue: message.deliveryStage)
    }

    private var displayedDeliveryState: SecretaryChatLocalDeliveryState? {
        guard let state = deliveryState else { return nil }
        guard message.isFromCapoo,
              state != .failedRetryPending,
              state != .failedQuarantined,
              state != .replyUnavailable,
              hasAssistantReplyAfterThisMessage else { return state }
        return .deviceAvailable
    }

    private var hasAssistantReplyAfterThisMessage: Bool {
        SecretaryChatRecovery.hasAssistantReply(afterMessageId: message.id, in: store.messages)
    }

    @ViewBuilder
    private func attachmentRow(_ attachment: SecretaryChatAttachment) -> some View {
        let card = SecretaryAttachmentView(store: store, attachment: attachment)
            .frame(maxWidth: 360, alignment: message.isFromCapoo ? .trailing : .leading)
        if message.isFromCapoo,
           attachment.presentationKind == .audio,
           attachment.transcript?.isEmpty == false {
            card
                .contextMenu {
                    Button {
                        openCorrection(for: attachment)
                    } label: {
                        Label("纠正识别文字", systemImage: "text.badge.checkmark")
                    }
                }
                .accessibilityAction(named: Text("纠正识别文字")) {
                    openCorrection(for: attachment)
                }
        } else {
            card
        }
    }

    private func openCorrection(for attachment: SecretaryChatAttachment) {
        onCorrectVoice(message.id, attachment)
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if message.isFromCapoo {
            LinearGradient(
                colors: [Color.secretaryUserBubbleTop, Color.secretaryUserBubbleBottom],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .opacity(surfaceOpacity)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.secretaryDeepJade.opacity(surfaceOpacity))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Color.secretaryJade.opacity(0.17), lineWidth: 1)
                }
        }
    }
}

private struct SecretaryVoiceCorrectionTarget: Identifiable {
    let messageId: String
    let attachment: SecretaryChatAttachment
    var id: String { "\(messageId):\(attachment.id)" }
}

private struct SecretaryVoiceCorrectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: SecretaryChatStore
    let target: SecretaryVoiceCorrectionTarget

    @State private var editedTranscript: String
    @State private var errorText: String?
    @State private var savedCorrection: SecretaryVoiceCorrectionRecord?
    @State private var isWorking = false

    private var transcript: String { target.attachment.transcript ?? "" }

    private var correctionDetents: Set<PresentationDetent> {
        savedCorrection == nil ? [.medium, .large] : [.height(360)]
    }

    init(store: SecretaryChatStore, target: SecretaryVoiceCorrectionTarget) {
        self.store = store
        self.target = target
        _editedTranscript = State(initialValue: target.attachment.transcript ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let savedCorrection {
                        completedView(savedCorrection)
                    } else {
                        selectionView
                    }
                }
                .padding(20)
            }
            .background(Color.secretaryBarJade.ignoresSafeArea())
            .navigationTitle("纠正识别文字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(Color.secretaryIvory)
                }
            }
        }
        .presentationDetents(correctionDetents)
        .presentationDragIndicator(.visible)
    }

    private var selectionView: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("直接把识别文字改对")
                .font(.headline)
                .foregroundStyle(Color.secretaryIvory)

            TextEditor(text: $editedTranscript)
                .font(.body)
                .foregroundStyle(Color.secretaryIvory)
                .tint(Color.secretaryJade)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 156)
                .padding(12)
                .background(Color.secretaryDeepJade.opacity(0.72), in: RoundedRectangle(cornerRadius: 14))
                .overlay {
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Color.secretaryJade.opacity(0.24), lineWidth: 1)
                }

            Text("修改后会记住这次纠正，不会重新发消息。")
                .font(.footnote)
                .foregroundStyle(Color.secretaryIvory.opacity(0.58))

            if let errorText {
                Text(errorText)
                    .font(.footnote)
                    .foregroundStyle(Color.secretaryAmber)
            }

            Button {
                Task { await save() }
            } label: {
                HStack {
                    if isWorking { ProgressView().tint(Color.secretaryBarJade) }
                    Text("保存纠正")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.secretaryBarJade)
            .background(Color.secretaryJade, in: RoundedRectangle(cornerRadius: 12))
            .opacity(canSave ? 1 : 0.42)
            .disabled(!canSave)
        }
    }

    private func completedView(_ correction: SecretaryVoiceCorrectionRecord) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("已经记住这次纠正", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(Color.secretaryJade)
            Text("“\(correction.selectedOriginal)” → “\(correction.replacement)”")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.secretaryIvory)
            Text(correction.correctedTranscript)
                .font(.body)
                .foregroundStyle(Color.secretaryIvory.opacity(0.82))
                .textSelection(.enabled)

            if let errorText {
                Text(errorText)
                    .font(.footnote)
                    .foregroundStyle(Color.secretaryAmber)
            }

            HStack(spacing: 12) {
                Button("撤销这次纠正") { Task { await revert(correction) } }
                    .disabled(isWorking)
                Spacer()
                Button("完成") { dismiss() }
                    .fontWeight(.semibold)
            }
            .foregroundStyle(Color.secretaryJade)
        }
    }

    private var normalizedTranscript: String {
        editedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !normalizedTranscript.isEmpty
            && normalizedTranscript != transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            && normalizedTranscript.count <= 2_000
            && !isWorking
    }

    @MainActor
    private func save() async {
        guard canSave else { return }
        isWorking = true
        errorText = nil
        defer { isWorking = false }
        do {
            savedCorrection = try await store.correctVoiceTranscript(
                messageId: target.messageId,
                attachmentId: target.attachment.id,
                expectedTranscript: transcript,
                correctedTranscript: normalizedTranscript
            )
        } catch {
            errorText = error.localizedDescription
        }
    }

    @MainActor
    private func revert(_ correction: SecretaryVoiceCorrectionRecord) async {
        isWorking = true
        errorText = nil
        defer { isWorking = false }
        do {
            try await store.revertVoiceCorrection(correction)
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

private struct SecretaryTypingRow: View {
    let name: String
    let avatarURL: URL?
    let subjectID: String?

    var body: some View {
        HStack(alignment: .bottom, spacing: 9) {
            SecretaryAvatarView(url: avatarURL, name: name, size: 48, subjectID: subjectID)
            HStack(spacing: 8) {
                ProgressView().tint(Color.secretaryJade)
                Text("\(name)正在输入中")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
            }
            .foregroundStyle(Color.secretaryIvory.opacity(0.66))
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(Color.secretaryDeepJade.opacity(0.82), in: Capsule())
            Spacer()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name)正在输入中")
    }
}

private struct SecretaryAvatarAssetsKey: EnvironmentKey {
    static let defaultValue: [String: SecretaryChatCharacterAssets] = [:]
}

extension EnvironmentValues {
    var secretaryAvatarAssets: [String: SecretaryChatCharacterAssets] {
        get { self[SecretaryAvatarAssetsKey.self] }
        set { self[SecretaryAvatarAssetsKey.self] = newValue }
    }
}

struct SecretaryAvatarView: View {
    @State private var loadedPublicURL: URL?

    @ObservedObject private var characterPhotos = SecretaryCharacterPhotos.shared
    let url: URL?
    let name: String
    let size: CGFloat
    let assetName: String?
    let subjectID: String?

    init(url: URL?, name: String, size: CGFloat, assetName: String? = nil, subjectID: String? = nil) {
        self.url = url
        self.name = name
        self.size = size
        self.assetName = assetName
        self.subjectID = subjectID
    }

    var body: some View {
        Group {
            if assetName == nil, let image = characterPhotos.image(for: .avatar, subjectID: subjectID) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let assetName {
                Image(assetName)
                    .resizable()
                    .scaledToFill()
            } else {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                            .onAppear { loadedPublicURL = url }
                    } else {
                        placeholder
                    }
                }
                .id(url)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: max(7, size * 0.24), style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: max(7, size * 0.24), style: .continuous)
                .stroke(Color.secretaryJade.opacity(0.32), lineWidth: 1)
        }
        .shadow(color: Color.secretaryJade.opacity(0.12), radius: 9, y: 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityIdentifier("secretary-avatar-\(subjectID ?? name)")
        .accessibilityValue(url != nil && loadedPublicURL == url ? "头像已加载" : "")
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(colors: [Color.secretaryJade.opacity(0.85), Color.secretaryDeepJade], startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(String(name.prefix(1)))
                .font(.system(size: size * 0.42, weight: .semibold, design: .serif))
                .foregroundStyle(Color.secretaryIvory)
        }
    }
}

private struct SecretaryFixedVideoReply: View {
    @ObservedObject var store: SecretaryChatStore
    @ObservedObject var speech: SecretarySpeechController
    let message: SecretaryChatMessage

    private var caption: String {
        SecretarySpeechCaptions.typedPrefix(message.spokenText, progress: speech.progress)
    }

    var body: some View {
        GeometryReader { viewport in
            let side = min(viewport.size.width - 32, viewport.size.height * 0.48, 440)
            let captionTop = viewport.size.height / 2 + side / 2 + 12
            ZStack(alignment: .topLeading) {
                SecretaryAvatarView(
                    url: store.avatarURL(for: message.sender.id),
                    name: message.sender.displayName,
                    size: side,
                    subjectID: message.sender.id
                )
                .frame(width: side, height: side)
                .overlay(alignment: .bottomTrailing) {
                    Button { speech.toggle(message) } label: {
                        Image(systemName: speech.phase == .paused ? "play.fill" : "stop.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 44, height: 44)
                            .background(.regularMaterial, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(speech.phase == .paused ? "继续朗读" : "停止朗读")
                    .padding(12)
                }
                .position(x: viewport.size.width / 2, y: viewport.size.height / 2)

                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if speech.phase == .preparing {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text("正在准备朗读")
                                }
                                .font(.system(size: 17, design: .rounded))
                                .foregroundStyle(Color.secretaryIvory)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityIdentifier("secretary-speech-preparing")
                            } else {
                                Text(caption.isEmpty ? " " : caption)
                                    .font(.system(size: 17, design: .rounded))
                                    .foregroundStyle(Color.secretaryIvory)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                            Color.clear.frame(height: 1).id("video-caption-bottom")
                        }
                        .padding(14)
                    }
                    .scrollIndicators(.hidden)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                    .onChange(of: caption) { _, _ in
                        proxy.scrollTo("video-caption-bottom", anchor: .bottom)
                    }
                }
                .frame(width: max(1, viewport.size.width - 32), height: max(40, viewport.size.height - captionTop - 12))
                .offset(x: 16, y: captionTop)
            }
        }
    }
}
