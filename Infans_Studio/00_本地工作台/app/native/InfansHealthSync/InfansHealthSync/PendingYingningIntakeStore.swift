import CryptoKit
import Foundation

actor PendingYingningIntakeStore {
    static let appGroupIdentifier = "group.com.example.infans.secretary"
    private let directoryURL: URL
    private let now: @Sendable () -> Date

    init(directoryURL: URL? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
        if let directoryURL { self.directoryURL = directoryURL }
        else if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier) {
            self.directoryURL = container.appendingPathComponent("InboxIntakeQueue", isDirectory: true)
        } else {
            self.directoryURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                .appendingPathComponent("InfansHealthSync", isDirectory: true)
                .appendingPathComponent("InboxIntakeQueue", isDirectory: true)
        }
    }

    func enqueue(_ item: YingningIntakeItem, attachmentPayloads: [YingningIntakeAttachmentPayload] = []) throws -> Bool {
        guard item.isValid, attachmentPayloads.map(\.attachment) == item.attachments,
              attachmentPayloads.allSatisfy({ $0.attachment.byteCount == $0.data.count }) else {
            throw YingningIntakeError.invalidContent
        }
        try prepareDirectory()
        let destination = fileURL(for: item.id)
        guard !FileManager.default.fileExists(atPath: destination.path) else { return false }
        if !attachmentPayloads.isEmpty {
            let folder = attachmentDirectoryURL(for: item.id)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            do {
                for payload in attachmentPayloads {
                    let file = attachmentFileURL(intakeID: item.id, attachmentID: payload.attachment.id)
                    try payload.data.write(to: file, options: .atomic)
                    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
#if os(iOS)
                    try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
#endif
                }
            } catch {
                try? FileManager.default.removeItem(at: folder)
                throw error
            }
        }
        do { try save(item) } catch {
            try? FileManager.default.removeItem(at: attachmentDirectoryURL(for: item.id))
            throw error
        }
        pruneDelivered()
        return true
    }

    func pending() -> [YingningIntakeItem] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return [] }
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? Data(contentsOf: $0) }
            .compactMap { try? JSONDecoder().decode(YingningIntakeItem.self, from: $0) }
            .filter { $0.state != .delivered }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func recent(limit: Int = 100) -> [YingningIntakeItem] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return [] }
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? Data(contentsOf: $0) }
            .compactMap { try? JSONDecoder().decode(YingningIntakeItem.self, from: $0) }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(max(0, limit))
            .map { $0 }
    }

    func item(id: String) -> YingningIntakeItem? {
        guard let data = try? Data(contentsOf: fileURL(for: id)) else { return nil }
        return try? JSONDecoder().decode(YingningIntakeItem.self, from: data)
    }

    func attachmentData(for item: YingningIntakeItem) throws -> [String: Data] {
        try Dictionary(uniqueKeysWithValues: item.attachments.map { attachment in
            let data = try Data(contentsOf: attachmentFileURL(intakeID: item.id, attachmentID: attachment.id))
            let sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard data.count == attachment.byteCount, sha256 == attachment.sha256 else { throw YingningIntakeError.attachmentUnavailable }
            return (attachment.id, data)
        })
    }

    func mark(_ id: String, state: InboxIntakeDeliveryState, error: String? = nil) throws {
        guard var row = item(id: id) else { return }
        row.state = state
        if state == .delivered { row.deliveryBoundary = "mac_persisted" }
        if state == .mailboxPersisted { row.deliveryBoundary = "mailbox_persisted" }
        row.lastError = error
        if state == .failedRetryPending { row.retryCount += 1 }
        try save(row)
    }

    func recordReceipt(_ receipt: YingningIntakeReceipt, for id: String) throws {
        guard let row = item(id: id), receipt.confirmsDurablePersistence(for: row) else {
            throw YingningIntakeError.incompleteMacReceipt
        }
        try mark(id, state: receipt.confirmsMacPersistence(for: row) ? .delivered : .mailboxPersisted)
    }

    func updateNote(_ id: String, note: String) throws {
        guard var row = item(id: id) else { return }
        // Receipt reconciliation resends the frozen original payload. Local
        // review notes must not silently mutate an already accepted intake ID.
        row.localNote = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2_000))
        try save(row)
    }

    /// Freeze the original request and send an independently retryable correction.
    /// Enqueue first, so a local note never claims success without a durable copy.
    func reviseNote(_ id: String, note: String, expectedNote: String) throws -> YingningIntakeItem? {
        guard let row = item(id: id) else { throw YingningIntakeError.invalidContent }
        let current = row.localNote ?? row.note
        guard current == expectedNote else { throw YingningIntakeError.server("备注已更新，请刷新后再编辑") }
        let clean = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2_000))
        guard clean != current else { return nil }
        var followup = YingningIntakeItem(
            title: "分享备注更新",
            text: "关联分享来件 \(row.id)\n最新备注：\(clean.isEmpty ? "（已清空）" : clean)",
            note: clean,
            source: row.source == .iPadOSQuickPhoto || row.source == .iPadOSShareExtension ? .iPadOSShareExtension : .iOSShareExtension,
            sourceSemantic: .sharedContent,
            sourceApp: "小秘书",
            deviceID: row.deviceID,
            deviceName: row.deviceName,
            createdAt: now()
        )
        followup.relatedIntakeID = row.id
        _ = try enqueue(followup)
        try updateNote(id, note: clean)
        return followup
    }

    func remove(_ id: String) throws {
        let destination = fileURL(for: id)
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        let folder = attachmentDirectoryURL(for: id)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

#if DEBUG
    func removeQuickPhotoFixtures() {
        for item in recent(limit: 10_000)
        where item.attachments.contains(where: { $0.fileName == "quick-photo-fixture.png" }) {
            try? remove(item.id)
        }
    }
#endif

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directoryURL.path)
    }
    private func safeID(_ id: String) -> String { id.lowercased().filter { $0.isHexDigit || $0 == "-" } }
    private func fileURL(for id: String) -> URL { directoryURL.appendingPathComponent("\(safeID(id)).json") }
    private func attachmentDirectoryURL(for id: String) -> URL {
        directoryURL.appendingPathComponent("attachments", isDirectory: true).appendingPathComponent(safeID(id), isDirectory: true)
    }
    private func attachmentFileURL(intakeID: String, attachmentID: String) -> URL {
        attachmentDirectoryURL(for: intakeID).appendingPathComponent(safeID(attachmentID))
    }

    private func save(_ item: YingningIntakeItem) throws {
        try prepareDirectory()
        let destination = fileURL(for: item.id)
        try JSONEncoder().encode(item).write(to: destination, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
#if os(iOS)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
#endif
    }

    private func pruneDelivered(maxCount: Int = 100, olderThanDays: Int = 30) {
        let formatter = ISO8601DateFormatter()
        let cutoff = now().addingTimeInterval(-Double(olderThanDays) * 86_400)
        let delivered = recent(limit: 10_000).filter { $0.state == .delivered }
        for (index, item) in delivered.enumerated() {
            let isOld = formatter.date(from: item.createdAt).map { $0 < cutoff } ?? true
            if index >= maxCount || isOld { try? remove(item.id) }
        }
    }
}

enum YingningIntakeError: LocalizedError, Equatable {
    case invalidContent
    case invalidServerURL
    case tokenUnavailable
    case attachmentUnavailable
    case incompleteMacReceipt
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidContent: return "来件需要包含网址、文字或受支持的原图"
        case .invalidServerURL: return "Mac 私有 HTTPS 地址不合法"
        case .tokenUnavailable: return "请先在银月 App 中保存独立设备令牌"
        case .attachmentUnavailable: return "原图文件不完整，来件仍保留待重试"
        case .incompleteMacReceipt: return "私有收件箱回执不完整，来件仍保留待重试"
        case let .server(message): return message
        }
    }
}
