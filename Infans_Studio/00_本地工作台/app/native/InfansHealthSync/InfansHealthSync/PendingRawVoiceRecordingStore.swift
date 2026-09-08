import Foundation

actor PendingRawVoiceRecordingStore {
    let directoryURL: URL

    init(directoryURL: URL) {
        self.directoryURL = directoryURL
    }

    static func defaultDirectoryURL(namespace: String) -> URL {
        let privateSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let fallbackCaches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return (privateSupport ?? fallbackCaches)
            .appendingPathComponent("InfansRawVoice", isDirectory: true)
            .appendingPathComponent(namespace, isDirectory: true)
    }

    nonisolated static func audioURL(for recordingID: String, in directoryURL: URL) -> URL {
        directoryURL.appendingPathComponent("\(recordingID.lowercased()).m4a", isDirectory: false)
    }

    nonisolated static func metadataURL(for recordingID: String, in directoryURL: URL) -> URL {
        directoryURL.appendingPathComponent("\(recordingID.lowercased()).json", isDirectory: false)
    }

    nonisolated static func stageIncomingFileSynchronously(
        _ sourceURL: URL,
        recording: RawVoiceRecording,
        directoryURL: URL
    ) throws -> RawVoiceRecording {
        guard recording.isValid else { throw RawVoiceStorageError.invalidRecording }
        let manager = FileManager.default
        try manager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var privateDirectoryURL = directoryURL
        try privateDirectoryURL.setResourceValues(resourceValues)
        let metadataURL = metadataURL(for: recording.recordingId, in: directoryURL)
        if manager.fileExists(atPath: metadataURL.path),
           let existing = try? JSONDecoder().decode(
               RawVoiceRecording.self,
               from: Data(contentsOf: metadataURL)
           ),
           existing.transcript?.isEmpty == false
                || manager.fileExists(atPath: audioURL(for: recording.recordingId, in: directoryURL).path) {
            return existing
        }
        let destination = audioURL(for: recording.recordingId, in: directoryURL)
        if manager.fileExists(atPath: destination.path) {
            try manager.removeItem(at: destination)
        }
        try manager.copyItem(at: sourceURL, to: destination)
        var persisted = recording
        persisted.state = .phonePersisted
        persisted.lastError = nil
        let metadata = try JSONEncoder().encode(persisted)
        try metadata.write(to: metadataURL, options: .atomic)
        return persisted
    }

    func audioURL(for recordingID: String) throws -> URL {
        try ensureDirectory()
        return Self.audioURL(for: recordingID, in: directoryURL)
    }

    func upsert(_ recording: RawVoiceRecording) throws {
        guard recording.isValid else { throw RawVoiceStorageError.invalidRecording }
        try ensureDirectory()
        let data = try JSONEncoder().encode(recording)
        try data.write(to: Self.metadataURL(for: recording.recordingId, in: directoryURL), options: .atomic)
    }

    @discardableResult
    func mark(
        _ recordingID: String,
        state: RawVoiceRecordingState,
        transcript: String? = nil,
        error: String? = nil
    ) throws -> RawVoiceRecording? {
        guard var recording = try item(recordingID) else { return nil }
        recording.state = state
        if let transcript { recording.transcript = transcript }
        recording.lastError = error
        try upsert(recording)
        return recording
    }

    func item(_ recordingID: String) throws -> RawVoiceRecording? {
        let url = Self.metadataURL(for: recordingID, in: directoryURL)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(RawVoiceRecording.self, from: Data(contentsOf: url))
    }

    func selectDestination(_ recordingID: String, route: SecretaryCommandRoute, conversationKey: String) throws {
        guard route != .auto, var row = try item(recordingID), row.state != .cancelled else {
            throw RawVoiceStorageError.invalidRecording
        }
        // Once reserved, a replay must retain its original route, text and command ID.
        guard row.preparedCommand == nil, row.selectedRoute == nil else { return }
        row.selectedRoute = route
        row.selectedConversationKey = conversationKey
        try upsert(row)
    }

    /// Reserve durably BEFORE adding to the Watch command outbox. Replays reuse this exact command.
    func prepareCommand(_ recordingID: String) throws -> CodexCommand? {
        guard var row = try item(recordingID), row.state != .cancelled else { return nil }
        if let command = row.preparedCommand { return command }
        guard [.transcriptReady, .watchTranscriptPersisted].contains(row.state), let route = row.selectedRoute, route != .auto,
              let text = row.transcript,
              let createdAt = ISO8601DateFormatter().date(from: row.createdAt) else { return nil }
        let command = CodexCommand(
            id: row.recordingId, text: text, createdAt: createdAt, source: .watchApp,
            deviceID: row.deviceID, route: route,
            conversationKey: row.selectedConversationKey ?? CodexCommand.defaultConversationKey
        )
        guard command.isValid else { throw RawVoiceStorageError.invalidRecording }
        row.preparedCommand = command
        row.commandEnqueued = false
        try upsert(row)
        return command
    }

    func markCommandEnqueued(_ recordingID: String) throws {
        guard var row = try item(recordingID), row.preparedCommand != nil else {
            throw RawVoiceStorageError.invalidRecording
        }
        row.commandEnqueued = true
        try upsert(row)
    }

    /// Accept late receipts by recording ID, not by the recording currently visible on screen.
    func applyWatchStatus(_ message: RawVoiceStatusMessage) throws -> RawVoiceRecording? {
        guard var row = try item(message.recordingID) else { return nil }
        if row.state == .cancelled { return row }
        // The phone's ACK only confirms it released its transcript copy. It is
        // NOT command delivery and must not hide an unrouted Watch draft.
        if message.state == .watchTranscriptPersisted { return row }
        if message.state == .failed && row.state.rank >= RawVoiceRecordingState.transcriptReady.rank { return row }
        guard message.state == .failed || message.state == .cancelled || message.state.rank >= row.state.rank else { return row }
        if message.state == .transcriptReady {
            guard let text = message.transcript?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            // A delayed duplicate may not mutate an already reserved command's contents.
            if row.preparedCommand == nil { row.transcript = text }
        }
        row.state = message.state
        row.lastError = message.error
        try upsert(row)
        return row
    }

    func items() throws -> [RawVoiceRecording] {
        try ensureDirectory()
        let urls = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        )
        return urls
            .filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(RawVoiceRecording.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func removeAudio(_ recordingID: String) throws {
        let url = Self.audioURL(for: recordingID, in: directoryURL)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    func remove(_ recordingID: String) throws {
        try removeAudio(recordingID)
        let metadata = Self.metadataURL(for: recordingID, in: directoryURL)
        if FileManager.default.fileExists(atPath: metadata.path) {
            try FileManager.default.removeItem(at: metadata)
        }
    }

    func containsAudio(_ recordingID: String) -> Bool {
        FileManager.default.fileExists(
            atPath: Self.audioURL(for: recordingID, in: directoryURL).path
        )
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var privateDirectoryURL = directoryURL
        try privateDirectoryURL.setResourceValues(resourceValues)
    }
}

enum RawVoiceStorageError: LocalizedError {
    case invalidRecording

    var errorDescription: String? {
        switch self {
        case .invalidRecording: "原声录音标识不完整"
        }
    }
}
