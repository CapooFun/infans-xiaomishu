import Foundation

enum CodexCommandSource: String, Codable, Sendable {
    case watchApp = "apple_watch_app"
    case siri = "apple_watch_siri"
}

enum SecretaryCommandRoute: String, Codable, Sendable {
    case auto
    case codex
    case companion
}

enum CodexCommandDeliveryState: String, Codable, Sendable {
    case received
    case sending
    case phoneReceived
    case macAccepted = "mac_accepted"
    case replyGenerating = "reply_generating"
    case replyReady = "reply_ready"
    case phoneReplyReceived = "phone_reply_received"
    case watchReplyPersisted = "watch_reply_persisted"
    case watchReplyAvailable = "watch_reply_available"
    case userSeen = "user_seen"
    case delivered
    case retryPending
    case failed
    case needsChoice = "needs_choice"

    var displayText: String {
        switch self {
        case .received: return "我听到啦"
        case .sending: return "正送去 iPhone"
        case .phoneReceived: return "iPhone 收到了"
        case .macAccepted: return "Mac 收到了"
        case .replyGenerating: return "我在想怎么回…"
        case .replyReady: return "回信写好啦"
        case .phoneReplyReceived: return "回信到 iPhone 了"
        case .watchReplyPersisted: return "收到回信啦"
        case .watchReplyAvailable: return "回信到手表啦"
        case .userSeen: return "你看过啦"
        case .delivered: return "已经送到啦"
        case .retryPending: return "没传过去，等我再试"
        case .failed: return "这次没传过去"
        case .needsChoice: return "想交给谁呢？"
        }
    }
}

enum SecretaryConfirmationState: String, Codable, Sendable {
    case pending
    case completed
    case cancelled
    case failed
}

enum SecretaryActionDecision: String, Codable, Sendable {
    case confirm
    case cancel
}

struct CodexCommand: Codable, Identifiable, Equatable, Sendable {
    static let schemaVersion = 1
    static let defaultConversationKey = "watch-default"

    let id: String
    let text: String
    let createdAt: String
    let source: CodexCommandSource
    let deviceID: String
    let route: SecretaryCommandRoute
    let conversationKey: String
    var state: CodexCommandDeliveryState
    var retryCount: Int
    var lastError: String?
    var phoneReceivedAt: String?
    var reply: SecretaryReply?

    private enum CodingKeys: String, CodingKey {
        case id, text, createdAt, source, deviceID, route, conversationKey
        case state, retryCount, lastError, phoneReceivedAt, reply
    }

    init(
        id: String = UUID().uuidString.lowercased(),
        text: String,
        createdAt: Date = Date(),
        source: CodexCommandSource,
        deviceID: String,
        route: SecretaryCommandRoute = .auto,
        conversationKey: String = CodexCommand.defaultConversationKey,
        state: CodexCommandDeliveryState = .received,
        retryCount: Int = 0,
        lastError: String? = nil,
        phoneReceivedAt: String? = nil,
        reply: SecretaryReply? = nil
    ) {
        self.id = id
        self.text = Self.normalizedText(text)
        self.createdAt = ISO8601DateFormatter().string(from: createdAt)
        self.source = source
        self.deviceID = deviceID
        self.route = route
        self.conversationKey = conversationKey
        self.state = state
        self.retryCount = retryCount
        self.lastError = lastError
        self.phoneReceivedAt = phoneReceivedAt
        self.reply = reply
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        source = try container.decode(CodexCommandSource.self, forKey: .source)
        deviceID = try container.decode(String.self, forKey: .deviceID)
        route = try container.decode(SecretaryCommandRoute.self, forKey: .route)
        conversationKey = try container.decodeIfPresent(String.self, forKey: .conversationKey) ?? Self.defaultConversationKey
        state = try container.decodeIfPresent(CodexCommandDeliveryState.self, forKey: .state) ?? .received
        retryCount = try container.decodeIfPresent(Int.self, forKey: .retryCount) ?? 0
        lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
        phoneReceivedAt = try container.decodeIfPresent(String.self, forKey: .phoneReceivedAt)
        reply = try container.decodeIfPresent(SecretaryReply.self, forKey: .reply)
    }

    static func normalizedText(_ value: String) -> String {
        correctSecretaryName(in: value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func correctSecretaryName(in value: String) -> String {
        let aliases = [
            "阴影", "莹宁", "莹凝", "莺宁", "莺凝", "英宁", "英凝", "英妮",
            "盈宁", "盈凝", "迎宁", "迎您", "应宁", "应您", "颖宁", "颖凝",
            "影宁", "影凝", "樱宁", "樱凝", "婴宁", "婴凝", "银宁", "银凝", "英玲",
            "伊米",
        ]
        let leadingAddressMarkers = ["，", ",", "。", "！", "!", "？", "?", " ", "我", "你", "帮", "请", "在", "能", "给"]
        let trailingAddressMarkers = ["，", ",", "。", "！", "!", "？", "?", " "]
        var result = value

        for alias in aliases {
            result = result.replacingOccurrences(of: "\(alias)小秘书", with: "银月")
            if result == alias { return "银月" }

            if leadingAddressMarkers.contains(where: { result.hasPrefix(alias + $0) }) {
                result.replaceSubrange(result.startIndex..<result.index(result.startIndex, offsetBy: alias.count), with: "银月")
            }

            for marker in trailingAddressMarkers {
                let suffix = marker + alias
                guard result.hasSuffix(suffix) else { continue }
                let start = result.index(result.endIndex, offsetBy: -alias.count)
                result.replaceSubrange(start..<result.endIndex, with: "银月")
                break
            }
        }
        return result
            .replacingOccurrences(of: "小秘书", with: "银月")
            .replacingOccurrences(of: "银月门帮", with: "银月能帮")
    }

    var isValid: Bool {
        UUID(uuidString: id) != nil
            && !text.isEmpty
            && text.count <= 4_000
            && !deviceID.isEmpty
            && deviceID.count <= 128
    }

    var connectivityPayload: [String: Any] {
        [
            "kind": "codexCommand",
            "schemaVersion": Self.schemaVersion,
            "id": id,
            "text": text,
            "createdAt": createdAt,
            "source": source.rawValue,
            "deviceId": deviceID,
            "route": route.rawValue,
            "conversationKey": conversationKey,
        ]
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> CodexCommand? {
        guard (payload["kind"] as? String) == "codexCommand",
              (payload["schemaVersion"] as? Int) == schemaVersion,
              let id = payload["id"] as? String,
              let text = payload["text"] as? String,
              let createdAt = payload["createdAt"] as? String,
              let sourceRaw = payload["source"] as? String,
              let source = CodexCommandSource(rawValue: sourceRaw),
              let deviceID = payload["deviceId"] as? String,
              let routeRaw = payload["route"] as? String,
              let route = SecretaryCommandRoute(rawValue: routeRaw) else { return nil }
        let conversationKey = payload["conversationKey"] as? String ?? defaultConversationKey
        var result = CodexCommand(id: id, text: text, source: source, deviceID: deviceID, route: route, conversationKey: conversationKey)
        result = CodexCommand(
            id: result.id,
            text: result.text,
            createdAt: ISO8601DateFormatter().date(from: createdAt) ?? Date(),
            source: result.source,
            deviceID: result.deviceID,
            route: result.route,
            conversationKey: result.conversationKey
        )
        return result.isValid ? result : nil
    }
}

enum WatchPendingCommandRetryPolicy {
    static func commandsToRetry(_ commands: [CodexCommand]) -> [CodexCommand] {
        commands.filter { command in
            [.received, .sending, .phoneReceived, .retryPending, .failed].contains(command.state)
        }
    }
}

enum SecretaryDeliveryStage: String, Codable, Sendable {
    case phoneReplyReceived = "phone_reply_received"
    case watchReplyPersisted = "watch_reply_persisted"
    case watchReplyAvailable = "watch_reply_available"
    case userSeen = "user_seen"
}

struct SecretaryDeliveryAcknowledgement: Equatable, Sendable {
    let commandId: String
    let replyId: String
    let deviceID: String
    let stage: SecretaryDeliveryStage
    let at: String

    init(commandId: String, replyId: String, deviceID: String, stage: SecretaryDeliveryStage, at: Date = Date()) {
        self.commandId = commandId
        self.replyId = replyId
        self.deviceID = deviceID
        self.stage = stage
        self.at = ISO8601DateFormatter().string(from: at)
    }

    var connectivityPayload: [String: Any] {
        [
            "kind": "codexDeliveryAck",
            "schemaVersion": CodexCommand.schemaVersion,
            "commandId": commandId,
            "replyId": replyId,
            "deviceId": deviceID,
            "stage": stage.rawValue,
            "at": at,
        ]
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> SecretaryDeliveryAcknowledgement? {
        guard (payload["kind"] as? String) == "codexDeliveryAck",
              (payload["schemaVersion"] as? Int) == CodexCommand.schemaVersion,
              let commandId = payload["commandId"] as? String,
              !commandId.isEmpty,
              let replyId = payload["replyId"] as? String,
              !replyId.isEmpty,
              let deviceID = payload["deviceId"] as? String,
              !deviceID.isEmpty,
              let stageRaw = payload["stage"] as? String,
              let stage = SecretaryDeliveryStage(rawValue: stageRaw),
              let at = payload["at"] as? String,
              ISO8601DateFormatter().date(from: at) != nil else { return nil }
        return SecretaryDeliveryAcknowledgement(
            commandId: commandId,
            replyId: replyId,
            deviceID: deviceID,
            stage: stage,
            at: ISO8601DateFormatter().date(from: at) ?? Date()
        )
    }
}

struct WatchConversationWindowState: Codable, Equatable, Sendable {
    let key: String
    let localDay: String?
    var lastActivityAt: Date
}

enum WatchConversationWindowPolicy {
    static let midnightGrace: TimeInterval = 30 * 60

    static func updated(
        previous: WatchConversationWindowState?,
        at now: Date,
        calendar: Calendar = tokyoCalendar
    ) -> WatchConversationWindowState {
        let currentDay = localDay(for: now, calendar: calendar)
        if let previous {
            let windowDay = previous.localDay ?? localDay(for: previous.lastActivityAt, calendar: calendar)
            let sameDay = windowDay == currentDay
            let elapsed = now.timeIntervalSince(previous.lastActivityAt)
            if sameDay || (elapsed >= 0 && elapsed <= midnightGrace) {
                return WatchConversationWindowState(key: previous.key, localDay: windowDay, lastActivityAt: now)
            }
        }
        return WatchConversationWindowState(key: "watch-\(currentDay)", localDay: currentDay, lastActivityAt: now)
    }

    static func localDay(for date: Date, calendar: Calendar = tokyoCalendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
    }

    private static var tokyoCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }
}

struct SecretaryReply: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let conversationKey: String
    let commandId: String
    let speaker: String
    let speakerName: String?
    let presentation: String?
    let text: String
    let createdAt: String
    let confirmation: SecretaryConfirmation?

    var proactiveInteractionID: String? {
        id == commandId && id.hasPrefix("interaction-") ? id : nil
    }

    /// The name to show to a person, keeping transport speaker IDs out of UI.
    /// Older replies do not carry `speakerName`, so the stable secretary IDs
    /// remain a backwards-compatible fallback.
    var resolvedSpeakerName: String {
        if let speakerName {
            let trimmed = speakerName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        switch speaker.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "yinyue": return "银月"
        case "meining": return "梅凝"
        default: return "银月"
        }
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> SecretaryReply? {
        guard let id = payload["replyId"] as? String,
              let commandId = payload["commandId"] as? String,
              let text = payload["replyText"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return SecretaryReply(
            id: id,
            conversationKey: payload["conversationKey"] as? String ?? CodexCommand.defaultConversationKey,
            commandId: commandId,
            speaker: payload["replySpeaker"] as? String ?? "yinyue",
            speakerName: payload["replySpeakerName"] as? String ?? payload["speakerName"] as? String,
            presentation: payload["replyPresentation"] as? String ?? payload["presentation"] as? String,
            text: text,
            createdAt: payload["replyCreatedAt"] as? String ?? ISO8601DateFormatter().string(from: Date()),
            confirmation: SecretaryConfirmation.fromConnectivityPayload(payload)
        )
    }
}

/// Arrival order is not conversation order: queued replies can be replayed
/// after newer replies. Keep every retained reply, but choose the home card by
/// the server timestamp, including its fractional seconds and timezone.
enum SecretaryReplyOrderingPolicy {
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func ordered(_ replies: [SecretaryReply]) -> [SecretaryReply] {
        replies.sorted { lhs, rhs in
            let left = date(lhs.createdAt) ?? .distantPast
            let right = date(rhs.createdAt) ?? .distantPast
            return left == right ? lhs.id < rhs.id : left < right
        }
    }

    static func retaining(_ incoming: SecretaryReply, in replies: [SecretaryReply], limit: Int = 40) -> [SecretaryReply] {
        if let existing = replies.first(where: { $0.id == incoming.id }),
           let previousDate = date(existing.createdAt),
           (date(incoming.createdAt) ?? .distantPast) < previousDate {
            return Array(ordered(replies).suffix(max(1, limit)))
        }
        return Array(ordered(replies.filter { $0.id != incoming.id } + [incoming]).suffix(max(1, limit)))
    }
}

enum SecretaryReplyApplicationState: Sendable {
    case active
    case background
}

enum SecretaryReplyNotificationDecision: Equatable, Sendable {
    case duplicate
    case quiet
    case tactile
    case banner(title: String, body: String, playsSound: Bool)
}

/// Pure notification policy shared by the Watch app and Swift Testing.
/// Delivery bookkeeping stays with the app because it is persisted in its
/// UserDefaults, while this type only decides the observable presentation.
enum SecretaryReplyNotificationPolicy {
    static func decide(
        reply: SecretaryReply,
        handledReplyIDs: Set<String>,
        applicationState: SecretaryReplyApplicationState
    ) -> SecretaryReplyNotificationDecision {
        guard !handledReplyIDs.contains(reply.id) else { return .duplicate }
        let ambient = reply.presentation == "ambient"
        switch applicationState {
        case .active:
            return ambient ? .quiet : .tactile
        case .background:
            return .banner(title: reply.resolvedSpeakerName, body: reply.text, playsSound: !ambient)
        }
    }
}

struct ProactiveInteractionEnvelope: Codable, Identifiable, Equatable, Sendable {
    let interactionId: String
    let roleId: String
    let roleName: String
    let kind: String
    let text: String
    let plannedAt: String
    let conversationKey: String
    let delivery: String

    var id: String { interactionId }

    var watchPayload: [String: Any] {
        [
            "kind": "proactiveInteraction",
            "commandId": interactionId,
            "replyId": interactionId,
            "conversationKey": conversationKey,
            "replySpeaker": roleId,
            "replySpeakerName": roleName,
            "replyText": text,
            "replyCreatedAt": plannedAt,
            "replyPresentation": delivery,
        ]
    }
}

struct ProactiveInteractionPullResponse: Codable, Sendable {
    let ok: Bool?
    let items: [ProactiveInteractionEnvelope]?
    let nextCheckAfterSeconds: Int?
    let error: String?
}

struct ProactiveInteractionAckResponse: Codable, Sendable {
    let ok: Bool?
    let acknowledged: [String]?
    let error: String?
}

struct SecretaryConfirmation: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let label: String
    let summary: String
    let state: SecretaryConfirmationState
    let result: String?
    let error: String?

    static func fromConnectivityPayload(_ payload: [String: Any]) -> SecretaryConfirmation? {
        guard let id = payload["confirmationId"] as? String,
              !id.isEmpty,
              let kind = payload["confirmationKind"] as? String,
              let label = payload["confirmationLabel"] as? String,
              let summary = payload["confirmationSummary"] as? String,
              let rawState = payload["confirmationState"] as? String,
              let state = SecretaryConfirmationState(rawValue: rawState) else { return nil }
        return SecretaryConfirmation(
            id: id,
            kind: kind,
            label: label,
            summary: summary,
            state: state,
            result: payload["confirmationResult"] as? String,
            error: payload["confirmationError"] as? String
        )
    }
}

struct SecretaryConfirmationDecision: Equatable, Sendable {
    let commandId: String
    let confirmationId: String
    let deviceID: String
    let decision: SecretaryActionDecision

    var connectivityPayload: [String: Any] {
        [
            "kind": "codexConfirmation",
            "schemaVersion": CodexCommand.schemaVersion,
            "commandId": commandId,
            "confirmationId": confirmationId,
            "deviceId": deviceID,
            "decision": decision.rawValue,
        ]
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> SecretaryConfirmationDecision? {
        guard (payload["kind"] as? String) == "codexConfirmation",
              (payload["schemaVersion"] as? Int) == CodexCommand.schemaVersion,
              let commandId = payload["commandId"] as? String,
              UUID(uuidString: commandId) != nil,
              let confirmationId = payload["confirmationId"] as? String,
              !confirmationId.isEmpty,
              let deviceID = payload["deviceId"] as? String,
              !deviceID.isEmpty,
              let decisionRaw = payload["decision"] as? String,
              let decision = SecretaryActionDecision(rawValue: decisionRaw) else { return nil }
        return SecretaryConfirmationDecision(
            commandId: commandId.lowercased(),
            confirmationId: confirmationId,
            deviceID: deviceID,
            decision: decision
        )
    }
}

struct CodexCommandResponse: Decodable, Sendable {
    let ok: Bool?
    let duplicate: Bool?
    let commandId: String?
    let status: String?
    let receivedAt: String?
    let conversationKey: String?
    let expectsReply: Bool?
    let reply: SecretaryReply?
    let actionApplied: Bool?
    let nativeAction: UnifiedReminderExecutionRequest?
    let error: String?
}

// A light response is deliberately not a CodexCommand or a chat message.
enum ProactiveReactionType: String, Codable, CaseIterable, Sendable {
    case pat, received, hug
    var title: String {
        switch self { case .pat: return "拍一拍"; case .received: return "收到啦"; case .hug: return "抱抱" }
    }
    var feedback: String {
        switch self { case .pat: return "已拍一拍"; case .received: return "已回应"; case .hug: return "已抱抱" }
    }
    var actionID: String { "proactive-reaction-\(rawValue)" }
    static let categoryID = "secretary-proactive-reaction"
}

struct ProactiveReaction: Codable, Equatable, Sendable {
    let interactionId: String
    let reactionId: String
    let reactionType: ProactiveReactionType
    let deviceId: String
    let deviceTime: String
    var deliveryStatus: String = "pending"

    init(interactionId: String, type: ProactiveReactionType, deviceId: String, at: Date = Date()) {
        self.interactionId = interactionId
        reactionId = "reaction-\(interactionId)"
        reactionType = type
        self.deviceId = deviceId
        deviceTime = ISO8601DateFormatter().string(from: at)
    }
    var connectivityPayload: [String: Any] {
        ["kind": "proactiveReaction", "interactionId": interactionId, "reactionId": reactionId,
         "reactionType": reactionType.rawValue, "deviceId": deviceId, "deviceTime": deviceTime]
    }
    static func fromConnectivityPayload(_ payload: [String: Any]) -> ProactiveReaction? {
        guard payload["kind"] as? String == "proactiveReaction",
              let interaction = payload["interactionId"] as? String, interaction.hasPrefix("interaction-"),
              interaction.count <= 140, payload["reactionId"] as? String == "reaction-\(interaction)",
              let raw = payload["reactionType"] as? String, let type = ProactiveReactionType(rawValue: raw),
              let device = payload["deviceId"] as? String, !device.isEmpty, device.count <= 128,
              let time = payload["deviceTime"] as? String, let date = SecretaryReplyOrderingPolicy.date(time) else { return nil }
        return ProactiveReaction(interactionId: interaction, type: type, deviceId: device, at: date)
    }
}

/// One atomic device outbox with durable tombstones. Never trim pending events;
/// the first tap wins even after restart, notification redelivery or a retry.
struct ProactiveReactionOutbox {
    let fileURL: URL
    init(namespace: String) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        fileURL = base.appendingPathComponent("ProactiveInteractions/\(namespace)-reactions.json")
    }
    init(fileURL: URL) { self.fileURL = fileURL }
    func all() throws -> [ProactiveReaction] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        return try JSONDecoder().decode([ProactiveReaction].self, from: Data(contentsOf: fileURL))
    }
    @discardableResult func enqueue(_ event: ProactiveReaction) throws -> ProactiveReaction {
        var rows = try all()
        if let prior = rows.first(where: { $0.interactionId == event.interactionId }) { return prior }
        rows.append(event)
        try save(rows)
        return event
    }
    func acknowledge(_ reactionId: String) throws {
        var rows = try all()
        guard let index = rows.firstIndex(where: { $0.reactionId == reactionId }) else { return }
        rows[index].deliveryStatus = "mac_persisted"
        try save(rows)
    }
    private func save(_ rows: [ProactiveReaction]) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(rows).write(to: fileURL, options: .atomic)
    }
}
