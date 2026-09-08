import Foundation

private struct YingningIntakeErrorResponse: Decodable {
    let error: String?
}

struct YingningIntakeClient: Sendable {
    func send(
        _ item: YingningIntakeItem,
        serverURL: String,
        token: String,
        attachmentData: [String: Data] = [:]
    ) async throws -> YingningIntakeReceipt {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw YingningIntakeError.invalidServerURL
        }
        guard item.isValid else { throw YingningIntakeError.invalidContent }

        var request = URLRequest(url: base.appendingPathComponent("api/secretary-mobile/mailbox/intakes"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        request.httpBody = try JSONEncoder().encode(item.request(attachmentData: attachmentData))

        let (data, response) = try await URLSession.shared.data(for: request)
        let receipt = try? JSONDecoder().decode(YingningIntakeReceipt.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let serverError = try? JSONDecoder().decode(YingningIntakeErrorResponse.self, from: data)
            throw YingningIntakeError.server(serverError?.error ?? "Mac 收件箱暂时不可用")
        }
        guard let receipt, receipt.confirmsDurablePersistence(for: item) else {
            throw YingningIntakeError.incompleteMacReceipt
        }
        return receipt
    }
}

actor InboxIntakeDeliveryService {
    private let store: PendingYingningIntakeStore
    private let client: YingningIntakeClient

    init(store: PendingYingningIntakeStore = PendingYingningIntakeStore(), client: YingningIntakeClient = YingningIntakeClient()) {
        self.store = store
        self.client = client
    }

    func enqueue(_ item: YingningIntakeItem, attachmentPayloads: [YingningIntakeAttachmentPayload] = []) async throws -> Bool {
        try await store.enqueue(item, attachmentPayloads: attachmentPayloads)
    }

    func pending() async -> [YingningIntakeItem] {
        await store.pending()
    }

    func recent(limit: Int = 100) async -> [YingningIntakeItem] {
        await store.recent(limit: limit)
    }

    func attachmentData(for item: YingningIntakeItem) async throws -> [String: Data] {
        try await store.attachmentData(for: item)
    }

    func updateNote(id: String, note: String) async throws {
        try await store.updateNote(id, note: note)
    }

    func reviseNote(id: String, note: String, expectedNote: String) async throws -> YingningIntakeItem? {
        try await store.reviseNote(id, note: note, expectedNote: expectedNote)
    }

#if DEBUG
    func removeQuickPhotoFixtures() async {
        await store.removeQuickPhotoFixtures()
    }
#endif

    func deliver(id: String, serverURL: String, token: String?) async throws -> YingningIntakeReceipt {
        guard let token, !token.isEmpty else { throw YingningIntakeError.tokenUnavailable }
        guard let item = await store.item(id: id) else { throw YingningIntakeError.invalidContent }
        try await store.mark(id, state: .sending)
        do {
            let attachmentData = try await store.attachmentData(for: item)
            let receipt = try await client.send(item, serverURL: serverURL, token: token, attachmentData: attachmentData)
            try await store.recordReceipt(receipt, for: id)
            return receipt
        } catch {
            let retainedByMailbox = item.state == .mailboxPersisted || item.deliveryBoundary == "mailbox_persisted"
            try? await store.mark(id, state: retainedByMailbox ? .mailboxPersisted : .failedRetryPending, error: error.localizedDescription)
            throw error
        }
    }

    func flush(serverURL: String, token: String?) async -> (delivered: Int, remaining: Int, lastError: String?, awaitingMac: Int, failed: Int) {
        let rows = await store.pending()
        var delivered = 0
        var lastError: String?
        for row in rows {
            do {
                let receipt = try await deliver(id: row.id, serverURL: serverURL, token: token)
                if receipt.confirmsMacPersistence(for: row) { delivered += 1 }
            } catch {
                lastError = error.localizedDescription
            }
        }
        let remaining = await store.pending()
        let awaitingMac = remaining.filter { $0.state == .mailboxPersisted || $0.deliveryBoundary == "mailbox_persisted" }.count
        let failed = remaining.filter { $0.state == .failedRetryPending && $0.deliveryBoundary != "mailbox_persisted" }.count
        return (delivered, remaining.count, lastError, awaitingMac, failed)
    }
}
