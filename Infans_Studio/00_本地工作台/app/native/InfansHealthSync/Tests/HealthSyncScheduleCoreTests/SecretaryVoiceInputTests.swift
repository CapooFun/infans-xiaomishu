import Foundation
import XCTest
@testable import HealthSyncScheduleCore

final class SecretaryVoiceInputTests: XCTestCase {
    func testRecordingContractUsesStableIDAndSixtySecondClientLimit() {
        let accepted = SecretaryVoiceRecording(
            recordingId: "ios_11111111-2222-4333-8444-555555555555",
            durationMs: 60_000
        )
        XCTAssertTrue(accepted.isValid)
        XCTAssertEqual(accepted.fileName, "\(accepted.recordingId).m4a")
        XCTAssertEqual(SecretaryVoiceRecording.mimeType, "audio/mp4")
        XCTAssertFalse(SecretaryVoiceRecording(
            recordingId: accepted.recordingId,
            durationMs: 60_001
        ).isValid)
        XCTAssertEqual(
            SecretaryVoiceDurationPolicy.milliseconds(reportedSeconds: 0.01, automaticLimitReached: true),
            60_000
        )
        XCTAssertEqual(SecretaryVoiceDurationPolicy.milliseconds(reportedSeconds: 3.456), 3_456)
    }

    func testPrivateRecordingStoreRetainsRetryableAudioAndDeletesExplicitly() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("secretary-ios-voice-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SecretaryVoiceRecordingStore(directoryURL: directory)
        let recording = SecretaryVoiceRecording(
            recordingId: "ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            durationMs: 1_250,
            state: .retryable,
            lastError: "Mac 离线"
        )
        let audioURL = try await store.prepareAudioURL(recordingID: recording.recordingId)
        try Data("aac-audio".utf8).write(to: audioURL)
        try await store.save(recording)

        let restored = try await store.latest()
        let restoredAudioURL = try await store.audioURL(for: recording)
        XCTAssertEqual(restored, recording)
        XCTAssertEqual(try Data(contentsOf: restoredAudioURL), Data("aac-audio".utf8))
        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)

        try await store.delete(recordingID: recording.recordingId)
        let deleted = try await store.latest()
        XCTAssertNil(deleted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: audioURL.path))
    }

    func testTranscriptionUsesBearerRawAudioDurationMimeStableIDAndYinyueHint() async throws {
        let recorder = VoiceRequestRecorder()
        VoiceURLProtocolStub.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"recordingId":"ios_11111111-2222-4333-8444-555555555555","duplicate":false,"transcript":{"text":"银月在这里。","language":"zh-CN"}}"#.utf8))
        }
        defer { VoiceURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceURLProtocolStub.self]
        let client = SecretaryVoiceTranscriptionClient(session: URLSession(configuration: configuration))
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try Data("fake-aac".utf8).write(to: fileURL)
        let recording = SecretaryVoiceRecording(
            recordingId: "ios_11111111-2222-4333-8444-555555555555",
            durationMs: 1_250
        )

        let result = try await client.transcribe(
            fileURL: fileURL,
            recording: recording,
            connection: .init(serverURL: "https://mac.example.test", bearerToken: "voice-token")
        )
        XCTAssertEqual(result.transcript.text, "银月在这里。")
        let request = try XCTUnwrap(recorder.request)
        XCTAssertEqual(request.url?.path, "/api/secretary-mobile/transcription")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer voice-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "audio/mp4")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Infans-Recording-Id"), recording.recordingId)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Infans-Duration-Ms"), "1250")
        XCTAssertEqual(request.httpBody, Data("fake-aac".utf8))
        let hints = try XCTUnwrap(request.value(forHTTPHeaderField: "X-Infans-Proper-Noun-Hints"))
        XCTAssertEqual(try decodeHints(hints), ["银月"])
    }

    func testProviderUnconfiguredIsExplicitAndDoesNotReturnTranscript() async throws {
        VoiceURLProtocolStub.handler = { _ in
            (503, Data(#"{"error":"尚未配置本地语音识别模型","code":"TRANSCRIPTION_PROVIDER_UNCONFIGURED"}"#.utf8))
        }
        defer { VoiceURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceURLProtocolStub.self]
        let client = SecretaryVoiceTranscriptionClient(session: URLSession(configuration: configuration))
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try Data("fake-aac".utf8).write(to: fileURL)
        let recording = SecretaryVoiceRecording(
            recordingId: "ios_99999999-2222-4333-8444-555555555555",
            durationMs: 900
        )

        do {
            _ = try await client.transcribe(
                fileURL: fileURL,
                recording: recording,
                connection: .init(serverURL: "https://mac.example.test", bearerToken: "voice-token")
            )
            XCTFail("未配置 provider 不应伪造逐字稿")
        } catch let error as SecretaryVoiceTranscriptionError {
            guard case let .providerUnconfigured(message) = error else {
                return XCTFail("应该是明确的 provider 未配置错误")
            }
            XCTAssertEqual(message, "尚未配置本地语音识别模型")
        }
    }

    private func decodeHints(_ encoded: String) throws -> [String] {
        var base64 = encoded.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return try JSONDecoder().decode([String].self, from: XCTUnwrap(Data(base64Encoded: base64)))
    }
}

private final class VoiceRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: URLRequest?

    var request: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ request: URLRequest) {
        var captured = request
        if captured.httpBody == nil {
            captured.httpBody = Self.readBody(from: request.httpBodyStream)
        }
        lock.lock()
        storage = captured
        lock.unlock()
    }

    private static func readBody(from stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { return nil }
            if count == 0 { return data }
            data.append(buffer, count: count)
        }
    }
}

private final class VoiceURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
