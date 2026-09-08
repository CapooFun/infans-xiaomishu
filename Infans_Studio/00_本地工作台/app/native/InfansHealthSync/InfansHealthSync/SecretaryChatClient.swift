import Foundation

struct SecretaryChatEndpointSet: Sendable {
    let bootstrapPath = "api/secretary-mobile/bootstrap"
    let conversationsPath = "api/secretary-mobile/conversations"
    let streamTurnPath = "api/secretary-mobile/turns/stream"
    let cancelTurnPath = "api/secretary-mobile/turns/cancel"
    let mailboxMessagesPath = "api/secretary-mobile/mailbox/messages"
    let mailboxSyncPath = "api/secretary-mobile/mailbox/sync"
    let controlledActionDecisionBasePath = "api/secretary-mobile/actions"
}

struct SecretaryChatConnection: Sendable {
    let serverURL: String
    let bearerToken: String
}

struct SecretaryChatAttachmentResource: Sendable {
    let data: Data
    let mimeType: String?
    let suggestedFilename: String?
}

struct SecretaryChatAttachmentUploadResponse: Decodable, Equatable, Sendable {
    let created: Bool
    let duplicate: Bool
    let attachment: SecretaryChatAttachment
}

struct SecretaryChatMailboxReceipt: Decodable, Equatable, Sendable {
    let accepted: Bool
    let duplicate: Bool
    let revision: Int
}

enum SecretaryChatClientError: LocalizedError {
    case invalidServerURL
    case tokenUnavailable
    case invalidResponse
    case http(status: Int, message: String)
    case streamEndedWithoutTerminalEvent

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: return "小秘书私有 HTTPS 地址不合法"
        case .tokenUnavailable: return "请先在设置中保存小秘书指令令牌"
        case .invalidResponse: return "小秘书服务返回了无法识别的聊天响应"
        case let .http(_, message): return message
        case .streamEndedWithoutTerminalEvent: return "聊天连接中断，这条消息已保留待重试"
        }
    }
}

private struct SecretaryChatServerError: Decodable {
    let error: String?
    let message: String?
}

private struct SecretaryChatCancelRequest: Encodable {
    let conversationId: String
    let generationId: String
}

struct SecretaryChatClient: Sendable {
    let endpoints: SecretaryChatEndpointSet
    let session: URLSession

    init(
        endpoints: SecretaryChatEndpointSet = SecretaryChatEndpointSet(),
        session: URLSession = .shared
    ) {
        self.endpoints = endpoints
        self.session = session
    }

    func bootstrap(connection: SecretaryChatConnection) async throws -> SecretaryChatBootstrap {
        let request = try makeRequest(path: endpoints.bootstrapPath, method: "GET", connection: connection)
        return try await decodeResponse(request, as: SecretaryChatBootstrap.self)
    }

    func conversation(id: String, connection: SecretaryChatConnection) async throws -> SecretaryChatConversation {
        let path = conversationPath(id)
        let request = try makeRequest(path: path, method: "GET", connection: connection)
        return try await decodeResponse(request, as: SecretaryChatConversation.self)
    }

    func conversations(connection: SecretaryChatConnection) async throws -> SecretaryChatConversationListResponse {
        let request = try makeRequest(path: endpoints.conversationsPath, method: "GET", connection: connection)
        return try await decodeResponse(request, as: SecretaryChatConversationListResponse.self)
    }

    func createConversation(
        _ payload: SecretaryChatCreateConversationRequest,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatConversation {
        var request = try makeRequest(path: endpoints.conversationsPath, method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(payload)
        return try await decodeResponse(request, as: SecretaryChatCreateConversationResponse.self).conversation
    }

    func updateConversation(
        id: String,
        payload: SecretaryChatUpdateConversationRequest,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatConversation {
        var request = try makeRequest(path: conversationPath(id), method: "PATCH", connection: connection)
        request.httpBody = try JSONEncoder().encode(payload)
        return try await decodeResponse(request, as: SecretaryChatUpdateConversationResponse.self).conversation
    }

    func deleteConversation(
        id: String,
        payload: SecretaryChatDeleteConversationRequest,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatDeleteConversationResponse {
        var request = try makeRequest(path: conversationPath(id), method: "DELETE", connection: connection)
        request.httpBody = try JSONEncoder().encode(payload)
        return try await decodeResponse(request, as: SecretaryChatDeleteConversationResponse.self)
    }

    func attachmentResource(
        path: String,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatAttachmentResource {
        let request = try makeRequest(path: path, method: "GET", connection: connection)
        let (data, response) = try await session.data(for: request)
        try await validate(response: response, errorData: data)
        return SecretaryChatAttachmentResource(
            data: data,
            mimeType: (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type"),
            suggestedFilename: response.suggestedFilename
        )
    }

    func voiceCorrections(connection: SecretaryChatConnection) async throws -> SecretaryVoiceCorrectionListResponse {
        let request = try makeRequest(
            path: "api/secretary-mobile/voice-corrections",
            method: "GET",
            connection: connection
        )
        return try await decodeResponse(request, as: SecretaryVoiceCorrectionListResponse.self)
    }

    func correctVoiceTranscript(
        _ payload: SecretaryVoiceCorrectionRequest,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryVoiceCorrectionResponse {
        var request = try makeRequest(
            path: "api/secretary-mobile/voice-corrections",
            method: "POST",
            connection: connection
        )
        request.httpBody = try JSONEncoder().encode(payload)
        return try await decodeResponse(request, as: SecretaryVoiceCorrectionResponse.self)
    }

    func revertVoiceCorrection(
        id: String,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryVoiceCorrectionResponse {
        var request = try makeRequest(
            path: "api/secretary-mobile/voice-corrections/\(id)/revert",
            method: "POST",
            connection: connection
        )
        request.httpBody = Data("{}".utf8)
        return try await decodeResponse(request, as: SecretaryVoiceCorrectionResponse.self)
    }

    func uploadAttachment(
        _ draft: SecretaryAttachmentDraft,
        fileURL: URL,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatAttachmentUploadResponse {
        guard draft.isValid else { throw SecretaryAttachmentDraftError.invalidDraft }
        var request = try makeRequest(
            path: "api/secretary-mobile/attachments",
            method: "POST",
            connection: connection
        )
        request.timeoutInterval = 90
        request.setValue(draft.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(draft.id, forHTTPHeaderField: "X-Infans-Attachment-Id")
        request.setValue(Self.encodedURIComponent(draft.name), forHTTPHeaderField: "X-Infans-Filename")
        if let durationMs = draft.durationMs {
            request.setValue(String(durationMs), forHTTPHeaderField: "X-Infans-Duration-Ms")
        }
        request.httpBody = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        guard request.httpBody?.count == draft.sizeBytes else {
            throw SecretaryAttachmentDraftError.fileUnreadable
        }
        let (data, response) = try await session.data(for: request)
        try await validate(response: response, errorData: data)
        let decoded = try JSONDecoder().decode(SecretaryChatAttachmentUploadResponse.self, from: data)
        guard decoded.attachment.id == draft.id,
              decoded.attachment.mimeType == draft.mimeType else {
            throw SecretaryChatClientError.invalidResponse
        }
        return decoded
    }

    func controlledActions(
        conversationId: String,
        connection: SecretaryChatConnection
    ) async throws -> [SecretaryChatControlledAction] {
        let request = try makeRequest(
            path: conversationPath(conversationId) + "/actions",
            method: "GET",
            connection: connection
        )
        return try await decodeResponse(request, as: SecretaryChatActionListResponse.self).actions
    }

    func decideControlledAction(
        actionId: String,
        request payload: SecretaryChatActionDecisionRequest,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatActionDecisionResponse {
        var request = try makeRequest(
            path: endpoints.controlledActionDecisionBasePath + "/\(actionId)/decision",
            method: "POST",
            connection: connection
        )
        request.httpBody = try JSONEncoder().encode(payload)
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse,
           http.statusCode == 409,
           let stale = try? JSONDecoder().decode(SecretaryChatActionDecisionResponse.self, from: data),
           stale.stale {
            return stale
        }
        try await validate(response: response, errorData: data)
        return try JSONDecoder().decode(SecretaryChatActionDecisionResponse.self, from: data)
    }

    func streamTurn(
        _ turn: PendingSecretaryChatTurn,
        connection: SecretaryChatConnection,
        onEvent: @escaping @MainActor (SecretaryChatStreamEvent) -> Void
    ) async throws -> SecretaryChatStreamEvent {
        var request = try makeRequest(path: endpoints.streamTurnPath, method: "POST", connection: connection)
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(turn.request)
        let (bytes, response) = try await session.bytes(for: request)
        try await validate(response: response, errorData: nil)

        var lastEvent: SecretaryChatStreamEvent?
        for try await line in bytes.lines {
            guard let event = try SecretaryChatNDJSON.decodeLine(line) else { continue }
            lastEvent = event
            await onEvent(event)
        }
        guard let lastEvent,
              SecretaryChatNDJSON.isTerminal(lastEvent) else {
            throw SecretaryChatClientError.streamEndedWithoutTerminalEvent
        }
        return lastEvent
    }

    func persistToMailbox(
        _ turn: PendingSecretaryChatTurn,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatMailboxReceipt {
        var request = try makeRequest(path: endpoints.mailboxMessagesPath, method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(turn.mailboxRequest)
        let receipt = try await decodeResponse(request, as: SecretaryChatMailboxReceipt.self)
        guard receipt.accepted else { throw SecretaryChatClientError.invalidResponse }
        return receipt
    }

    func syncMailbox(
        conversationId: String,
        afterRevision: Int,
        connection: SecretaryChatConnection
    ) async throws -> SecretaryChatMailboxSyncResponse {
        var request = try makeRequest(path: endpoints.mailboxSyncPath, method: "GET", connection: connection)
        guard let url = request.url,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw SecretaryChatClientError.invalidServerURL
        }
        components.queryItems = [
            URLQueryItem(name: "conversationId", value: conversationId),
            URLQueryItem(name: "afterRevision", value: String(max(0, afterRevision))),
        ]
        guard let resolved = components.url else { throw SecretaryChatClientError.invalidServerURL }
        request.url = resolved
        return try await decodeResponse(request, as: SecretaryChatMailboxSyncResponse.self)
    }

    func cancel(conversationId: String, generationId: String, connection: SecretaryChatConnection) async throws {
        var request = try makeRequest(path: endpoints.cancelTurnPath, method: "POST", connection: connection)
        request.httpBody = try JSONEncoder().encode(SecretaryChatCancelRequest(
            conversationId: conversationId,
            generationId: generationId
        ))
        let (_, response) = try await session.data(for: request)
        try await validate(response: response, errorData: nil)
    }

    func makeRequest(path: String, method: String, connection: SecretaryChatConnection) throws -> URLRequest {
        let raw = connection.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !connection.bearerToken.isEmpty else { throw SecretaryChatClientError.tokenUnavailable }
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw SecretaryChatClientError.invalidServerURL
        }
        let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard let resourceURL = URL(string: normalizedPath, relativeTo: base.appendingPathComponent("/"))?.absoluteURL,
              resourceURL.scheme == base.scheme,
              resourceURL.host == base.host,
              resourceURL.port == base.port else {
            throw SecretaryChatClientError.invalidServerURL
        }
        var request = URLRequest(url: resourceURL)
        request.httpMethod = method
        request.timeoutInterval = method == "GET" ? 20 : 180
        request.setValue("Bearer \(connection.bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func decodeResponse<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try await validate(response: response, errorData: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func validate(response: URLResponse, errorData: Data?) async throws {
        guard let http = response as? HTTPURLResponse else { throw SecretaryChatClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let server = errorData.flatMap { try? JSONDecoder().decode(SecretaryChatServerError.self, from: $0) }
            let fallback = http.statusCode == 401 || http.statusCode == 403
                ? "小秘书指令令牌已失效，请重新配对"
                : "小秘书聊天服务暂时不可用"
            throw SecretaryChatClientError.http(
                status: http.statusCode,
                message: server?.error ?? server?.message ?? fallback
            )
        }
    }

    private func conversationPath(_ id: String) -> String {
        endpoints.conversationsPath + "/" + id
    }

    private static func encodedURIComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "attachment"
    }
}
