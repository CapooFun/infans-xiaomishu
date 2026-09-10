import Foundation

enum SecretaryChatEventType: String, Codable, Sendable {
    case started
    case delta
    case speakerChanged = "speaker_changed"
    case attachment
    case completed
    case failed
    case cancelled
    case resyncRequired = "resync_required"
}

enum SecretaryChatLocalDeliveryState: String, Codable, Sendable {
    case localQueued = "local_queued"
    case macPersisted = "mac_persisted"
    case replyGenerating = "reply_generating"
    case deviceAvailable = "device_available"
    case replyUnavailable = "reply_unavailable"
    case failedRetryPending = "failed_retry_pending"
    case failedQuarantined = "failed_quarantined"

    var userFacingText: String {
        switch self {
        case .localQueued: return "发送中"
        case .macPersisted: return "未读"
        case .replyGenerating, .deviceAvailable: return "已读"
        case .replyUnavailable: return "已读不回"
        case .failedRetryPending: return "未送达"
        case .failedQuarantined: return "信箱未处理，请修改后重发"
        }
    }

    static func merging(_ current: String, with incoming: String) -> String {
        func rank(_ raw: String) -> Int? {
            switch SecretaryChatLocalDeliveryState(rawValue: raw) {
            case .localQueued: return 0
            case .macPersisted: return 1
            case .replyGenerating: return 2
            case .deviceAvailable, .replyUnavailable: return 3
            case .failedRetryPending, .failedQuarantined, .none: return nil
            }
        }
        if incoming == failedQuarantined.rawValue || incoming == failedRetryPending.rawValue {
            return incoming
        }
        if current == failedQuarantined.rawValue || current == failedRetryPending.rawValue {
            return current
        }
        guard let incomingRank = rank(incoming) else { return incoming }
        guard let currentRank = rank(current) else { return incoming }
        return incomingRank >= currentRank ? incoming : current
    }
}

enum SecretaryConversationDisplayTitle {
    static func listTitle(storedTitle: String, secretaryName: String) -> String {
        return isAutomatic(storedTitle, secretaryName: secretaryName) ? secretaryName : storedTitle
    }

    static func nextStoredTitle(secretaryName: String) -> String {
        secretaryName
    }

    static func isAutomatic(_ title: String, secretaryName: String) -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == secretaryName { return true }
        if trimmed == "和\(secretaryName)聊聊" || trimmed == "与\(secretaryName)的对话" { return true }
        let escaped = NSRegularExpression.escapedPattern(for: secretaryName)
        if trimmed.range(of: "^\(escaped)(?: \\d+)?$", options: .regularExpression) != nil {
            return true
        }
        return trimmed.range(
            of: "^\\d{1,2}月\\d{1,2}日(?:\\s*[·•]\\s*|\\s+)和\(escaped)聊聊(?: \\d+)?$",
            options: .regularExpression
        ) != nil
    }
}

struct SecretaryChatProtocolInfo: Codable, Equatable, Sendable {
    let id: String
    let version: Int
    let minimumClientVersion: String
    let eventTypes: [String]
    let endpoints: SecretaryChatProtocolEndpoints?
    let conversationMutation: SecretaryChatConversationMutationInfo?
    let replySpeakerControl: SecretaryChatReplySpeakerControlInfo?
}

struct SecretaryChatReplySpeakerControlInfo: Codable, Equatable, Sendable {
    let stateField: String
    let derivedLightsField: String
    let controllableRoleKinds: [String]
    let `default`: String
    let allowEmptySelection: Bool
    let emptySelectionBehavior: String
    let excludesUserSpeaker: Bool
}

struct SecretaryChatProtocolEndpoints: Codable, Equatable, Sendable {
    let controlledActions: String?
    let controlledActionDecision: String?
}

struct SecretaryChatConversationMutationInfo: Codable, Equatable, Sendable {
    let expectedVersionField: String
    let mutableFields: [String]
    let mutableChatStateFields: [String]
    let allowedPrivacy: [String]?
    let allowedQualityModes: [String]?
    let allowedOrdinaryBackends: [String]?
    let allowedCursorModels: [String]?
}

struct SecretaryChatServiceInfo: Codable, Equatable, Sendable {
    let version: String
    let reachable: Bool
}

struct SecretaryChatIdentityInfo: Codable, Equatable, Sendable {
    let valid: Bool
    let needsPairing: Bool
}

struct SecretaryChatProductInfo: Codable, Equatable, Sendable {
    let id: String
    let name: String
}

struct SecretaryChatCharacterAssets: Codable, Equatable, Sendable {
    let avatar: String?
    let portrait: String?
    let source: String
    let mediaMode: String?
    let manifestPath: String?
    var avatarPresentation: SecretaryAvatarPresentation? = nil
}

struct SecretaryAvatarPresentation: Codable, Equatable, Sendable {
    let position: String
    let scale: Double
    let origin: String

    private func coordinates(_ value: String) -> (Double, Double) {
        let parts = value.split(separator: " ").map(String.init)
        func fraction(_ token: String) -> Double {
            switch token {
            case "left", "top": return 0
            case "right", "bottom": return 1
            case "center": return 0.5
            default:
                guard token.hasSuffix("%"), let number = Double(token.dropLast()), number.isFinite else { return 0.5 }
                return min(1, max(0, number / 100))
            }
        }
        return (fraction(parts.first ?? "center"), fraction(parts.count > 1 ? parts[1] : "center"))
    }

    func frame(imageWidth: Double, imageHeight: Double, side: Double) -> (width: Double, height: Double, x: Double, y: Double) {
        let width = max(1, imageWidth), height = max(1, imageHeight)
        let fill = max(side / width, side / height)
        let zoom = scale.isFinite ? min(4, max(1, scale)) : 1
        let position = coordinates(position), origin = coordinates(origin)
        let baseWidth = width * fill, baseHeight = height * fill
        return (baseWidth * zoom, baseHeight * zoom,
                (side - baseWidth) * position.0 * zoom + side * origin.0 * (1 - zoom),
                (side - baseHeight) * position.1 * zoom + side * origin.1 * (1 - zoom))
    }
}

extension SecretaryChatCharacterAssets {
    init(avatar: String?, portrait: String?, source: String) {
        self.init(avatar: avatar, portrait: portrait, source: source, mediaMode: nil, manifestPath: nil)
    }
}

struct SecretaryChatCharacter: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let displayName: String
    let kind: String
    let secretaryEligible: Bool
    let fallbackText: String
    let accent: String?
    let assets: SecretaryChatCharacterAssets
}

struct SecretaryChatFeatures: Codable, Equatable, Sendable {
    let textChat: Bool
    let streamingReplies: Bool
    let reliableRetry: Bool
    let cancellation: Bool
    let conversationList: Bool
    let attachments: Bool
    let controlledActions: Bool?
    let voice: Bool
    let notifications: Bool
}

struct SecretaryChatModelRuntime: Codable, Equatable, Sendable {
    let ordinary: SecretaryChatModelChannel
}

struct SecretaryChatModelChannel: Codable, Equatable, Sendable {
    let selected: String?
    let options: [SecretaryChatModelOption]
}

struct SecretaryChatModelOption: Codable, Identifiable, Equatable, Sendable {
    var id: String { backend }
    let backend: String
    let available: Bool
    let model: String?
    let label: String
}

enum SecretaryOrdinaryChannelSwitch {
    static let unconfiguredBackend = "unconfigured"
    static let backends = [unconfiguredBackend]
    static let listTitle = "一对一模型"

    static func allowedBackends(declared: [String]?) -> [String] {
        _ = declared
        return backends
    }

    static func entryLabel(backend: String, secretaryID: String) -> String {
        _ = backend
        _ = secretaryID
        return "未配置"
    }

    static func resolvedBackend(_ raw: String?, secretaryID: String) -> String {
        _ = raw
        _ = secretaryID
        return unconfiguredBackend
    }
}

struct SecretaryChatUsage: Codable, Equatable, Sendable {
    let openrouter: SecretaryChatProviderUsage
    let cursor: SecretaryChatProviderUsage
}

struct SecretaryChatProviderUsage: Codable, Equatable, Sendable {
    let available: Bool
    let readOnly: Bool
    let reason: String?
    let scope: String?
    let currency: String?
    let usageUsd: Double?
    let limitUsd: Double?
    let limitRemainingUsd: Double?
    let checkedAt: String?
}

struct SecretaryChatConversationState: Codable, Equatable, Sendable {
    var activeSecretaryId: String
    var activeReplySpeakers: [String]? = nil
    var qualityMode: String
    var privacy: String
    var ordinaryBackend: String? = nil
    var cursorModel: String? = nil
}

extension SecretaryChatConversationState {
    enum CodingKeys: String, CodingKey {
        case activeSecretaryId
        case activeReplySpeakers
        case qualityMode
        case privacy
        case ordinaryBackend
        case cursorModel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        activeSecretaryId = try container.decode(String.self, forKey: .activeSecretaryId)
        activeReplySpeakers = try container.decodeIfPresent([String].self, forKey: .activeReplySpeakers)
        qualityMode = try container.decodeIfPresent(String.self, forKey: .qualityMode) ?? "light"
        privacy = try container.decodeIfPresent(String.self, forKey: .privacy) ?? "standard"
        ordinaryBackend = try container.decodeIfPresent(String.self, forKey: .ordinaryBackend)
        cursorModel = try container.decodeIfPresent(String.self, forKey: .cursorModel)
    }
}

struct SecretaryChatSender: Codable, Equatable, Sendable {
    let id: String
    let kind: String
    let displayName: String
}

struct SecretaryChatAttachment: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let name: String
    let mimeType: String
    let resourcePath: String
    let fallbackText: String
    let durationMs: Int?
    let transcript: String?

    init(
        id: String,
        kind: String,
        name: String,
        mimeType: String,
        resourcePath: String,
        fallbackText: String,
        durationMs: Int? = nil,
        transcript: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.mimeType = mimeType
        self.resourcePath = resourcePath
        self.fallbackText = fallbackText
        self.durationMs = durationMs
        self.transcript = transcript
    }

    var presentationKind: SecretaryChatAttachmentPresentationKind {
        let normalizedMime = mimeType.lowercased()
        let normalizedKind = kind.lowercased()
        if normalizedMime.hasPrefix("image/") || normalizedKind == "image" { return .image }
        if normalizedMime.hasPrefix("audio/") || normalizedKind == "audio" { return .audio }
        return .file
    }

    func replacingTranscript(_ value: String?) -> Self {
        Self(
            id: id,
            kind: kind,
            name: name,
            mimeType: mimeType,
            resourcePath: resourcePath,
            fallbackText: value ?? fallbackText,
            durationMs: durationMs,
            transcript: value
        )
    }
}

enum SecretaryChatAttachmentPresentationKind: String, Codable, Equatable, Sendable {
    case image
    case audio
    case file
}

enum SecretaryAttachmentPlaybackSource: Equatable, Sendable {
    case localDraft
    case remoteResource
    case unavailable
}

enum SecretaryAttachmentPlaybackSourcePolicy {
    static func preferredSource(
        hasLocalDraft: Bool,
        localFileExists: Bool,
        resourcePath: String
    ) -> SecretaryAttachmentPlaybackSource {
        if hasLocalDraft, localFileExists { return .localDraft }
        let normalizedPath = resourcePath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedPath.isEmpty, !normalizedPath.hasPrefix("local-draft:") {
            return .remoteResource
        }
        return .unavailable
    }
}

struct SecretaryChatMessage: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var sequence: Int
    let role: String
    let sender: SecretaryChatSender
    let createdAt: String?
    let createdAtKnown: Bool
    var text: String
    var fallbackText: String
    var attachments: [SecretaryChatAttachment]
    var deliveryStage: String

    var isFromCapoo: Bool { role == "user" }

    var spokenText: String {
        let preferred = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferred.isEmpty { return preferred }
        // 附件-only 消息直接显示图片/文件卡；fallback 只留给列表预览和无卡端。
        if !attachments.isEmpty { return "" }
        let fallback = fallbackText.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback
    }
}

enum SecretaryChatMessageFallback {
    static func attachmentText(for attachments: [SecretaryChatAttachment]) -> String {
        guard !attachments.isEmpty else { return "" }
        let kinds = attachments.map(\.presentationKind)
        if kinds.allSatisfy({ $0 == .image }) {
            return attachments.count == 1 ? "发送了一张图片" : "发送了 \(attachments.count) 张图片"
        }
        if kinds.allSatisfy({ $0 == .audio }) {
            return attachments.count == 1 ? "发送了一段录音" : "发送了 \(attachments.count) 段录音"
        }
        if kinds.allSatisfy({ $0 == .file }) {
            return attachments.count == 1 ? "发送了一个文件" : "发送了 \(attachments.count) 个文件"
        }
        return "发送了 \(attachments.count) 个附件"
    }
}

enum SecretarySpeechRateSetting: String, Codable, CaseIterable, Equatable, Sendable {
    case gentle
    case natural
    case lively

    var label: String {
        switch self {
        case .gentle: return "慢一点"
        case .natural: return "自然"
        case .lively: return "轻快"
        }
    }

    var rateMultiplier: Float {
        switch self {
        case .gentle: return 0.82
        case .natural: return 1
        case .lively: return 1.18
        }
    }
}

struct SecretaryChatNotificationPlan: Equatable, Sendable {
    let identifier: String
    let title: String
    let body: String
}

enum SecretaryChatNotificationPolicy {
    static func plan(
        for message: SecretaryChatMessage,
        conversationIsPrivate: Bool,
        appIsActive: Bool,
        notificationsEnabled: Bool,
        authorizationGranted: Bool,
        handledMessageIDs: Set<String>
    ) -> SecretaryChatNotificationPlan? {
        guard !message.isFromCapoo,
              message.deliveryStage == SecretaryChatLocalDeliveryState.deviceAvailable.rawValue,
              !message.id.isEmpty,
              !handledMessageIDs.contains(message.id),
              !appIsActive,
              notificationsEnabled,
              authorizationGranted else { return nil }
        if conversationIsPrivate {
            return SecretaryChatNotificationPlan(
                identifier: "secretary-chat-\(message.id)",
                title: "小秘书",
                body: "有一条新回复，打开后再看内容。"
            )
        }
        return SecretaryChatNotificationPlan(
            identifier: "secretary-chat-\(message.id)",
            title: message.sender.displayName,
            body: message.spokenText
        )
    }
}

struct SecretaryChatLastMessage: Codable, Equatable, Sendable {
    let id: String
    let sender: SecretaryChatSender
    let createdAt: String?
    let fallbackText: String
}

struct SecretaryChatConversationSummary: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let version: String
    let type: String
    let title: String
    let privacy: String
    let activeSecretaryId: String
    let memberIds: [String]
    let updatedAt: String?
    let messageCount: Int
    let lastMessage: SecretaryChatLastMessage?
}

enum SecretaryConversationVisibilityPolicy {
    static func phoneConversations(
        _ conversations: [SecretaryChatConversationSummary]
    ) -> [SecretaryChatConversationSummary] {
        ordinaryConversations(conversations)
    }

    static func visibleConversations(
        _ conversations: [SecretaryChatConversationSummary]
    ) -> [SecretaryChatConversationSummary] {
        ordinaryConversations(conversations)
    }

    static func ordinaryConversations(
        _ conversations: [SecretaryChatConversationSummary]
    ) -> [SecretaryChatConversationSummary] {
        conversations.filter(isVisibleInOrdinaryList)
    }

    static func isVisibleInOrdinaryList(
        _ conversation: SecretaryChatConversationSummary
    ) -> Bool {
        guard conversation.type == "direct", conversation.privacy == "standard" else { return false }
        let preview = conversation.lastMessage?.fallbackText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard preview != "内容已隐藏" else { return false }
        let ordinaryMembers = Set(["capoo", conversation.activeSecretaryId])
        return conversation.memberIds.allSatisfy(ordinaryMembers.contains)
    }
}

struct SecretaryChatConversation: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var version: String
    let type: String
    let title: String
    let privacy: String
    let activeSecretaryId: String
    let memberIds: [String]
    let updatedAt: String?
    var messageCount: Int
    var messages: [SecretaryChatMessage]
    var chatState: SecretaryChatConversationState
}

extension SecretaryChatConversation {
    enum CodingKeys: String, CodingKey {
        case id
        case version
        case type
        case title
        case privacy
        case activeSecretaryId
        case memberIds
        case updatedAt
        case messageCount
        case messages
        case chatState
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        version = try container.decode(String.self, forKey: .version)
        let decodedType = try container.decode(String.self, forKey: .type)
        type = decodedType
        title = try container.decode(String.self, forKey: .title)
        let decodedPrivacy = try container.decode(String.self, forKey: .privacy)
        let decodedActiveSecretaryId = try container.decode(String.self, forKey: .activeSecretaryId)
        let decodedMemberIds = try container.decode([String].self, forKey: .memberIds)
        privacy = decodedPrivacy
        activeSecretaryId = decodedActiveSecretaryId
        memberIds = decodedMemberIds
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        messageCount = try container.decode(Int.self, forKey: .messageCount)
        messages = try container.decode([SecretaryChatMessage].self, forKey: .messages)
        chatState = try container.decodeIfPresent(SecretaryChatConversationState.self, forKey: .chatState)
            ?? SecretaryChatConversationState(
                activeSecretaryId: decodedActiveSecretaryId,
                qualityMode: "light",
                privacy: decodedPrivacy
            )
    }
}

struct SecretaryChatBootstrap: Codable, Equatable, Sendable {
    let protocolInfo: SecretaryChatProtocolInfo
    let service: SecretaryChatServiceInfo
    let identity: SecretaryChatIdentityInfo
    let product: SecretaryChatProductInfo
    let activeSecretaryId: String
    let defaultConversationId: String
    let characters: [SecretaryChatCharacter]
    let features: SecretaryChatFeatures
    let modelRuntime: SecretaryChatModelRuntime?
    let usage: SecretaryChatUsage?
    let recentConversations: [SecretaryChatConversationSummary]
    let warnings: [SecretaryChatWarning]

    enum CodingKeys: String, CodingKey {
        case protocolInfo = "protocol"
        case service
        case identity
        case product
        case activeSecretaryId
        case defaultConversationId
        case characters
        case features
        case modelRuntime
        case usage
        case recentConversations
        case warnings
    }
}

struct SecretaryChatConversationListResponse: Codable, Equatable, Sendable {
    let conversations: [SecretaryChatConversationSummary]
    let errors: [SecretaryChatWarning]
    let complete: Bool
}

struct SecretaryChatCreateConversationRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let conversationId: String
    let title: String?
    let activeSecretaryId: String?

    init(
        protocolVersion: Int,
        conversationId: String,
        title: String?,
        activeSecretaryId: String? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.conversationId = conversationId
        self.title = title
        self.activeSecretaryId = activeSecretaryId
    }
}

struct SecretaryChatCreateConversationResponse: Codable, Equatable, Sendable {
    let created: Bool
    let duplicate: Bool
    let conversation: SecretaryChatConversation
}

struct SecretaryChatConversationStatePatch: Codable, Equatable, Sendable {
    let activeSecretaryId: String?
    let activeReplySpeakers: [String]?
    let privacy: String?
    let qualityMode: String?
    let ordinaryBackend: String?
    let cursorModel: String?

    init(
        activeSecretaryId: String? = nil,
        activeReplySpeakers: [String]? = nil,
        privacy: String? = nil,
        qualityMode: String? = nil,
        ordinaryBackend: String? = nil,
        cursorModel: String? = nil
    ) {
        self.activeSecretaryId = activeSecretaryId
        self.activeReplySpeakers = activeReplySpeakers
        self.privacy = privacy
        self.qualityMode = qualityMode
        self.ordinaryBackend = ordinaryBackend
        self.cursorModel = cursorModel
    }
}

struct SecretaryChatUpdateConversationRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let expectedConversationVersion: String
    let title: String?
    let chatState: SecretaryChatConversationStatePatch?
}

struct SecretaryChatUpdateConversationResponse: Codable, Equatable, Sendable {
    let conversation: SecretaryChatConversation
}

struct SecretaryChatDeleteConversationRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let expectedConversationVersion: String
}

struct SecretaryChatDeleteConversationResponse: Codable, Equatable, Sendable {
    let id: String
    let deleted: Bool
    let removedAttachments: [String]
    let attachmentCleanupDeferred: Bool
}

struct SecretaryChatWarning: Codable, Equatable, Sendable {
    let id: String?
    let code: String?
}

struct SecretaryChatStreamEvent: Codable, Equatable, Sendable {
    let type: SecretaryChatEventType
    let conversationId: String?
    let generationId: String?
    let userMessageId: String?
    let messageId: String?
    let speakerId: String?
    let deliveryStage: String?
    let persistedAt: String?
    let conversationVersion: String?
    let text: String?
    let messages: [SecretaryChatMessage]?
    let code: String?
    let message: String?
    let retryable: Bool?
    let fallbackText: String?
    let reason: String?
    let retryAfterMs: Int?
    let duplicate: Bool?
    let autoContinuation: Bool?
    let execution: SecretaryChatExecutionSummary?
    let card: SecretaryChatEventCard?
    let actions: [SecretaryChatControlledAction]?
}

struct SecretaryChatEventCard: Codable, Equatable, Sendable {
    let controlledAction: SecretaryChatControlledAction?

    init(controlledAction: SecretaryChatControlledAction?) {
        self.controlledAction = controlledAction
    }

    init(from decoder: Decoder) throws {
        controlledAction = try? SecretaryChatControlledAction(from: decoder)
    }

    func encode(to encoder: Encoder) throws {
        if let controlledAction {
            try controlledAction.encode(to: encoder)
        } else {
            _ = encoder.container(keyedBy: EmptyCodingKeys.self)
        }
    }

    private enum EmptyCodingKeys: CodingKey {}
}

struct SecretaryChatControlledAction: Codable, Identifiable, Equatable, Sendable {
    var id: String { actionId }
    let actionId: String
    let conversationId: String
    let generationId: String
    let assistantMessageId: String
    let order: Int
    let label: String
    let publicPreview: SecretaryChatActionPublicPreview
    let state: String
    let result: SecretaryChatActionResult?
    let error: SecretaryChatActionError?

    var isTerminal: Bool { ["completed", "cancelled", "failed"].contains(state) }
    var isPending: Bool { publicPreview.requiresConfirm && !isTerminal }
}

struct SecretaryChatActionPublicPreview: Codable, Equatable, Sendable {
    let kind: String
    let targetLabel: String
    let targetPath: String?
    let summary: String
    let before: String
    let after: String
    let expiresAt: String?
    let requiresConfirm: Bool
}

struct SecretaryChatActionResult: Codable, Equatable, Sendable {
    let ok: Bool?
    let targetLabel: String?
    let cancelled: Bool?
}

struct SecretaryChatActionError: Codable, Equatable, Sendable {
    let code: String?
    let message: String?
}

struct SecretaryChatActionListResponse: Codable, Equatable, Sendable {
    let actions: [SecretaryChatControlledAction]
}

struct SecretaryChatActionDecisionRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let conversationId: String
    let generationId: String
    let decision: String
}

struct SecretaryChatActionDecisionResponse: Codable, Equatable, Sendable {
    let duplicate: Bool
    let stale: Bool
    let action: SecretaryChatControlledAction
}

enum SecretaryChatActionQueue {
    static func sorted(_ actions: [SecretaryChatControlledAction]) -> [SecretaryChatControlledAction] {
        actions.sorted {
            if $0.generationId != $1.generationId { return $0.generationId < $1.generationId }
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.actionId < $1.actionId
        }
    }

    static func earliestPending(
        in actions: [SecretaryChatControlledAction],
        conversationId: String?
    ) -> SecretaryChatControlledAction? {
        guard let conversationId else { return nil }
        return sorted(actions).first { $0.conversationId == conversationId && $0.isPending }
    }

    static func replacingConversation(
        in existing: [SecretaryChatControlledAction],
        conversationId: String,
        with authoritative: [SecretaryChatControlledAction]
    ) -> [SecretaryChatControlledAction] {
        sorted(existing.filter { $0.conversationId != conversationId } + authoritative)
    }

    static func upserting(
        _ action: SecretaryChatControlledAction,
        into existing: [SecretaryChatControlledAction]
    ) -> [SecretaryChatControlledAction] {
        sorted(existing.filter { $0.actionId != action.actionId } + [action])
    }

    static func canSend(
        actions: [SecretaryChatControlledAction],
        conversationId: String?,
        decidingActionId: String?
    ) -> Bool {
        decidingActionId == nil && earliestPending(in: actions, conversationId: conversationId) == nil
    }

    static func canDecide(
        actionId: String,
        actions: [SecretaryChatControlledAction],
        conversationId: String?,
        decidingActionId: String?
    ) -> Bool {
        decidingActionId == nil
            && earliestPending(in: actions, conversationId: conversationId)?.actionId == actionId
    }
}

struct SecretaryChatExecutionSummary: Codable, Equatable, Sendable {
    let backend: String?
    let model: String?
    let usage: SecretaryChatTurnUsage?
}

struct SecretaryChatTurnUsage: Codable, Equatable, Sendable {
    let totalTokens: Int?
    let cost: Double?

    enum CodingKeys: String, CodingKey {
        case totalTokens = "total_tokens"
        case cost
    }
}

struct SecretaryConversationExecutionMetrics: Equatable, Sendable {
    var latestModel: String?
    var totalTokens: Int = 0
    var reportedCostUSD: Double = 0
    var completedTurns: Int = 0
    var tokensComplete = true
    var costComplete = true

    mutating func record(_ execution: SecretaryChatExecutionSummary?) {
        completedTurns += 1
        if let model = execution?.model?.trimmingCharacters(in: .whitespacesAndNewlines), !model.isEmpty {
            latestModel = model
        }
        if let tokens = execution?.usage?.totalTokens {
            totalTokens += tokens
        } else {
            tokensComplete = false
        }
        if let cost = execution?.usage?.cost {
            reportedCostUSD += cost
        } else {
            costComplete = false
        }
    }
}

enum SecretaryChatNDJSON {
    static func decodeLine(_ line: String) throws -> SecretaryChatStreamEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        return try JSONDecoder().decode(SecretaryChatStreamEvent.self, from: data)
    }

    static func decode(_ data: Data) throws -> [SecretaryChatStreamEvent] {
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        return try text.split(whereSeparator: \.isNewline).compactMap { try decodeLine(String($0)) }
    }

    static func isTerminal(_ event: SecretaryChatStreamEvent) -> Bool {
        [.completed, .failed, .cancelled, .resyncRequired].contains(event.type)
    }
}

struct SecretaryChatTurnRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let conversationId: String
    let messageId: String
    let generationId: String
    let createdAt: String
    let text: String
    let expectedConversationVersion: String
    let attachments: [SecretaryChatTurnAttachmentReference]
    let autoChat: Bool?
}

struct SecretaryChatTurnAttachmentReference: Codable, Equatable, Sendable {
    let id: String
    let transcript: String?

    init(id: String, transcript: String? = nil) {
        self.id = id
        self.transcript = transcript
    }
}

struct SecretaryChatMailboxAttachment: Codable, Equatable, Sendable {
    let id: String
    let kind: String
    let mimeType: String
    let durationMs: Int?
    let transcript: String?
    let resourcePath: String?
}

struct SecretaryChatMailboxMessageRequest: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let conversationId: String
    let messageId: String
    let generationId: String
    let createdAt: String
    let text: String
    let expectedConversationVersion: String
    let attachments: [SecretaryChatMailboxAttachment]
}

struct SecretaryChatMailboxMessage: Decodable, Equatable, Sendable {
    let protocolVersion: Int
    let conversationId: String
    let messageId: String
    let generationId: String
    let createdAt: String
    let text: String
    let expectedConversationVersion: String
    let attachments: [SecretaryChatMailboxAttachment]
    let status: String?
    let lastError: String?

    var localDeliveryState: SecretaryChatLocalDeliveryState {
        switch status {
        case "failed": return .failedQuarantined
        case "processing": return .replyGenerating
        case "replied": return .deviceAvailable
        default: return .macPersisted
        }
    }
}

struct SecretaryChatMailboxReply: Decodable, Equatable, Sendable {
    let protocolVersion: Int
    let conversationId: String
    let messageId: String
    let generationId: String
    let text: String
    let speakerId: String
    let createdAt: String
}

struct SecretaryChatMailboxSyncResponse: Decodable, Equatable, Sendable {
    let schemaVersion: Int
    let revision: Int
    let changed: Bool
    let messages: [SecretaryChatMailboxMessage]
    let replies: [SecretaryChatMailboxReply]
}

struct SecretaryVoiceCorrectionRecord: Codable, Identifiable, Equatable, Sendable {
    var id: String { correctionId }
    let schemaVersion: Int
    let correctionId: String
    let conversationId: String
    let messageId: String
    let attachmentId: String
    let selectedOriginal: String
    let replacement: String
    let prefix: String
    let suffix: String
    let originalTranscript: String
    let correctedTranscript: String
    let createdAt: String
    let revokedAt: String?
}

struct SecretaryVoiceCorrectionListResponse: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let corrections: [SecretaryVoiceCorrectionRecord]
    let hints: [String]
}

struct SecretaryVoiceCorrectionRequest: Codable, Equatable, Sendable {
    let correctionId: String
    let conversationId: String
    let messageId: String
    let attachmentId: String
    let expectedTranscript: String
    let correctedTranscript: String
}

struct SecretaryVoiceCorrectionResponse: Codable, Equatable, Sendable {
    let duplicate: Bool
    let correction: SecretaryVoiceCorrectionRecord
    let transcript: String
}

struct PendingSecretaryChatTurn: Codable, Identifiable, Equatable, Sendable {
    var id: String { messageId }
    let conversationId: String
    let messageId: String
    let generationId: String
    let createdAt: String
    let text: String
    var expectedConversationVersion: String
    var state: SecretaryChatLocalDeliveryState
    var lastError: String?
    var retryCount: Int
    var autoChat: Bool?
    var attachments: [SecretaryAttachmentDraft]

    enum CodingKeys: String, CodingKey {
        case conversationId
        case messageId
        case generationId
        case createdAt
        case text
        case expectedConversationVersion
        case state
        case lastError
        case retryCount
        case autoChat
        case attachments
    }

    init(
        conversationId: String,
        messageId: String,
        generationId: String,
        createdAt: String,
        text: String,
        expectedConversationVersion: String,
        state: SecretaryChatLocalDeliveryState,
        lastError: String?,
        retryCount: Int,
        autoChat: Bool?,
        attachments: [SecretaryAttachmentDraft]
    ) {
        self.conversationId = conversationId
        self.messageId = messageId
        self.generationId = generationId
        self.createdAt = createdAt
        self.text = text
        self.expectedConversationVersion = expectedConversationVersion
        self.state = state
        self.lastError = lastError
        self.retryCount = retryCount
        self.autoChat = autoChat
        self.attachments = attachments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try container.decode(String.self, forKey: .conversationId)
        messageId = try container.decode(String.self, forKey: .messageId)
        generationId = try container.decode(String.self, forKey: .generationId)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        text = try container.decode(String.self, forKey: .text)
        expectedConversationVersion = try container.decode(String.self, forKey: .expectedConversationVersion)
        state = try container.decode(SecretaryChatLocalDeliveryState.self, forKey: .state)
        lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
        retryCount = try container.decodeIfPresent(Int.self, forKey: .retryCount) ?? 0
        autoChat = try container.decodeIfPresent(Bool.self, forKey: .autoChat)
        attachments = try container.decodeIfPresent([SecretaryAttachmentDraft].self, forKey: .attachments) ?? []
    }

    static func make(
        conversationId: String,
        text: String,
        expectedConversationVersion: String,
        attachments: [SecretaryAttachmentDraft] = [],
        autoChat: Bool = false,
        now: Date = Date(),
        id: UUID = UUID()
    ) -> Self {
        let stable = id.uuidString.lowercased()
        return Self(
            conversationId: conversationId,
            messageId: "msg-\(stable)",
            generationId: "gen-\(stable)",
            createdAt: ISO8601DateFormatter().string(from: now),
            text: text,
            expectedConversationVersion: expectedConversationVersion,
            state: .localQueued,
            lastError: nil,
            retryCount: 0,
            autoChat: autoChat ? true : nil,
            attachments: autoChat ? [] : attachments
        )
    }

    static func makeVoice(
        conversationId: String,
        attachment: SecretaryAttachmentDraft,
        expectedConversationVersion: String,
        createdAt: Date = Date()
    ) -> Self {
        precondition(attachment.kind == "audio")
        return Self(
            conversationId: conversationId,
            messageId: "msg-\(attachment.id)",
            generationId: "gen-\(attachment.id)",
            createdAt: ISO8601DateFormatter().string(from: createdAt),
            text: "",
            expectedConversationVersion: expectedConversationVersion,
            state: .localQueued,
            lastError: nil,
            retryCount: 0,
            autoChat: nil,
            attachments: [attachment]
        )
    }

    var request: SecretaryChatTurnRequest {
        SecretaryChatTurnRequest(
            protocolVersion: 1,
            conversationId: conversationId,
            messageId: messageId,
            generationId: generationId,
            createdAt: createdAt,
            text: text,
            expectedConversationVersion: expectedConversationVersion,
            attachments: attachments.compactMap { attachment in
                attachment.uploadedAttachment.map {
                    SecretaryChatTurnAttachmentReference(id: $0.id, transcript: attachment.normalizedTranscript)
                }
            },
            autoChat: autoChat
        )
    }

    var mailboxRequest: SecretaryChatMailboxMessageRequest {
        SecretaryChatMailboxMessageRequest(
            protocolVersion: 1,
            conversationId: conversationId,
            messageId: messageId,
            generationId: generationId,
            createdAt: createdAt,
            text: text,
            expectedConversationVersion: expectedConversationVersion,
            attachments: attachments.map { attachment in
                SecretaryChatMailboxAttachment(
                    id: attachment.id,
                    kind: attachment.kind,
                    mimeType: attachment.mimeType,
                    durationMs: attachment.durationMs,
                    transcript: attachment.normalizedTranscript,
                    resourcePath: attachment.uploadedAttachment?.resourcePath ?? "local-draft:\(attachment.id)"
                )
            }
        )
    }

    var hasUnuploadedAttachments: Bool {
        attachments.contains { $0.uploadedAttachment == nil }
    }

    var isReadyForStreaming: Bool {
        guard autoChat != true else { return attachments.isEmpty }
        return !hasUnuploadedAttachments && !attachments.contains(where: { $0.requiresTranscript })
    }

    var isReadyForMailbox: Bool {
        guard autoChat != true else { return false }
        return !attachments.contains(where: { $0.requiresTranscript })
    }

    var needsTransmission: Bool {
        state == .localQueued || state == .failedRetryPending
    }
}

enum SecretaryChatTransmissionOrder {
    static func nextMessageID(
        scheduledMessageIDs: [String],
        pendingTurns: [PendingSecretaryChatTurn]
    ) -> String? {
        let scheduled = Set(scheduledMessageIDs)
        guard !scheduled.isEmpty else { return nil }
        for turn in pendingTurns {
            if scheduled.contains(turn.messageId), turn.needsTransmission {
                return turn.messageId
            }
        }
        return nil
    }
}

actor SecretaryVoiceQueueAdmission {
    private var inFlight: [String: Task<Bool, Never>] = [:]

    func perform(
        messageID: String,
        operation: @escaping @Sendable () async -> Bool
    ) async -> Bool {
        if let existing = inFlight[messageID] {
            return await existing.value
        }
        let task = Task { await operation() }
        inFlight[messageID] = task
        let result = await task.value
        inFlight[messageID] = nil
        return result
    }
}

struct SecretaryConversationUnreadState: Codable, Equatable, Sendable {
    var readMessageIDs: [String: String] = [:]

    func isUnread(_ summary: SecretaryChatConversationSummary) -> Bool {
        guard let last = summary.lastMessage, last.sender.kind != "user" else { return false }
        return readMessageIDs[summary.id] != last.id
    }

    /// 已读记录没有变化时不要重新赋值，否则每次对账都会通知界面重建一次。
    func needsReadMark(_ summary: SecretaryChatConversationSummary) -> Bool {
        guard let last = summary.lastMessage else { return false }
        return readMessageIDs[summary.id] != last.id
    }

    mutating func markRead(_ summary: SecretaryChatConversationSummary) {
        if let last = summary.lastMessage { readMessageIDs[summary.id] = last.id }
    }
}

struct SecretaryChatDeviceCache: Codable, Equatable, Sendable {
    var bootstrap: SecretaryChatBootstrap?
    var currentConversationId: String?
    var conversation: SecretaryChatConversation?
    var conversationSummaries: [SecretaryChatConversationSummary]
    var cachedConversations: [String: SecretaryChatConversation]
    var pendingCreationId: String?
    var draft: String
    var draftsByConversation: [String: String]
    var scrollAnchorsByConversation: [String: String]
    var pendingTurns: [PendingSecretaryChatTurn]
    var controlledActions: [SecretaryChatControlledAction]
    var unreadState: SecretaryConversationUnreadState

    static let empty = Self(
        bootstrap: nil,
        currentConversationId: nil,
        conversation: nil,
        conversationSummaries: [],
        cachedConversations: [:],
        pendingCreationId: nil,
        draft: "",
        draftsByConversation: [:],
        scrollAnchorsByConversation: [:],
        pendingTurns: [],
        controlledActions: []
    )

    enum CodingKeys: String, CodingKey {
        case bootstrap
        case currentConversationId
        case conversation
        case conversationSummaries
        case cachedConversations
        case pendingCreationId
        case draft
        case draftsByConversation
        case scrollAnchorsByConversation
        case pendingTurns
        case controlledActions
        case unreadState
    }

    init(
        bootstrap: SecretaryChatBootstrap?,
        currentConversationId: String?,
        conversation: SecretaryChatConversation?,
        conversationSummaries: [SecretaryChatConversationSummary],
        cachedConversations: [String: SecretaryChatConversation],
        pendingCreationId: String?,
        draft: String,
        draftsByConversation: [String: String],
        scrollAnchorsByConversation: [String: String],
        pendingTurns: [PendingSecretaryChatTurn],
        controlledActions: [SecretaryChatControlledAction] = [],
        unreadState: SecretaryConversationUnreadState = .init()
    ) {
        self.bootstrap = bootstrap
        self.currentConversationId = currentConversationId
        self.conversation = conversation
        self.conversationSummaries = conversationSummaries
        self.cachedConversations = cachedConversations
        self.pendingCreationId = pendingCreationId
        self.draft = draft
        self.draftsByConversation = draftsByConversation
        self.scrollAnchorsByConversation = scrollAnchorsByConversation
        self.pendingTurns = pendingTurns
        self.controlledActions = controlledActions
        self.unreadState = unreadState
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bootstrap = try container.decodeIfPresent(SecretaryChatBootstrap.self, forKey: .bootstrap)
        currentConversationId = try container.decodeIfPresent(String.self, forKey: .currentConversationId)
        conversation = try container.decodeIfPresent(SecretaryChatConversation.self, forKey: .conversation)
        conversationSummaries = try container.decodeIfPresent(
            [SecretaryChatConversationSummary].self,
            forKey: .conversationSummaries
        ) ?? []
        cachedConversations = try container.decodeIfPresent(
            [String: SecretaryChatConversation].self,
            forKey: .cachedConversations
        ) ?? [:]
        if let conversation { cachedConversations[conversation.id] = conversation }
        pendingCreationId = try container.decodeIfPresent(String.self, forKey: .pendingCreationId)
        draft = try container.decodeIfPresent(String.self, forKey: .draft) ?? ""
        draftsByConversation = try container.decodeIfPresent(
            [String: String].self,
            forKey: .draftsByConversation
        ) ?? [:]
        if let currentConversationId, draftsByConversation[currentConversationId] == nil, !draft.isEmpty {
            draftsByConversation[currentConversationId] = draft
        }
        scrollAnchorsByConversation = try container.decodeIfPresent(
            [String: String].self,
            forKey: .scrollAnchorsByConversation
        ) ?? [:]
        pendingTurns = try container.decodeIfPresent([PendingSecretaryChatTurn].self, forKey: .pendingTurns) ?? []
        controlledActions = try container.decodeIfPresent(
            [SecretaryChatControlledAction].self,
            forKey: .controlledActions
        ) ?? []
        if let stored = try container.decodeIfPresent(SecretaryConversationUnreadState.self, forKey: .unreadState) {
            unreadState = stored
        } else {
            unreadState = .init()
            for summary in conversationSummaries { unreadState.markRead(summary) }
        }
    }
}

enum SecretaryChatRecovery {
    static func hasCompletedReply(
        forMessageId messageId: String,
        generationId: String,
        in messages: [SecretaryChatMessage]
    ) -> Bool {
        let replyPrefix = "reply-\(generationId)"
        if !generationId.isEmpty,
           messages.contains(where: { $0.id == replyPrefix || $0.id.hasPrefix(replyPrefix + ":") }) {
            return true
        }
        return hasAssistantReply(afterMessageId: messageId, in: messages)
    }

    static func hasAssistantReply(afterMessageId messageId: String, in messages: [SecretaryChatMessage]) -> Bool {
        guard let userIndex = messages.firstIndex(where: { $0.id == messageId }) else {
            return false
        }
        return messages.dropFirst(userIndex + 1).contains {
            !$0.isFromCapoo && !$0.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    static func promotingReadReceipts(in messages: [SecretaryChatMessage]) -> [SecretaryChatMessage] {
        var next = messages
        for index in next.indices where next[index].isFromCapoo {
            let current = next[index].deliveryStage
            if current == SecretaryChatLocalDeliveryState.failedRetryPending.rawValue
                || current == SecretaryChatLocalDeliveryState.failedQuarantined.rawValue
                || current == SecretaryChatLocalDeliveryState.replyUnavailable.rawValue {
                continue
            }
            if hasAssistantReply(afterMessageId: next[index].id, in: next) {
                next[index].deliveryStage = SecretaryChatLocalDeliveryState.merging(
                    current,
                    with: SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
                )
            }
        }
        return next
    }

    static func reconciled(
        pending: [PendingSecretaryChatTurn],
        with conversation: SecretaryChatConversation
    ) -> [PendingSecretaryChatTurn] {
        pending.compactMap { turn in
            if hasCompletedReply(forMessageId: turn.messageId, generationId: turn.generationId, in: conversation.messages) {
                return nil
            }
            guard turn.state != .failedQuarantined,
                  conversation.messages.contains(where: { $0.id == turn.messageId }) else { return turn }
            var aligned = turn
            aligned.expectedConversationVersion = conversation.version
            // Mac 已持久化同一稳定 messageId。这时只能对账正式回复，
            // 不再把它当作尚未送达的本地发件重复提交。
            aligned.state = turn.state == .replyGenerating ? .replyGenerating : .macPersisted
            aligned.lastError = nil
            return aligned
        }
    }

    static func resynced(_ turn: PendingSecretaryChatTurn, conversationVersion: String) -> PendingSecretaryChatTurn {
        var aligned = turn
        aligned.expectedConversationVersion = conversationVersion
        return aligned
    }
}

extension SecretaryChatMessage {
    static func localUserMessage(from turn: PendingSecretaryChatTurn, sequence: Int) -> Self {
        let attachments = turn.attachments.map(\.messageAttachment)
        let fallback = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self(
            id: turn.messageId,
            sequence: sequence,
            role: "user",
            sender: .init(id: "capoo", kind: "user", displayName: "我"),
            createdAt: turn.createdAt,
            createdAtKnown: true,
            text: turn.text,
            fallbackText: fallback.isEmpty ? SecretaryChatMessageFallback.attachmentText(for: attachments) : fallback,
            attachments: attachments,
            deliveryStage: turn.state.rawValue
        )
    }
}

extension SecretaryChatConversation {
    var summary: SecretaryChatConversationSummary {
        let last = messages.max(by: { $0.sequence < $1.sequence })
        return SecretaryChatConversationSummary(
            id: id,
            version: version,
            type: type,
            title: title,
            privacy: privacy,
            activeSecretaryId: activeSecretaryId,
            memberIds: memberIds,
            updatedAt: updatedAt,
            messageCount: messageCount,
            lastMessage: last.map {
                SecretaryChatLastMessage(
                    id: $0.id,
                    sender: $0.sender,
                    createdAt: $0.createdAt,
                    fallbackText: privacy == "private" ? "内容已隐藏" : $0.fallbackText
                )
            }
        )
    }
}
