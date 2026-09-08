import AVFoundation
import QuickLook
import SwiftUI
import UIKit

struct SecretaryAttachmentView: View {
    @ObservedObject var store: SecretaryChatStore
    let attachment: SecretaryChatAttachment

    @State private var localURL: URL?
    @State private var previewURL: URL?
    @State private var isLoading = false
    @State private var loadError: String?
    @StateObject private var audio = SecretaryAttachmentAudioController()

    var body: some View {
        Group {
            switch attachment.presentationKind {
            case .image:
                imageCard
            case .audio:
                audioCard
            case .file:
                fileCard
            }
        }
        .task(id: "\(attachment.id)|\(attachment.resourcePath)") {
            audio.stop()
            localURL = nil
            loadError = nil
            if attachment.presentationKind == .image { await loadIfNeeded() }
        }
        .quickLookPreview($previewURL)
    }

    @ViewBuilder
    private var imageCard: some View {
        if let localURL, let image = UIImage(contentsOfFile: localURL.path) {
            Button { previewURL = localURL } label: {
                VStack(alignment: .leading, spacing: 7) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: 360, minHeight: 120, maxHeight: 240)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                    attachmentCaption(symbol: "photo")
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开图片 \(displayName)")
        } else {
            loadingCard(symbol: "photo", action: { await loadIfNeeded() })
        }
    }

    private var audioCard: some View {
        Button {
            Task {
                if let url = await resolvedURL() { audio.toggle(url) }
            }
        } label: {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 11) {
                    ZStack {
                        Circle().fill(Color.secretaryJade.opacity(0.16))
                        if isLoading {
                            ProgressView().tint(Color.secretaryJade)
                        } else {
                            Image(systemName: audio.isPlaying ? "stop.fill" : "play.fill")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.secretaryJade)
                        }
                    }
                    .frame(width: 38, height: 38)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayName)
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(Color.secretaryIvory)
                            .lineLimit(1)
                        Text(audio.isPlaying ? "正在播放" : "点一下听听")
                            .font(.system(size: 10, design: .rounded))
                            .foregroundStyle(Color.secretaryIvory.opacity(0.48))
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "waveform")
                        .foregroundStyle(Color.secretaryJade.opacity(0.54))
                }
                Text(attachment.transcript ?? attachment.fallbackText)
                    .font(.system(size: 12, weight: .regular, design: .rounded))
                    .foregroundStyle(attachment.transcript == nil ? Color.secretaryIvory.opacity(0.48) : Color.secretaryIvory.opacity(0.88))
                    .multilineTextAlignment(.leading)
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .attachmentCardSurface()
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel(audio.isPlaying ? "停止播放 \(displayName)" : "播放 \(displayName)")
        .overlay(alignment: .bottomLeading) { errorCaption }
    }

    private var fileCard: some View {
        Button {
            Task {
                if let url = await resolvedURL() { previewURL = url }
            }
        } label: {
            HStack(spacing: 11) {
                Image(systemName: fileSymbol)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Color.secretaryJade)
                    .frame(width: 38, height: 38)
                    .background(Color.secretaryJade.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(Color.secretaryIvory)
                        .lineLimit(2)
                    Text(isLoading ? "正在从 Mac 取来…" : "点一下打开")
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(Color.secretaryIvory.opacity(0.48))
                }
                Spacer(minLength: 0)
                if isLoading {
                    ProgressView().tint(Color.secretaryJade)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.secretaryIvory.opacity(0.28))
                }
            }
            .attachmentCardSurface()
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel("打开附件 \(displayName)")
        .overlay(alignment: .bottomLeading) { errorCaption }
    }

    private func loadingCard(symbol: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView().tint(Color.secretaryJade)
                } else {
                    Image(systemName: loadError == nil ? symbol : "arrow.clockwise")
                        .foregroundStyle(Color.secretaryJade)
                }
                Text(loadError ?? "正在从 Mac 取来…")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(loadError == nil ? Color.secretaryIvory.opacity(0.56) : Color.secretaryAmber)
                    .lineLimit(2)
            }
            .attachmentCardSurface()
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }

    private func attachmentCaption(symbol: String) -> some View {
        Label(displayName, systemImage: symbol)
            .font(.system(size: 10, weight: .medium, design: .rounded))
            .foregroundStyle(Color.secretaryIvory.opacity(0.52))
            .lineLimit(1)
    }

    @ViewBuilder
    private var errorCaption: some View {
        if let displayError {
            Text(displayError)
                .font(.system(size: 9, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
                .lineLimit(2)
                .padding(.horizontal, 12)
                .offset(y: 13)
        }
    }

    private var displayName: String {
        if attachment.presentationKind == .audio, let durationMs = attachment.durationMs {
            let totalSeconds = max(1, Int((Double(durationMs) / 1_000).rounded()))
            return String(format: "语音 · %d:%02d", totalSeconds / 60, totalSeconds % 60)
        }
        return attachment.name.isEmpty ? (attachment.fallbackText.isEmpty ? "附件" : attachment.fallbackText) : attachment.name
    }

    private var displayError: String? { loadError ?? audio.lastError }

    private var fileSymbol: String {
        if attachment.mimeType.lowercased().contains("pdf") { return "doc.richtext" }
        if attachment.mimeType.lowercased().contains("zip") { return "archivebox" }
        return "doc"
    }

    private func resolvedURL() async -> URL? {
        if let localURL, FileManager.default.fileExists(atPath: localURL.path) { return localURL }
        self.localURL = nil
        await loadIfNeeded()
        return localURL
    }

    private func loadIfNeeded() async {
        guard localURL == nil, !isLoading else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            localURL = try await store.localAttachmentURL(for: attachment)
        } catch {
            loadError = error.localizedDescription
        }
    }
}

@MainActor
private final class SecretaryAttachmentAudioController: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isPlaying = false
    @Published private(set) var lastError: String?
    private var player: AVAudioPlayer?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(stopForBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(stopForBackground),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func toggle(_ url: URL) {
        if isPlaying {
            stop()
            return
        }
        do {
            lastError = nil
            let session = AVAudioSession.sharedInstance()
            // Explicitly playing a sent voice message should remain audible while the
            // hardware silent switch is on, matching a normal messaging app.
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            player.prepareToPlay()
            self.player = player
            isPlaying = player.play()
        } catch {
            stop()
            lastError = "这段音频暂时不能播放，请在 Mac 上打开。"
        }
    }

    func stop() {
        player?.stop()
        player = nil
        isPlaying = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    @objc private func stopForBackground() { stop() }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }
}

private extension View {
    func attachmentCardSurface() -> some View {
        padding(11)
            .background(Color.secretaryDeepJade.opacity(0.36), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.secretaryJade.opacity(0.17), lineWidth: 1)
            }
    }
}
