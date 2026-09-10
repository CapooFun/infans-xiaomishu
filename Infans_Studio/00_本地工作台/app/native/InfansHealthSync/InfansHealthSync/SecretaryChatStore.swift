import Foundation
import OSLog

enum SecretaryChatConnectionState: Equatable {
    case loading
    case online
    case offline(String)
    case needsPairing(String)

    var label: String {
        switch self {
        case .loading: return "正在连接"
        case .online: return "已连接"
        case .offline: return "暂时离线"
        case .needsPairing: return "需要重新配对"
        }
    }

    var detail: String? {
        switch self {
        case let .offline(message), let .needsPairing(message): return message
        default: return nil
        }
    }
}

@MainActor
final class SecretaryChatStore: ObservableObject {
    private static let voiceRecognitionLogger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "InfansHealthSync",
        category: "SecretaryOnDeviceASR"
    )

    @Published private(set) var bootstrap: SecretaryChatBootstrap?
    @Published private(set) var unreadState = SecretaryConversationUnreadState()
    private var chatIsActive = false
    @Published private(set) var conversationSummaries: [SecretaryChatConversationSummary] = []
    @Published private(set) var currentConversation: SecretaryChatConversation?
    @Published private(set) var messages: [SecretaryChatMessage] = []
    @Published private(set) var pendingTurns: [PendingSecretaryChatTurn] = []
    @Published private(set) var connectionState: SecretaryChatConnectionState = .loading
    @Published private(set) var isStreaming = false
    @Published private(set) var isUploadingAttachments = false
    @Published private(set) var isManagingConversation = false
    @Published private(set) var currentConversationId: String?
    @Published private(set) var activeSpeakerId: String?
    @Published var managementError: String?
    @Published var draft = ""
    @Published private(set) var attachmentDrafts: [SecretaryAttachmentDraft] = []
    @Published private(set) var attachmentDraftError: String?
    @Published private(set) var controlledActions: [SecretaryChatControlledAction] = []
    @Published private(set) var decidingActionID: String?
    @Published private(set) var presentedActionID: String?
    @Published private(set) var actionDecisionNotice: String?
    @Published private(set) var executionMetricsByConversation: [String: SecretaryConversationExecutionMetrics] = [:]

    private let client: SecretaryChatClient
    private let voiceClient: SecretaryVoiceTranscriptionClient
    private let onDeviceVoiceTranscriber: SecretaryOnDeviceVoiceTranscriber
    private let persistence: SecretaryChatPersistence
    private let attachmentDraftStore: SecretaryAttachmentDraftStore
    private var cachedConversations: [String: SecretaryChatConversation] = [:]
    private var draftsByConversation: [String: String] = [:]
    private var scrollAnchorsByConversation: [String: String] = [:]
    private var pendingCreationId: String?
    private var started = false
    private var streamingTurn: PendingSecretaryChatTurn?
    private var streamingSpeakerId: String?
    private var persistenceRevision = 0
    private var automaticallyRetriedMessageIDs = Set<String>()
    private var mailboxRevisionByConversation: [String: Int] = [:]
    private var mailboxSyncInFlight = false
    private var pendingTransmissionMessageIDs: [String] = []
    private var pendingTransmissionTask: Task<Void, Never>?
    private let voiceQueueAdmission = SecretaryVoiceQueueAdmission()
    private var voiceRecognitionHintsCache = ["银月"]
    private var scrollAnchorPersistTask: Task<Void, Never>?

    init(
        client: SecretaryChatClient = SecretaryChatClient(),
        voiceClient: SecretaryVoiceTranscriptionClient = SecretaryVoiceTranscriptionClient(),
        onDeviceVoiceTranscriber: SecretaryOnDeviceVoiceTranscriber = SecretaryOnDeviceVoiceTranscriber(),
        persistence: SecretaryChatPersistence = SecretaryChatPersistence(),
        attachmentDraftStore: SecretaryAttachmentDraftStore = SecretaryAttachmentDraftStore()
    ) {
        self.client = client
        self.voiceClient = voiceClient
        self.onDeviceVoiceTranscriber = onDeviceVoiceTranscriber
        self.persistence = persistence
        self.attachmentDraftStore = attachmentDraftStore
    }

    var activeSecretary: SecretaryChatCharacter? {
        availableSecretaries.first(where: { $0.id == displaySecretaryID })
    }

    var activeSecretaryName: String { activeSecretary?.displayName ?? "银月" }

    var showsTypingIndicator: Bool {
        let assistantHasVisibleDraft = messages.contains { message in
            !message.isFromCapoo
                && message.deliveryStage == SecretaryChatLocalDeliveryState.replyGenerating.rawValue
                && !message.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !assistantHasVisibleDraft else { return false }
        return pendingTurns.contains { turn in
            turn.conversationId == currentConversationId
                && turn.state == .replyGenerating
                && turn.autoChat != true
                && !SecretaryChatRecovery.hasCompletedReply(
                    forMessageId: turn.messageId,
                    generationId: turn.generationId,
                    in: messages
                )
        }
    }

    var typingIndicatorName: String {
        if let streamingSpeakerId,
           let name = bootstrap?.characters.first(where: { $0.id == streamingSpeakerId })?.displayName {
            return name
        }
        return activeSecretaryName
    }

    var typingIndicatorSubjectID: String {
        streamingSpeakerId ?? displaySecretaryID
    }

    var typingIndicatorAvatarURL: URL? {
        let path = bootstrap?.characters.first(where: { $0.id == typingIndicatorSubjectID })?.assets.avatar
            ?? availableSecretaries.first(where: { $0.id == typingIndicatorSubjectID })?.assets.avatar
        return resolvedResourceURL(path) ?? activeSecretaryAvatarURL
    }
    var composerStatusPlaceholder: String {
        switch connectionState {
        case .online:
            return displaySecretaryID == "yinyue"
                ? "你好，我在呢。想说什么都可以。"
                : "\(activeSecretaryName)在这里，慢慢说。"
        case .loading:
            return "正在连接"
        case .offline:
            return "连接较弱 · 消息会先留在本机"
        case .needsPairing:
            return "需要重新配对"
        }
    }
    var availableSecretaries: [SecretaryChatCharacter] {
        SecretaryBundledArt.seats(merging: bootstrap?.characters ?? [])
    }
    var displaySecretaryID: String {
        SecretaryBundledArt.resolvedSeatID(
            currentConversation?.activeSecretaryId ?? bootstrap?.activeSecretaryId
        )
    }
    var defaultSecretaryName: String {
        guard let bootstrap else { return "银月" }
        return bootstrap.characters.first(where: { $0.id == bootstrap.activeSecretaryId })?.displayName ?? "银月"
    }
    var activeSecretaryAvatarPath: String? { activeSecretary?.assets.avatar }
    var activeSecretaryAvatarURL: URL? { resolvedResourceURL(activeSecretaryAvatarPath) }
    var pendingCount: Int { pendingCount(for: currentConversationId) }
    var currentAttachmentDrafts: [SecretaryAttachmentDraft] {
        attachmentDrafts.filter { $0.conversationId == effectiveConversationId }
    }
    var failedAttachmentDrafts: [SecretaryAttachmentDraft] {
        pendingTurns
            .filter { $0.conversationId == currentConversationId && $0.lastError != nil }
            .flatMap(\.attachments)
            .filter { $0.kind != "audio" }
            .filter { $0.uploadedAttachment == nil }
    }
    var remainingAttachmentSlots: Int {
        max(0, SecretaryAttachmentDraft.maximumCount - currentAttachmentDrafts.count)
    }
    var totalPendingCount: Int { pendingTurns.filter(\.needsTransmission).count }
    var currentControlledActions: [SecretaryChatControlledAction] {
        SecretaryChatActionQueue.sorted(controlledActions).filter { $0.conversationId == currentConversationId }
    }
    var nextPendingControlledAction: SecretaryChatControlledAction? {
        guard supportsControlledActions else { return nil }
        return SecretaryChatActionQueue.earliestPending(
            in: controlledActions,
            conversationId: currentConversationId
        )
    }
    var presentedControlledAction: SecretaryChatControlledAction? {
        guard let presentedActionID else { return nil }
        return controlledActions.first { $0.actionId == presentedActionID }
    }
    var canSendCurrentDraft: Bool {
        guard supportsControlledActions else { return true }
        return SecretaryChatActionQueue.canSend(
            actions: controlledActions,
            conversationId: currentConversationId,
            decidingActionId: decidingActionID
        )
    }
    var currentControls: SecretaryChatConversationState? { currentConversation?.chatState }
    var currentOrdinaryBackend: String {
        SecretaryOrdinaryChannelSwitch.resolvedBackend(
            currentControls?.ordinaryBackend ?? bootstrap?.modelRuntime?.ordinary.selected,
            secretaryID: displaySecretaryID
        )
    }
    var ordinaryChannelSwitchBackends: [String] {
        SecretaryOrdinaryChannelSwitch.allowedBackends(
            declared: bootstrap?.protocolInfo.conversationMutation?.allowedOrdinaryBackends
        )
    }

    func chooseOrdinaryBackend(_ backend: String) async {
        let allowed = ordinaryChannelSwitchBackends
        guard allowed.contains(backend) else {
            managementError = "这个单聊模型通道没有出现在可用名单里。"
            return
        }
        // 开源模型位只留空壳；点「未配置」不改默认，也不写入作者通道。
    }

    var currentExecutionMetrics: SecretaryConversationExecutionMetrics? {
        guard let currentConversationId else { return nil }
        return executionMetricsByConversation[currentConversationId]
    }
    var currentMembers: [SecretaryChatCharacter] {
        guard let bootstrap, let currentConversation else { return [] }
        return currentConversation.memberIds.compactMap { id in
            bootstrap.characters.first(where: { $0.id == id })
        }
    }
    var controllableReplySpeakers: [SecretaryChatCharacter] {
        guard bootstrap?.protocolInfo.replySpeakerControl?.excludesUserSpeaker == true else { return [] }
        return currentMembers
    }
    var activeReplySpeakerIDs: [String] {
        currentConversation?.chatState.activeReplySpeakers ?? currentMembers.map(\.id)
    }

    func avatarURL(for characterId: String) -> URL? {
        resolvedResourceURL(bootstrap?.characters.first(where: { $0.id == characterId })?.assets.avatar)
    }

    func localAttachmentURL(for attachment: SecretaryChatAttachment) async throws -> URL {
        let memoryDraft = localDraft(id: attachment.id)
        let storedDrafts = memoryDraft == nil ? (try? await attachmentDraftStore.loadAll()) : nil
        let draft = memoryDraft ?? storedDrafts?.first(where: { $0.id == attachment.id })
        let draftURL: URL? = if let draft {
            try? await attachmentDraftStore.localURL(for: draft)
        } else {
            nil
        }
        switch SecretaryAttachmentPlaybackSourcePolicy.preferredSource(
            hasLocalDraft: draft != nil,
            localFileExists: draftURL != nil,
            resourcePath: attachment.resourcePath
        ) {
        case .localDraft:
            guard let draftURL else { throw SecretaryAttachmentDraftError.fileMissing }
            return draftURL
        case .remoteResource:
            return try await SecretaryAttachmentCache.shared.localURL(
                for: attachment,
                client: client,
                connection: try connection()
            )
        case .unavailable:
            throw SecretaryAttachmentDraftError.fileMissing
        }
    }

    func hasUnreadReply(in summary: SecretaryChatConversationSummary) -> Bool {
        unreadState.isUnread(summary)
    }

    func setChatActive(_ active: Bool) {
        chatIsActive = active
        if active { markVisibleConversationRead(); persist() }
    }

    private func markVisibleConversationRead() {
        guard chatIsActive, let conversation = currentConversation, conversation.id == currentConversationId,
              let last = conversation.messages.last,
              last.deliveryStage == SecretaryChatLocalDeliveryState.deviceAvailable.rawValue else { return }
        let summary = conversation.summary
        guard unreadState.needsReadMark(summary) else { return }
        unreadState.markRead(summary)
    }

    private func refreshConversationSummaries() async {
        guard let connection = try? connection(),
              let listed = try? await client.conversations(connection: connection) else { return }
        if conversationSummaries != listed.conversations {
            conversationSummaries = listed.conversations
            persist()
        }
    }

    func pendingCount(for conversationId: String?) -> Int {
        guard let conversationId else { return 0 }
        return pendingTurns.filter { $0.conversationId == conversationId && $0.needsTransmission }.count
    }

    func start() async {
        guard !started else { return }
        started = true
        let cached = await persistence.load()
        bootstrap = cached.bootstrap
        unreadState = cached.unreadState
        conversationSummaries = cached.conversationSummaries
        cachedConversations = cached.cachedConversations
        draftsByConversation = cached.draftsByConversation
        scrollAnchorsByConversation = cached.scrollAnchorsByConversation
        pendingCreationId = cached.pendingCreationId
        currentConversationId = cached.currentConversationId
        currentConversation = cached.conversation ?? cached.currentConversationId.flatMap { cached.cachedConversations[$0] }
        draft = cached.currentConversationId.flatMap { cached.draftsByConversation[$0] } ?? cached.draft
        pendingTurns = cached.pendingTurns
        controlledActions = cached.controlledActions
        presentedActionID = nextPendingControlledAction?.actionId
        await restoreAttachmentDrafts()
        rebuildMessages()
        if let currentConversationId { _ = await syncMailbox(conversationId: currentConversationId) }
        if pendingCount > 0 { await retryPending() }
        await reloadFromMac()
        if let currentConversationId { _ = await syncMailbox(conversationId: currentConversationId) }
        if pendingCount > 0 { await retryPending() }
    }

    func refresh() async {
        if let currentConversationId { _ = await syncMailbox(conversationId: currentConversationId) }
        if pendingCount > 0 { await retryPending() }
        await reloadFromMac()
        if let currentConversationId { _ = await syncMailbox(conversationId: currentConversationId) }
        if pendingCount > 0 { await retryPending() }
    }

    /// A stream may disappear after the Mac has already accepted the stable message ID.
    /// Reconcile first, then resume only the same pending ID so recovery cannot duplicate a turn.
    func recoverPendingWhileVisible() async {
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            guard !Task.isCancelled else { return }
            await refreshConversationSummaries()
            guard !Task.isCancelled, pendingTransmissionTask == nil,
                  !isStreaming, !isUploadingAttachments,
                  let conversationId = currentConversationId else { continue }

            _ = await syncMailbox(conversationId: conversationId)

            // A genuinely failed local turn gets one quiet automatic retry per foreground App
            // lifetime. Older persisted retry counters do not suppress recovery after an update.
            let failed = pendingTurns.first(where: {
                $0.conversationId == conversationId
                    && $0.state == .failedRetryPending
                    && !automaticallyRetriedMessageIDs.contains($0.messageId)
            })
            guard let refreshed = failed else { continue }
            if automaticallyRetriedMessageIDs.insert(refreshed.messageId).inserted {
                schedulePendingTransmission(messageId: refreshed.messageId)
                await pendingTransmissionTask?.value
            }
        }
    }

    func updateDraft(_ value: String) {
        draft = value
        if let currentConversationId {
            draftsByConversation[currentConversationId] = value
        }
        persist()
    }

    func addPhoto(
        data: Data,
        sourceTypeIdentifier: String?,
        suggestedName: String
    ) async {
        guard SecretaryAttachmentSelectionPolicy.canAccept(existingCount: currentAttachmentDrafts.count) else {
            attachmentDraftError = SecretaryAttachmentDraftError.tooMany.localizedDescription
            return
        }
        do {
            let staged = try await attachmentDraftStore.stagePhoto(
                data: data,
                sourceTypeIdentifier: sourceTypeIdentifier,
                suggestedName: suggestedName,
                conversationId: effectiveConversationId
            )
            attachmentDrafts.append(staged)
            attachmentDraftError = nil
        } catch {
            attachmentDraftError = error.localizedDescription
        }
    }

    func addImportedFiles(_ urls: [URL]) async {
        for url in urls {
            guard SecretaryAttachmentSelectionPolicy.canAccept(existingCount: currentAttachmentDrafts.count) else {
                attachmentDraftError = SecretaryAttachmentDraftError.tooMany.localizedDescription
                return
            }
            do {
                let staged = try await attachmentDraftStore.stageImportedFile(
                    url,
                    conversationId: effectiveConversationId
                )
                attachmentDrafts.append(staged)
                attachmentDraftError = nil
            } catch {
                attachmentDraftError = error.localizedDescription
            }
        }
    }

    func removeAttachmentDraft(_ id: String) async {
        guard let index = attachmentDrafts.firstIndex(where: { $0.id == id }) else { return }
        let removed = attachmentDrafts.remove(at: index)
        try? await attachmentDraftStore.remove(removed)
        attachmentDraftError = nil
    }

    func removeFailedPendingAttachment(_ id: String) async {
        guard !isStreaming, !isUploadingAttachments,
              let turnIndex = pendingTurns.firstIndex(where: {
                  $0.conversationId == currentConversationId
                      && $0.lastError != nil
                      && $0.attachments.contains(where: { $0.id == id && $0.uploadedAttachment == nil })
              }),
              let attachmentIndex = pendingTurns[turnIndex].attachments.firstIndex(where: { $0.id == id }) else {
            return
        }
        let removed = pendingTurns[turnIndex].attachments.remove(at: attachmentIndex)
        try? await attachmentDraftStore.remove(removed)
        if pendingTurns[turnIndex].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           pendingTurns[turnIndex].attachments.isEmpty {
            pendingTurns.remove(at: turnIndex)
        }
        rebuildMessages()
        persist()
    }

    func clearAttachmentDraftError() {
        attachmentDraftError = nil
    }

    func reportAttachmentDraftError(_ message: String) {
        attachmentDraftError = message
    }

    func controlledActions(forAssistantMessageID messageID: String) -> [SecretaryChatControlledAction] {
        currentControlledActions.filter { $0.assistantMessageId == messageID }
    }

    var unanchoredControlledActions: [SecretaryChatControlledAction] {
        let messageIDs = Set(messages.map(\.id))
        return currentControlledActions.filter { !messageIDs.contains($0.assistantMessageId) }
    }

    func presentControlledAction(_ actionID: String) {
        guard nextPendingControlledAction?.actionId == actionID else { return }
        actionDecisionNotice = nil
        presentedActionID = actionID
    }

    func dismissControlledActionConfirmation() {
        guard decidingActionID == nil else { return }
        presentedActionID = nil
        actionDecisionNotice = nil
    }

    func decideControlledAction(_ actionID: String, decision: String) async {
        guard decision == "confirm" || decision == "cancel",
              SecretaryChatActionQueue.canDecide(
                  actionId: actionID,
                  actions: controlledActions,
                  conversationId: currentConversationId,
                  decidingActionId: decidingActionID
              ),
              let action = controlledActions.first(where: { $0.actionId == actionID }) else { return }
        decidingActionID = actionID
        actionDecisionNotice = nil
        defer { decidingActionID = nil }
        do {
            let response = try await client.decideControlledAction(
                actionId: action.actionId,
                request: SecretaryChatActionDecisionRequest(
                    protocolVersion: 1,
                    conversationId: action.conversationId,
                    generationId: action.generationId,
                    decision: decision
                ),
                connection: try connection()
            )
            upsertControlledAction(response.action, automaticallyPresent: false)
            if response.stale {
                actionDecisionNotice = "预览已更新，请重新确认"
                presentedActionID = response.action.actionId
            } else if response.action.state == "failed" {
                actionDecisionNotice = response.action.error?.message ?? "这项写入没有完成"
                presentedActionID = nil
            } else {
                presentedActionID = nextPendingControlledAction?.actionId
            }
            persist()
        } catch {
            actionDecisionNotice = error.localizedDescription
        }
    }

    /// 阅读位置只由会话视图自己跟踪，不做成 @Published：滚动一次就通知整个界面重建，
    /// 会让滚动位置重新对齐顶部那条消息，看起来像第一条气泡在闪。
    func restoredScrollAnchor() -> String? {
        currentConversationId.flatMap { scrollAnchorsByConversation[$0] }
    }

    func recordScrollAnchor(_ messageId: String?) {
        guard let currentConversationId else { return }
        // 切会话时视图可能还带着上一场的锚点，别把它记到新会话名下。
        if let messageId, !messages.contains(where: { $0.id == messageId }) { return }
        guard scrollAnchorsByConversation[currentConversationId] != messageId else { return }
        scrollAnchorsByConversation[currentConversationId] = messageId
        scheduleScrollAnchorPersist()
    }

    /// 滚动过程中每跨过一条消息都写一次磁盘会拖住主线程，落盘统一延后合并。
    private func scheduleScrollAnchorPersist() {
        scrollAnchorPersistTask?.cancel()
        scrollAnchorPersistTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.persist()
        }
    }

    func selectConversation(_ id: String) async {
        guard id != currentConversationId else { return }
        guard !isStreaming else {
            managementError = "请先停止当前回复，再切换会话。"
            return
        }
        saveCurrentLocalState()
        currentConversationId = id
        presentedActionID = nil
        actionDecisionNotice = nil
        currentConversation = cachedConversations[id]
        restoreLocalState(for: id)
        rebuildMessages()
        persist()
        do {
            let conversation = try await client.conversation(id: id, connection: try connection())
            applyServerConversation(conversation)
            await reconcileControlledActionsFromMac(conversationId: id)
            connectionState = .online
            managementError = nil
            persist()
        } catch {
            handleManagementFailure(error, offlineMessage: "已显示这台设备上最后保存的会话。")
        }
    }

    func ensureDirectConversationVisible() async {
        let currentIsHidden = currentConversation.map { conversation in
            conversation.type != "direct" || conversation.privacy != "standard"
        }
            ?? conversationSummaries.first(where: { $0.id == currentConversationId }).map {
                $0.type != "direct" || $0.privacy != "standard"
            }
            ?? false
        guard currentIsHidden else { return }

        if let next = SecretaryConversationVisibilityPolicy.phoneConversations(conversationSummaries).first {
            await selectConversation(next.id)
            return
        }

        await createConversation(
            title: SecretaryConversationDisplayTitle.nextStoredTitle(secretaryName: defaultSecretaryName),
            secretaryId: bootstrap?.activeSecretaryId
        )
    }

    func createConversation(title: String?, secretaryId: String? = nil) async {
        guard !isManagingConversation else { return }
        isManagingConversation = true
        defer { isManagingConversation = false }
        do {
            let creationId = pendingCreationId ?? "native_\(UUID().uuidString.lowercased())"
            pendingCreationId = creationId
            persist()
            let conversation = try await client.createConversation(
                SecretaryChatCreateConversationRequest(
                    protocolVersion: 1,
                    conversationId: creationId,
                    title: normalizedOptionalText(title),
                    activeSecretaryId: secretaryId
                ),
                connection: try connection()
            )
            pendingCreationId = nil
            applyServerConversation(conversation)
            await reconcileControlledActionsFromMac(conversationId: conversation.id)
            connectionState = .online
            managementError = nil
            persist()
        } catch {
            handleManagementFailure(error)
        }
    }

    func renameCurrentConversation(_ title: String) async {
        guard let conversation = currentConversation else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty, cleanTitle != conversation.title else { return }
        await updateCurrentConversation(
            SecretaryChatUpdateConversationRequest(
                protocolVersion: 1,
                expectedConversationVersion: conversation.version,
                title: cleanTitle,
                chatState: nil
            )
        )
    }

    func deleteCurrentConversation() async -> Bool {
        guard let conversation = currentConversation else { return false }
        return await deleteConversation(id: conversation.id, expectedVersion: conversation.version)
    }

    func deleteConversation(_ summary: SecretaryChatConversationSummary) async -> Bool {
        let expectedVersion = currentConversation?.id == summary.id
            ? currentConversation?.version ?? summary.version
            : summary.version
        return await deleteConversation(id: summary.id, expectedVersion: expectedVersion)
    }

    private func deleteConversation(id: String, expectedVersion: String) async -> Bool {
        guard !isManagingConversation else { return false }
        guard pendingCount(for: id) == 0 else {
            managementError = "这个会话还有没送到 Mac 的消息，请先再试一次，或先保留会话。"
            return false
        }
        let deletesCurrentConversation = currentConversation?.id == id
        isManagingConversation = true
        defer { isManagingConversation = false }
        do {
            let response = try await client.deleteConversation(
                id: id,
                payload: SecretaryChatDeleteConversationRequest(
                    protocolVersion: 1,
                    expectedConversationVersion: expectedVersion
                ),
                connection: try connection()
            )
            guard response.deleted else {
                managementError = "Mac 没有删除这个会话。"
                return false
            }
            let localDrafts = attachmentDrafts.filter { $0.conversationId == id }
            attachmentDrafts.removeAll { $0.conversationId == id }
            cleanupLocalAttachments(localDrafts)
            controlledActions.removeAll { $0.conversationId == id }
            cachedConversations[id] = nil
            draftsByConversation[id] = nil
            scrollAnchorsByConversation[id] = nil
            conversationSummaries.removeAll { $0.id == id }
            if deletesCurrentConversation {
                let nextId = SecretaryConversationVisibilityPolicy
                    .ordinaryConversations(conversationSummaries)
                    .first?.id
                currentConversationId = nextId
                currentConversation = nextId.flatMap { cachedConversations[$0] }
                restoreLocalState(for: nextId)
                rebuildMessages()
                if let nextId { _ = await loadConversationFromMac(nextId) }
            }
            managementError = nil
            persist()
            return true
        } catch {
            handleManagementFailure(error)
            return false
        }
    }

    func saveControls(
        qualityMode: String,
        ordinaryBackend: String?,
        cursorModel: String?
    ) async {
        guard let conversation = currentConversation else { return }
        let mutation = bootstrap?.protocolInfo.conversationMutation
        if let ordinaryBackend,
           mutation?.allowedOrdinaryBackends?.contains(ordinaryBackend) != true {
            managementError = "这个单聊模型通道没有出现在 Mac 下发的可用名单里。"
            return
        }
        if let cursorModel,
           mutation?.allowedCursorModels?.contains(cursorModel) != true {
            managementError = "这个模型没有出现在电脑下发的可用名单里。"
            return
        }
        await updateCurrentConversation(
            patch(
                for: conversation,
                qualityMode: qualityMode,
                ordinaryBackend: ordinaryBackend,
                cursorModel: cursorModel
            )
        )
    }

    func clearManagementError() {
        managementError = nil
    }

    func sendDraft() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let frozenAttachments = currentAttachmentDrafts
        guard (!text.isEmpty || !frozenAttachments.isEmpty),
              !isStreaming,
              !isUploadingAttachments,
              canSendCurrentDraft else { return }
        let conversationId = currentConversationId
            ?? bootstrap?.defaultConversationId
            ?? "native_yingning_default"
        let turn = PendingSecretaryChatTurn.make(
            conversationId: conversationId,
            text: text,
            expectedConversationVersion: currentConversation?.version ?? "",
            attachments: frozenAttachments
        )
        currentConversationId = conversationId
        draft = ""
        draftsByConversation[conversationId] = ""
        let frozenIDs = Set(frozenAttachments.map(\.id))
        attachmentDrafts.removeAll { frozenIDs.contains($0.id) }
        pendingTurns.append(turn)
        rebuildMessages()
        persist()
        schedulePendingTransmission(messageId: turn.messageId)
        await pendingTransmissionTask?.value
    }

    func queueVoiceRecording(_ recording: SecretaryVoiceRecording, fileURL: URL) async -> Bool {
        let conversationId = effectiveConversationId
        let messageId = "msg-\(recording.recordingId)"
        return await voiceQueueAdmission.perform(messageID: messageId) { [weak self] in
            guard let self else { return false }
            return await self.stageVoiceRecording(
                recording,
                fileURL: fileURL,
                conversationId: conversationId,
                messageId: messageId
            )
        }
    }

    private func stageVoiceRecording(
        _ recording: SecretaryVoiceRecording,
        fileURL: URL,
        conversationId: String,
        messageId: String
    ) async -> Bool {
        if pendingTurns.contains(where: { $0.messageId == messageId })
            || messages.contains(where: { $0.id == messageId }) {
            return true
        }
        guard canSendCurrentDraft else { return false }
        do {
            let attachment = try await attachmentDraftStore.stageVoice(
                from: fileURL,
                recording: recording,
                conversationId: conversationId
            )
            let turn = PendingSecretaryChatTurn.makeVoice(
                conversationId: conversationId,
                attachment: attachment,
                expectedConversationVersion: currentConversation?.version ?? "",
                createdAt: recording.createdAt
            )
            currentConversationId = conversationId
            pendingTurns.append(turn)
            rebuildMessages()
            persist()
            schedulePendingTransmission(messageId: turn.messageId)
            return true
        } catch {
            attachmentDraftError = "原声还没放进对话：\(error.localizedDescription)"
            return false
        }
    }

    func correctVoiceTranscript(
        messageId: String,
        attachmentId: String,
        expectedTranscript: String,
        correctedTranscript: String
    ) async throws -> SecretaryVoiceCorrectionRecord {
        guard let conversationId = currentConversationId else { throw SecretaryChatClientError.invalidResponse }
        let stable = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let response = try await client.correctVoiceTranscript(
            SecretaryVoiceCorrectionRequest(
                correctionId: "voicefix_\(stable)",
                conversationId: conversationId,
                messageId: messageId,
                attachmentId: attachmentId,
                expectedTranscript: expectedTranscript,
                correctedTranscript: correctedTranscript
            ),
            connection: try connection()
        )
        replaceVoiceTranscript(
            messageId: messageId,
            attachmentId: attachmentId,
            transcript: response.transcript
        )
        connectionState = .online
        persist()
        return response.correction
    }

    func revertVoiceCorrection(_ correction: SecretaryVoiceCorrectionRecord) async throws {
        let response = try await client.revertVoiceCorrection(
            id: correction.correctionId,
            connection: try connection()
        )
        replaceVoiceTranscript(
            messageId: correction.messageId,
            attachmentId: correction.attachmentId,
            transcript: response.transcript
        )
        connectionState = .online
        persist()
    }

    func retryPending() async {
        guard let conversationId = currentConversationId else { return }
        for turn in pendingTurns where turn.conversationId == conversationId && turn.needsTransmission {
            if Task.isCancelled { return }
            schedulePendingTransmission(messageId: turn.messageId)
        }
        await pendingTransmissionTask?.value
    }

    func retryPending(messageId: String) async {
        guard let initial = pendingTurns.first(where: {
                  $0.messageId == messageId && $0.conversationId == currentConversationId
              }) else { return }
        _ = await syncMailbox(conversationId: initial.conversationId)
        persist()
        guard let refreshed = pendingTurns.first(where: {
            $0.messageId == messageId && $0.needsTransmission
        }) else { return }
        schedulePendingTransmission(messageId: refreshed.messageId)
        await pendingTransmissionTask?.value
    }

    func stopGenerating() async {
        guard let turn = streamingTurn else { return }
        do {
            try await client.cancel(
                conversationId: turn.conversationId,
                generationId: turn.generationId,
                connection: try connection()
            )
        } catch {
            handleTransmissionFailure(turn.messageId, error: error)
        }
    }

    private func reloadFromMac() async {
        if currentConversation == nil { connectionState = .loading }
        do {
            let connection = try connection()
            let nextBootstrap = try await client.bootstrap(connection: connection)
            bootstrap = nextBootstrap
            guard nextBootstrap.identity.valid, !nextBootstrap.identity.needsPairing else {
                connectionState = .needsPairing("这台设备的小秘书身份需要重新配对。")
                persist()
                return
            }
            let listed = try await client.conversations(connection: connection)
            conversationSummaries = listed.conversations
            let selected = preferredConversationId(bootstrap: nextBootstrap)
            if selected != currentConversationId {
                saveCurrentLocalState()
                presentedActionID = nil
                actionDecisionNotice = nil
            }
            currentConversationId = selected
            restoreLocalState(for: selected)
            let loaded = await loadConversationFromMac(selected, connection: connection, bootstrap: nextBootstrap)
            if loaded {
                connectionState = .online
                managementError = nil
            }
            persist()
            Task { [weak self] in
                await self?.refreshVoiceRecognitionHints(connection: connection)
            }
        } catch {
            updateConnectionState(for: error)
            rebuildMessages()
        }
    }

    private func preferredConversationId(bootstrap: SecretaryChatBootstrap) -> String {
        if let currentConversationId,
           conversationSummaries.contains(where: { $0.id == currentConversationId }) || currentConversationId == bootstrap.defaultConversationId {
            return currentConversationId
        }
        return conversationSummaries.first?.id ?? bootstrap.defaultConversationId
    }

    private func loadConversationFromMac(
        _ id: String,
        connection providedConnection: SecretaryChatConnection? = nil,
        bootstrap providedBootstrap: SecretaryChatBootstrap? = nil
    ) async -> Bool {
        do {
            let conversation = try await client.conversation(
                id: id,
                connection: try providedConnection ?? connection()
            )
            applyServerConversation(conversation)
            await reconcileControlledActionsFromMac(
                conversationId: id,
                providedConnection: providedConnection
            )
            return true
        } catch let error as SecretaryChatClientError {
            if case let .http(status, _) = error, status == 404, let source = providedBootstrap ?? bootstrap {
                let empty = emptyConversation(id: id, bootstrap: source)
                currentConversation = empty
                cachedConversations[id] = empty
                rebuildMessages()
                return true
            } else {
                recordLoadFailure(error)
                return false
            }
        } catch {
            recordLoadFailure(error)
            return false
        }
    }

    private func recordLoadFailure(_ error: Error) {
        if let cached = currentConversationId.flatMap({ cachedConversations[$0] }) {
            currentConversation = cached
            rebuildMessages()
        }
        updateConnectionState(for: error)
    }

    private func updateCurrentConversation(_ payload: SecretaryChatUpdateConversationRequest) async {
        guard let id = currentConversationId, !isManagingConversation else { return }
        isManagingConversation = true
        defer { isManagingConversation = false }
        do {
            let conversation = try await client.updateConversation(
                id: id,
                payload: payload,
                connection: try connection()
            )
            applyServerConversation(conversation)
            connectionState = .online
            managementError = nil
            persist()
        } catch {
            handleManagementFailure(error)
            if case let SecretaryChatClientError.http(status, _) = error, status == 409 {
                managementError = "我正在重新对齐这个会话，已写好的消息不会重复发送。"
                _ = await loadConversationFromMac(id)
            }
        }
    }

    private func patch(
        for conversation: SecretaryChatConversation,
        qualityMode: String? = nil,
        ordinaryBackend: String? = nil,
        cursorModel: String? = nil
    ) -> SecretaryChatUpdateConversationRequest {
        SecretaryChatUpdateConversationRequest(
            protocolVersion: 1,
            expectedConversationVersion: conversation.version,
            title: nil,
            chatState: SecretaryChatConversationStatePatch(
                activeSecretaryId: nil,
                qualityMode: qualityMode,
                ordinaryBackend: ordinaryBackend,
                cursorModel: cursorModel
            )
        )
    }

    private func handleManagementFailure(_ error: Error, offlineMessage: String? = nil) {
        updateConnectionState(for: error, offlineMessage: offlineMessage)
    }

    private func updateConnectionState(for error: Error, offlineMessage: String? = nil) {
        if case SecretaryChatClientError.tokenUnavailable = error {
            connectionState = .needsPairing(error.localizedDescription)
        } else if case let SecretaryChatClientError.http(status, message) = error, status == 401 || status == 403 {
            connectionState = .needsPairing(message)
        } else {
            connectionState = .offline(offlineMessage ?? error.localizedDescription)
        }
    }

    private func normalizedOptionalText(_ text: String?) -> String? {
        guard let clean = text?.trimmingCharacters(in: .whitespacesAndNewlines), !clean.isEmpty else { return nil }
        return clean
    }

    private func transmit(_ initialTurn: PendingSecretaryChatTurn, allowResyncRetry: Bool) async {
        guard let initialIndex = pendingTurns.firstIndex(where: { $0.messageId == initialTurn.messageId }) else { return }
        guard pendingTurns[initialIndex].conversationId == currentConversationId else { return }
        guard await transcribePendingVoiceIfNeeded(messageId: initialTurn.messageId) else { return }
        let usesMailbox = shouldUseMailbox(for: pendingTurns[initialIndex])
        guard await uploadPendingAttachmentsIfNeeded(
            messageId: initialTurn.messageId,
            includesAudio: !usesMailbox
        ) else { return }
        guard let index = pendingTurns.firstIndex(where: { $0.messageId == initialTurn.messageId }) else { return }
        let turn = pendingTurns[index]
        guard turn.conversationId == currentConversationId else { return }
        if usesMailbox {
            guard turn.isReadyForMailbox else {
                handleAttachmentUploadFailure(turn.messageId, error: "这段原声还没有可用的逐字稿")
                return
            }
            do {
                _ = try await client.persistToMailbox(turn, connection: try mailboxConnection())
                updatePending(turn.messageId, state: .macPersisted, error: nil)
                persist()
                _ = await syncMailbox(conversationId: turn.conversationId)
            } catch {
                // A timed-out accept may already be durable on the NAS. Only retry the
                // same stable IDs; never fall through to direct Mac generation.
                handleTransmissionFailure(turn.messageId, error: error)
            }
            return
        }
        guard turn.isReadyForStreaming else {
            handleAttachmentUploadFailure(turn.messageId, error: "这段原声还没有可用的逐字稿")
            return
        }
        streamingTurn = turn
        streamingSpeakerId = bootstrap?.activeSecretaryId ?? currentConversation?.activeSecretaryId
        activeSpeakerId = streamingSpeakerId
        isStreaming = true
        updatePending(turn.messageId, state: .localQueued, error: nil)
        do {
            let connection = try connection()
            let terminal = try await client.streamTurn(turn, connection: connection) { [weak self] event in
                self?.handle(event, for: turn)
            }
            if terminal.type == .resyncRequired {
                isStreaming = false
                streamingTurn = nil
                if allowResyncRetry { await resolveResync(turn, event: terminal) }
            }
        } catch let error as SecretaryChatClientError {
            if case let .http(status, _) = error, status == 409, allowResyncRetry {
                isStreaming = false
                streamingTurn = nil
                await resolveHTTPConflict(turn)
            } else {
                handleTransmissionFailure(turn.messageId, error: error)
            }
        } catch {
            handleTransmissionFailure(turn.messageId, error: error)
        }
        if streamingTurn?.messageId == turn.messageId, !isStreaming { streamingTurn = nil }
    }

    private func shouldUseMailbox(for turn: PendingSecretaryChatTurn) -> Bool {
        guard turn.autoChat != true else { return false }
        guard currentConversation?.id == turn.conversationId else { return true }
        guard let conversation = currentConversation else { return true }
        return conversation.type == "direct"
    }

    @discardableResult
    private func syncMailbox(conversationId: String) async -> Bool {
        guard !mailboxSyncInFlight else { return false }
        mailboxSyncInFlight = true
        defer { mailboxSyncInFlight = false }
        do {
            let snapshot = try await client.syncMailbox(
                conversationId: conversationId,
                afterRevision: mailboxRevisionByConversation[conversationId] ?? 0,
                connection: try mailboxConnection()
            )
            mailboxRevisionByConversation[conversationId] = max(
                mailboxRevisionByConversation[conversationId] ?? 0,
                snapshot.revision
            )
            applyMailboxSnapshot(snapshot, conversationId: conversationId)
            return true
        } catch let error as SecretaryChatClientError {
            if case .tokenUnavailable = error {
                connectionState = .needsPairing(error.localizedDescription)
            } else if case let .http(status, message) = error, status == 401 || status == 403 {
                connectionState = .needsPairing(message)
            }
            return false
        } catch {
            return false
        }
    }

    private func applyMailboxSnapshot(
        _ snapshot: SecretaryChatMailboxSyncResponse,
        conversationId: String
    ) {
        guard currentConversationId == conversationId else { return }
        if currentConversation == nil {
            currentConversation = mailboxConversation(id: conversationId)
        }
        guard var conversation = currentConversation else { return }
        let previouslyAvailable = Set(
            conversation.messages
                .filter { !$0.isFromCapoo && $0.deliveryStage == SecretaryChatLocalDeliveryState.deviceAvailable.rawValue }
                .map(\.id)
        )
        let pendingBefore = pendingTurns
        var merged = conversation.messages

        for mailboxMessage in snapshot.messages where mailboxMessage.conversationId == conversationId {
            if let index = pendingTurns.firstIndex(where: {
                $0.messageId == mailboxMessage.messageId && $0.generationId == mailboxMessage.generationId
            }) {
                pendingTurns[index].state = SecretaryChatLocalDeliveryState(
                    rawValue: SecretaryChatLocalDeliveryState.merging(
                        pendingTurns[index].state.rawValue,
                        with: mailboxMessage.localDeliveryState.rawValue
                    )
                ) ?? mailboxMessage.localDeliveryState
                pendingTurns[index].lastError = mailboxMessage.status == "failed" ? mailboxMessage.lastError : nil
            }
            var local = pendingTurns.first(where: { $0.messageId == mailboxMessage.messageId })
                .map { SecretaryChatMessage.localUserMessage(from: $0, sequence: 0) }
                ?? mailboxUserMessage(mailboxMessage)
            if mailboxMessage.status == "failed" {
                local.deliveryStage = SecretaryChatLocalDeliveryState.failedQuarantined.rawValue
            }
            upsertMailboxMessage(local, in: &merged)
        }

        for reply in snapshot.replies where reply.conversationId == conversationId {
            upsertMailboxMessage(mailboxAssistantMessage(reply), in: &merged)
            pendingTurns.removeAll {
                $0.conversationId == reply.conversationId && $0.generationId == reply.generationId
            }
        }

        for index in merged.indices { merged[index].sequence = index + 1 }
        merged = SecretaryChatRecovery.promotingReadReceipts(in: merged)

        // 每三秒一次的信箱对账多数时候什么都没变。这时不能再往界面推一遍同样的消息，
        // 否则聊天区被反复重建，顶部那条气泡会被重新对齐，看起来像在闪。
        guard merged != conversation.messages || pendingTurns != pendingBefore else {
            startPendingTransmissionWorkerIfNeeded()
            return
        }

        conversation.messages = merged
        conversation.messageCount = merged.count
        currentConversation = conversation
        cachedConversations[conversation.id] = conversation
        upsertSummary(conversation.summary)
        rebuildMessages()

        let newlyAvailable = merged.filter {
            !$0.isFromCapoo
                && $0.deliveryStage == SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
                && !previouslyAvailable.contains($0.id)
        }
        if let latest = newlyAvailable.last {
            SecretarySpeechController.shared.automaticallySpeakIfNeeded(latest)
        }
        for reply in newlyAvailable {
            Task {
                await SecretaryChatNotificationController.shared.notifyIfNeeded(
                    message: reply,
                    conversation: conversation
                )
            }
        }
        persist()
        startPendingTransmissionWorkerIfNeeded()
    }

    private func upsertMailboxMessage(_ message: SecretaryChatMessage, in messages: inout [SecretaryChatMessage]) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            // A later Mac conversation refresh stays authoritative for richer fields,
            // while the mailbox owns delivery of an otherwise missing message.
            messages[index].deliveryStage = SecretaryChatLocalDeliveryState.merging(
                messages[index].deliveryStage,
                with: message.deliveryStage
            )
        } else {
            var next = message
            next.sequence = messages.count + 1
            messages.append(next)
        }
    }

    private func mailboxUserMessage(_ message: SecretaryChatMailboxMessage) -> SecretaryChatMessage {
        let attachments = message.attachments.map { item in
            let name = item.kind == "audio" ? "语音" : (item.kind == "image" ? "图片" : "附件")
            return SecretaryChatAttachment(
                id: item.id,
                kind: item.kind,
                name: name,
                mimeType: item.mimeType,
                resourcePath: item.resourcePath ?? "local-draft:\(item.id)",
                fallbackText: item.transcript ?? name,
                durationMs: item.durationMs,
                transcript: item.transcript
            )
        }
        let fallback = message.text.isEmpty
            ? SecretaryChatMessageFallback.attachmentText(for: attachments)
            : message.text
        return SecretaryChatMessage(
            id: message.messageId,
            sequence: 0,
            role: "user",
            sender: .init(id: "capoo", kind: "user", displayName: "我"),
            createdAt: message.createdAt,
            createdAtKnown: true,
            text: message.text,
            fallbackText: fallback,
            attachments: attachments,
            deliveryStage: message.localDeliveryState.rawValue
        )
    }

    private func mailboxAssistantMessage(_ reply: SecretaryChatMailboxReply) -> SecretaryChatMessage {
        let displayName = bootstrap?.characters.first(where: { $0.id == reply.speakerId })?.displayName
            ?? (reply.speakerId == "yinyue" ? "银月" : reply.speakerId)
        return SecretaryChatMessage(
            id: reply.messageId,
            sequence: 0,
            role: "assistant",
            sender: .init(id: reply.speakerId, kind: "character", displayName: displayName),
            createdAt: reply.createdAt,
            createdAtKnown: true,
            text: reply.text,
            fallbackText: reply.text,
            attachments: [],
            deliveryStage: SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
        )
    }

    private func mailboxConversation(id: String) -> SecretaryChatConversation {
        let secretaryId = bootstrap?.activeSecretaryId ?? "yinyue"
        return SecretaryChatConversation(
            id: id,
            version: "",
            type: "direct",
            title: "与\(bootstrap?.characters.first(where: { $0.id == secretaryId })?.displayName ?? "银月")的对话",
            privacy: "standard",
            activeSecretaryId: secretaryId,
            memberIds: ["capoo", secretaryId],
            updatedAt: nil,
            messageCount: 0,
            messages: [],
            chatState: SecretaryChatConversationState(
                activeSecretaryId: secretaryId,
                qualityMode: "light",
                privacy: "standard"
            )
        )
    }

    private func schedulePendingTransmission(messageId: String) {
        if !pendingTransmissionMessageIDs.contains(messageId) {
            pendingTransmissionMessageIDs.append(messageId)
        }
        startPendingTransmissionWorkerIfNeeded()
    }

    private func startPendingTransmissionWorkerIfNeeded() {
        guard pendingTransmissionTask == nil, !pendingTransmissionMessageIDs.isEmpty else { return }
        pendingTransmissionTask = Task { [weak self] in
            await self?.drainPendingTransmissions()
        }
    }

    private func drainPendingTransmissions() async {
        while !Task.isCancelled {
            let pendingIDs = Set(pendingTurns.map(\.messageId))
            pendingTransmissionMessageIDs.removeAll { !pendingIDs.contains($0) }
            guard !isStreaming, !isUploadingAttachments,
                  let conversationId = currentConversationId,
                  let nextMessageID = SecretaryChatTransmissionOrder.nextMessageID(
                    scheduledMessageIDs: pendingTransmissionMessageIDs,
                    pendingTurns: pendingTurns.filter { $0.conversationId == conversationId }
                  ),
                  let turn = pendingTurns.first(where: { $0.messageId == nextMessageID }) else {
                break
            }
            pendingTransmissionMessageIDs.removeAll { $0 == nextMessageID }
            await transmit(turn, allowResyncRetry: true)
        }
        pendingTransmissionTask = nil
        if !Task.isCancelled,
           !isStreaming,
           !isUploadingAttachments,
           SecretaryChatTransmissionOrder.nextMessageID(
                scheduledMessageIDs: pendingTransmissionMessageIDs,
                pendingTurns: pendingTurns.filter { $0.conversationId == currentConversationId }
           ) != nil {
            startPendingTransmissionWorkerIfNeeded()
        }
    }

    private func uploadPendingAttachmentsIfNeeded(messageId: String, includesAudio: Bool) async -> Bool {
        guard let initialIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }) else { return false }
        if pendingTurns[initialIndex].attachments.isEmpty { return true }
        guard pendingTurns[initialIndex].autoChat != true else {
            handleAttachmentUploadFailure(messageId, error: "自动续聊不能携带附件")
            return false
        }
        let needsUpload = pendingTurns[initialIndex].attachments.contains {
            $0.uploadedAttachment == nil && (includesAudio || $0.kind != "audio")
        }
        guard needsUpload else { return true }
        isUploadingAttachments = true
        defer { isUploadingAttachments = false }
        updatePending(messageId, state: .localQueued, error: nil)
        do {
            let connection = try connection()
            while let turnIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }),
                  let attachmentIndex = pendingTurns[turnIndex].attachments.firstIndex(where: {
                      $0.uploadedAttachment == nil && (includesAudio || $0.kind != "audio")
                  }) {
                var draft = pendingTurns[turnIndex].attachments[attachmentIndex]
                let localURL = try await attachmentDraftStore.localURL(for: draft)
                let response = try await client.uploadAttachment(draft, fileURL: localURL, connection: connection)
                draft.uploadedAttachment = response.attachment
                draft.lastError = nil
                pendingTurns[turnIndex].attachments[attachmentIndex] = draft
                try await attachmentDraftStore.save(draft)
                rebuildMessages()
                persist()
            }
            return true
        } catch {
            handleAttachmentUploadFailure(messageId, error: error.localizedDescription)
            return false
        }
    }

    private func transcribePendingVoiceIfNeeded(messageId: String) async -> Bool {
        guard let initialIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }) else { return false }
        guard pendingTurns[initialIndex].attachments.contains(where: { $0.requiresTranscript }) else { return true }
        updatePending(messageId, state: .localQueued, error: nil)
        do {
            while let turnIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }),
                  let attachmentIndex = pendingTurns[turnIndex].attachments.firstIndex(where: { $0.requiresTranscript }) {
                var draft = pendingTurns[turnIndex].attachments[attachmentIndex]
                guard let durationMs = draft.durationMs else { throw SecretaryVoiceStorageError.invalidRecording }
                let localURL = try await attachmentDraftStore.localURL(for: draft)
                let recording = SecretaryVoiceRecording(
                    recordingId: draft.id,
                    durationMs: durationMs
                )
                let hints = voiceRecognitionHintsCache
                do {
                    let benchmark = try await onDeviceVoiceTranscriber.benchmark(
                        fileURL: localURL,
                        audioDurationMs: durationMs,
                        contextualStrings: hints
                    )
                    Self.voiceRecognitionLogger.info(
                        "engine=\(benchmark.result.engine.rawValue, privacy: .public) locale=\(benchmark.result.localeIdentifier, privacy: .public) audioMs=\(benchmark.audioDurationMs) processingMs=\(benchmark.processingDurationMs) rtf=\(benchmark.realTimeFactor)"
                    )
                    draft.transcript = benchmark.result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                } catch {
                    let connection = try connection()
                    let result = try await voiceClient.transcribe(
                        fileURL: localURL,
                        recording: recording,
                        properNouns: hints,
                        connection: connection
                    )
                    draft.transcript = result.transcript.text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                draft.lastError = nil
                pendingTurns[turnIndex].attachments[attachmentIndex] = draft
                try await attachmentDraftStore.save(draft)
                rebuildMessages()
                persist()
            }
            return true
        } catch {
            updatePending(
                messageId,
                state: .failedRetryPending,
                error: "原声已保留，但还没识别好：\(error.localizedDescription)"
            )
            if let turnIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }) {
                for index in pendingTurns[turnIndex].attachments.indices
                    where pendingTurns[turnIndex].attachments[index].requiresTranscript {
                    pendingTurns[turnIndex].attachments[index].lastError = error.localizedDescription
                }
            }
            rebuildMessages()
            persist()
            return false
        }
    }

    private func refreshVoiceRecognitionHints(connection: SecretaryChatConnection) async {
        guard let shared = try? await client.voiceCorrections(connection: connection).hints else { return }
        voiceRecognitionHintsCache = Array(Set(["银月"] + shared)).sorted()
    }

    private func handleAttachmentUploadFailure(_ messageId: String, error: String) {
        updatePending(
            messageId,
            state: .failedRetryPending,
            error: "附件还没上传：\(error)"
        )
        if let turnIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }) {
            for index in pendingTurns[turnIndex].attachments.indices
                where pendingTurns[turnIndex].attachments[index].uploadedAttachment == nil {
                pendingTurns[turnIndex].attachments[index].lastError = error
            }
        }
        rebuildMessages()
        persist()
    }

    private func handle(_ event: SecretaryChatStreamEvent, for turn: PendingSecretaryChatTurn) {
        guard turn.conversationId == currentConversationId else { return }
        switch event.type {
        case .started:
            if let version = event.conversationVersion {
                updatePending(turn.messageId, state: .macPersisted, expectedVersion: version, error: nil)
                currentConversation?.version = version
            } else {
                updatePending(turn.messageId, state: .macPersisted, error: nil)
            }
            connectionState = .online
        case .speakerChanged:
            streamingSpeakerId = event.speakerId ?? streamingSpeakerId
            activeSpeakerId = streamingSpeakerId
            return
        case .delta:
            appendDelta(event, turn: turn)
            return
        case .completed:
            upsertControlledActions(event.actions ?? [], automaticallyPresent: true)
            completeTurn(turn, event: event)
        case .failed:
            markReplyUnavailableIfPersisted(
                turn,
                error: event.message ?? event.fallbackText ?? "小秘书还没有完成这条回复"
            )
        case .cancelled:
            markReplyUnavailableIfPersisted(turn, error: "本次回复已停止，原消息仍可重试")
        case .resyncRequired:
            updatePending(
                turn.messageId,
                state: event.reason == "generation_in_progress" ? .replyGenerating : .failedRetryPending,
                error: event.fallbackText
            )
        case .attachment:
            if let action = event.card?.controlledAction {
                upsertControlledAction(action, automaticallyPresent: true)
                persist()
            } else if event.card != nil {
                managementError = "Mac 发来一张当前版本还不认识的操作卡，请在 Mac 上查看。"
            }
            return
        }
        persist()
    }

    private func appendDelta(_ event: SecretaryChatStreamEvent, turn: PendingSecretaryChatTurn) {
        guard let delta = event.text, !delta.isEmpty else { return }
        updatePending(turn.messageId, state: .replyGenerating, error: nil)
        let messageId = event.messageId ?? "reply-\(turn.generationId)"
        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            messages[index].text += delta
            messages[index].fallbackText = messages[index].text
            return
        }
        let speakerId = event.speakerId ?? streamingSpeakerId ?? bootstrap?.activeSecretaryId ?? "yinyue"
        let name = bootstrap?.characters.first(where: { $0.id == speakerId })?.displayName ?? activeSecretaryName
        messages.append(SecretaryChatMessage(
            id: messageId,
            sequence: (messages.map(\.sequence).max() ?? 0) + 1,
            role: "assistant",
            sender: .init(id: speakerId, kind: "character", displayName: name),
            createdAt: nil,
            createdAtKnown: false,
            text: delta,
            fallbackText: delta,
            attachments: [],
            deliveryStage: SecretaryChatLocalDeliveryState.replyGenerating.rawValue
        ))
    }

    private func completeTurn(_ turn: PendingSecretaryChatTurn, event: SecretaryChatStreamEvent) {
        if event.duplicate != true {
            var metrics = executionMetricsByConversation[turn.conversationId] ?? SecretaryConversationExecutionMetrics()
            metrics.record(event.execution)
            executionMetricsByConversation[turn.conversationId] = metrics
        }
        let previouslyAvailableMessageIDs = Set(
            messages
                .filter { $0.deliveryStage == SecretaryChatLocalDeliveryState.deviceAvailable.rawValue }
                .map(\.id)
        )
        let prefix = "reply-\(turn.generationId)"
        messages.removeAll { $0.id == prefix || $0.id.hasPrefix(prefix + ":") }
        for message in event.messages ?? [] {
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index] = message
            } else {
                messages.append(message)
            }
        }
        messages.sort { $0.sequence < $1.sequence }
        if let index = messages.firstIndex(where: { $0.id == turn.messageId }) {
            messages[index].deliveryStage = SecretaryChatLocalDeliveryState.merging(
                messages[index].deliveryStage,
                with: SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
            )
        }
        messages = SecretaryChatRecovery.promotingReadReceipts(in: messages)
        pendingTurns.removeAll { $0.messageId == turn.messageId }
        cleanupLocalAttachments(turn.attachments)
        if var conversation = currentConversation {
            conversation.version = event.conversationVersion ?? conversation.version
            conversation.messages = messages
            conversation.messageCount = messages.count
            currentConversation = conversation
            cachedConversations[conversation.id] = conversation
            upsertSummary(conversation.summary)
            let newlyAvailableReplies = messages.filter {
                !$0.isFromCapoo
                    && $0.deliveryStage == SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
                    && !previouslyAvailableMessageIDs.contains($0.id)
            }
            if let latestReply = newlyAvailableReplies.last {
                SecretarySpeechController.shared.automaticallySpeakIfNeeded(latestReply)
            }
            for reply in newlyAvailableReplies {
                Task {
                    await SecretaryChatNotificationController.shared.notifyIfNeeded(
                        message: reply,
                        conversation: conversation
                    )
                }
            }
        }
        isStreaming = false
        streamingTurn = nil
        activeSpeakerId = nil
        connectionState = .online
        startPendingTransmissionWorkerIfNeeded()
    }

    private func resolveResync(_ turn: PendingSecretaryChatTurn, event: SecretaryChatStreamEvent) async {
        do {
            let conversation = try await client.conversation(id: turn.conversationId, connection: try connection())
            applyServerConversation(conversation)
            await reconcileControlledActionsFromMac(conversationId: turn.conversationId)
            let prefix = "reply-\(turn.generationId)"
            if conversation.messages.contains(where: { $0.id == prefix || $0.id.hasPrefix(prefix + ":") }) {
                pendingTurns.removeAll { $0.messageId == turn.messageId }
                cleanupLocalAttachments(turn.attachments)
                persist()
                return
            }
            // 已在 Mac 上看到同一 messageId 时，applyServerConversation 会把这轮
            // 收敛为 replyGenerating。不得再走一次 streamTurn。
            if let reconciled = pendingTurns.first(where: { $0.messageId == turn.messageId }),
               !reconciled.needsTransmission {
                persist()
                return
            }
            if let pendingIndex = pendingTurns.firstIndex(where: { $0.messageId == turn.messageId }) {
                pendingTurns[pendingIndex] = SecretaryChatRecovery.resynced(
                    pendingTurns[pendingIndex],
                    conversationVersion: conversation.version
                )
            }
            updatePending(
                turn.messageId,
                state: event.reason == "generation_in_progress" ? .replyGenerating : .failedRetryPending,
                error: event.fallbackText
            )
            if event.reason != "generation_in_progress",
               let refreshed = pendingTurns.first(where: { $0.messageId == turn.messageId }) {
                await transmit(refreshed, allowResyncRetry: false)
            }
        } catch {
            handleTransmissionFailure(turn.messageId, error: error)
        }
    }

    private func resolveHTTPConflict(_ turn: PendingSecretaryChatTurn) async {
        do {
            let conversation = try await client.conversation(id: turn.conversationId, connection: try connection())
            applyServerConversation(conversation)
            await reconcileControlledActionsFromMac(conversationId: turn.conversationId)
            if turn.autoChat == true {
                pendingTurns.removeAll { $0.messageId == turn.messageId }
                rebuildMessages()
                persist()
                return
            }
            guard let index = pendingTurns.firstIndex(where: { $0.messageId == turn.messageId }) else { return }
            if !pendingTurns[index].needsTransmission {
                persist()
                return
            }
            pendingTurns[index] = SecretaryChatRecovery.resynced(
                pendingTurns[index],
                conversationVersion: conversation.version
            )
            let refreshed = pendingTurns[index]
            await transmit(refreshed, allowResyncRetry: false)
        } catch {
            handleTransmissionFailure(turn.messageId, error: error)
        }
    }

    private func applyServerConversation(_ serverConversation: SecretaryChatConversation) {
        var conversation = serverConversation
        let localMessages = (currentConversation?.id == conversation.id ? currentConversation?.messages : nil)
            ?? cachedConversations[conversation.id]?.messages
            ?? []
        for local in localMessages where local.attachments.contains(where: { $0.resourcePath.hasPrefix("local-draft:") }) {
            if let index = conversation.messages.firstIndex(where: { $0.id == local.id }) {
                var preserved = local
                preserved.sequence = conversation.messages[index].sequence
                preserved.deliveryStage = SecretaryChatLocalDeliveryState.merging(
                    local.deliveryStage,
                    with: conversation.messages[index].deliveryStage
                )
                conversation.messages[index] = preserved
            }
        }
        conversation.messages.sort { $0.sequence < $1.sequence }
        conversation.messages = SecretaryChatRecovery.promotingReadReceipts(in: conversation.messages)
        conversation.messageCount = conversation.messages.count
        let switchedConversation = currentConversationId != nil && currentConversationId != conversation.id
        if let currentConversationId, currentConversationId != conversation.id {
            saveCurrentLocalState()
        }
        if currentConversation != conversation { currentConversation = conversation }
        if currentConversationId != conversation.id { currentConversationId = conversation.id }
        restoreLocalState(for: conversation.id)
        cachedConversations[conversation.id] = conversation
        upsertSummary(conversation.summary)
        let sorted = conversation.messages.sorted { $0.sequence < $1.sequence }
        if messages != sorted { messages = sorted }
        if switchedConversation {
            presentedActionID = nil
            actionDecisionNotice = nil
        }
        reconcilePendingAgainstConversation()
    }

    private func upsertSummary(_ summary: SecretaryChatConversationSummary) {
        // 摘要没变就别重排列表：每次对账都重排会连带整个界面重建一次。
        if conversationSummaries.first != summary {
            conversationSummaries.removeAll { $0.id == summary.id }
            conversationSummaries.insert(summary, at: 0)
        }
        if summary.id == currentConversationId { markVisibleConversationRead() }
    }

    private func reconcilePendingAgainstConversation() {
        guard var conversation = currentConversation else {
            rebuildMessages()
            return
        }
        for turn in pendingTurns where turn.conversationId == conversation.id
            && turn.attachments.contains(where: { $0.kind == "audio" }) {
            let prefix = "reply-\(turn.generationId)"
            guard conversation.messages.contains(where: { $0.id == prefix || $0.id.hasPrefix(prefix + ":") }) else {
                continue
            }
            let sequence = conversation.messages.first(where: { $0.id == turn.messageId })?.sequence
                ?? max(1, (conversation.messages.map(\.sequence).max() ?? 0) - 1)
            let local = SecretaryChatMessage.localUserMessage(from: turn, sequence: sequence)
            if let index = conversation.messages.firstIndex(where: { $0.id == turn.messageId }) {
                var next = local
                next.deliveryStage = SecretaryChatLocalDeliveryState.merging(
                    conversation.messages[index].deliveryStage,
                    with: local.deliveryStage
                )
                conversation.messages[index] = next
            } else {
                conversation.messages.append(local)
                conversation.messages.sort { $0.sequence < $1.sequence }
            }
        }
        conversation.messages = SecretaryChatRecovery.promotingReadReceipts(in: conversation.messages)
        if currentConversation != conversation { currentConversation = conversation }
        cachedConversations[conversation.id] = conversation
        let before = pendingTurns
        let reconciledTurns = SecretaryChatRecovery.reconciled(pending: pendingTurns, with: conversation)
        if pendingTurns != reconciledTurns { pendingTurns = reconciledTurns }
        let retainedIDs = Set(pendingTurns.map(\.messageId))
        cleanupLocalAttachments(
            before
                .filter { !retainedIDs.contains($0.messageId) }
                .flatMap(\.attachments)
                .filter { $0.kind != "audio" }
        )
        rebuildMessages()
        startPendingTransmissionWorkerIfNeeded()
    }

    private func rebuildMessages() {
        var merged = currentConversation?.messages ?? []
        let currentPending = pendingTurns.filter { $0.conversationId == currentConversationId }
        for turn in currentPending {
            if turn.autoChat == true { continue }
            if let index = merged.firstIndex(where: { $0.id == turn.messageId }) {
                let local = SecretaryChatMessage.localUserMessage(from: turn, sequence: merged[index].sequence)
                merged[index].text = local.text
                merged[index].fallbackText = local.fallbackText
                merged[index].attachments = local.attachments
                merged[index].deliveryStage = SecretaryChatLocalDeliveryState.merging(
                    merged[index].deliveryStage,
                    with: turn.state.rawValue
                )
            } else {
                merged.append(.localUserMessage(from: turn, sequence: (merged.map(\.sequence).max() ?? 0) + 1))
            }
        }
        let next = SecretaryChatRecovery.promotingReadReceipts(in: merged.sorted { $0.sequence < $1.sequence })
        if messages != next { messages = next }
        markVisibleConversationRead()
    }

    private func replaceVoiceTranscript(messageId: String, attachmentId: String, transcript: String) {
        if let messageIndex = messages.firstIndex(where: { $0.id == messageId }),
           let attachmentIndex = messages[messageIndex].attachments.firstIndex(where: { $0.id == attachmentId }) {
            messages[messageIndex].attachments[attachmentIndex] = messages[messageIndex].attachments[attachmentIndex]
                .replacingTranscript(transcript)
        }
        if var conversation = currentConversation,
           let messageIndex = conversation.messages.firstIndex(where: { $0.id == messageId }),
           let attachmentIndex = conversation.messages[messageIndex].attachments.firstIndex(where: { $0.id == attachmentId }) {
            conversation.messages[messageIndex].attachments[attachmentIndex] = conversation.messages[messageIndex]
                .attachments[attachmentIndex]
                .replacingTranscript(transcript)
            currentConversation = conversation
        }
        if let turnIndex = pendingTurns.firstIndex(where: { $0.messageId == messageId }),
           let attachmentIndex = pendingTurns[turnIndex].attachments.firstIndex(where: { $0.id == attachmentId }) {
            pendingTurns[turnIndex].attachments[attachmentIndex].transcript = transcript
        }
    }

    private func updatePending(
        _ messageId: String,
        state: SecretaryChatLocalDeliveryState,
        expectedVersion: String? = nil,
        error: String?
    ) {
        guard let index = pendingTurns.firstIndex(where: { $0.messageId == messageId }) else { return }
        pendingTurns[index].state = state
        if let expectedVersion { pendingTurns[index].expectedConversationVersion = expectedVersion }
        pendingTurns[index].lastError = error
        if state == .failedRetryPending { pendingTurns[index].retryCount += 1 }
        rebuildMessages()
    }

    private func markReplyUnavailableIfPersisted(_ turn: PendingSecretaryChatTurn, error: String) {
        let current = pendingTurns.first(where: { $0.messageId == turn.messageId })?.state ?? turn.state
        if current == .macPersisted || current == .replyGenerating || current == .deviceAvailable {
            updatePending(turn.messageId, state: .replyUnavailable, error: error)
            isStreaming = false
            streamingTurn = nil
            activeSpeakerId = nil
            return
        }
        markRetryPending(turn.messageId, error: error, marksConnectionOffline: false)
    }

    private func markRetryPending(_ messageId: String, error: String, marksConnectionOffline: Bool) {
        updatePending(messageId, state: .failedRetryPending, error: error)
        isStreaming = false
        streamingTurn = nil
        activeSpeakerId = nil
        if marksConnectionOffline { connectionState = .offline(error) }
    }

    private func handleTransmissionFailure(_ messageId: String, error: Error) {
        if let turn = pendingTurns.first(where: { $0.messageId == messageId }),
           turn.state == .macPersisted || turn.state == .replyGenerating {
            // 流在 started 之后被后台/网络中断，不能把已收件误降级为“没传过去”。
            updatePending(messageId, state: .replyGenerating, error: nil)
        } else {
            updatePending(messageId, state: .failedRetryPending, error: error.localizedDescription)
        }
        isStreaming = false
        streamingTurn = nil
        activeSpeakerId = nil
        if case SecretaryChatClientError.tokenUnavailable = error {
            connectionState = .needsPairing(error.localizedDescription)
        } else if case let SecretaryChatClientError.http(status, message) = error, status == 401 || status == 403 {
            connectionState = .needsPairing(message)
        } else {
            connectionState = .offline(error.localizedDescription)
        }
        persist()
        startPendingTransmissionWorkerIfNeeded()
    }

    private func emptyConversation(id: String, bootstrap: SecretaryChatBootstrap) -> SecretaryChatConversation {
        SecretaryChatConversation(
            id: id,
            version: "",
            type: "direct",
            title: "与\(bootstrap.characters.first(where: { $0.id == bootstrap.activeSecretaryId })?.displayName ?? "银月")的对话",
            privacy: "standard",
            activeSecretaryId: bootstrap.activeSecretaryId,
            memberIds: ["capoo", bootstrap.activeSecretaryId],
            updatedAt: nil,
            messageCount: 0,
            messages: [],
            chatState: SecretaryChatConversationState(
                activeSecretaryId: bootstrap.activeSecretaryId,
                qualityMode: "light",
                privacy: "standard"
            )
        )
    }

    private func connection() throws -> SecretaryChatConnection {
        guard let token = CodexCommandTokenKeychain.read(), !token.isEmpty else {
            throw SecretaryChatClientError.tokenUnavailable
        }
        return SecretaryChatConnection(
            serverURL: CodexCommandSettings.shared.serverURL,
            bearerToken: token
        )
    }

    private func mailboxConnection() throws -> SecretaryChatConnection {
        guard let token = CodexCommandTokenKeychain.read(), !token.isEmpty else {
            throw SecretaryChatClientError.tokenUnavailable
        }
        return SecretaryChatConnection(
            serverURL: CodexCommandSettings.shared.mailboxServerURL,
            bearerToken: token
        )
    }

    private func resolvedResourceURL(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if let absolute = URL(string: path), absolute.scheme != nil { return absolute }
        let rawBase = CodexCommandSettings.shared.serverURL
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: rawBase) else { return nil }
        return base.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }

    private func persist() {
        saveCurrentLocalState()
        var conversations = cachedConversations
        let persistedConversation = currentConversation.map { conversation in
            var copy = conversation
            copy.messages = messages.filter { message in
                !pendingTurns.contains(where: { $0.messageId == message.id })
            }
            copy.messageCount = copy.messages.count
            conversations[copy.id] = copy
            return copy
        }
        let cache = SecretaryChatDeviceCache(
            bootstrap: bootstrap,
            currentConversationId: currentConversationId,
            conversation: persistedConversation,
            conversationSummaries: conversationSummaries,
            cachedConversations: conversations,
            pendingCreationId: pendingCreationId,
            draft: draft,
            draftsByConversation: draftsByConversation,
            scrollAnchorsByConversation: scrollAnchorsByConversation,
            pendingTurns: pendingTurns,
            controlledActions: controlledActions,
            unreadState: unreadState
        )
        persistenceRevision += 1
        let revision = persistenceRevision
        Task { try? await persistence.save(cache, revision: revision) }
    }

    private func saveCurrentLocalState() {
        guard let currentConversationId else { return }
        draftsByConversation[currentConversationId] = draft
    }

    private func restoreLocalState(for conversationId: String?) {
        guard let conversationId else {
            draft = ""
            return
        }
        draft = draftsByConversation[conversationId] ?? ""
    }

    private var supportsControlledActions: Bool {
        bootstrap?.features.controlledActions == true
            && bootstrap?.protocolInfo.endpoints?.controlledActions
                == "GET /api/secretary-mobile/conversations/:id/actions"
            && bootstrap?.protocolInfo.endpoints?.controlledActionDecision
                == "POST /api/secretary-mobile/actions/:id/decision"
    }

    private func reconcileControlledActionsFromMac(
        conversationId: String,
        providedConnection: SecretaryChatConnection? = nil
    ) async {
        guard supportsControlledActions else { return }
        do {
            let actions = try await client.controlledActions(
                conversationId: conversationId,
                connection: try providedConnection ?? connection()
            )
            controlledActions = SecretaryChatActionQueue.replacingConversation(
                in: controlledActions,
                conversationId: conversationId,
                with: actions
            )
            if let presentedActionID,
               !controlledActions.contains(where: { $0.actionId == presentedActionID && $0.isPending }) {
                self.presentedActionID = nil
            }
            if self.presentedActionID == nil {
                self.presentedActionID = nextPendingControlledAction?.actionId
            }
            actionDecisionNotice = nil
            persist()
        } catch {
            actionDecisionNotice = "暂时无法与 Mac 对齐受控写入：\(error.localizedDescription)"
        }
    }

    private func upsertControlledActions(
        _ actions: [SecretaryChatControlledAction],
        automaticallyPresent: Bool
    ) {
        for action in actions {
            upsertControlledAction(action, automaticallyPresent: automaticallyPresent)
        }
    }

    private func upsertControlledAction(
        _ action: SecretaryChatControlledAction,
        automaticallyPresent: Bool
    ) {
        controlledActions = SecretaryChatActionQueue.upserting(action, into: controlledActions)
        if action.isTerminal, presentedActionID == action.actionId {
            presentedActionID = nextPendingControlledAction?.actionId
        } else if automaticallyPresent,
                  presentedActionID == nil,
                  nextPendingControlledAction?.actionId == action.actionId {
            presentedActionID = action.actionId
        }
    }

    private var effectiveConversationId: String {
        currentConversationId ?? bootstrap?.defaultConversationId ?? "native_yingning_default"
    }

    private func localDraft(id: String) -> SecretaryAttachmentDraft? {
        attachmentDrafts.first(where: { $0.id == id })
            ?? pendingTurns.lazy.flatMap(\.attachments).first(where: { $0.id == id })
    }

    private func restoreAttachmentDrafts() async {
        do {
            let stored = try await attachmentDraftStore.loadAll()
            let pendingIDs = Set(pendingTurns.flatMap(\.attachments).map(\.id))
            let sentIDs = Set(
                cachedConversations.values
                    .flatMap(\.messages)
                    .flatMap(\.attachments)
                    .filter { $0.resourcePath.hasPrefix("local-draft:") }
                    .map(\.id)
            )
            attachmentDrafts = stored.filter {
                !pendingIDs.contains($0.id) && !sentIDs.contains($0.id)
            }
        } catch {
            attachmentDraftError = "本地附件草稿暂时无法读取：\(error.localizedDescription)"
        }
    }

    private func cleanupLocalAttachments(_ drafts: [SecretaryAttachmentDraft]) {
        guard !drafts.isEmpty else { return }
        let store = attachmentDraftStore
        Task {
            for draft in drafts {
                try? await store.remove(draft)
            }
        }
    }
}
