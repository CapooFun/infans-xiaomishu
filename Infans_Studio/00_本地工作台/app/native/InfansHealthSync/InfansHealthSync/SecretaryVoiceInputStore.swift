import Foundation
import UIKit

struct SecretaryVoiceCaptureRequest: Identifiable, Equatable, Sendable {
    let id: UUID
    let recording: SecretaryVoiceRecording
    let fileURL: URL

    init(recording: SecretaryVoiceRecording, fileURL: URL, id: UUID = UUID()) {
        self.id = id
        self.recording = recording
        self.fileURL = fileURL
    }
}

@MainActor
final class SecretaryVoiceInputStore: ObservableObject {
    enum Phase: Equatable {
        case idle
        case requestingPermission
        case recording
        case queueing
        case retryable
        case permissionDenied
        case failed
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var statusText: String?
    @Published private(set) var elapsedSeconds = 0
    @Published private(set) var captureRequest: SecretaryVoiceCaptureRequest?

    private let recorder: SecretaryVoiceRecorder
    private let recordingStore: SecretaryVoiceRecordingStore
    private var current: SecretaryVoiceRecording?
    private var recordingURL: URL?
    private var elapsedTask: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var started = false
    private var holdSessionID: UUID?

    init(
        recorder: SecretaryVoiceRecorder? = nil,
        recordingStore: SecretaryVoiceRecordingStore = SecretaryVoiceRecordingStore()
    ) {
        let resolvedRecorder = recorder ?? SecretaryVoiceRecorder()
        self.recorder = resolvedRecorder
        self.recordingStore = recordingStore
        resolvedRecorder.onMaximumDurationReached = { [weak self] duration in
            Task { await self?.finishRecording(duration: duration, queueImmediately: true) }
        }
        let center = NotificationCenter.default
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.handleBackgroundTransition() }
            })
        }
    }

    deinit {
        elapsedTask?.cancel()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    var isRecording: Bool { phase == .recording }
    var isBusy: Bool { phase == .requestingPermission || phase == .queueing }
    var hasRetainedAudio: Bool { current != nil && phase == .retryable }
    var recordingLimitCountdown: Int? {
        guard isRecording, elapsedSeconds >= 50 else { return nil }
        return max(1, 60 - elapsedSeconds)
    }

    func start() async {
        guard !started else { return }
        started = true
        do {
            guard let restored = try await recordingStore.latest() else { return }
            let url = try await recordingStore.audioURL(for: restored)
            current = restored
            recordingURL = url
            phase = .retryable
            statusText = restored.lastError ?? "上次的原声还在这台设备上，可以继续发送"
        } catch {
            phase = .failed
            statusText = error.localizedDescription
        }
    }

    func toggleRecording() async {
        if phase == .recording {
            await finishRecording(duration: recorder.stop(), queueImmediately: true)
            return
        }
        await beginRecording(holdSessionID: nil)
    }

    func beginHoldRecording() async {
        guard holdSessionID == nil, phase != .recording else { return }
        let sessionID = UUID()
        holdSessionID = sessionID
        await beginRecording(holdSessionID: sessionID)
    }

    func endHoldRecording(cancelled: Bool) async {
        guard holdSessionID != nil else { return }
        holdSessionID = nil
        if cancelled {
            await cancelAndDelete()
        } else if phase == .recording {
            await finishRecording(duration: recorder.stop(), queueImmediately: true)
        }
    }

    func retry() {
        guard phase == .retryable, let recording = current, let recordingURL else { return }
        phase = .queueing
        statusText = "正在把原声放进对话…"
        captureRequest = SecretaryVoiceCaptureRequest(recording: recording, fileURL: recordingURL)
    }

    func markQueued(recordingID: String) async {
        guard current?.recordingId == recordingID else { return }
        try? await recordingStore.delete(recordingID: recordingID)
        current = nil
        recordingURL = nil
        captureRequest = nil
        elapsedSeconds = 0
        phase = .idle
        statusText = nil
    }

    func markQueueFailed(recordingID: String, message: String) async {
        guard var retained = current, retained.recordingId == recordingID else { return }
        retained.state = .retryable
        retained.lastError = message
        try? await recordingStore.save(retained)
        current = retained
        captureRequest = nil
        phase = .retryable
        statusText = message
    }

    func cancelAndDelete() async {
        holdSessionID = nil
        elapsedTask?.cancel()
        elapsedTask = nil
        let recording = current
        if phase == .recording { _ = recorder.stop() }
        if let recording {
            try? await recordingStore.delete(recordingID: recording.recordingId)
        } else if let recordingURL, FileManager.default.fileExists(atPath: recordingURL.path) {
            try? FileManager.default.removeItem(at: recordingURL)
        }
        current = nil
        recordingURL = nil
        captureRequest = nil
        elapsedSeconds = 0
        phase = .idle
        statusText = nil
    }

    func dismissStatus() {
        guard current == nil, phase != .recording, phase != .queueing else { return }
        phase = .idle
        statusText = nil
    }

    private func beginRecording(holdSessionID requiredHoldSessionID: UUID?) async {
        guard !isBusy else { return }
        if current != nil {
            if requiredHoldSessionID != nil { holdSessionID = nil }
            statusText = "请先重试或删除上一段原声"
            return
        }
        phase = .requestingPermission
        statusText = "正在请求麦克风权限…"
        guard await recorder.requestPermission() else {
            if requiredHoldSessionID != nil { holdSessionID = nil }
            phase = .permissionDenied
            statusText = "麦克风权限未开启，请到 iPhone「设置」中允许小秘书使用麦克风"
            return
        }
        if let requiredHoldSessionID, holdSessionID != requiredHoldSessionID {
            phase = .idle
            statusText = nil
            return
        }
        guard UIApplication.shared.applicationState == .active else {
            if requiredHoldSessionID != nil { holdSessionID = nil }
            phase = .idle
            statusText = "回到小秘书后再开始录音"
            return
        }
        do {
            let recordingID = "ios_\(UUID().uuidString.lowercased())"
            let url = try await recordingStore.prepareAudioURL(recordingID: recordingID)
            try recorder.start(at: url)
            recordingURL = url
            current = SecretaryVoiceRecording(recordingId: recordingID, durationMs: 1)
            elapsedSeconds = 0
            phase = .recording
            statusText = "正在录原声·最长 60 秒"
            startElapsedUpdates()
        } catch {
            if requiredHoldSessionID != nil { holdSessionID = nil }
            phase = .failed
            statusText = error.localizedDescription
            current = nil
            recordingURL = nil
        }
    }

    private func startElapsedUpdates() {
        elapsedTask?.cancel()
        elapsedTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, self.phase == .recording else { return }
                self.elapsedSeconds = min(60, Int(self.recorder.currentDuration.rounded(.down)))
            }
        }
    }

    private func finishRecording(duration: TimeInterval, queueImmediately: Bool) async {
        guard phase == .recording, let provisional = current else { return }
        holdSessionID = nil
        elapsedTask?.cancel()
        elapsedTask = nil
        if recorder.isRecording { _ = recorder.stop() }
        let durationMs = SecretaryVoiceDurationPolicy.milliseconds(
            reportedSeconds: duration,
            automaticLimitReached: duration >= SecretaryVoiceRecorder.maximumDuration
        )
        var finalized = SecretaryVoiceRecording(
            recordingId: provisional.recordingId,
            createdAt: provisional.createdAt,
            durationMs: durationMs
        )
        do {
            if !queueImmediately {
                finalized.state = .retryable
                finalized.lastError = "已因进入后台安全停止，原声已保留"
            }
            try await recordingStore.save(finalized)
            current = finalized
            let url = try await recordingStore.audioURL(for: finalized)
            recordingURL = url
            if queueImmediately {
                phase = .queueing
                statusText = "正在把原声放进对话…"
                captureRequest = SecretaryVoiceCaptureRequest(recording: finalized, fileURL: url)
            } else {
                phase = .retryable
                statusText = finalized.lastError
            }
        } catch {
            phase = .failed
            statusText = "录音已停止，但保存原声失败：\(error.localizedDescription)"
        }
    }

    private func handleBackgroundTransition() async {
        holdSessionID = nil
        if phase == .recording {
            await finishRecording(duration: recorder.stop(), queueImmediately: false)
        }
    }
}
