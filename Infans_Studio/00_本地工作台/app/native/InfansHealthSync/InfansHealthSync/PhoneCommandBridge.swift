import AVFoundation
import Foundation
import UIKit

@MainActor
private final class SecretaryDeliveryBackgroundLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

private struct MacRawVoiceTranscriptionProvider: RawVoiceTranscriptionProviding {
    private let client = SecretaryVoiceTranscriptionClient()

    var availability: RawVoiceProviderAvailability {
        guard let token = CodexCommandTokenKeychain.read(), !token.isEmpty else {
            return RawVoiceProviderAvailability(
                state: .disabled,
                reason: "请先在 iPhone 设置里配对小秘书设备令牌；原声仍会保留"
            )
        }
        let rawServerURL = SecretarySharedConfiguration.serverURL()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let serverURL = URL(string: rawServerURL),
              serverURL.scheme == "https" || serverURL.host == "127.0.0.1" else {
            return RawVoiceProviderAvailability(
                state: .unavailable,
                reason: "Mac 私有地址不合法；原声仍会保留"
            )
        }
        return RawVoiceProviderAvailability(state: .available, reason: nil)
    }

    func transcribe(fileURL: URL, recording: RawVoiceRecording) async throws -> String {
        let providerAvailability = availability
        guard providerAvailability.state == .available else {
            throw RawVoiceTranscriptionError.providerUnavailable(
                providerAvailability.reason ?? "Mac 本地转写暂时不可用，原声仍会保留"
            )
        }
        guard let token = CodexCommandTokenKeychain.read(), !token.isEmpty else {
            throw RawVoiceTranscriptionError.providerUnavailable("小秘书设备令牌不可用，原声仍会保留")
        }
        let durationMs = try Self.audioDurationMs(fileURL)
        let createdAt = ISO8601DateFormatter().date(from: recording.createdAt) ?? Date()
        let requestRecording = SecretaryVoiceRecording(
            recordingId: recording.recordingId,
            createdAt: createdAt,
            durationMs: durationMs
        )
        let result = try await client.transcribe(
            fileURL: fileURL,
            recording: requestRecording,
            properNouns: ["银月"],
            connection: SecretaryChatConnection(
                serverURL: SecretarySharedConfiguration.serverURL(),
                bearerToken: token
            )
        )
        return result.transcript.text
    }

    private static func audioDurationMs(_ fileURL: URL) throws -> Int {
        let file = try AVAudioFile(forReading: fileURL)
        let sampleRate = file.processingFormat.sampleRate
        guard sampleRate.isFinite, sampleRate > 0, file.length > 0 else {
            throw RawVoiceTranscriptionError.providerUnavailable("手表原声时长无法核对，原声仍会保留")
        }
        return min(
            SecretaryVoiceRecording.maximumDurationMs,
            max(1, Int((Double(file.length) / sampleRate * 1_000).rounded()))
        )
    }
}

private struct DeviceFirstRawVoiceTranscriptionProvider: RawVoiceTranscriptionProviding {
    private let onDevice = SecretaryOnDeviceVoiceTranscriber()
    private let macFallback = MacRawVoiceTranscriptionProvider()

    // Availability of the new Speech framework is runtime-probed inside the actor.
    // Keep the durable pipeline moving so an unsupported device can fall through
    // to the private Mac provider instead of being stranded before transcription.
    var availability: RawVoiceProviderAvailability {
        RawVoiceProviderAvailability(state: .available, reason: nil)
    }

    func transcribe(fileURL: URL, recording: RawVoiceRecording) async throws -> String {
        do {
            return try await onDevice.transcribe(
                fileURL: fileURL,
                contextualStrings: ["银月"]
            ).text
        } catch {
            return try await macFallback.transcribe(fileURL: fileURL, recording: recording)
        }
    }
}

private struct ProactiveInteractionDeviceRequest: Encodable {
    let deviceId: String
}

private struct ProactiveInteractionAckRequest: Encodable {
    let deviceId: String
    let interactionIds: [String]
    let stage: String
}

private struct CodexReplyQueryRequest: Encodable {
    let schemaVersion: Int
    let commandId: String
    let deviceId: String
}

private struct CodexDeliveryAckRequest: Encodable {
    let schemaVersion: Int
    let commandId: String
    let deviceId: String
    let stage: String
    let at: String
}

private struct CodexNativeActionResultRequest: Encodable {
    let schemaVersion: Int
    let commandId: String
    let confirmationId: String
    let deviceId: String
    let success: Bool
    let result: UnifiedReminderExecutionResult?
    let error: String?
}

struct CodexCommandClient: Sendable {
    private func baseURL(_ serverURL: String) throws -> URL {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw HealthSyncError.invalidServerURL
        }
        return base
    }

    func send(_ command: CodexCommand, serverURL: String, token: String) async throws -> CodexCommandResponse {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw HealthSyncError.invalidServerURL
        }
        let url = base.appendingPathComponent("api/codex-command/inbox")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        var body = [
            "schemaVersion": String(CodexCommand.schemaVersion),
            "commandId": command.id,
            "text": command.text,
            "createdAt": command.createdAt,
            "source": command.source.rawValue,
            "deviceId": command.deviceID,
            "route": command.route.rawValue,
            "conversationKey": command.conversationKey,
        ]
        if let phoneReceivedAt = command.phoneReceivedAt { body["phoneReceivedAt"] = phoneReceivedAt }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = try? JSONDecoder().decode(CodexCommandResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 指令收件箱暂时不可用")
        }
        guard decoded?.ok == true, decoded?.commandId == command.id else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 回执不完整")
        }
        return decoded!
    }

    func reply(for command: CodexCommand, serverURL: String, token: String) async throws -> CodexCommandResponse {
        let url = try baseURL(serverURL).appendingPathComponent("api/codex-command/reply")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        request.httpBody = try JSONEncoder().encode(CodexReplyQueryRequest(
            schemaVersion: CodexCommand.schemaVersion,
            commandId: command.id,
            deviceId: command.deviceID
        ))
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = try? JSONDecoder().decode(CodexCommandResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              decoded?.ok == true, decoded?.commandId == command.id else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 回复状态暂时不可用")
        }
        return decoded!
    }

    func acknowledgeDelivery(
        _ acknowledgement: SecretaryDeliveryAcknowledgement,
        serverURL: String,
        token: String
    ) async throws {
        let url = try baseURL(serverURL).appendingPathComponent("api/codex-command/delivery-ack")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        request.httpBody = try JSONEncoder().encode(CodexDeliveryAckRequest(
            schemaVersion: CodexCommand.schemaVersion,
            commandId: acknowledgement.commandId,
            deviceId: acknowledgement.deviceID,
            stage: acknowledgement.stage.rawValue,
            at: acknowledgement.at
        ))
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = try? JSONDecoder().decode(CodexCommandResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), decoded?.ok == true else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 没有确认逐跳状态")
        }
    }

    func confirm(
        _ confirmation: SecretaryConfirmationDecision,
        serverURL: String,
        token: String
    ) async throws -> CodexCommandResponse {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw HealthSyncError.invalidServerURL
        }
        let url = base.appendingPathComponent("api/codex-command/confirm")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 150
        request.httpBody = try JSONEncoder().encode([
            "schemaVersion": String(CodexCommand.schemaVersion),
            "commandId": confirmation.commandId,
            "confirmationId": confirmation.confirmationId,
            "deviceId": confirmation.deviceID,
            "decision": confirmation.decision.rawValue,
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try? decoder.decode(CodexCommandResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 暂时无法处理这次确认")
        }
        guard decoded?.ok == true,
              decoded?.commandId == confirmation.commandId,
              decoded?.reply != nil else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 确认回执不完整")
        }
        return decoded!
    }

    func completeNativeAction(
        commandId: String,
        confirmationId: String,
        deviceID: String,
        result: UnifiedReminderExecutionResult?,
        error: String?,
        serverURL: String,
        token: String
    ) async throws -> CodexCommandResponse {
        let url = try baseURL(serverURL).appendingPathComponent("api/codex-command/native-action-result")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        request.httpBody = try encoder.encode(CodexNativeActionResultRequest(
            schemaVersion: CodexCommand.schemaVersion,
            commandId: commandId,
            confirmationId: confirmationId,
            deviceId: deviceID,
            success: result != nil,
            result: result,
            error: error
        ))
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try? decoder.decode(CodexCommandResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              decoded?.ok == true, decoded?.commandId == commandId else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 没有确认 iPhone 本机执行结果")
        }
        return decoded!
    }

    func sendLightReaction(_ event: ProactiveReaction, serverURL: String, token: String) async throws {
        let url = try baseURL(serverURL).appendingPathComponent("api/proactive-interactions/reaction")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(event)
        let (data, response) = try await URLSession.shared.data(for: request)
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let reaction = body?["reaction"] as? [String: Any]
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              body?["ok"] as? Bool == true, body?["deliveryBoundary"] as? String == "mac_persisted",
              reaction?["reactionId"] as? String == event.reactionId else { throw URLError(.badServerResponse) }
    }

    func pullProactive(serverURL: String, token: String, deviceID: String) async throws -> [ProactiveInteractionEnvelope] {
        let url = try baseURL(serverURL).appendingPathComponent("api/proactive-interactions/pull")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        request.httpBody = try JSONEncoder().encode(ProactiveInteractionDeviceRequest(deviceId: deviceID))
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = try? JSONDecoder().decode(ProactiveInteractionPullResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), decoded?.ok == true else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 主动陪伴队列暂时不可用")
        }
        return decoded?.items ?? []
    }

    func acknowledgeProactive(
        _ interactionIDs: [String],
        serverURL: String,
        token: String,
        deviceID: String,
        stage: String = "delivered_to_phone"
    ) async throws {
        guard !interactionIDs.isEmpty else { return }
        let url = try baseURL(serverURL).appendingPathComponent("api/proactive-interactions/ack")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        request.httpBody = try JSONEncoder().encode(ProactiveInteractionAckRequest(
            deviceId: deviceID,
            interactionIds: interactionIDs,
            stage: stage
        ))
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = try? JSONDecoder().decode(ProactiveInteractionAckResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), decoded?.ok == true else {
            throw HealthSyncError.server(decoded?.error ?? "Mac 没有确认主动陪伴投递")
        }
    }
}


@MainActor
final class PhoneCommandBridge: NSObject, ObservableObject {
    static let shared = PhoneCommandBridge()

    @Published private(set) var pendingCount = 0
    @Published private(set) var statusText = "已连接本机"
    @Published private(set) var lastError: String?

    private var started = false

    func start() {
        guard !started else { return }
        started = true
        lastError = nil
    }

    func prepareBackgroundCredential() {
        do { try CodexCommandTokenKeychain.migrateLegacyItemIfNeeded() }
        catch { lastError = error.localizedDescription }
    }
}
