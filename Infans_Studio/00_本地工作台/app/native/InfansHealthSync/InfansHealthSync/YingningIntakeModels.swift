import CryptoKit
import Foundation

enum InboxIntakeSource: String, Codable, CaseIterable, Sendable {
    case iOSShareExtension = "ios_share_extension"
    case iPadOSShareExtension = "ipados_share_extension"
    case iOSQuickPhoto = "ios_quick_photo"
    case iPadOSQuickPhoto = "ipados_quick_photo"
}

enum InboxIntakeSourceSemantic: String, Codable, Sendable {
    case sharedContent = "shared_content"
    case photoShare = "photo_share"
    case quickPhotoInbox = "quick_photo_inbox"
}

enum InboxIntakeDeliveryState: String, Codable, Sendable {
    case pending
    case sending
    case failedRetryPending = "failed_retry_pending"
    case mailboxPersisted = "mailbox_persisted"
    case delivered

    var label: String {
        switch self {
        case .pending: return "等待发送"
        case .sending: return "正在送往收件箱"
        case .failedRetryPending: return "发送失败，已保留待重试"
        case .mailboxPersisted: return "信箱已收，等待 Mac 保存"
        case .delivered: return "已送达收件箱"
        }
    }
}

struct YingningIntakeAttachment: Codable, Equatable, Identifiable, Sendable {
    static let maximumCount = 4
    static let maximumBytesPerFile = 24 * 1_024 * 1_024
    static let maximumTotalBytes = 32 * 1_024 * 1_024
    static let allowedContentTypes = Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"])

    let id: String
    let role: String
    let fileName: String
    let contentType: String
    let byteCount: Int
    let pixelWidth: Int?
    let pixelHeight: Int?
    let createdAt: String
    let sha256: String

    init(id: String = UUID().uuidString.lowercased(), fileName: String, contentType: String, data: Data, pixelWidth: Int? = nil, pixelHeight: Int? = nil, createdAt: Date = Date()) {
        self.id = id.lowercased()
        role = "original"
        self.fileName = String(fileName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(240))
        self.contentType = contentType.lowercased()
        byteCount = data.count
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.createdAt = ISO8601DateFormatter().string(from: createdAt)
        sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    var isValid: Bool {
        UUID(uuidString: id) != nil && role == "original" && !fileName.isEmpty
            && Self.allowedContentTypes.contains(contentType)
            && byteCount > 0 && byteCount <= Self.maximumBytesPerFile
            && sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }
}

struct YingningIntakeAttachmentPayload: Equatable, Sendable {
    let attachment: YingningIntakeAttachment
    let data: Data

    init(fileName: String, contentType: String, data: Data, pixelWidth: Int? = nil, pixelHeight: Int? = nil) {
        attachment = YingningIntakeAttachment(fileName: fileName, contentType: contentType, data: data, pixelWidth: pixelWidth, pixelHeight: pixelHeight)
        self.data = data
    }
}

struct YingningIntakeItem: Codable, Equatable, Identifiable, Sendable {
    static let schemaVersion = 2
    let id: String
    let url: String
    let title: String
    let text: String
    var note: String
    var localNote: String?
    var relatedIntakeID: String?
    var deliveryBoundary: String?
    let source: InboxIntakeSource
    let sourceSemantic: InboxIntakeSourceSemantic
    let sourceApp: String
    let deviceID: String
    let deviceName: String
    let createdAt: String
    let attachments: [YingningIntakeAttachment]
    var state: InboxIntakeDeliveryState
    var retryCount: Int
    var lastError: String?

    enum CodingKeys: String, CodingKey {
        case id = "intakeId"
        case url, title, text, note, localNote, relatedIntakeID, deliveryBoundary, source, sourceSemantic, sourceApp, attachments
        case deviceID = "deviceId"
        case deviceName, createdAt, state, retryCount, lastError
    }

    init(id: String = UUID().uuidString.lowercased(), url: String = "", title: String = "", text: String = "", note: String = "", source: InboxIntakeSource, sourceSemantic: InboxIntakeSourceSemantic = .sharedContent, sourceApp: String = "", deviceID: String, deviceName: String, createdAt: Date = Date(), attachments: [YingningIntakeAttachment] = [], state: InboxIntakeDeliveryState = .pending, retryCount: Int = 0, lastError: String? = nil) {
        self.id = id.lowercased()
        self.url = Self.trim(url, limit: 4_096)
        self.title = Self.trim(title, limit: 300)
        self.text = Self.trim(text, limit: 8_000)
        self.note = Self.trim(note, limit: 2_000)
        self.localNote = nil
        self.relatedIntakeID = nil
        self.deliveryBoundary = state == .delivered ? "mac_persisted" : nil
        self.source = source
        self.sourceSemantic = sourceSemantic
        self.sourceApp = Self.trim(sourceApp, limit: 120)
        self.deviceID = Self.trim(deviceID.lowercased(), limit: 128)
        self.deviceName = Self.trim(deviceName, limit: 120)
        self.createdAt = ISO8601DateFormatter().string(from: createdAt)
        self.attachments = attachments
        self.state = state
        self.retryCount = retryCount
        self.lastError = lastError
    }

    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        id = try box.decode(String.self, forKey: .id)
        url = try box.decodeIfPresent(String.self, forKey: .url) ?? ""
        title = try box.decodeIfPresent(String.self, forKey: .title) ?? ""
        text = try box.decodeIfPresent(String.self, forKey: .text) ?? ""
        note = try box.decodeIfPresent(String.self, forKey: .note) ?? ""
        localNote = try box.decodeIfPresent(String.self, forKey: .localNote)
        relatedIntakeID = try box.decodeIfPresent(String.self, forKey: .relatedIntakeID)
        deliveryBoundary = try box.decodeIfPresent(String.self, forKey: .deliveryBoundary)
        source = try box.decode(InboxIntakeSource.self, forKey: .source)
        sourceSemantic = try box.decodeIfPresent(InboxIntakeSourceSemantic.self, forKey: .sourceSemantic) ?? .sharedContent
        sourceApp = try box.decodeIfPresent(String.self, forKey: .sourceApp) ?? ""
        deviceID = try box.decode(String.self, forKey: .deviceID)
        deviceName = try box.decodeIfPresent(String.self, forKey: .deviceName) ?? ""
        createdAt = try box.decode(String.self, forKey: .createdAt)
        attachments = try box.decodeIfPresent([YingningIntakeAttachment].self, forKey: .attachments) ?? []
        state = try box.decodeIfPresent(InboxIntakeDeliveryState.self, forKey: .state) ?? .pending
        // Old delivered meant either relay or Mac. Preserve its original until
        // a fresh final receipt establishes which boundary was actually crossed.
        if state == .delivered && deliveryBoundary != "mac_persisted" { state = .mailboxPersisted }
        retryCount = try box.decodeIfPresent(Int.self, forKey: .retryCount) ?? 0
        lastError = try box.decodeIfPresent(String.self, forKey: .lastError)
    }

    var isValid: Bool {
        let uuidIsValid = UUID(uuidString: id) != nil
        let deviceIDIsValid = !deviceID.isEmpty && deviceID.range(of: "^[a-z0-9._-]{1,128}$", options: .regularExpression) != nil
        let urlIsValid: Bool
        if url.isEmpty { urlIsValid = true }
        else if let parsed = URL(string: url) { urlIsValid = parsed.scheme == "http" || parsed.scheme == "https" }
        else { urlIsValid = false }
        let attachmentsAreValid = attachments.count <= YingningIntakeAttachment.maximumCount
            && attachments.allSatisfy(\.isValid)
            && attachments.reduce(0) { $0 + $1.byteCount } <= YingningIntakeAttachment.maximumTotalBytes
        return uuidIsValid && deviceIDIsValid && urlIsValid && attachmentsAreValid
            && (!url.isEmpty || !text.isEmpty || !attachments.isEmpty)
    }

    var request: YingningIntakeRequest { request(attachmentData: [:]) }

    func request(attachmentData: [String: Data]) -> YingningIntakeRequest {
        YingningIntakeRequest(
            schemaVersion: attachments.isEmpty ? 1 : Self.schemaVersion,
            intakeId: id, url: url, title: title, text: text, note: note,
            source: source.rawValue, sourceSemantic: sourceSemantic.rawValue, sourceApp: sourceApp,
            deviceId: deviceID, deviceName: deviceName, createdAt: createdAt,
            attachments: attachments.map { YingningIntakeRequestAttachment(metadata: $0, data: attachmentData[$0.id]) }
        )
    }

    private static func trim(_ value: String, limit: Int) -> String {
        String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
    }
}

struct YingningIntakeRequestAttachment: Codable, Equatable, Sendable {
    let attachmentId: String
    let role: String
    let fileName: String
    let contentType: String
    let byteCount: Int
    let pixelWidth: Int?
    let pixelHeight: Int?
    let createdAt: String
    let sha256: String
    let data: Data?

    init(metadata: YingningIntakeAttachment, data: Data?) {
        attachmentId = metadata.id
        role = metadata.role
        fileName = metadata.fileName
        contentType = metadata.contentType
        byteCount = metadata.byteCount
        pixelWidth = metadata.pixelWidth
        pixelHeight = metadata.pixelHeight
        createdAt = metadata.createdAt
        sha256 = metadata.sha256
        self.data = data
    }
}

struct YingningIntakeRequest: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let intakeId: String
    let url: String
    let title: String
    let text: String
    let note: String
    let source: String
    let sourceSemantic: String
    let sourceApp: String
    let deviceId: String
    let deviceName: String
    let createdAt: String
    let attachments: [YingningIntakeRequestAttachment]
}

struct YingningIntakeReceipt: Codable, Equatable, Sendable {
    let ok: Bool
    let duplicate: Bool
    let intakeId: String
    let canonicalItemId: String
    let status: String
    let deliveredAt: String
    let deliveryBoundary: String

    func confirmsMacPersistence(for item: YingningIntakeItem) -> Bool {
        ok && intakeId.caseInsensitiveCompare(item.id) == .orderedSame
            && !canonicalItemId.isEmpty && status == "delivered" && deliveryBoundary == "mac_persisted"
    }

    func confirmsDurablePersistence(for item: YingningIntakeItem) -> Bool {
        ok && intakeId.caseInsensitiveCompare(item.id) == .orderedSame
            && !canonicalItemId.isEmpty && status == "delivered"
            && (deliveryBoundary == "mailbox_persisted" || deliveryBoundary == "mac_persisted")
    }
}
