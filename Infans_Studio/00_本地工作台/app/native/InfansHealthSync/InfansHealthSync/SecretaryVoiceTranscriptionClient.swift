import Foundation
#if canImport(AVFAudio) && canImport(Speech)
import AVFAudio
import Speech
#endif

struct SecretaryVoiceRecording: Codable, Equatable, Identifiable, Sendable {
    enum State: String, Codable, Sendable {
        case recorded
        case transcribing
        case retryable
        case transcriptReady
    }

    static let maximumDurationMs = 60_000
    static let mimeType = "audio/mp4"

    let recordingId: String
    let createdAt: Date
    let durationMs: Int
    let fileName: String
    var state: State
    var transcript: String?
    var lastError: String?

    var id: String { recordingId }

    init(
        recordingId: String = "ios_\(UUID().uuidString.lowercased())",
        createdAt: Date = Date(),
        durationMs: Int,
        state: State = .recorded,
        transcript: String? = nil,
        lastError: String? = nil
    ) {
        self.recordingId = recordingId
        self.createdAt = createdAt
        self.durationMs = durationMs
        self.fileName = "\(recordingId).m4a"
        self.state = state
        self.transcript = transcript
        self.lastError = lastError
    }

    var isValid: Bool {
        recordingId.range(of: #"^[0-9A-Za-z][0-9A-Za-z._-]{7,79}$"#, options: .regularExpression) != nil
            && !recordingId.contains("..")
            && (1...Self.maximumDurationMs).contains(durationMs)
            && fileName == "\(recordingId).m4a"
    }
}

enum SecretaryVoiceDurationPolicy {
    static func milliseconds(
        reportedSeconds: TimeInterval,
        automaticLimitReached: Bool = false
    ) -> Int {
        if automaticLimitReached { return SecretaryVoiceRecording.maximumDurationMs }
        return min(
            SecretaryVoiceRecording.maximumDurationMs,
            max(1, Int((reportedSeconds * 1_000).rounded()))
        )
    }
}

enum SecretaryOnDeviceTranscriptionEngine: String, Codable, Equatable, Sendable {
    case speechTranscriber
    case dictationTranscriber
}

struct SecretaryOnDeviceTranscriptionResult: Equatable, Sendable {
    let text: String
    let localeIdentifier: String
    let engine: SecretaryOnDeviceTranscriptionEngine
}

struct SecretaryOnDeviceTranscriptionProbe: Equatable, Sendable {
    let speechTranscriberAvailable: Bool
    let supportedLocaleIdentifiers: [String]
    let installedLocaleIdentifiers: [String]
}

struct SecretaryOnDeviceTranscriptionBenchmark: Equatable, Sendable {
    let result: SecretaryOnDeviceTranscriptionResult
    let audioDurationMs: Int
    let processingDurationMs: Int
    let realTimeFactor: Double
}

enum SecretaryOnDeviceTranscriptionError: LocalizedError {
    case unavailable
    case emptyResult

    var errorDescription: String? {
        switch self {
        case .unavailable: return "这台设备暂时没有可用的端侧语音识别"
        case .emptyResult: return "端侧语音识别没有得到文字"
        }
    }
}

actor SecretaryOnDeviceVoiceTranscriber {
    private let preferredLocaleIdentifiers: [String]

    init(preferredLocaleIdentifiers: [String] = ["zh-CN", "ja-JP"]) {
        self.preferredLocaleIdentifiers = preferredLocaleIdentifiers
    }

    func probe() async -> SecretaryOnDeviceTranscriptionProbe {
        #if canImport(AVFAudio) && canImport(Speech)
        if #available(iOS 26.0, macOS 26.0, *) {
            let supported = await SpeechTranscriber.supportedLocales
            let installed = await SpeechTranscriber.installedLocales
            return SecretaryOnDeviceTranscriptionProbe(
                speechTranscriberAvailable: SpeechTranscriber.isAvailable,
                supportedLocaleIdentifiers: supported.map(\.identifier).sorted(),
                installedLocaleIdentifiers: installed.map(\.identifier).sorted()
            )
        }
        #endif
        return SecretaryOnDeviceTranscriptionProbe(
            speechTranscriberAvailable: false,
            supportedLocaleIdentifiers: [],
            installedLocaleIdentifiers: []
        )
    }

    func transcribe(
        fileURL: URL,
        contextualStrings: [String] = []
    ) async throws -> SecretaryOnDeviceTranscriptionResult {
        #if canImport(AVFAudio) && canImport(Speech)
        if #available(iOS 26.0, macOS 26.0, *) {
            if SpeechTranscriber.isAvailable {
                for identifier in preferredLocaleIdentifiers {
                    guard let locale = await SpeechTranscriber.supportedLocale(
                        equivalentTo: Locale(identifier: identifier)
                    ) else { continue }
                    do {
                        return try await transcribeWithSpeechTranscriber(
                            fileURL: fileURL,
                            locale: locale,
                            contextualStrings: contextualStrings
                        )
                    } catch SecretaryOnDeviceTranscriptionError.emptyResult {
                        continue
                    } catch {
                        // DictationTranscriber is the independent system fallback.
                    }
                }
            }
            for identifier in preferredLocaleIdentifiers {
                guard let locale = await DictationTranscriber.supportedLocale(
                    equivalentTo: Locale(identifier: identifier)
                ) else { continue }
                do {
                    return try await transcribeWithDictationTranscriber(
                        fileURL: fileURL,
                        locale: locale,
                        contextualStrings: contextualStrings
                    )
                } catch SecretaryOnDeviceTranscriptionError.emptyResult {
                    continue
                } catch {
                    continue
                }
            }
        }
        #endif
        throw SecretaryOnDeviceTranscriptionError.unavailable
    }

    func benchmark(
        fileURL: URL,
        audioDurationMs: Int,
        contextualStrings: [String] = []
    ) async throws -> SecretaryOnDeviceTranscriptionBenchmark {
        let startedAt = Date()
        let result = try await transcribe(fileURL: fileURL, contextualStrings: contextualStrings)
        let processingDurationMs = max(1, Int(Date().timeIntervalSince(startedAt) * 1_000))
        let normalizedAudioDuration = max(1, audioDurationMs)
        return SecretaryOnDeviceTranscriptionBenchmark(
            result: result,
            audioDurationMs: normalizedAudioDuration,
            processingDurationMs: processingDurationMs,
            realTimeFactor: Double(processingDurationMs) / Double(normalizedAudioDuration)
        )
    }

    #if canImport(AVFAudio) && canImport(Speech)
    @available(iOS 26.0, macOS 26.0, *)
    private func transcribeWithSpeechTranscriber(
        fileURL: URL,
        locale: Locale,
        contextualStrings: [String]
    ) async throws -> SecretaryOnDeviceTranscriptionResult {
        let module = SpeechTranscriber(locale: locale, preset: .transcription)
        try await prepareAssets(for: [module])
        let text = try await analyze(
            fileURL: fileURL,
            module: module,
            contextualStrings: contextualStrings
        )
        return SecretaryOnDeviceTranscriptionResult(
            text: text,
            localeIdentifier: locale.identifier,
            engine: .speechTranscriber
        )
    }

    @available(iOS 26.0, macOS 26.0, *)
    private func transcribeWithDictationTranscriber(
        fileURL: URL,
        locale: Locale,
        contextualStrings: [String]
    ) async throws -> SecretaryOnDeviceTranscriptionResult {
        let module = DictationTranscriber(locale: locale, preset: .shortDictation)
        try await prepareAssets(for: [module])
        let text = try await analyze(
            fileURL: fileURL,
            module: module,
            contextualStrings: contextualStrings
        )
        return SecretaryOnDeviceTranscriptionResult(
            text: text,
            localeIdentifier: locale.identifier,
            engine: .dictationTranscriber
        )
    }

    @available(iOS 26.0, macOS 26.0, *)
    private func prepareAssets(for modules: [any SpeechModule]) async throws {
        switch await AssetInventory.status(forModules: modules) {
        case .installed:
            return
        case .supported, .downloading:
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                try await request.downloadAndInstall()
            }
        case .unsupported:
            throw SecretaryOnDeviceTranscriptionError.unavailable
        @unknown default:
            throw SecretaryOnDeviceTranscriptionError.unavailable
        }
    }

    @available(iOS 26.0, macOS 26.0, *)
    private func analyze(
        fileURL: URL,
        module: SpeechTranscriber,
        contextualStrings: [String]
    ) async throws -> String {
        let context = AnalysisContext()
        context.contextualStrings[.general] = Array(contextualStrings.prefix(100))
        let analyzer = SpeechAnalyzer(modules: [module])
        let analyzerContext = await analyzer.context
        analyzerContext.contextualStrings = context.contextualStrings
        let resultTask = Task { () throws -> [String] in
            var parts: [String] = []
            for try await result in module.results {
                parts.append(String(result.text.characters))
            }
            return parts
        }
        do {
            let file = try AVAudioFile(forReading: fileURL)
            _ = try await analyzer.analyzeSequence(from: file)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            let text = try await resultTask.value.joined().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw SecretaryOnDeviceTranscriptionError.emptyResult }
            return text
        } catch {
            resultTask.cancel()
            throw error
        }
    }

    @available(iOS 26.0, macOS 26.0, *)
    private func analyze(
        fileURL: URL,
        module: DictationTranscriber,
        contextualStrings: [String]
    ) async throws -> String {
        let context = AnalysisContext()
        context.contextualStrings[.general] = Array(contextualStrings.prefix(100))
        let analyzer = SpeechAnalyzer(modules: [module])
        let analyzerContext = await analyzer.context
        analyzerContext.contextualStrings = context.contextualStrings
        let resultTask = Task { () throws -> [String] in
            var parts: [String] = []
            for try await result in module.results {
                parts.append(String(result.text.characters))
            }
            return parts
        }
        do {
            let file = try AVAudioFile(forReading: fileURL)
            _ = try await analyzer.analyzeSequence(from: file)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            let text = try await resultTask.value.joined().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw SecretaryOnDeviceTranscriptionError.emptyResult }
            return text
        } catch {
            resultTask.cancel()
            throw error
        }
    }
    #endif
}

actor SecretaryVoiceRecordingStore {
    let directoryURL: URL

    init(directoryURL: URL = SecretaryVoiceRecordingStore.defaultDirectoryURL()) {
        self.directoryURL = directoryURL
    }

    static func defaultDirectoryURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("SecretaryVoiceInput", isDirectory: true)
            .appendingPathComponent("private-recordings", isDirectory: true)
    }

    nonisolated static func audioURL(recordingID: String, directoryURL: URL) -> URL {
        directoryURL.appendingPathComponent("\(recordingID).m4a", isDirectory: false)
    }

    nonisolated static func metadataURL(recordingID: String, directoryURL: URL) -> URL {
        directoryURL.appendingPathComponent("\(recordingID).json", isDirectory: false)
    }

    func prepareAudioURL(recordingID: String) throws -> URL {
        try ensurePrivateDirectory()
        let url = Self.audioURL(recordingID: recordingID, directoryURL: directoryURL)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        return url
    }

    func save(_ recording: SecretaryVoiceRecording) throws {
        guard recording.isValid else { throw SecretaryVoiceStorageError.invalidRecording }
        try ensurePrivateDirectory()
        let data = try JSONEncoder().encode(recording)
        let url = Self.metadataURL(recordingID: recording.recordingId, directoryURL: directoryURL)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let audioURL = Self.audioURL(recordingID: recording.recordingId, directoryURL: directoryURL)
        if FileManager.default.fileExists(atPath: audioURL.path) {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: audioURL.path)
        }
    }

    func latest() throws -> SecretaryVoiceRecording? {
        try ensurePrivateDirectory()
        return try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" }
        .compactMap { try? JSONDecoder().decode(SecretaryVoiceRecording.self, from: Data(contentsOf: $0)) }
        .filter(\.isValid)
        .max { $0.createdAt < $1.createdAt }
    }

    func audioURL(for recording: SecretaryVoiceRecording) throws -> URL {
        guard recording.isValid else { throw SecretaryVoiceStorageError.invalidRecording }
        let url = Self.audioURL(recordingID: recording.recordingId, directoryURL: directoryURL)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw SecretaryVoiceStorageError.audioMissing
        }
        return url
    }

    func delete(recordingID: String) throws {
        for url in [
            Self.audioURL(recordingID: recordingID, directoryURL: directoryURL),
            Self.metadataURL(recordingID: recordingID, directoryURL: directoryURL),
        ] where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func ensurePrivateDirectory() throws {
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = directoryURL
        try mutableURL.setResourceValues(values)
    }
}

enum SecretaryVoiceStorageError: LocalizedError {
    case invalidRecording
    case audioMissing

    var errorDescription: String? {
        switch self {
        case .invalidRecording: "原声录音信息不完整"
        case .audioMissing: "这段原声文件已经不在设备上"
        }
    }
}

struct SecretaryVoiceTranscriptionResult: Decodable, Equatable, Sendable {
    struct Transcript: Decodable, Equatable, Sendable {
        let text: String
        let language: String?
    }

    let recordingId: String
    let duplicate: Bool
    let transcript: Transcript
}

private struct SecretaryVoiceServerError: Decodable {
    let error: String?
    let code: String?
}

enum SecretaryVoiceTranscriptionError: LocalizedError, Equatable {
    case providerUnconfigured(String)
    case offline
    case timedOut
    case cancelled
    case invalidResponse
    case server(status: Int, code: String?, message: String)

    var errorDescription: String? {
        switch self {
        case let .providerUnconfigured(message): message
        case .offline: "暂时连不上 Mac，原声已保留"
        case .timedOut: "本地语音识别超时，原声已保留"
        case .cancelled: "转写已取消"
        case .invalidResponse: "Mac 返回了无法识别的逐字稿，原声已保留"
        case let .server(_, _, message): message
        }
    }
}

struct SecretaryVoiceTranscriptionClient: Sendable {
    let session: URLSession
    let chatClient: SecretaryChatClient

    init(session: URLSession = .shared) {
        self.session = session
        self.chatClient = SecretaryChatClient(session: session)
    }

    func transcribe(
        fileURL: URL,
        recording: SecretaryVoiceRecording,
        properNouns: [String] = ["银月"],
        connection: SecretaryChatConnection
    ) async throws -> SecretaryVoiceTranscriptionResult {
        guard recording.isValid else { throw SecretaryVoiceStorageError.invalidRecording }
        var request = try chatClient.makeRequest(
            path: "api/secretary-mobile/transcription",
            method: "POST",
            connection: connection
        )
        request.timeoutInterval = 75
        request.setValue(SecretaryVoiceRecording.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(recording.recordingId, forHTTPHeaderField: "X-Infans-Recording-Id")
        request.setValue(String(recording.durationMs), forHTTPHeaderField: "X-Infans-Duration-Ms")
        request.setValue("zh-CN", forHTTPHeaderField: "X-Infans-Language")
        request.setValue(try Self.encodedHints(properNouns), forHTTPHeaderField: "X-Infans-Proper-Noun-Hints")
        request.httpBody = try Data(contentsOf: fileURL, options: .mappedIfSafe)

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw SecretaryVoiceTranscriptionError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                let server = try? JSONDecoder().decode(SecretaryVoiceServerError.self, from: data)
                if http.statusCode == 503, server?.code == "TRANSCRIPTION_PROVIDER_UNCONFIGURED" {
                    throw SecretaryVoiceTranscriptionError.providerUnconfigured(
                        server?.error ?? "Mac 还没配置本地语音识别，原声已保留"
                    )
                }
                throw SecretaryVoiceTranscriptionError.server(
                    status: http.statusCode,
                    code: server?.code,
                    message: server?.error ?? "Mac 本地转写暂时不可用，原声已保留"
                )
            }
            let result = try JSONDecoder().decode(SecretaryVoiceTranscriptionResult.self, from: data)
            guard result.recordingId == recording.recordingId,
                  !result.transcript.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw SecretaryVoiceTranscriptionError.invalidResponse
            }
            return result
        } catch let error as URLError {
            switch error.code {
            case .timedOut: throw SecretaryVoiceTranscriptionError.timedOut
            case .cancelled: throw SecretaryVoiceTranscriptionError.cancelled
            default: throw SecretaryVoiceTranscriptionError.offline
            }
        }
    }

    func cancel(recordingID: String, connection: SecretaryChatConnection) async {
        guard let body = try? JSONEncoder().encode(["recordingId": recordingID]),
              var request = try? chatClient.makeRequest(
                path: "api/secretary-mobile/transcription/cancel",
                method: "POST",
                connection: connection
              ) else { return }
        request.timeoutInterval = 10
        request.httpBody = body
        _ = try? await session.data(for: request)
    }

    static func encodedHints(_ values: [String]) throws -> String {
        let normalized = Array(Set(values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }))
            .filter { !$0.isEmpty }
            .sorted()
        let data = try JSONEncoder().encode(normalized)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
