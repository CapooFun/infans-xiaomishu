import Foundation
import Testing
@testable import HealthSyncScheduleCore

@Test func rawVoiceRecordingKeepsStableIDAcrossFileAndStatusHops() throws {
    let id = "d6836064-cef1-41f1-aaba-96629d45a07b"
    let recording = RawVoiceRecording(
        recordingId: id,
        createdAt: Date(timeIntervalSince1970: 1_788_350_000),
        deviceID: "watch-test",
        state: .queuedToPhone
    )
    #expect(recording.isValid)
    #expect(recording.fileName == "\(id).m4a")

    let decoded = try #require(RawVoiceRecording.fromFileTransferMetadata(recording.fileTransferMetadata))
    #expect(decoded.recordingId == id)
    #expect(decoded.deviceID == "watch-test")

    let status = RawVoiceStatusMessage(
        recordingID: id,
        state: .providerUnavailable,
        transcript: nil,
        error: "模型尚未接入"
    )
    #expect(RawVoiceStatusMessage.fromConnectivityPayload(status.connectivityPayload) == status)

    let acknowledgement = RawVoiceDeliveryAcknowledgement(
        recordingID: id,
        deviceID: "watch-test",
        stage: .watchTranscriptPersisted,
        at: Date(timeIntervalSince1970: 1_788_350_010)
    )
    #expect(
        RawVoiceDeliveryAcknowledgement.fromConnectivityPayload(acknowledgement.connectivityPayload)
            == acknowledgement
    )
}

@Test func rawVoiceStoreOnlyDeletesAudioAfterTheNextHopIsDurable() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("raw-voice-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.deletingLastPathComponent()
        .appendingPathComponent("raw-voice-source-\(UUID().uuidString).m4a")
    defer { try? FileManager.default.removeItem(at: source) }
    try Data([0, 1, 2, 3]).write(to: source)

    let recording = RawVoiceRecording(deviceID: "watch-test", state: .queuedToPhone)
    let persisted = try PendingRawVoiceRecordingStore.stageIncomingFileSynchronously(
        source,
        recording: recording,
        directoryURL: directory
    )
    #expect(persisted.state == .phonePersisted)
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)

    let phoneCopy = try #require(await store.item(recording.recordingId))
    #expect(phoneCopy.state == .phonePersisted)
    #expect(await store.containsAudio(recording.recordingId))

    _ = try await store.mark(
        recording.recordingId,
        state: .transcriptReady,
        transcript: "银月，我回来了"
    )
    try await store.removeAudio(recording.recordingId)
    #expect(!(await store.containsAudio(recording.recordingId)))
    #expect((try await store.item(recording.recordingId))?.transcript == "银月，我回来了")

    let duplicate = try PendingRawVoiceRecordingStore.stageIncomingFileSynchronously(
        source,
        recording: recording,
        directoryURL: directory
    )
    #expect(duplicate.state == .transcriptReady)
    #expect(duplicate.transcript == "银月，我回来了")
    #expect(!(await store.containsAudio(recording.recordingId)))

    try await store.remove(recording.recordingId)
    #expect(try await store.item(recording.recordingId) == nil)
}

@Test func disabledRawVoiceProviderIsExplicitAndNeverPretendsToFallback() async {
    let provider = DisabledRawVoiceTranscriptionProvider()
    #expect(provider.availability.state == .disabled)
    #expect(provider.availability.reason == "Mac 本地转写模型尚未接入")
    await #expect(throws: RawVoiceTranscriptionError.self) {
        try await provider.transcribe(
            fileURL: URL(fileURLWithPath: "/tmp/not-read.m4a"),
            recording: RawVoiceRecording(deviceID: "watch-test")
        )
    }
}

@Test func watchVoiceRoutesSurviveNewRecordingsAndOutOfOrderTranscripts() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-routes-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let first = RawVoiceRecording(deviceID: "watch", state: .queuedToPhone)
    let second = RawVoiceRecording(deviceID: "watch", state: .queuedToPhone)
    try await store.upsert(first)
    try await store.selectDestination(first.id, route: .companion, conversationKey: "first-conversation")
    try await store.upsert(second)
    try await store.selectDestination(second.id, route: .codex, conversationKey: "second-conversation")
    let restored = PendingRawVoiceRecordingStore(directoryURL: directory)
    for row in [second, first] {
        _ = try await restored.applyWatchStatus(.init(recordingID: row.id, state: .transcriptReady, transcript: "测试 \(row.id)", error: nil))
    }
    let a = try #require(await restored.prepareCommand(first.id))
    let b = try #require(await restored.prepareCommand(second.id))
    #expect(a.id == first.id && b.id == second.id)
    #expect(a.route == .companion && b.route == .codex)
    #expect(a.conversationKey == "first-conversation" && b.conversationKey == "second-conversation")
    #expect(a.createdAt == first.createdAt)
}

@Test func watchVoiceReservationIsStableAcrossCrashAndDuplicateReceipt() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-reserve-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let row = RawVoiceRecording(deviceID: "watch", state: .transcriptReady, transcript: "原本的话")
    try await store.upsert(row)
    try await store.selectDestination(row.id, route: .companion, conversationKey: "original")
    let reserved = try #require(await store.prepareCommand(row.id))
    let restored = PendingRawVoiceRecordingStore(directoryURL: directory)
    #expect(try await restored.item(row.id)?.commandEnqueued == false)
    _ = try await restored.applyWatchStatus(.init(recordingID: row.id, state: .transcriptReady, transcript: "迟到的不同内容", error: nil))
    try await restored.selectDestination(row.id, route: .codex, conversationKey: "changed")
    #expect(try await restored.prepareCommand(row.id) == reserved)
    try await restored.markCommandEnqueued(row.id)
    #expect(try await PendingRawVoiceRecordingStore(directoryURL: directory).item(row.id)?.commandEnqueued == true)
    #expect(try await restored.item(row.id)?.transcript == "原本的话")
}

@Test func watchVoiceStatusDoesNotRegressCompletedTranscriptOrResurrectDeletedRecording() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-late-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let row = RawVoiceRecording(deviceID: "watch", state: .transcriptReady, transcript: "已经存好")
    try await store.upsert(row)
    for state in [RawVoiceRecordingState.phonePersisted, .transcribing, .failed] {
        let result = try #require(await store.applyWatchStatus(.init(recordingID: row.id, state: state, transcript: nil, error: "迟到错误")))
        #expect(result.state == .transcriptReady && result.lastError == nil)
    }
    _ = try await store.applyWatchStatus(.init(recordingID: row.id, state: .cancelled, transcript: nil, error: nil))
    #expect(try await store.prepareCommand(row.id) == nil)
    #expect(try await store.applyWatchStatus(.init(recordingID: row.id, state: .transcriptReady, transcript: "重放", error: nil))?.state == .cancelled)
    try await store.remove(row.id)
    #expect(try await store.applyWatchStatus(.init(recordingID: row.id, state: .transcriptReady, transcript: "重放", error: nil)) == nil)
}

@Test func watchLegacyTranscriptNeedsExplicitRouteAndKeepsBothRecordingsRecoverable() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-legacy-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let id = UUID().uuidString.lowercased()
    let legacy = """
    {"recordingId":"\(id)","createdAt":"2026-09-03T12:09:26Z","deviceID":"watch","fileName":"\(id).m4a","mimeType":"audio/mp4","state":"transcript_ready","transcript":"旧的锁屏测试"}
    """
    let row = try JSONDecoder().decode(RawVoiceRecording.self, from: Data(legacy.utf8))
    #expect(row.needsDestination && row.commandEnqueued == nil)
    try await store.upsert(row)
    try await store.upsert(RawVoiceRecording(deviceID: "watch", state: .queuedToPhone))
    #expect(try await store.prepareCommand(row.id) == nil)
    #expect(try await store.items().filter { $0.needsDestination }.count == 2)
    try await store.selectDestination(row.id, route: .companion, conversationKey: "recover")
    #expect(try await store.prepareCommand(row.id)?.id == id)
    #expect(try await store.items().filter { $0.needsDestination }.count == 1)
}

@Test func watchVoiceDoesNotAcknowledgeAnUnpersistedOrEmptyTranscript() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-invalid-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let row = RawVoiceRecording(deviceID: "watch", state: .phonePersisted)
    try await store.upsert(row)
    #expect(try await store.applyWatchStatus(.init(recordingID: row.id, state: .transcriptReady, transcript: "  ", error: nil)) == nil)
    #expect(try await store.item(row.id)?.state == .phonePersisted)
    try Data("invalid".utf8).write(to: PendingRawVoiceRecordingStore.metadataURL(for: row.id, in: directory))
    await #expect(throws: (any Error).self) {
        try await store.applyWatchStatus(.init(recordingID: row.id, state: .transcriptReady, transcript: "不能丢掉手机副本", error: nil))
    }
}

@MainActor @Test func phoneRetriesSavedTranscriptWithoutProviderOrWrongDeviceMutation() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-phone-replay-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let row = RawVoiceRecording(deviceID: "watch", state: .transcriptReady, transcript: "锁屏测试")
    try await store.upsert(row)
    let pipeline = PhoneRawVoicePipeline(store: store, provider: DisabledRawVoiceTranscriptionProvider())
    var replies: [RawVoiceStatusMessage] = []
    pipeline.setStatusHandler { replies.append($0) }
    let retry = RawVoiceControlMessage(recordingID: row.id, deviceID: "watch", action: .retry)
    #expect(RawVoiceControlMessage.fromConnectivityPayload(retry.connectivityPayload) == retry)
    await pipeline.receive(.init(recordingID: row.id, deviceID: "other-watch", action: .delete))
    #expect(try await store.item(row.id) != nil)
    await pipeline.receive(retry)
    await pipeline.receive(retry)
    #expect(replies.count == 2 && replies.allSatisfy { $0.recordingID == row.id && $0.state == .transcriptReady })
    #expect(try await store.item(row.id)?.transcript == "锁屏测试")
}

@Test func phoneCleanupAckCannotHideUnroutedWatchTranscript() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-ack-before-choice-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let row = RawVoiceRecording(deviceID: "watch", state: .transcriptReady, transcript: "仍然需要选去向")
    try await store.upsert(row)
    for _ in 0..<3 {
        let saved = try #require(await store.applyWatchStatus(.init(recordingID: row.id, state: .watchTranscriptPersisted, transcript: nil, error: nil)))
        #expect(saved.state == .transcriptReady && saved.needsDestination)
    }
    let restarted = PendingRawVoiceRecordingStore(directoryURL: directory)
    try await restarted.selectDestination(row.id, route: .companion, conversationKey: "test")
    // A double-tap cannot change a selection before command reservation.
    try await restarted.selectDestination(row.id, route: .codex, conversationKey: "other")
    let command = try #require(await restarted.prepareCommand(row.id))
    #expect(command.id == row.id && command.route == .companion)
}

@Test func legacyCleanupStateStillAllowsExplicitWatchRecovery() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("raw-legacy-ack-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingRawVoiceRecordingStore(directoryURL: directory)
    let row = RawVoiceRecording(deviceID: "watch", state: .watchTranscriptPersisted, transcript: "兼容旧状态")
    #expect(row.needsDestination)
    try await store.upsert(row)
    try await store.selectDestination(row.id, route: .companion, conversationKey: "test")
    #expect(try await store.prepareCommand(row.id)?.id == row.id)
}
