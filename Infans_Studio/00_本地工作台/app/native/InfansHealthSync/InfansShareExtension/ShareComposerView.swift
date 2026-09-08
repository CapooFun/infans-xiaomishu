import SwiftUI
import UIKit

@MainActor
final class ShareComposerModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case sending
        case mailboxPersisted
        case delivered
        case failedRetryPending(String)
        case failed(String)
    }

    @Published private(set) var payload = SharePayload(url: "", title: "", text: "", sourceApp: "", images: [], loadError: nil)
    @Published var note = ""
    @Published private(set) var phase: Phase = .loading
    let quickShare = !SecretarySharedConfiguration.usesDetailedSharing

    private let extensionContext: NSExtensionContext
    private let service = InboxIntakeDeliveryService()
    private var queuedItem: YingningIntakeItem?
    private let resultVisibilityNanoseconds: UInt64 = 800_000_000

    init(extensionContext: NSExtensionContext) {
        self.extensionContext = extensionContext
    }

    var contentSummary: String {
        if !payload.images.isEmpty { return payload.images.count == 1 ? payload.images[0].attachment.fileName : "\(payload.images.count) 张原图" }
        if !payload.title.isEmpty { return payload.title }
        if !payload.url.isEmpty { return payload.url }
        return payload.text
    }

    var canSend: Bool {
        payload.hasSupportedContent && payload.loadError == nil && (phase == .ready || isFailed)
    }

    var isReceived: Bool { phase == .delivered || phase == .mailboxPersisted }

    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    var isRetryPending: Bool {
        if case .failedRetryPending = phase { return true }
        return false
    }

    func load() async {
        guard phase == .loading else { return }
        payload = await SharePayloadLoader.load(from: extensionContext.inputItems)
        if let loadError = payload.loadError { phase = .failed(loadError) }
        else { phase = payload.hasSupportedContent ? .ready : .failed("这次没有读到可以收下的网址、文字或照片。") }
        if quickShare && canSend { await send() }
    }

    func send() async {
        guard canSend else { return }
        phase = .sending
        do {
            let item: YingningIntakeItem
            if let queuedItem {
                item = queuedItem
            } else {
                let source: InboxIntakeSource = UIDevice.current.userInterfaceIdiom == .pad
                    ? .iPadOSShareExtension
                    : .iOSShareExtension
                item = YingningIntakeItem(
                    url: payload.url,
                    title: payload.title,
                    text: payload.text,
                    note: note,
                    source: source,
                    sourceSemantic: payload.images.isEmpty ? .sharedContent : .photoShare,
                    sourceApp: payload.sourceApp,
                    deviceID: SecretarySharedConfiguration.deviceID(),
                    deviceName: UIDevice.current.name,
                    attachments: payload.images.map(\.attachment)
                )
                guard item.isValid else { throw YingningIntakeError.invalidContent }
                _ = try await service.enqueue(item, attachmentPayloads: payload.images)
                queuedItem = item
            }
            let serverURL = SecretarySharedConfiguration.mailboxServerURL()
            let token = CodexCommandTokenKeychain.read()
            do {
                let receipt = try await service.deliver(id: item.id, serverURL: serverURL, token: token)
                phase = receipt.deliveryBoundary == "mac_persisted" ? .delivered : .mailboxPersisted
            } catch {
                phase = .failedRetryPending(error.localizedDescription)
            }
            try? await Task.sleep(nanoseconds: resultVisibilityNanoseconds)
            finish()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func finish() {
        extensionContext.completeRequest(returningItems: [], completionHandler: nil)
    }

    func cancel() {
        if queuedItem != nil {
            finish()
            return
        }
        extensionContext.cancelRequest(withError: NSError(
            domain: "com.example.infans.secretary.share",
            code: NSUserCancelledError,
            userInfo: [NSLocalizedDescriptionKey: "用户取消分享"]
        ))
    }
}

struct ShareComposerView: View {
    private let backgroundImage: UIImage?
    private let hasCustomBackground: Bool
    @StateObject private var model: ShareComposerModel
    @FocusState private var noteFocused: Bool
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(extensionContext: NSExtensionContext) {
        _model = StateObject(wrappedValue: ShareComposerModel(extensionContext: extensionContext))
        let custom = SecretarySharedConfiguration.shareBackgroundURL.flatMap { UIImage(contentsOfFile: $0.path) }
        hasCustomBackground = custom != nil
        backgroundImage = custom ?? Self.loadShareBackground()
    }

    var body: some View {
        ZStack {
            Color(red: 0.02, green: 0.08, blue: 0.09)
                .ignoresSafeArea()

            GeometryReader { backgroundProxy in
                if let backgroundImage {
                    Image(uiImage: backgroundImage)
                        .resizable()
                        .scaledToFill()
                        .frame(
                            width: backgroundProxy.size.width,
                            height: backgroundProxy.size.height,
                            alignment: hasCustomBackground ? .center : .topTrailing
                        )
                        .scaleEffect(hasCustomBackground ? 1 : 1.08, anchor: .topTrailing)
                        .offset(
                            x: hasCustomBackground ? 0 : backgroundProxy.size.width * 0.03,
                            y: hasCustomBackground ? 0 : -backgroundProxy.size.height * 0.18
                        )
                }
            }
            .clipped()
            .ignoresSafeArea()

            LinearGradient(
                colors: [
                    Color(red: 0.02, green: 0.08, blue: 0.09).opacity(0.24),
                    Color(red: 0.02, green: 0.08, blue: 0.09).opacity(0.54),
                    Color(red: 0.01, green: 0.05, blue: 0.06).opacity(0.96),
                ],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )
            .ignoresSafeArea()

            if model.quickShare {
                quickShareStatus
            } else {
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("发给秘书")
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .foregroundStyle(Color(red: 0.75, green: 0.91, blue: 0.84))
                                Text("我先替你收着啦")
                                    .font(.caption2)
                                    .foregroundStyle(.white.opacity(0.62))
                            }
                            Spacer()
                            Button(action: model.cancel) {
                                Image(systemName: "xmark")
                                    .font(.system(size: 13, weight: .bold))
                                    .frame(width: 36, height: 36)
                                    .background(.black.opacity(0.26), in: Circle())
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.white.opacity(0.86))
                            .disabled(model.phase == .sending)
                            .accessibilityLabel("先不发了")
                        }

                        Spacer(minLength: horizontalSizeClass == .regular ? 64 : 28)

                        VStack(alignment: .leading, spacing: 13) {
                            sharedContent

                            Text("有什么要悄悄嘱咐我的吗？")
                                .font(.system(size: 14, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.82))

                            ZStack(alignment: .topLeading) {
                                if model.note.isEmpty {
                                    Text("留一句给我的悄悄话，或者直接发送…")
                                        .font(.system(size: 16, weight: .regular, design: .rounded))
                                        .foregroundStyle(.white.opacity(0.36))
                                        .padding(.horizontal, 15)
                                        .padding(.vertical, 14)
                                        .allowsHitTesting(false)
                                }
                                TextEditor(text: $model.note)
                                    .focused($noteFocused)
                                    .scrollContentBackground(.hidden)
                                    .font(.system(size: 16, weight: .regular, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.94))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 7)
                                    .frame(minHeight: 112, maxHeight: 150)
                                    .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .stroke(.white.opacity(noteFocused ? 0.30 : 0.13), lineWidth: 1)
                                    }
                                    .disabled(model.phase == .sending || model.isReceived || model.isRetryPending)
                            }

                            statusView

                            Button {
                                Task { await model.send() }
                            } label: {
                                HStack(spacing: 9) {
                                    if model.phase == .sending {
                                        ProgressView().tint(Color(red: 0.02, green: 0.11, blue: 0.10))
                                    } else if model.isReceived {
                                        Image(systemName: "checkmark")
                                    } else if model.isRetryPending {
                                        Image(systemName: "arrow.clockwise")
                                    } else {
                                        Image(systemName: "paperplane.fill")
                                    }
                                    Text(sendButtonTitle)
                                }
                                .font(.system(size: 17, weight: .bold, design: .rounded))
                                .frame(maxWidth: .infinity, minHeight: 56)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(model.isRetryPending ? Color(red: 0.19, green: 0.11, blue: 0.03) : Color(red: 0.02, green: 0.11, blue: 0.10))
                            .background(
                                LinearGradient(
                                    colors: model.isRetryPending
                                        ? [Color(red: 0.96, green: 0.78, blue: 0.52), Color(red: 0.86, green: 0.61, blue: 0.31)]
                                        : [Color(red: 0.68, green: 0.90, blue: 0.79), Color(red: 0.43, green: 0.78, blue: 0.68)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                            )
                            .shadow(color: Color(red: 0.31, green: 0.75, blue: 0.62).opacity(0.25), radius: 18, y: 8)
                            .disabled(!model.canSend || model.phase == .sending || model.isReceived || model.isRetryPending)
                            .opacity(model.canSend || model.phase == .sending || model.isReceived || model.isRetryPending ? 1 : 0.48)
                        }
                        .padding(18)
                        .background(
                            LinearGradient(
                                colors: [
                                    Color(red: 0.03, green: 0.10, blue: 0.11).opacity(0.72),
                                    Color(red: 0.01, green: 0.05, blue: 0.06).opacity(0.56),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            in: RoundedRectangle(cornerRadius: 26, style: .continuous)
                        )
                        .environment(\.colorScheme, .dark)
                        .overlay {
                            RoundedRectangle(cornerRadius: 26, style: .continuous)
                                .stroke(.white.opacity(0.12), lineWidth: 1)
                        }
                    }
                    .padding(horizontalSizeClass == .regular ? 30 : 16)
                    .padding(.vertical, 18)
                    .frame(maxWidth: horizontalSizeClass == .regular ? 570 : .infinity, minHeight: proxy.size.height, alignment: .bottomLeading)
                    .frame(maxWidth: .infinity, alignment: horizontalSizeClass == .regular ? .leading : .center)
                }
            }
            }
        }
        .task { await model.load() }
        .onChange(of: model.phase) { _, phase in
            if phase == .ready && !model.quickShare { noteFocused = true }
        }
        .preferredColorScheme(.dark)
    }

    private var quickShareStatus: some View {
        VStack(spacing: 18) {
            if model.phase == .loading || model.phase == .sending {
                ProgressView().tint(.white)
            } else {
                Image(systemName: model.isFailed ? "exclamationmark.circle" : "checkmark.circle.fill")
                    .font(.system(size: 38))
                    .foregroundStyle(Color(red: 0.68, green: 0.90, blue: 0.79))
            }
            Text("发给秘书").font(.headline)
            statusView
                .font(.subheadline)
                .multilineTextAlignment(.center)
            if model.isFailed {
                if model.canSend {
                    Button("再试一次") { Task { await model.send() } }
                }
                Button("关闭", action: model.cancel)
            }
        }
        .foregroundStyle(.white)
        .padding(28)
        .frame(maxWidth: 400)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 24))
        .padding(24)
    }

    private var sendButtonTitle: String {
        if model.phase == .sending { return "正在接过来…" }
        if model.phase == .delivered { return "收好啦！" }
        if model.phase == .mailboxPersisted { return "信箱已收" }
        if model.isRetryPending { return "我先收着，等会再试" }
        if model.isFailed { return "再试一次" }
        return "交给银月"
    }

    private static func loadShareBackground() -> UIImage? {
        guard let url = Bundle.main.url(
            forResource: "YinyueShareBackground",
            withExtension: "jpg"
        ) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    private var sharedContent: some View {
        HStack(spacing: 11) {
                if let image = model.payload.images.first.flatMap({ UIImage(data: $0.data) }) {
                    Image(uiImage: image)
                        .resizable().scaledToFill()
                        .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else {
                    Image(systemName: model.payload.url.isEmpty ? "text.quote" : "link")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(red: 0.76, green: 0.91, blue: 0.84))
                .frame(width: 30, height: 30)
                .background(.white.opacity(0.08), in: Circle())
                }
            VStack(alignment: .leading, spacing: 2) {
                Text("正在分享")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.50))
                Text(model.contentSummary.isEmpty ? "正在读取内容……" : model.contentSummary)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.90))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(11)
        .background(.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    private var statusView: some View {
        switch model.phase {
        case .loading:
            HStack { ProgressView(); Text("正在读取分享内容……") }
        case .ready:
            Text("悄悄话可以留空；交给我后这里会自动关闭。")
        case .sending:
            Text("我正在接过来…")
        case .mailboxPersisted:
            Text("信箱已收下，等待 Mac 保存；可以放心关闭。")
                .foregroundStyle(Color(red: 0.68, green: 0.90, blue: 0.79))
        case .delivered:
            Text("已经安全收好啦！")
                .foregroundStyle(Color(red: 0.68, green: 0.90, blue: 0.79))
        case .failedRetryPending:
            Text("先在这台设备存好了，联网后会自动送达～")
            .foregroundStyle(Color(red: 1.0, green: 0.78, blue: 0.52))
        case let .failed(message):
            Text(message)
                .foregroundStyle(Color(red: 1.0, green: 0.74, blue: 0.53))
        }
        EmptyView()
    }
}
