import AVFoundation
import CryptoKit
import Foundation
import UIKit
import UserNotifications

@MainActor
final class SecretaryChatNotificationRouter: ObservableObject {
    static let shared = SecretaryChatNotificationRouter()

    @Published private(set) var pendingConversationID: String?

    init() {}

    func receive(conversationID: String?) {
        let normalized = conversationID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty else { return }
        pendingConversationID = normalized
    }

    func consume(_ conversationID: String) {
        guard pendingConversationID == conversationID else { return }
        pendingConversationID = nil
    }
}

@MainActor
final class SecretarySpeechPreferences: ObservableObject {
    static let shared = SecretarySpeechPreferences()

    @Published var automaticallyReadsReplies: Bool {
        didSet { defaults.set(automaticallyReadsReplies, forKey: Keys.automaticallyReadsReplies) }
    }
    @Published var videoFeelEnabled: Bool {
        didSet { defaults.set(videoFeelEnabled, forKey: Keys.videoFeelEnabled) }
    }
    @Published var rate: SecretarySpeechRateSetting {
        didSet { defaults.set(rate.rawValue, forKey: Keys.rate) }
    }

    private enum Keys {
        static let automaticallyReadsReplies = "secretaryChat.speech.automaticallyReadsReplies"
        static let videoFeelEnabled = "secretaryChat.speech.videoFeelEnabled"
        static let rate = "secretaryChat.speech.rate"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        automaticallyReadsReplies = defaults.bool(forKey: Keys.automaticallyReadsReplies)
        videoFeelEnabled = defaults.object(forKey: Keys.videoFeelEnabled) as? Bool ?? true
        rate = SecretarySpeechRateSetting(rawValue: defaults.string(forKey: Keys.rate) ?? "") ?? .natural
    }
}

enum SecretaryVoicePlaybackPhase: Equatable {
    case idle
    case preparing
    case playing
    case paused
    case failed
}

struct SecretaryVoicePlaybackBinding: Equatable {
    let phase: SecretaryVoicePlaybackPhase
    let messageID: String?
    let speakerID: String?
    let speakerName: String?
    let spokenText: String?
    let progress: Double
    let statusText: String?
    let failureDetail: String?
    let canRetry: Bool
}

private enum SecretaryVoicePlaybackError: LocalizedError {
    case invalidServerURL
    case tokenUnavailable
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: return "Mac 私有 HTTPS 地址不合法"
        case .tokenUnavailable: return "请先在设置中保存小秘书指令令牌"
        case .invalidResponse: return "Mac 没有返回可播放的银月语音"
        case let .server(message): return message
        }
    }
}

private struct SecretaryVoicePlaybackRequest: Encodable {
    let messageId: String
    let speaker: String
    let text: String
}

private struct SecretaryVoicePlaybackServerError: Decodable {
    let error: String?
}

private struct SecretaryVoicePlaybackResource {
    let data: Data
    let voice: String?
    let provider: String?
    let cache: String?
}

private struct SecretaryVoicePlaybackClient {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func synthesize(
        message: SecretaryChatMessage,
        serverURL: String,
        bearerToken: String
    ) async throws -> SecretaryVoicePlaybackResource {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !bearerToken.isEmpty else { throw SecretaryVoicePlaybackError.tokenUnavailable }
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw SecretaryVoicePlaybackError.invalidServerURL
        }
        let url = base.appendingPathComponent("api/secretary-mobile/tts")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(SecretaryVoicePlaybackRequest(
            messageId: message.id,
            speaker: message.sender.id,
            text: message.spokenText
        ))

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SecretaryVoicePlaybackError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let decoded = try? JSONDecoder().decode(SecretaryVoicePlaybackServerError.self, from: data)
            throw SecretaryVoicePlaybackError.server(decoded?.error ?? "Mac 暂时无法生成银月语音")
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        guard contentType.hasPrefix("audio/"), data.count > 128 else {
            throw SecretaryVoicePlaybackError.invalidResponse
        }
        return SecretaryVoicePlaybackResource(
            data: data,
            voice: http.value(forHTTPHeaderField: "X-Secretary-Voice"),
            provider: http.value(forHTTPHeaderField: "X-Secretary-Voice-Provider"),
            cache: http.value(forHTTPHeaderField: "X-Secretary-Voice-Cache")
        )
    }
}

private actor SecretaryVoiceAudioCache {
    static let shared = SecretaryVoiceAudioCache()

    private let fileManager = FileManager.default
    private let maximumFiles = 48
    private let maximumBytes = 64 * 1024 * 1024

    func data(for key: String) -> Data? {
        let url = cacheDirectory().appendingPathComponent("\(key).mp3")
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), !data.isEmpty else { return nil }
        try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    func save(_ data: Data, for key: String) throws {
        let directory = cacheDirectory()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedDirectory = directory
        try? protectedDirectory.setResourceValues(values)

        let destination = directory.appendingPathComponent("\(key).mp3")
        try data.write(to: destination, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var protectedFile = destination
        try? protectedFile.setResourceValues(values)
        prune(directory: directory)
    }

    private func cacheDirectory() -> URL {
        let base = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return base.appendingPathComponent("SecretaryVoicePlayback", isDirectory: true)
    }

    private func prune(directory: URL) {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        guard var files = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return }
        files = files.filter { $0.pathExtension == "mp3" }
        files.sort {
            let left = (try? $0.resourceValues(forKeys: keys).contentModificationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: keys).contentModificationDate) ?? .distantPast
            return left > right
        }
        var keptBytes = 0
        for (index, file) in files.enumerated() {
            let size = (try? file.resourceValues(forKeys: keys).fileSize) ?? 0
            keptBytes += size
            if index < maximumFiles && keptBytes <= maximumBytes { continue }
            try? fileManager.removeItem(at: file)
        }
    }
}

@MainActor
final class SecretarySpeechController: NSObject, ObservableObject, AVAudioPlayerDelegate {
    static let shared = SecretarySpeechController()

    @Published private(set) var speakingMessageID: String?
    @Published private(set) var phase: SecretaryVoicePlaybackPhase = .idle
    @Published private(set) var progress: Double = 0
    @Published private(set) var currentSpeakerID: String?
    @Published private(set) var currentSpeakerName: String?
    @Published private(set) var currentSpokenText: String?
    @Published private(set) var statusText: String?
    @Published private(set) var failureDetail: String?
    @Published private(set) var voiceName: String?
    @Published private(set) var providerName: String?

    private let preferences: SecretarySpeechPreferences
    private let client: SecretaryVoicePlaybackClient
    private let cache: SecretaryVoiceAudioCache
    private var player: AVAudioPlayer?
    private var playbackTask: Task<Void, Never>?
    private var progressTask: Task<Void, Never>?
    private var retryMessage: SecretaryChatMessage?
    private var observers: [NSObjectProtocol] = []
    private var generation = 0

    override convenience init() {
        self.init(preferences: .shared)
    }

    private init(
        preferences: SecretarySpeechPreferences,
        client: SecretaryVoicePlaybackClient = SecretaryVoicePlaybackClient(),
        cache: SecretaryVoiceAudioCache = .shared
    ) {
        self.preferences = preferences
        self.client = client
        self.cache = cache
        super.init()
        let center = NotificationCenter.default
        for name in [
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            AVAudioSession.interruptionNotification,
        ] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.stop() }
            })
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    var binding: SecretaryVoicePlaybackBinding {
        SecretaryVoicePlaybackBinding(
            phase: phase,
            messageID: speakingMessageID ?? retryMessage?.id,
            speakerID: currentSpeakerID,
            speakerName: currentSpeakerName,
            spokenText: currentSpokenText,
            progress: progress,
            statusText: statusText,
            failureDetail: failureDetail,
            canRetry: phase == .failed && retryMessage != nil
        )
    }

    func toggle(_ message: SecretaryChatMessage) {
        if speakingMessageID == message.id && phase == .paused {
            resume()
        } else if speakingMessageID == message.id {
            stop()
        } else {
            speak(message)
        }
    }

    func automaticallySpeakIfNeeded(_ message: SecretaryChatMessage) {
        guard preferences.automaticallyReadsReplies,
              UIApplication.shared.applicationState == .active else { return }
        speak(message)
    }

    func speak(_ message: SecretaryChatMessage) {
        let text = message.spokenText
        guard !message.isFromCapoo, !text.isEmpty else { return }
        stop(clearPresentation: false)
        generation += 1
        let requestGeneration = generation
        speakingMessageID = message.id
        retryMessage = message
        currentSpeakerID = message.sender.id
        currentSpeakerName = message.sender.displayName
        currentSpokenText = text
        phase = .preparing
        progress = 0
        statusText = "正在从 Mac 取得\(message.sender.displayName)的声音…"
        failureDetail = nil
        voiceName = nil
        providerName = nil

        let cacheKey = Self.cacheKey(for: message)
        playbackTask = Task { [weak self] in
            guard let self else { return }
            do {
                let data: Data
                if let cached = await cache.data(for: cacheKey) {
                    data = cached
                } else {
                    guard let token = CodexCommandTokenKeychain.read(), !token.isEmpty else {
                        throw SecretaryVoicePlaybackError.tokenUnavailable
                    }
                    let resource = try await client.synthesize(
                        message: message,
                        serverURL: CodexCommandSettings.shared.serverURL,
                        bearerToken: token
                    )
                    guard !Task.isCancelled, requestGeneration == generation else { return }
                    data = resource.data
                    voiceName = resource.voice
                    providerName = resource.provider
                    try? await cache.save(data, for: cacheKey)
                }
                guard !Task.isCancelled, requestGeneration == generation else { return }
                try startPlayback(data, message: message)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, requestGeneration == generation else { return }
                fail(message: message, error: error)
            }
        }
    }

#if DEBUG && targetEnvironment(simulator)
    func playCharacterQAAudio(_ message: SecretaryChatMessage) async {
        stop()
        do {
            let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18765/fixture.wav")!)
            speakingMessageID = message.id
            currentSpokenText = message.spokenText
            try startPlayback(data, message: message)
        } catch { stop() }
    }
#endif

    func retry() {
        guard let retryMessage else { return }
        speak(retryMessage)
    }

    func pause() {
        guard phase == .playing else { return }
        player?.pause()
        progressTask?.cancel()
        phase = .paused
        statusText = "朗读已暂停"
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func resume() {
        guard phase == .paused, let player, UIApplication.shared.applicationState == .active else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            guard player.play() else { throw SecretaryVoicePlaybackError.invalidResponse }
            phase = .playing
            observeProgress()
        } catch { stop() }
    }

    func stop() {
        stop(clearPresentation: true)
    }

    private func stop(clearPresentation: Bool) {
        generation += 1
        playbackTask?.cancel()
        playbackTask = nil
        progressTask?.cancel()
        progressTask = nil
        player?.stop()
        player = nil
        speakingMessageID = nil
        phase = .idle
        progress = 0
        statusText = nil
        failureDetail = nil
        voiceName = nil
        providerName = nil
        if clearPresentation {
            retryMessage = nil
            currentSpeakerID = nil
            currentSpeakerName = nil
            currentSpokenText = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func startPlayback(_ data: Data, message: SecretaryChatMessage) throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audioSession.setActive(true)
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        player.enableRate = true
        player.rate = preferences.rate.rateMultiplier
        guard player.prepareToPlay(), player.play() else {
            throw SecretaryVoicePlaybackError.invalidResponse
        }
        self.player = player
        phase = .playing
        statusText = "\(message.sender.displayName)正在朗读"
        observeProgress()
    }

    private func observeProgress() {
        progressTask?.cancel()
        progressTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, let player = self.player, player.isPlaying else { return }
                self.progress = player.duration > 0 ? min(1, max(0, player.currentTime / player.duration)) : 0
            }
        }
    }

    private func fail(message: SecretaryChatMessage, error: Error) {
        player?.stop()
        player = nil
        progressTask?.cancel()
        progressTask = nil
        speakingMessageID = nil
        retryMessage = message
        phase = .failed
        progress = 0
        statusText = "暂不可朗读，文字仍在"
        failureDetail = error.localizedDescription
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private static func cacheKey(for message: SecretaryChatMessage) -> String {
        let payload = Data("secretary-mobile-edge-v2\u{0}\(message.sender.id)\u{0}\(message.spokenText)".utf8)
        return SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === player else { return }
            if flag {
                self.stop(clearPresentation: true)
            } else if let message = self.retryMessage {
                self.fail(message: message, error: SecretaryVoicePlaybackError.invalidResponse)
            }
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            guard self.player === player else { return }
            guard let message = self.retryMessage else { return }
            self.fail(message: message, error: error ?? SecretaryVoicePlaybackError.invalidResponse)
        }
    }
}

@MainActor
final class SecretaryChatNotificationController: ObservableObject {
    static let shared = SecretaryChatNotificationController()

    @Published var enabled: Bool {
        didSet { defaults.set(enabled, forKey: Keys.enabled) }
    }
    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var lastError: String?

    private enum Keys {
        static let enabled = "secretaryChat.notifications.enabled"
        static let handledMessageIDs = "secretaryChat.notifications.handledMessageIDs"
    }

    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private var handledMessageIDs: Set<String>
    private var handledMessageOrder: [String]

    init(
        center: UNUserNotificationCenter = .current(),
        defaults: UserDefaults = .standard
    ) {
        self.center = center
        self.defaults = defaults
        enabled = defaults.bool(forKey: Keys.enabled)
        let storedIDs = defaults.stringArray(forKey: Keys.handledMessageIDs) ?? []
        handledMessageOrder = Array(storedIDs.suffix(500))
        handledMessageIDs = Set(handledMessageOrder)
    }

    var authorizationGranted: Bool {
        [.authorized, .provisional, .ephemeral].contains(authorizationStatus)
    }

    var authorizationText: String {
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "系统通知已允许"
        case .denied: return "系统通知已关闭，可在 iPhone 设置中重新打开"
        case .notDetermined: return "还没有请求系统通知权限"
        @unknown default: return "暂时无法读取系统通知状态"
        }
    }

    func refreshAuthorization() async {
        authorizationStatus = await center.notificationSettings().authorizationStatus
    }

    /// Must only be called from the explicit settings button.
    func requestAuthorization() async {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorization()
            if granted { enabled = true }
            lastError = granted ? nil : "你没有允许系统通知。"
        } catch {
            lastError = error.localizedDescription
            await refreshAuthorization()
        }
    }

    func notifyIfNeeded(
        message: SecretaryChatMessage,
        conversation: SecretaryChatConversation
    ) async {
        await refreshAuthorization()
        let isPrivate = conversation.privacy == "private" || conversation.chatState.privacy == "private"
        guard let plan = SecretaryChatNotificationPolicy.plan(
            for: message,
            conversationIsPrivate: isPrivate,
            appIsActive: UIApplication.shared.applicationState == .active,
            notificationsEnabled: enabled,
            authorizationGranted: authorizationGranted,
            handledMessageIDs: handledMessageIDs
        ) else { return }

        let content = UNMutableNotificationContent()
        content.title = plan.title
        content.body = plan.body
        content.sound = .default
        content.userInfo = [
            "conversationId": conversation.id,
            "messageId": message.id,
        ]
        do {
            try await center.add(UNNotificationRequest(identifier: plan.identifier, content: content, trigger: nil))
            handledMessageIDs.insert(message.id)
            handledMessageOrder.removeAll { $0 == message.id }
            handledMessageOrder.append(message.id)
            if handledMessageOrder.count > 500 {
                handledMessageOrder.removeFirst(handledMessageOrder.count - 500)
                handledMessageIDs = Set(handledMessageOrder)
            }
            defaults.set(handledMessageOrder, forKey: Keys.handledMessageIDs)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}
