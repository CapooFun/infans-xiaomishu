import Foundation

enum RawVoiceProviderState: String, Sendable {
    case available
    case disabled
    case unavailable
}

struct RawVoiceProviderAvailability: Equatable, Sendable {
    let state: RawVoiceProviderState
    let reason: String?
}

protocol RawVoiceTranscriptionProviding: Sendable {
    var availability: RawVoiceProviderAvailability { get }
    func transcribe(fileURL: URL, recording: RawVoiceRecording) async throws -> String
}

struct DisabledRawVoiceTranscriptionProvider: RawVoiceTranscriptionProviding {
    let availability = RawVoiceProviderAvailability(
        state: .disabled,
        reason: "Mac 本地转写模型尚未接入"
    )

    func transcribe(fileURL: URL, recording: RawVoiceRecording) async throws -> String {
        throw RawVoiceTranscriptionError.providerUnavailable(availability.reason ?? "转写模型尚未接入")
    }
}

enum RawVoiceTranscriptionError: LocalizedError {
    case providerUnavailable(String)
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case let .providerUnavailable(reason): reason
        case .emptyTranscript: "转写结果为空，原声已保留等待重试"
        }
    }
}

@MainActor
final class PhoneRawVoicePipeline {
    typealias StatusHandler = @MainActor (RawVoiceStatusMessage) -> Void

    private let store: PendingRawVoiceRecordingStore
    private let provider: any RawVoiceTranscriptionProviding
    private var statusHandler: StatusHandler?
    private var activeRecordingIDs: Set<String> = []

    init(
        store: PendingRawVoiceRecordingStore = PendingRawVoiceRecordingStore(
            directoryURL: PendingRawVoiceRecordingStore.defaultDirectoryURL(namespace: "phone-inbox")
        ),
        provider: any RawVoiceTranscriptionProviding = DisabledRawVoiceTranscriptionProvider()
    ) {
        self.store = store
        self.provider = provider
    }

    func setStatusHandler(_ handler: @escaping StatusHandler) {
        statusHandler = handler
    }

    func start() {
        Task { await retryPending() }
    }

    func acceptPersistedFile(_ recording: RawVoiceRecording) async {
        guard recording.isValid else { return }
        if recording.state == .transcriptReady, let transcript = recording.transcript {
            sendStatus(recordingID: recording.recordingId, state: .transcriptReady, transcript: transcript)
            return
        }
        sendStatus(recordingID: recording.recordingId, state: .phonePersisted)
        await transcribeIfPossible(recordingID: recording.recordingId)
    }

    @discardableResult
    func retryPending() async -> Bool {
        guard let rows = try? await store.items() else { return false }
        for recording in rows where recording.state != .watchTranscriptPersisted && recording.state != .cancelled {
            if recording.state == .transcriptReady, let transcript = recording.transcript {
                sendStatus(recordingID: recording.recordingId, state: .transcriptReady, transcript: transcript)
            } else {
                sendStatus(recordingID: recording.recordingId, state: .phonePersisted)
                await transcribeIfPossible(recordingID: recording.recordingId)
            }
        }
        return true
    }

    func receive(_ acknowledgement: RawVoiceDeliveryAcknowledgement) async {
        guard acknowledgement.stage == .watchTranscriptPersisted else { return }
        try? await store.remove(acknowledgement.recordingID)
    }

    func receive(_ control: RawVoiceControlMessage) async {
        guard let row = try? await store.item(control.recordingID), row.deviceID == control.deviceID else { return }
        switch control.action {
        case .delete:
            try? await store.remove(control.recordingID)
            sendStatus(recordingID: control.recordingID, state: .cancelled)
        case .retry:
            // Replay a durable transcript without re-transcribing or creating a command.
            await acceptPersistedFile(row)
        }
    }

    private func transcribeIfPossible(recordingID: String) async {
        guard !activeRecordingIDs.contains(recordingID) else { return }
        let row: RawVoiceRecording
        do {
            guard let stored = try await store.item(recordingID) else { return }
            row = stored
        } catch {
            sendStatus(recordingID: recordingID, state: .failed, error: error.localizedDescription)
            return
        }
        let availability = provider.availability
        guard availability.state == .available else {
            let reason = availability.reason ?? "转写 provider 暂不可用"
            _ = try? await store.mark(recordingID, state: .providerUnavailable, error: reason)
            sendStatus(recordingID: recordingID, state: .providerUnavailable, error: reason)
            return
        }
        activeRecordingIDs.insert(recordingID)
        defer { activeRecordingIDs.remove(recordingID) }
        do {
            _ = try await store.mark(recordingID, state: .transcribing)
            sendStatus(recordingID: recordingID, state: .transcribing)
            let audioURL = try await store.audioURL(for: recordingID)
            let rawTranscript = try await provider.transcribe(fileURL: audioURL, recording: row)
            let transcript = rawTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { throw RawVoiceTranscriptionError.emptyTranscript }
            _ = try await store.mark(recordingID, state: .transcriptReady, transcript: transcript)
            // The provider result is durably persisted. The transcript can be
            // replayed to Watch without retaining another copy of the raw audio.
            try await store.removeAudio(recordingID)
            sendStatus(recordingID: recordingID, state: .transcriptReady, transcript: transcript)
        } catch {
            let message = error.localizedDescription
            _ = try? await store.mark(recordingID, state: .providerUnavailable, error: message)
            sendStatus(recordingID: recordingID, state: .providerUnavailable, error: message)
        }
    }

    private func sendStatus(
        recordingID: String,
        state: RawVoiceRecordingState,
        transcript: String? = nil,
        error: String? = nil
    ) {
        statusHandler?(RawVoiceStatusMessage(
            recordingID: recordingID,
            state: state,
            transcript: transcript,
            error: error
        ))
    }
}
