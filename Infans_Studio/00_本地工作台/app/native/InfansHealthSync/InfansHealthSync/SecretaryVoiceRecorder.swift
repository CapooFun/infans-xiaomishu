import AVFoundation
import Foundation

@MainActor
final class SecretaryVoiceRecorder: NSObject, @preconcurrency AVAudioRecorderDelegate {
    static let maximumDuration: TimeInterval = 60

    var onMaximumDurationReached: (@MainActor (TimeInterval) -> Void)?

    private var recorder: AVAudioRecorder?

    var isRecording: Bool { recorder?.isRecording == true }
    var currentDuration: TimeInterval { recorder?.currentTime ?? 0 }

    func requestPermission() async -> Bool {
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted: return true
        case .denied: return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                session.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default: return false
        }
    }

    func start(at fileURL: URL) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true, options: [])
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let next = try AVAudioRecorder(url: fileURL, settings: settings)
        next.delegate = self
        next.isMeteringEnabled = true
        guard next.prepareToRecord(), next.record(forDuration: Self.maximumDuration) else {
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
            throw SecretaryVoiceRecorderError.startFailed
        }
        recorder = next
    }

    @discardableResult
    func stop() -> TimeInterval {
        let duration = min(Self.maximumDuration, max(0, recorder?.currentTime ?? 0))
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        return duration
    }

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        // AVAudioRecorder can report a value close to zero after record(forDuration:)
        // stops automatically. This delegate is the automatic-limit path: manual
        // stop clears self.recorder before its callback arrives.
        guard self.recorder === recorder else { return }
        self.recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        guard flag else { return }
        Task { @MainActor [weak self] in
            self?.onMaximumDurationReached?(Self.maximumDuration)
        }
    }
}

enum SecretaryVoiceRecorderError: LocalizedError {
    case startFailed

    var errorDescription: String? { "无法开始录音，请确认麦克风没有被其他应用占用" }
}
