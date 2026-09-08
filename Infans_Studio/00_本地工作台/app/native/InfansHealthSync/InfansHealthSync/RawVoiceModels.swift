import Foundation

enum RawVoiceRecordingState: String, Codable, CaseIterable, Sendable {
    case recording
    case queuedToPhone = "queued_to_phone"
    case phonePersisted = "phone_persisted"
    case providerUnavailable = "provider_unavailable"
    case transcribing
    case transcriptReady = "transcript_ready"
    case watchTranscriptPersisted = "watch_transcript_persisted"
    case cancelled
    case failed

    var rank: Int {
        switch self {
        case .recording: 0
        case .queuedToPhone: 1
        case .phonePersisted: 2
        case .providerUnavailable: 3
        case .transcribing: 4
        case .transcriptReady: 5
        case .watchTranscriptPersisted: 6
        case .cancelled: 7
        case .failed: 0
        }
    }

    var displayText: String {
        switch self {
        case .recording: "正在录原声"
        case .queuedToPhone: "原声已排队，等待 iPhone 存好"
        case .phonePersisted: "iPhone 已存好原声"
        case .providerUnavailable: "转写模型尚未接入，原声已保留"
        case .transcribing: "iPhone 正在转成文字"
        case .transcriptReady: "逐字稿已回到手表"
        case .watchTranscriptPersisted: "手表已存好逐字稿"
        case .cancelled: "这段原声已删除"
        case .failed: "原声链路待重试"
        }
    }
}

struct RawVoiceRecording: Codable, Identifiable, Equatable, Sendable {
    static let schemaVersion = 1
    static let kind = "rawVoiceRecording"

    let recordingId: String
    let createdAt: String
    let deviceID: String
    let fileName: String
    let mimeType: String
    var state: RawVoiceRecordingState
    var transcript: String?
    var lastError: String?
    // Watch-local handoff state; optional for existing recordings and phone compatibility.
    var selectedRoute: SecretaryCommandRoute?
    var selectedConversationKey: String?
    var preparedCommand: CodexCommand?
    var commandEnqueued: Bool?

    var id: String { recordingId }

    init(
        recordingId: String = UUID().uuidString.lowercased(),
        createdAt: Date = Date(),
        deviceID: String,
        fileName: String? = nil,
        mimeType: String = "audio/mp4",
        state: RawVoiceRecordingState = .recording,
        transcript: String? = nil,
        lastError: String? = nil
    ) {
        let normalizedID = recordingId.lowercased()
        self.recordingId = normalizedID
        self.createdAt = ISO8601DateFormatter().string(from: createdAt)
        self.deviceID = deviceID
        self.fileName = fileName ?? "\(normalizedID).m4a"
        self.mimeType = mimeType
        self.state = state
        self.transcript = transcript
        self.lastError = lastError
    }

    var isValid: Bool {
        UUID(uuidString: recordingId) != nil
            && !deviceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && fileName == "\(recordingId).m4a"
            && mimeType == "audio/mp4"
    }

    var needsDestination: Bool {
        selectedRoute == nil && preparedCommand == nil
            && ![.recording, .cancelled].contains(state)
    }

    var needsRecoveryAttention: Bool {
        needsDestination || (commandEnqueued != true && [.failed, .providerUnavailable].contains(state))
    }

    var fileTransferMetadata: [String: Any] {
        [
            "kind": Self.kind,
            "schemaVersion": Self.schemaVersion,
            "recordingId": recordingId,
            "createdAt": createdAt,
            "deviceId": deviceID,
            "fileName": fileName,
            "mimeType": mimeType,
        ]
    }

    static func fromFileTransferMetadata(_ metadata: [String: Any]?) -> RawVoiceRecording? {
        guard let metadata,
              metadata["kind"] as? String == kind,
              metadata["schemaVersion"] as? Int == schemaVersion,
              let recordingID = metadata["recordingId"] as? String,
              UUID(uuidString: recordingID) != nil,
              let createdAt = metadata["createdAt"] as? String,
              ISO8601DateFormatter().date(from: createdAt) != nil,
              let deviceID = metadata["deviceId"] as? String,
              let fileName = metadata["fileName"] as? String,
              let mimeType = metadata["mimeType"] as? String else { return nil }
        let recording = RawVoiceRecording(
            recordingId: recordingID,
            createdAt: ISO8601DateFormatter().date(from: createdAt)!,
            deviceID: deviceID,
            fileName: fileName,
            mimeType: mimeType,
            state: .queuedToPhone
        )
        return recording.isValid ? recording : nil
    }
}

struct RawVoiceStatusMessage: Equatable, Sendable {
    static let kind = "rawVoiceStatus"

    let recordingID: String
    let state: RawVoiceRecordingState
    let transcript: String?
    let error: String?

    var connectivityPayload: [String: Any] {
        var payload: [String: Any] = [
            "kind": Self.kind,
            "schemaVersion": RawVoiceRecording.schemaVersion,
            "recordingId": recordingID,
            "status": state.rawValue,
        ]
        if let transcript { payload["transcript"] = transcript }
        if let error { payload["error"] = String(error.prefix(240)) }
        return payload
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> RawVoiceStatusMessage? {
        guard payload["kind"] as? String == kind,
              payload["schemaVersion"] as? Int == RawVoiceRecording.schemaVersion,
              let recordingID = payload["recordingId"] as? String,
              UUID(uuidString: recordingID) != nil,
              let rawState = payload["status"] as? String,
              let state = RawVoiceRecordingState(rawValue: rawState) else { return nil }
        let transcript = payload["transcript"] as? String
        if state == .transcriptReady,
           transcript?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            return nil
        }
        return RawVoiceStatusMessage(
            recordingID: recordingID.lowercased(),
            state: state,
            transcript: transcript,
            error: payload["error"] as? String
        )
    }
}

enum RawVoiceAcknowledgementStage: String, Codable, Sendable {
    case phonePersisted = "phone_persisted"
    case watchTranscriptPersisted = "watch_transcript_persisted"
}

struct RawVoiceDeliveryAcknowledgement: Equatable, Sendable {
    static let kind = "rawVoiceAck"

    let recordingID: String
    let deviceID: String
    let stage: RawVoiceAcknowledgementStage
    let at: String

    init(
        recordingID: String,
        deviceID: String,
        stage: RawVoiceAcknowledgementStage,
        at: Date = Date()
    ) {
        self.recordingID = recordingID.lowercased()
        self.deviceID = deviceID
        self.stage = stage
        self.at = ISO8601DateFormatter().string(from: at)
    }

    var connectivityPayload: [String: Any] {
        [
            "kind": Self.kind,
            "schemaVersion": RawVoiceRecording.schemaVersion,
            "recordingId": recordingID,
            "deviceId": deviceID,
            "stage": stage.rawValue,
            "at": at,
        ]
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> RawVoiceDeliveryAcknowledgement? {
        guard payload["kind"] as? String == kind,
              payload["schemaVersion"] as? Int == RawVoiceRecording.schemaVersion,
              let recordingID = payload["recordingId"] as? String,
              UUID(uuidString: recordingID) != nil,
              let deviceID = payload["deviceId"] as? String,
              !deviceID.isEmpty,
              let rawStage = payload["stage"] as? String,
              let stage = RawVoiceAcknowledgementStage(rawValue: rawStage),
              let at = payload["at"] as? String,
              ISO8601DateFormatter().date(from: at) != nil else { return nil }
        return RawVoiceDeliveryAcknowledgement(
            recordingID: recordingID,
            deviceID: deviceID,
            stage: stage,
            at: ISO8601DateFormatter().date(from: at)!
        )
    }
}

enum RawVoiceControlAction: String, Sendable {
    case delete
    case retry
}

struct RawVoiceControlMessage: Equatable, Sendable {
    static let kind = "rawVoiceControl"

    let recordingID: String
    let deviceID: String
    let action: RawVoiceControlAction

    var connectivityPayload: [String: Any] {
        [
            "kind": Self.kind,
            "schemaVersion": RawVoiceRecording.schemaVersion,
            "recordingId": recordingID,
            "deviceId": deviceID,
            "action": action.rawValue,
        ]
    }

    static func fromConnectivityPayload(_ payload: [String: Any]) -> RawVoiceControlMessage? {
        guard payload["kind"] as? String == kind,
              payload["schemaVersion"] as? Int == RawVoiceRecording.schemaVersion,
              let recordingID = payload["recordingId"] as? String,
              UUID(uuidString: recordingID) != nil,
              let deviceID = payload["deviceId"] as? String,
              !deviceID.isEmpty,
              let rawAction = payload["action"] as? String,
              let action = RawVoiceControlAction(rawValue: rawAction) else { return nil }
        return RawVoiceControlMessage(
            recordingID: recordingID.lowercased(),
            deviceID: deviceID,
            action: action
        )
    }
}
