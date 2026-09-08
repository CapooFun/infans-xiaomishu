import AppIntents
import AVFoundation
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
final class QuickPhotoInboxRouter: ObservableObject {
    static let shared = QuickPhotoInboxRouter()
    @Published var isPresented = false

    func open() { isPresented = true }
    func close() { isPresented = false }

    func handle(url: URL) {
        guard url.scheme == "infans-secretary", url.host == "quick-photo" else { return }
        open()
    }
}

struct OpenQuickPhotoInboxIntent: AppIntent {
    static let title: LocalizedStringResource = "快速拍照收件箱"
    static let description = IntentDescription("打开独立收件相机，按下快门就存入收件箱。")
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickPhotoInboxRouter.shared.open()
        return .result()
    }
}

struct SaveScreenshotToInboxIntent: AppIntent {
    static let title: LocalizedStringResource = "收下截屏"
    static let description = IntentDescription("把快捷指令刚截下的屏幕直接存入收件箱，不打开 App，也不要求确认。")
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(
        title: "截屏",
        description: "连接快捷指令中“截屏”动作的结果。",
        supportedTypeIdentifiers: ["public.image"],
        inputConnectionBehavior: .connectToPreviousIntentResult
    )
    var screenshot: IntentFile

    static var parameterSummary: some ParameterSummary {
        Summary("把 \(\.$screenshot) 收进收件箱")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let data = screenshot.data
        guard !data.isEmpty, data.count <= YingningIntakeAttachment.maximumBytesPerFile else {
            throw YingningIntakeError.attachmentUnavailable
        }
        let imageSource = CGImageSourceCreateWithData(data as CFData, nil)
        let detectedType = imageSource.flatMap(CGImageSourceGetType).flatMap { UTType($0 as String) }
        let contentType = detectedType?.preferredMIMEType ?? screenshot.type?.preferredMIMEType ?? ""
        guard YingningIntakeAttachment.allowedContentTypes.contains(contentType) else {
            throw YingningIntakeError.attachmentUnavailable
        }
        let properties = imageSource.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }
        let width = properties?[kCGImagePropertyPixelWidth] as? Int
        let height = properties?[kCGImagePropertyPixelHeight] as? Int
        let fileExtension = detectedType?.preferredFilenameExtension ?? screenshot.type?.preferredFilenameExtension ?? "png"
        let payload = YingningIntakeAttachmentPayload(
            fileName: "SCREENSHOT_\(Self.timestamp()).\(fileExtension.uppercased())",
            contentType: contentType,
            data: data,
            pixelWidth: width,
            pixelHeight: height
        )
        let source: InboxIntakeSource = UIDevice.current.userInterfaceIdiom == .pad
            ? .iPadOSQuickPhoto
            : .iOSQuickPhoto
        let item = YingningIntakeItem(
            source: source,
            sourceSemantic: .quickPhotoInbox,
            sourceApp: "小秘书",
            deviceID: SecretarySharedConfiguration.deviceID(),
            deviceName: UIDevice.current.name,
            attachments: [payload.attachment]
        )
        let service = InboxIntakeDeliveryService()
        _ = try await service.enqueue(item, attachmentPayloads: [payload])
        do {
            _ = try await service.deliver(
                id: item.id,
                serverURL: SecretarySharedConfiguration.mailboxServerURL(),
                token: CodexCommandTokenKeychain.read()
            )
        } catch {
            InboxIntakeRetrySchedule.submit()
        }
        return .result()
    }

    private static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return formatter.string(from: Date())
    }
}

@MainActor
final class ForegroundScreenshotInboxCapture {
    static let shared = ForegroundScreenshotInboxCapture()

    private let service = InboxIntakeDeliveryService()
    private var observer: NSObjectProtocol?
    private var lastCaptureAt = Date.distantPast

    private init() {}

    func start() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.userDidTakeScreenshotNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.captureAndEnqueue() }
        }
    }

    private func captureAndEnqueue() async {
        let now = Date()
        guard UIApplication.shared.applicationState == .active,
              now.timeIntervalSince(lastCaptureAt) > 0.75,
              let window = activeWindow() else { return }
        lastCaptureAt = now

        let bounds = window.bounds.integral
        guard bounds.width > 0, bounds.height > 0 else { return }
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.screen.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        let data = renderer.pngData { context in
            if !window.drawHierarchy(in: bounds, afterScreenUpdates: false) {
                window.layer.render(in: context.cgContext)
            }
        }
        guard !data.isEmpty, data.count <= YingningIntakeAttachment.maximumBytesPerFile else { return }

        let payload = YingningIntakeAttachmentPayload(
            fileName: "SCREENSHOT_\(Self.timestamp()).PNG",
            contentType: "image/png",
            data: data,
            pixelWidth: Int(bounds.width * format.scale),
            pixelHeight: Int(bounds.height * format.scale)
        )
        let source: InboxIntakeSource = UIDevice.current.userInterfaceIdiom == .pad
            ? .iPadOSQuickPhoto
            : .iOSQuickPhoto
        let item = YingningIntakeItem(
            source: source,
            sourceSemantic: .quickPhotoInbox,
            sourceApp: "小秘书",
            deviceID: SecretarySharedConfiguration.deviceID(),
            deviceName: UIDevice.current.name,
            attachments: [payload.attachment]
        )
        do {
            _ = try await service.enqueue(item, attachmentPayloads: [payload])
            do {
                _ = try await service.deliver(
                    id: item.id,
                    serverURL: SecretarySharedConfiguration.mailboxServerURL(),
                    token: CodexCommandTokenKeychain.read()
                )
            } catch {
                InboxIntakeRetrySchedule.submit()
            }
        } catch {
            InboxIntakeRetrySchedule.submit()
        }
    }

    private func activeWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        return scenes.lazy.compactMap { scene in
            scene.windows.first(where: \.isKeyWindow)
                ?? scene.windows.first(where: { !$0.isHidden && $0.alpha > 0 })
        }.first
    }

    private static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return formatter.string(from: Date())
    }
}

struct InfansSecretaryAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenQuickPhotoInboxIntent(),
            phrases: ["用 \(.applicationName) 快速拍照", "打开 \(.applicationName) 收件相机"],
            shortTitle: "拍照收件",
            systemImageName: "camera.badge.ellipsis"
        )
    }
}

@MainActor
final class QuickPhotoInboxModel: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate {
    enum Phase: Equatable { case preparing, camera, capturing, failed(String) }
    enum Feedback: Equatable { case saved, failed(String) }

    @Published private(set) var phase: Phase = .preparing
    @Published private(set) var feedback: Feedback?
    @Published private(set) var capturedCount = 0
    let session = AVCaptureSession()
    let usesDebugFixture = ProcessInfo.processInfo.arguments.contains("-InfansQuickCaptureFixture")
        || ProcessInfo.processInfo.arguments.contains("InfansQuickCaptureFixture")
        || ProcessInfo.processInfo.environment["INFANS_QUICK_CAPTURE_FIXTURE"] == "1"
    private let automaticallyCapturesDebugFixture = ProcessInfo.processInfo.arguments.contains("-InfansQuickCaptureAuto")
        || ProcessInfo.processInfo.arguments.contains("InfansQuickCaptureAuto")
        || ProcessInfo.processInfo.environment["INFANS_QUICK_CAPTURE_AUTO"] == "1"
    private let output = AVCapturePhotoOutput()
    private let service = InboxIntakeDeliveryService()
    private var pendingContentType = "image/jpeg"
    private var feedbackID = UUID()

    func start() async {
        guard phase == .preparing else { return }
#if DEBUG
        if usesDebugFixture {
            phase = .camera
            if automaticallyCapturesDebugFixture {
                try? await Task.sleep(for: .milliseconds(300))
                capture()
            }
            return
        }
#endif
        let authorized: Bool
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: authorized = true
        case .notDetermined: authorized = await AVCaptureDevice.requestAccess(for: .video)
        default: authorized = false
        }
        guard authorized else {
            phase = .failed("需要允许使用相机，才能拍下新来件。")
            return
        }
        do {
            try configureSession()
            session.startRunning()
            phase = .camera
        } catch {
            phase = .failed("相机暂时打不开，稍后再试一次吧。")
        }
    }

    func stop() { if session.isRunning { session.stopRunning() } }

    func retryStart() {
        phase = .preparing
        Task { await start() }
    }

    func capture() {
        guard phase == .camera else { return }
        phase = .capturing
        feedback = nil
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
#if DEBUG
        if usesDebugFixture {
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 900))
            let data = renderer.pngData { context in
                UIColor(red: 0.04, green: 0.16, blue: 0.15, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 1200, height: 900))
                UIColor(red: 0.69, green: 0.89, blue: 0.80, alpha: 1).setFill()
                context.cgContext.fillEllipse(in: CGRect(x: 420, y: 270, width: 360, height: 360))
            }
            acceptCapturedPhoto(data: data, contentType: "image/png", fileName: "quick-photo-fixture.png", pixelWidth: 1200, pixelHeight: 900)
            return
        }
#endif
        let settings: AVCapturePhotoSettings
        if output.availablePhotoCodecTypes.contains(.hevc) {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
            pendingContentType = "image/heic"
        } else {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            pendingContentType = "image/jpeg"
        }
        output.capturePhoto(with: settings, delegate: self)
    }

    private func enqueueCapturedPhoto(data: Data, contentType: String, fileName: String, pixelWidth: Int?, pixelHeight: Int?) async {
        let payload = YingningIntakeAttachmentPayload(
            fileName: fileName,
            contentType: contentType,
            data: data,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight
        )
        let source: InboxIntakeSource = UIDevice.current.userInterfaceIdiom == .pad ? .iPadOSQuickPhoto : .iOSQuickPhoto
        let item = YingningIntakeItem(
            source: source,
            sourceSemantic: .quickPhotoInbox,
            sourceApp: "小秘书",
            deviceID: SecretarySharedConfiguration.deviceID(),
            deviceName: UIDevice.current.name,
            attachments: [payload.attachment]
        )
        do {
            _ = try await service.enqueue(item, attachmentPayloads: [payload])
            recordCaptureDiagnostic(savedItemID: item.id)
            phase = .camera
            capturedCount += 1
            showFeedback(.saved)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    _ = try await service.deliver(
                        id: item.id,
                        serverURL: SecretarySharedConfiguration.mailboxServerURL(),
                        token: CodexCommandTokenKeychain.read()
                    )
                } catch {
                    InboxIntakeRetrySchedule.submit()
                }
            }
        } catch {
            recordCaptureDiagnostic(error: error)
            phase = .camera
            showFeedback(.failed("这张没存进去，请再拍一次"))
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private func acceptCapturedPhoto(data: Data, contentType: String, fileName: String, pixelWidth: Int?, pixelHeight: Int?) {
        Task { await enqueueCapturedPhoto(data: data, contentType: contentType, fileName: fileName, pixelWidth: pixelWidth, pixelHeight: pixelHeight) }
    }

    private func showFeedback(_ value: Feedback) {
        let id = UUID()
        feedbackID = id
        feedback = value
        Task { @MainActor [weak self] in
            let delay: Duration = switch value {
            case .saved: .milliseconds(1_800)
            case .failed: .milliseconds(3_200)
            }
            try? await Task.sleep(for: delay)
            guard self?.feedbackID == id else { return }
            self?.feedback = nil
        }
    }

    private func recordCaptureDiagnostic(savedItemID: String) {
        let defaults = SecretarySharedConfiguration.defaults
        defaults.set(savedItemID, forKey: "secretary.quickPhoto.lastSavedItemID")
        defaults.set(Date().timeIntervalSince1970, forKey: "secretary.quickPhoto.lastSavedAt")
        defaults.removeObject(forKey: "secretary.quickPhoto.lastSaveError")
    }

    private func recordCaptureDiagnostic(error: Error) {
        let defaults = SecretarySharedConfiguration.defaults
        defaults.set(Date().timeIntervalSince1970, forKey: "secretary.quickPhoto.lastSaveFailedAt")
        defaults.set(String(error.localizedDescription.prefix(240)), forKey: "secretary.quickPhoto.lastSaveError")
    }

    private func configureSession() throws {
        guard session.inputs.isEmpty else { return }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw YingningIntakeError.attachmentUnavailable
        }
        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input), session.canAddOutput(output) else { throw YingningIntakeError.attachmentUnavailable }
        session.addInput(input)
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .quality
    }

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        Task { @MainActor in
            guard error == nil, let data = photo.fileDataRepresentation(), data.count <= YingningIntakeAttachment.maximumBytesPerFile else {
                if let error { recordCaptureDiagnostic(error: error) }
                else { recordCaptureDiagnostic(error: YingningIntakeError.attachmentUnavailable) }
                phase = .camera
                showFeedback(.failed("这张没存进去，请再拍一次"))
                return
            }
            let isHEIC = pendingContentType == "image/heic"
            acceptCapturedPhoto(
                data: data,
                contentType: isHEIC ? "image/heic" : "image/jpeg",
                fileName: "IMG_\(Self.timestamp()).\(isHEIC ? "HEIC" : "JPG")",
                pixelWidth: Int(photo.resolvedSettings.photoDimensions.width),
                pixelHeight: Int(photo.resolvedSettings.photoDimensions.height)
            )
        }
    }

    nonisolated private static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return formatter.string(from: Date())
    }
}

struct QuickPhotoCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> PreviewView { let view = PreviewView(); view.layerView.session = session; return view }
    func updateUIView(_ uiView: PreviewView, context: Context) { uiView.layerView.session = session }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var layerView: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        override init(frame: CGRect) { super.init(frame: frame); layerView.videoGravity = .resizeAspectFill }
        required init?(coder: NSCoder) { nil }
    }
}

struct QuickPhotoInboxView: View {
    @StateObject private var model = QuickPhotoInboxModel()
    @Environment(\.dismiss) private var dismiss
    @State private var showsHistory = false

    var body: some View {
        ZStack {
            Color(red: 0.015, green: 0.055, blue: 0.06).ignoresSafeArea()
            switch model.phase {
            case .preparing:
                ProgressView("正在打开收件相机…").tint(.white).foregroundStyle(.white)
            case .camera, .capturing:
                camera
            case let .failed(message):
                failure(message)
            }
        }
        .task { await model.start() }
        .onDisappear { model.stop() }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showsHistory) { QuickPhotoHistoryView() }
    }

    private var camera: some View {
        ZStack {
            if model.usesDebugFixture {
                LinearGradient(colors: [Color(red: 0.04, green: 0.16, blue: 0.15), Color(red: 0.01, green: 0.06, blue: 0.07)], startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
            } else {
                QuickPhotoCameraPreview(session: model.session).ignoresSafeArea()
            }
            LinearGradient(colors: [.black.opacity(0.56), .clear, .black.opacity(0.72)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            VStack {
                header
                Spacer()
                if let feedback = model.feedback {
                    feedbackView(feedback)
                        .transition(.scale.combined(with: .opacity))
                } else if model.phase == .capturing {
                    Label("正在收件…", systemImage: "arrow.down.circle")
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(.black.opacity(0.58), in: Capsule())
                }
                Button(action: model.capture) {
                    Circle().fill(.white).frame(width: 72, height: 72)
                        .overlay(Circle().stroke(.black.opacity(0.25), lineWidth: 2).padding(5))
                        .overlay { if model.phase == .capturing { ProgressView().tint(.black) } }
                }
                .accessibilityLabel("拍照")
                .disabled(model.phase == .capturing)
                .padding(.bottom, 34)
            }
        }
        .animation(.easeOut(duration: 0.16), value: model.feedback)
    }

    @ViewBuilder
    private func feedbackView(_ feedback: QuickPhotoInboxModel.Feedback) -> some View {
        switch feedback {
        case .saved:
            Label("已收下", systemImage: "checkmark")
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(.black.opacity(0.58), in: Capsule())
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(Color.red.opacity(0.78), in: Capsule())
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.badge.exclamationmark").font(.system(size: 52)).foregroundStyle(Color(red: 0.96, green: 0.72, blue: 0.45))
                Text(message).multilineTextAlignment(.center)
                HStack(spacing: 12) {
                    Button("关闭") { dismiss() }.buttonStyle(QuickPhotoSecondaryButtonStyle())
                    Button("再试一次", action: model.retryStart).buttonStyle(QuickPhotoPrimaryButtonStyle())
                }.frame(maxWidth: 520)
        }.padding(28).foregroundStyle(.white)
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text("快速拍照收件箱").font(.system(size: 19, weight: .bold, design: .rounded))
                Text(model.capturedCount == 0 ? "快门即收件" : "本次已收 \(model.capturedCount) 张")
                    .font(.caption).foregroundStyle(.white.opacity(0.68))
            }
            Spacer()
            Button { showsHistory = true } label: {
                Label("最近收件", systemImage: "photo.stack")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .padding(.horizontal, 12)
                    .frame(height: 42)
                    .background(.black.opacity(0.42), in: Capsule())
            }
            .accessibilityLabel("最近收件")
            Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 42, height: 42).background(.black.opacity(0.35), in: Circle()) }
                .accessibilityLabel("取消")
        }.foregroundStyle(.white).padding(.top, 4)
    }
}

@MainActor
final class QuickPhotoHistoryModel: ObservableObject {
    struct Entry: Identifiable {
        let item: YingningIntakeItem
        let images: [Data]
        let noteDelivery: String?
        var id: String { item.id }
    }

    @Published private(set) var entries: [Entry] = []
    @Published private(set) var statusByID: [String: String] = [:]
    private let service = InboxIntakeDeliveryService()

    func reload() async {
        let rows = await service.recent(limit: 500)
        var loaded: [Entry] = []
        for item in rows where item.relatedIntakeID == nil {
            // Failed or unavailable image previews must not hide the share itself.
            let data = (try? await service.attachmentData(for: item)) ?? [:]
            let images = item.attachments.compactMap { data[$0.id] }
            let latestNote = rows.first { $0.relatedIntakeID == item.id }
            loaded.append(Entry(item: item, images: images, noteDelivery: latestNote.map { "备注：" + $0.state.label }))
        }
        entries = loaded
    }

    func addNote(_ note: String, to item: YingningIntakeItem) async -> Bool {
        do {
            let followup = try await service.reviseNote(id: item.id, note: note, expectedNote: item.localNote ?? item.note)
            statusByID[item.id] = "备注已保存"
            if let followup {
                InboxIntakeRetrySchedule.submit()
                Task { @MainActor in
                    do {
                        _ = try await service.deliver(
                            id: followup.id,
                            serverURL: SecretarySharedConfiguration.mailboxServerURL(),
                            token: CodexCommandTokenKeychain.read()
                        )
                    } catch {
                        InboxIntakeRetrySchedule.submit()
                    }
                    await reload()
                }
            }
            await reload()
            return true
        } catch {
            statusByID[item.id] = error.localizedDescription
            return false
        }
    }
}

struct QuickPhotoHistoryView: View {
    @StateObject private var model = QuickPhotoHistoryModel()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var isRefreshing = false

    var body: some View {
        NavigationStack {
            Group {
                if model.entries.isEmpty {
                    ContentUnavailableView("还没有分享", systemImage: "tray.and.arrow.up", description: Text("发给秘书的照片、截图、链接和文字都在这里。"))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(model.entries) { entry in
                                QuickPhotoHistoryCard(
                                    entry: entry,
                                    status: model.statusByID[entry.id],
                                    onAddNote: { note in await model.addNote(note, to: entry.item) }
                                )
                            }
                        }
                        .padding()
                        .frame(maxWidth: 760)
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("发件箱")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { Task { await refreshDelivery() } } label: { Label("刷新送达", systemImage: "arrow.clockwise") }
                        .disabled(isRefreshing)
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .task { await model.reload(); await refreshDelivery() }
            .refreshable { await refreshDelivery() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refreshDelivery() } }
            }
        }
    }

    private func refreshDelivery() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        _ = await YingningIntakeCoordinator.shared.retryPending()
        await model.reload()
        isRefreshing = false
    }
}

private struct QuickPhotoHistoryCard: View {
    let entry: QuickPhotoHistoryModel.Entry
    let status: String?
    let onAddNote: (String) async -> Bool
    @State private var note = ""
    @State private var isSaving = false
    @State private var isEditing = false

    private var savedNote: String { entry.item.localNote ?? entry.item.note }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(entry.images.enumerated()), id: \.offset) { _, data in
                if let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(maxHeight: 340)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
            if entry.images.isEmpty && !entry.item.attachments.isEmpty {
                Label("原图暂时无法预览", systemImage: "photo")
                    .foregroundStyle(.secondary)
            }
            if !entry.item.title.isEmpty { Text(entry.item.title).font(.headline) }
            if let url = URL(string: entry.item.url), ["http", "https"].contains(url.scheme ?? "") {
                Link(entry.item.url, destination: url).font(.subheadline).lineLimit(3)
            }
            if !entry.item.text.isEmpty { Text(entry.item.text).font(.subheadline).textSelection(.enabled) }
            HStack {
                Text(formattedDate).font(.footnote)
                Spacer()
                Label(entry.item.state.label, systemImage: entry.item.state == .delivered ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath")
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
            if isEditing {
                TextField("事后补一句（可选）", text: $note, axis: .vertical)
                    .lineLimit(3...6)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSaving)
                HStack {
                    Button("取消") { isEditing = false }.disabled(isSaving)
                    Spacer()
                    Button("保存备注") {
                        isSaving = true
                        Task {
                            if await onAddNote(note) { isEditing = false }
                            isSaving = false
                        }
                    }
                    .disabled(isSaving || note.trimmingCharacters(in: .whitespacesAndNewlines) == savedNote)
                }
            } else {
                if !savedNote.isEmpty { Text(savedNote).font(.body) }
                Button(savedNote.isEmpty ? "补备注" : "修改备注") {
                    note = savedNote
                    isEditing = true
                }
            }
            if let status { Text(status).font(.caption).foregroundStyle(.secondary) }
            if let delivery = entry.noteDelivery { Text(delivery).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var formattedDate: String {
        guard let date = ISO8601DateFormatter().date(from: entry.item.createdAt) else { return entry.item.createdAt }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct QuickPhotoPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 16, weight: .bold, design: .rounded)).frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(Color(red: 0.02, green: 0.10, blue: 0.09))
            .background(Color(red: 0.57, green: 0.88, blue: 0.76).opacity(configuration.isPressed ? 0.72 : 1), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }
}

private struct QuickPhotoSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 16, weight: .semibold, design: .rounded)).frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(.white).background(.white.opacity(configuration.isPressed ? 0.08 : 0.13), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }
}
