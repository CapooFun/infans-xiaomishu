import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import HealthSyncScheduleCore

final class SecretaryAttachmentDraftTests: XCTestCase {
    func testUploadUsesBearerRawBodyCanonicalMIMEStableIDAndAcceptsCreatedOrDuplicate() async throws {
        let recorder = AttachmentRequestRecorder()
        let status = AttachmentStatusQueue([201, 200])
        AttachmentURLProtocolStub.handler = { request in
            recorder.append(request)
            let code = status.next()
            return (code, Self.uploadResponse(created: code == 201, duplicate: code == 200))
        }
        defer { AttachmentURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AttachmentURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachment-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let bytes = Data("private-pdf-bytes".utf8)
        try bytes.write(to: fileURL)
        let draft = SecretaryAttachmentDraft(
            id: "iosasset_12345678",
            conversationId: "native_yingning_default",
            name: "银月 笔记.pdf",
            mimeType: "application/pdf",
            kind: "file",
            sizeBytes: bytes.count
        )
        let connection = SecretaryChatConnection(serverURL: "https://mac.example.test", bearerToken: "attachment-token")

        let created = try await client.uploadAttachment(draft, fileURL: fileURL, connection: connection)
        let duplicate = try await client.uploadAttachment(draft, fileURL: fileURL, connection: connection)

        XCTAssertTrue(created.created)
        XCTAssertTrue(duplicate.duplicate)
        XCTAssertEqual(recorder.requests.count, 2)
        for request in recorder.requests {
            XCTAssertEqual(request.url?.path, "/api/secretary-mobile/attachments")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer attachment-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Infans-Attachment-Id"), draft.id)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Infans-Filename"), "%E9%93%B6%E6%9C%88%20%E7%AC%94%E8%AE%B0.pdf")
            XCTAssertEqual(request.httpBody, bytes)
        }
    }

    func testPureAttachmentTurnAndRetryReuseSameRemoteReference() throws {
        var draft = SecretaryAttachmentDraft(
            id: "iosasset_retry_1234",
            conversationId: "native_yingning_default",
            name: "notes.md",
            mimeType: "text/markdown",
            kind: "file",
            sizeBytes: 12
        )
        var turn = PendingSecretaryChatTurn.make(
            conversationId: draft.conversationId,
            text: "",
            expectedConversationVersion: "v1",
            attachments: [draft],
            id: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
        )

        XCTAssertTrue(turn.hasUnuploadedAttachments)
        XCTAssertFalse(turn.isReadyForStreaming)
        XCTAssertTrue(turn.request.attachments.isEmpty)

        draft.uploadedAttachment = SecretaryChatAttachment(
            id: draft.id,
            kind: draft.kind,
            name: draft.name,
            mimeType: draft.mimeType,
            resourcePath: "/api/secretary-mobile/attachments/iosasset_retry_1234/content",
            fallbackText: draft.name
        )
        turn.attachments[0] = draft
        turn.state = .failedRetryPending
        turn.lastError = "stream disconnected"
        turn.retryCount += 1

        XCTAssertTrue(turn.isReadyForStreaming)
        XCTAssertEqual(turn.request.text, "")
        XCTAssertEqual(turn.request.attachments, [.init(id: "iosasset_retry_1234")])
        XCTAssertEqual(turn.messageId, "msg-11111111-2222-4333-8444-555555555555")
        XCTAssertEqual(turn.attachments[0].id, draft.id)
    }

    func testVoiceTurnAppearsBeforeTranscriptAndStreamsOnlyAfterTranscriptIsReady() throws {
        var draft = SecretaryAttachmentDraft(
            id: "ios_12345678-1234-4234-8234-123456789abc",
            conversationId: "native_yingning_default",
            name: "语音 · 0:08",
            mimeType: "audio/mp4",
            kind: "audio",
            sizeBytes: 1_024,
            durationMs: 8_200
        )
        var turn = PendingSecretaryChatTurn.makeVoice(
            conversationId: draft.conversationId,
            attachment: draft,
            expectedConversationVersion: "v1",
            createdAt: Date(timeIntervalSince1970: 1_788_300_000)
        )

        XCTAssertEqual(turn.messageId, "msg-\(draft.id)")
        XCTAssertFalse(turn.isReadyForStreaming)
        XCTAssertEqual(turn.attachments[0].messageAttachment.fallbackText, "正在识别这段原声…")

        draft.uploadedAttachment = SecretaryChatAttachment(
            id: draft.id,
            kind: draft.kind,
            name: draft.name,
            mimeType: draft.mimeType,
            resourcePath: "/api/secretary-mobile/attachments/\(draft.id)/content",
            fallbackText: draft.name,
            durationMs: draft.durationMs
        )
        turn.attachments[0] = draft
        XCTAssertFalse(turn.hasUnuploadedAttachments)
        XCTAssertFalse(turn.isReadyForStreaming)

        draft.transcript = "银月，帮我记一下。"
        turn.attachments[0] = draft
        XCTAssertTrue(turn.isReadyForStreaming)
        XCTAssertEqual(
            turn.request.attachments,
            [.init(id: draft.id, transcript: "银月，帮我记一下。")]
        )
        XCTAssertEqual(turn.attachments[0].messageAttachment.transcript, "银月，帮我记一下。")
    }

    func testConsecutiveVoiceTurnsEnterMailboxInOrderWithoutWaitingForTheFirstReply() {
        var first = makeVoiceTurn(id: "ios_11111111-2222-4333-8444-555555555555")
        let second = makeVoiceTurn(id: "ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")

        XCTAssertEqual(
            SecretaryChatTransmissionOrder.nextMessageID(
                scheduledMessageIDs: [first.messageId, second.messageId],
                pendingTurns: [first, second]
            ),
            first.messageId
        )

        first.state = .replyGenerating
        XCTAssertEqual(
            SecretaryChatTransmissionOrder.nextMessageID(
                scheduledMessageIDs: [second.messageId],
                pendingTurns: [first, second]
            ),
            second.messageId
        )

        first.state = .failedRetryPending
        XCTAssertEqual(
            SecretaryChatTransmissionOrder.nextMessageID(
                scheduledMessageIDs: [second.messageId],
                pendingTurns: [first, second]
            ),
            second.messageId
        )
    }

    func testMailboxVoiceRequestCarriesTranscriptWithoutMacUploadAndKeepsLocalResource() throws {
        let draft = SecretaryAttachmentDraft(
            id: "ios_12345678-1234-4234-8234-123456789abc",
            conversationId: "native_yingning_default",
            name: "语音 · 0:04",
            mimeType: "audio/mp4",
            kind: "audio",
            sizeBytes: 1_024,
            durationMs: 4_200,
            transcript: "银月，这条是离线语音。"
        )
        let turn = PendingSecretaryChatTurn.makeVoice(
            conversationId: draft.conversationId,
            attachment: draft,
            expectedConversationVersion: "stale-device-version"
        )

        XCTAssertTrue(turn.hasUnuploadedAttachments)
        XCTAssertFalse(turn.isReadyForStreaming)
        XCTAssertTrue(turn.isReadyForMailbox)
        XCTAssertEqual(turn.mailboxRequest.messageId, turn.messageId)
        XCTAssertEqual(turn.mailboxRequest.generationId, turn.generationId)
        XCTAssertEqual(turn.mailboxRequest.attachments, [
            SecretaryChatMailboxAttachment(
                id: draft.id,
                kind: "audio",
                mimeType: "audio/mp4",
                durationMs: 4_200,
                transcript: "银月，这条是离线语音。",
                resourcePath: "local-draft:\(draft.id)"
            ),
        ])
    }

    func testMailboxClientPostsToNASAndSyncsStableReply() async throws {
        let recorder = AttachmentRequestRecorder()
        AttachmentURLProtocolStub.handler = { request in
            recorder.append(request)
            if request.url?.path == "/api/secretary-mobile/mailbox/messages" {
                return (202, Data(#"{"accepted":true,"duplicate":false,"revision":4}"#.utf8))
            }
            return (200, Data(#"{"schemaVersion":1,"revision":5,"changed":true,"messages":[],"replies":[{"protocolVersion":1,"conversationId":"native_yingning_default","messageId":"reply-gen-12345678","generationId":"gen-12345678","text":"收到了。","speakerId":"yinyue","createdAt":"2026-09-05T00:00:01Z"}]}"#.utf8))
        }
        defer { AttachmentURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AttachmentURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let turn = PendingSecretaryChatTurn(
            conversationId: "native_yingning_default",
            messageId: "msg-12345678",
            generationId: "gen-12345678",
            createdAt: "2026-09-05T00:00:00Z",
            text: "Mac 离线时先收件。",
            expectedConversationVersion: "v1",
            state: .localQueued,
            lastError: nil,
            retryCount: 0,
            autoChat: nil,
            attachments: []
        )
        let connection = SecretaryChatConnection(serverURL: "https://nas.example.test", bearerToken: "mailbox-token")

        let receipt = try await client.persistToMailbox(turn, connection: connection)
        XCTAssertTrue(receipt.accepted)
        let sync = try await client.syncMailbox(
            conversationId: turn.conversationId,
            afterRevision: 4,
            connection: connection
        )

        XCTAssertEqual(sync.replies.map(\.generationId), [turn.generationId])
        XCTAssertEqual(recorder.requests.map { $0.url?.host }, ["nas.example.test", "nas.example.test"])
        XCTAssertEqual(recorder.requests.last?.url?.query, "conversationId=native_yingning_default&afterRevision=4")
        let posted = try JSONDecoder().decode(SecretaryChatMailboxMessageRequest.self, from: XCTUnwrap(recorder.requests.first?.httpBody))
        XCTAssertEqual(posted.messageId, turn.messageId)
    }

    func testConcurrentVoiceQueueAdmissionRunsOneOperationForTheSameStableID() async {
        let admission = SecretaryVoiceQueueAdmission()
        let counter = VoiceQueueInvocationCounter()

        async let first = admission.perform(messageID: "msg-ios_same_stable_id") {
            await counter.recordInvocation()
        }
        async let second = admission.perform(messageID: "msg-ios_same_stable_id") {
            await counter.recordInvocation()
        }

        let results = await (first, second)
        let invocationCount = await counter.value
        XCTAssertTrue(results.0)
        XCTAssertTrue(results.1)
        XCTAssertEqual(invocationCount, 1)
    }

    func testMissingLocalDraftUsesRemoteAttachmentAfterSuccessfulCleanup() {
        XCTAssertEqual(
            SecretaryAttachmentPlaybackSourcePolicy.preferredSource(
                hasLocalDraft: true,
                localFileExists: false,
                resourcePath: "/api/secretary-mobile/attachments/voice/content"
            ),
            .remoteResource
        )
        XCTAssertEqual(
            SecretaryAttachmentPlaybackSourcePolicy.preferredSource(
                hasLocalDraft: true,
                localFileExists: true,
                resourcePath: "/api/secretary-mobile/attachments/voice/content"
            ),
            .localDraft
        )
        XCTAssertEqual(
            SecretaryAttachmentPlaybackSourcePolicy.preferredSource(
                hasLocalDraft: true,
                localFileExists: false,
                resourcePath: "local-draft:voice"
            ),
            .unavailable
        )
    }

    func testVoiceUploadCarriesDurationAndKeepsStableAttachmentID() async throws {
        let recorder = AttachmentRequestRecorder()
        AttachmentURLProtocolStub.handler = { request in
            recorder.append(request)
            return (201, Self.uploadResponse(
                created: true,
                duplicate: false,
                id: "ios_12345678-1234-4234-8234-123456789abc",
                kind: "audio",
                name: "语音 · 0:09",
                mimeType: "audio/mp4"
            ))
        }
        defer { AttachmentURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AttachmentURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let bytes = Data(repeating: 7, count: 2_048)
        try bytes.write(to: fileURL)
        let draft = SecretaryAttachmentDraft(
            id: "ios_12345678-1234-4234-8234-123456789abc",
            conversationId: "native_yingning_default",
            name: "语音 · 0:09",
            mimeType: "audio/mp4",
            kind: "audio",
            sizeBytes: bytes.count,
            durationMs: 9_400
        )

        _ = try await client.uploadAttachment(
            draft,
            fileURL: fileURL,
            connection: .init(serverURL: "https://mac.example.test", bearerToken: "voice-token")
        )

        XCTAssertEqual(recorder.requests.first?.value(forHTTPHeaderField: "X-Infans-Duration-Ms"), "9400")
        XCTAssertEqual(recorder.requests.first?.value(forHTTPHeaderField: "X-Infans-Attachment-Id"), draft.id)
        XCTAssertEqual(recorder.requests.first?.httpBody, bytes)
    }

    private func makeVoiceTurn(id: String) -> PendingSecretaryChatTurn {
        PendingSecretaryChatTurn.makeVoice(
            conversationId: "native_yingning_default",
            attachment: SecretaryAttachmentDraft(
                id: id,
                conversationId: "native_yingning_default",
                name: "语音 · 0:03",
                mimeType: "audio/mp4",
                kind: "audio",
                sizeBytes: 512,
                durationMs: 3_000
            ),
            expectedConversationVersion: "v1"
        )
    }

    func testLegacyPendingTurnWithoutAttachmentsDecodesEmptyArray() throws {
        let data = Data(#"{"conversationId":"native_yingning_default","messageId":"msg-12345678","generationId":"gen-12345678","createdAt":"2026-09-02T00:00:00Z","text":"legacy","expectedConversationVersion":"v1","state":"local_queued","retryCount":0}"#.utf8)
        let turn = try JSONDecoder().decode(PendingSecretaryChatTurn.self, from: data)
        XCTAssertEqual(turn.attachments, [])
        XCTAssertTrue(turn.isReadyForStreaming)
    }

    func testSelectionPolicyRejectsFifthAttachment() {
        XCTAssertTrue(SecretaryAttachmentSelectionPolicy.canAccept(existingCount: 0, incomingCount: 4))
        XCTAssertTrue(SecretaryAttachmentSelectionPolicy.canAccept(existingCount: 3))
        XCTAssertFalse(SecretaryAttachmentSelectionPolicy.canAccept(existingCount: 4))
        XCTAssertFalse(SecretaryAttachmentSelectionPolicy.canAccept(existingCount: 2, incomingCount: 3))
    }

    func testCanonicalFileMIMETypesCoverOfficeAndTextWhitelist() {
        let expected: [String: String] = [
            "document.doc": "application/msword",
            "document.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "table.xls": "application/vnd.ms-excel",
            "table.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "slides.ppt": "application/vnd.ms-powerpoint",
            "slides.pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "readme.md": "text/markdown",
            "rows.csv": "text/csv",
            "data.json": "application/json",
        ]
        for (name, mime) in expected {
            XCTAssertEqual(SecretaryAttachmentMIME.mimeType(forFileName: name), mime)
        }
        XCTAssertNil(SecretaryAttachmentMIME.mimeType(forFileName: "photo.heic"))
        XCTAssertNil(SecretaryAttachmentMIME.mimeType(forFileName: "blob.bin"))
    }

    func testPrivateStagingCopiesBasenameProtectsPermissionsAndDeletesExplicitly() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("secretary-attachment-tests-\(UUID().uuidString)", isDirectory: true)
        let sourceDirectory = root.appendingPathComponent("provider/private/path", isDirectory: true)
        let stageDirectory = root.appendingPathComponent("app-support/private-staging", isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let sourceURL = sourceDirectory.appendingPathComponent("前辈笔记.md")
        let bytes = Data("# 银月".utf8)
        try bytes.write(to: sourceURL)
        let store = SecretaryAttachmentDraftStore(directoryURL: stageDirectory)

        let draft = try await store.stageImportedFile(sourceURL, conversationId: "native_yingning_default")
        let localURL = try await store.localURL(for: draft)
        XCTAssertEqual(draft.name, "前辈笔记.md")
        XCTAssertFalse(draft.localFileName.contains(sourceDirectory.path))
        XCTAssertEqual(try Data(contentsOf: localURL), bytes)
        XCTAssertEqual(try stageDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let directoryMode = try XCTUnwrap((try FileManager.default.attributesOfItem(atPath: stageDirectory.path)[.posixPermissions]) as? NSNumber)
        let fileMode = try XCTUnwrap((try FileManager.default.attributesOfItem(atPath: localURL.path)[.posixPermissions]) as? NSNumber)
        XCTAssertEqual(directoryMode.intValue & 0o777, 0o700)
        XCTAssertEqual(fileMode.intValue & 0o777, 0o600)

        try await store.remove(draft)
        XCTAssertFalse(FileManager.default.fileExists(atPath: localURL.path))
    }

    func testHEICIsReencodedToJPEGWithoutGPSOrCaptureMetadata() throws {
        let heic = try makeHEICWithMetadata()
        let normalized = try SecretaryPhotoNormalizer.normalize(
            heic,
            sourceTypeIdentifier: UTType.heic.identifier,
            suggestedName: "camera.heic"
        )
        XCTAssertEqual(normalized.mimeType, "image/jpeg")
        XCTAssertTrue(normalized.fileName.hasSuffix(".jpg"))
        XCTAssertLessThanOrEqual(normalized.data.count, SecretaryAttachmentMIME.imageMaximumBytes)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(normalized.data as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertNil(properties[kCGImagePropertyExifDictionary])
        XCTAssertNil(properties[kCGImagePropertyTIFFDictionary])
        XCTAssertNotEqual(CGImageSourceGetType(source) as String?, UTType.heic.identifier)
    }

    private func makeHEICWithMetadata() throws -> Data {
        let width = 3
        let height = 2
        let pixels = [UInt8](repeating: 180, count: width * height * 4)
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let image = try XCTUnwrap(CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ))
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.heic.identifier as CFString,
            1,
            nil
        ) else {
            throw XCTSkip("This host cannot encode HEIC")
        }
        let metadata: [CFString: Any] = [
            kCGImagePropertyOrientation: 6,
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 35.0],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:09:02 12:00:00"],
        ]
        CGImageDestinationAddImage(destination, image, metadata as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw XCTSkip("This host cannot finalize HEIC")
        }
        return output as Data
    }

    private static func uploadResponse(
        created: Bool,
        duplicate: Bool,
        id: String = "iosasset_12345678",
        kind: String = "file",
        name: String = "银月 笔记.pdf",
        mimeType: String = "application/pdf"
    ) -> Data {
        Data(#"{"created":\#(created),"duplicate":\#(duplicate),"attachment":{"id":"\#(id)","kind":"\#(kind)","name":"\#(name)","mimeType":"\#(mimeType)","resourcePath":"/api/secretary-mobile/attachments/\#(id)/content","fallbackText":"\#(name)"}}"#.utf8)
    }
}

private actor VoiceQueueInvocationCounter {
    private(set) var value = 0

    func recordInvocation() async -> Bool {
        value += 1
        try? await Task.sleep(for: .milliseconds(20))
        return true
    }
}

private final class AttachmentStatusQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int]

    init(_ values: [Int]) { self.values = values }

    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return values.isEmpty ? 500 : values.removeFirst()
    }
}

private final class AttachmentRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URLRequest] = []

    var requests: [URLRequest] {
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
        storage.append(captured)
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

private final class AttachmentURLProtocolStub: URLProtocol, @unchecked Sendable {
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
