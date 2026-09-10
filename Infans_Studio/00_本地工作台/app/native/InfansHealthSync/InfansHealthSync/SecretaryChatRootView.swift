import SwiftUI
import UIKit

enum SecretaryAppearanceTheme: String, CaseIterable, Identifiable {
    case night
    case day

    var id: String { rawValue }
    var name: String { self == .night ? "玄夜" : "晴岚" }
    var detail: String { self == .night ? "玉夜冷青" : "云白玉青" }
    var symbol: String { self == .night ? "moon.stars.fill" : "sun.max.fill" }
    var colorScheme: ColorScheme { self == .night ? .dark : .light }

    static func normalized(_ rawValue: String) -> SecretaryAppearanceTheme {
        SecretaryAppearanceTheme(rawValue: rawValue) ?? .night
    }
}

private struct SecretarySurfaceOpacityKey: EnvironmentKey {
    static let defaultValue = 0.84
}

extension EnvironmentValues {
    var secretarySurfaceOpacity: Double {
        get { self[SecretarySurfaceOpacityKey.self] }
        set { self[SecretarySurfaceOpacityKey.self] = newValue }
    }
}

struct SecretaryChatRootView: View {
    @StateObject private var store = SecretaryChatStore()
    @StateObject private var notificationRouter = SecretaryChatNotificationRouter.shared
    @ObservedObject private var speech = SecretarySpeechController.shared
    @ObservedObject private var speechPreferences = SecretarySpeechPreferences.shared
    @State private var showsSettings = false
    @State private var showsConversationDrawer = false
    @State private var showsInspector = false
    @State private var padSidebar: SecretaryPadSidebar?
    @AppStorage("secretary.appearanceTheme") private var appearanceThemeRaw = SecretaryAppearanceTheme.night.rawValue
    @AppStorage("secretary.surfaceOpacity") private var surfaceOpacity = 0.84
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var appearanceTheme: SecretaryAppearanceTheme {
        SecretaryAppearanceTheme.normalized(appearanceThemeRaw)
    }

    private var normalizedSurfaceOpacity: Double {
        min(1, max(0.64, surfaceOpacity))
    }

    private var usesPhoneFrontend: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    private var immersiveSpeechActive: Bool {
        speechPreferences.videoFeelEnabled
            && (speech.phase == .playing || speech.phase == .preparing || speech.phase == .paused)
            && speech.speakingMessageID != nil
    }

    var body: some View {
        GeometryReader { geometry in
            let layout = SecretaryChatLayout(width: geometry.size.width, sizeClass: horizontalSizeClass)
            let usesPadLandscapeCanvas = UIDevice.current.userInterfaceIdiom == .pad
                && geometry.size.width > geometry.size.height
                && geometry.size.width >= 900
            let usesLandscapeChatBackground = horizontalSizeClass != .compact
                && geometry.size.width > geometry.size.height
            Group {
                if usesPadLandscapeCanvas {
                    padLandscapeCanvas(geometry: geometry)
                } else {
                    standardCanvas(
                        layout: layout,
                        usesLandscapeChatBackground: usesLandscapeChatBackground,
                        availableWidth: geometry.size.width
                    )
                }
            }
        }
        .task {
            await store.start()
            await SecretaryCharacterPhotos.shared.refresh()
            await store.ensureDirectConversationVisible()
            await openPendingNotificationConversationIfNeeded()
        }
        .task(id: scenePhase) {
            store.setChatActive(scenePhase == .active)
            guard scenePhase == .active else { return }
            await store.recoverPendingWhileVisible()
        }
        .onChange(of: notificationRouter.pendingConversationID) { _, conversationID in
            guard conversationID != nil else { return }
            Task { await openPendingNotificationConversationIfNeeded() }
        }
        .onChange(of: scenePhase) { _, phase in
            store.setChatActive(phase == .active)
            if phase == .active {
                // 前台恢复先以 Mac 正式会话对账。切后台时丢失的流式 delta 不是权威消息。
                Task { await store.refresh(); await SecretaryCharacterPhotos.shared.refresh() }
            }
        }
        .inspector(isPresented: $showsInspector) {
            NavigationStack {
                SecretaryConversationInspectorView(store: store)
                    .background(SecretaryJadeBackground())
                    .navigationTitle("会话控制")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("完成") { showsInspector = false }
                        }
                    }
            }
            .inspectorColumnWidth(min: 320, ideal: 336, max: 380)
            .preferredColorScheme(appearanceTheme.colorScheme)
        }
        .sheet(isPresented: controlledActionSheetBinding) {
            SecretaryChatActionConfirmationView(store: store)
        }
        .alert("会话没有完成操作", isPresented: managementErrorBinding) {
            Button("知道了") { store.clearManagementError() }
        } message: {
            Text(store.managementError ?? "请重新同步 Mac 后再试。")
        }
        .environment(\.secretaryAvatarAssets, Dictionary(uniqueKeysWithValues: (store.bootstrap?.characters ?? []).map { ($0.id, $0.assets) }))
        .environment(\.secretarySpeechImmersion, immersiveSpeechActive)
        .environment(\.secretarySurfaceOpacity, normalizedSurfaceOpacity)
        .preferredColorScheme(appearanceTheme.colorScheme)
    }

    @ViewBuilder
    private func standardCanvas(
        layout: SecretaryChatLayout,
        usesLandscapeChatBackground: Bool,
        availableWidth: CGFloat
    ) -> some View {
        ZStack {
            // Match the clipped chat chrome to the status/home-indicator safe areas.
            Color.secretaryBarJade.ignoresSafeArea()
            standardChatColumn(layout: layout)
                .environment(\.secretaryChatUsesLandscapeBackground, layout != .compact && usesLandscapeChatBackground)

            if showsConversationDrawer {
                standardConversationDrawer(availableWidth: availableWidth)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                    .zIndex(20)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: showsConversationDrawer)
        .sheet(isPresented: $showsSettings) {
            SecretarySettingsView(
                secretaryID: store.displaySecretaryID,
                secretaryName: store.activeSecretaryName,
                secretaryAvatarURL: store.activeSecretaryAvatarURL,
                chatStore: store,
                showsOrdinaryModelList: usesPhoneFrontend
            )
        }
    }

    private func standardChatColumn(layout: SecretaryChatLayout) -> some View {
        ZStack {
            SecretaryChatBackground(secretaryID: store.displaySecretaryID)
            if immersiveSpeechActive {
                SecretarySpeechImmersionScrim()
            }
            VStack(spacing: 0) {
                SecretaryChatHeader(
                    store: store,
                    showsSettings: $showsSettings,
                    showsConversations: $showsConversationDrawer,
                    showsInspector: nil
                )
                SecretaryConversationView(
                    store: store,
                    onOpenConnectionHelp: { showsConversationDrawer = true }
                )
                SecretaryMessageComposer(store: store)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func standardConversationDrawer(availableWidth: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            Button {
                showsConversationDrawer = false
            } label: {
                Color.black.opacity(0.46)
                    .ignoresSafeArea()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭会话列表")

            SecretaryConversationListView(
                store: store,
                onSelect: { showsConversationDrawer = false },
                onOpenSettings: {
                    openSettingsFromConversationDrawer()
                }
            )
            .frame(width: min(380, max(280, availableWidth * 0.86)))
            .background(SecretaryJadeBackground())
            .shadow(color: .black.opacity(0.36), radius: 28, x: 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func openSettingsFromConversationDrawer() {
        // Avoid making UIKit dismiss the drawer and present a sheet in one layout pass.
        showsConversationDrawer = false
        let presentationDelay: UInt64 = reduceMotion ? 0 : 180_000_000
        Task { @MainActor in
            if presentationDelay > 0 {
                try? await Task.sleep(nanoseconds: presentationDelay)
            }
            guard !showsConversationDrawer else { return }
            showsSettings = true
        }
    }

    private func padLandscapeCanvas(geometry: GeometryProxy) -> some View {
        let horizontalInset = max(24, geometry.safeAreaInsets.leading + 18)
        let verticalInset = max(16, geometry.safeAreaInsets.top + 10)
        let spacing: CGFloat = 14
        let contentWidth = max(0, geometry.size.width - horizontalInset * 2)
        let sidebarWidth = min(280, max(220, contentWidth * 0.22))
        let reservedWidth = padSidebar != nil ? sidebarWidth + spacing : 0
        let availableChatWidth = max(0, contentWidth - reservedWidth)
        let chatWidth = min(650, availableChatWidth)

        return ZStack {
            SecretaryChatBackground(secretaryID: store.displaySecretaryID)
                .environment(\.secretaryChatUsesLandscapeBackground, true)
                .ignoresSafeArea()

            Color.secretaryBackdropTint.opacity(0.07).ignoresSafeArea()

            Group {
                HStack(alignment: .top, spacing: spacing) {
                    if let padSidebar {
                        padSidebarPanel(padSidebar)
                            .frame(width: sidebarWidth)
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                    padChatSurface
                        .frame(width: chatWidth)
                }
            }
            .padding(.leading, horizontalInset)
            .padding(.trailing, horizontalInset)
            .padding(.top, verticalInset)
            .padding(.bottom, max(14, geometry.safeAreaInsets.bottom + 10))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.88), value: padSidebar)
        }
        .onChange(of: showsSettings) { _, requested in
            guard requested else { return }
            // iPad 横屏的设置属于左侧临时工作区，不应退回系统居中 sheet。
            showsSettings = false
            togglePadSidebar(.settings)
        }
    }

    private var padChatSurface: some View {
        ZStack {
            VStack(spacing: 0) {
                SecretaryPadChatHeader(
                    store: store,
                    conversationsPresented: padSidebar == .conversations,
                    onOpenConversations: {
                        SecretaryKeyboard.resign()
                        togglePadSidebar(.conversations)
                    },
                    onOpenConnection: {
                        togglePadSidebar(.settings)
                    }
                )
                SecretaryConversationView(store: store)
                SecretaryMessageComposer(store: store)
            }
            if immersiveSpeechActive {
                SecretarySpeechImmersionScrim()
            }
        }
        .background(Color.secretaryPanelJade.opacity(normalizedSurfaceOpacity))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.secretaryJade.opacity(0.18), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.34), radius: 28, y: 14)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: speech.speakingMessageID)
    }

    @ViewBuilder
    private func padSidebarPanel(_ sidebar: SecretaryPadSidebar) -> some View {
        switch sidebar {
        case .conversations:
            VStack(spacing: 0) {
                ZStack(alignment: .topTrailing) {
                    SecretaryConversationListView(
                        store: store,
                        onSelect: { closePadSidebar() },
                        onOpenSettings: { togglePadSidebar(.settings) }
                    )
                    Button { closePadSidebar() } label: {
                        Image(systemName: "xmark")
                            .frame(width: 38, height: 38)
                    }
                    .buttonStyle(SecretaryQuietButtonStyle())
                    .padding(.top, 12)
                    .padding(.trailing, 12)
                    .accessibilityLabel("关闭会话列表")
                }

            }
            .secretaryPadFloatingPanel()

        case .settings:
            SecretarySettingsView(
                secretaryID: store.displaySecretaryID,
                secretaryName: store.activeSecretaryName,
                secretaryAvatarURL: store.activeSecretaryAvatarURL,
                onClose: { closePadSidebar() }
            )
                .secretaryPadFloatingPanel()
        }
    }

    private func togglePadSidebar(_ sidebar: SecretaryPadSidebar) {
        let change = {
            padSidebar = padSidebar == sidebar ? nil : sidebar
        }
        if reduceMotion { change() } else { withAnimation(.spring(response: 0.36, dampingFraction: 0.88), change) }
    }

    private func closePadSidebar() {
        if reduceMotion { padSidebar = nil } else { withAnimation(.easeInOut(duration: 0.20)) { padSidebar = nil } }
    }

    private var managementErrorBinding: Binding<Bool> {
        Binding(
            get: { store.managementError != nil },
            set: { if !$0 { store.clearManagementError() } }
        )
    }

    private var controlledActionSheetBinding: Binding<Bool> {
        Binding(
            get: { store.presentedControlledAction != nil },
            set: { if !$0 { store.dismissControlledActionConfirmation() } }
        )
    }

    @MainActor
    private func openPendingNotificationConversationIfNeeded() async {
        guard let conversationID = notificationRouter.pendingConversationID else { return }
        await store.selectConversation(conversationID)
        showsConversationDrawer = false
        showsInspector = false
        padSidebar = nil
        notificationRouter.consume(conversationID)
    }
}

private enum SecretaryPadSidebar: Equatable {
    case conversations
    case settings
}

private struct SecretaryPadChatHeader: View {
    @ObservedObject var store: SecretaryChatStore
    let conversationsPresented: Bool
    let onOpenConversations: () -> Void
    let onOpenConnection: () -> Void
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(action: onOpenConversations) {
                    Image(systemName: "sidebar.left")
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(SecretaryHeaderButtonStyle())
                .accessibilityLabel(conversationsPresented ? "关闭会话列表" : "打开会话列表")

                Spacer(minLength: 12)

                VStack(spacing: 2) {
                    Text(store.activeSecretaryName)
                        .font(.system(size: 18, weight: .semibold, design: .serif))
                        .foregroundStyle(Color.secretaryIvory)
                        .onTapGesture { SecretaryKeyboard.resign() }
                }

                Spacer(minLength: 12)

                Color.clear.frame(width: 40, height: 40)
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 6)

            if connectionNeedsAttention {
                Button(action: onOpenConnection) {
                    Label(store.connectionState.label, systemImage: "exclamationmark.circle.fill")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(Color.secretaryAmber)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.black.opacity(0.24), in: Capsule())
                }
                .buttonStyle(.plain)
                .padding(.bottom, 7)
                .accessibilityHint("打开设置与连接")
            }
        }
        .background(Color.secretaryPanelJade.opacity(surfaceOpacity))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.secretaryJade.opacity(0.16)).frame(height: 1)
        }
    }

    private var connectionNeedsAttention: Bool {
        switch store.connectionState {
        case .online, .loading: return false
        case .offline, .needsPairing: return true
        }
    }
}

private struct SecretaryPadFloatingPanelModifier: ViewModifier {
    let minimumOpacity: Double
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity

    func body(content: Content) -> some View {
        content
            .background(Color.secretaryPanelJade.opacity(max(minimumOpacity, surfaceOpacity)))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.secretaryJade.opacity(0.18), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.34), radius: 28, y: 14)
    }
}

private extension View {
    func secretaryPadFloatingPanel(minimumOpacity: Double = 0) -> some View {
        modifier(SecretaryPadFloatingPanelModifier(minimumOpacity: minimumOpacity))
    }
}

enum SecretaryChatLayout: Equatable {
    case wide
    case dual
    case compact

    init(width: CGFloat, sizeClass: UserInterfaceSizeClass?) {
        if sizeClass == .compact || width < 700 {
            self = .compact
        } else if width >= 1_180 {
            self = .wide
        } else {
            self = .dual
        }
    }
}

private struct SecretaryColumnDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.secretaryJade.opacity(0.16))
            .frame(width: 1)
            .overlay {
                Rectangle().fill(Color.secretaryBackdropTint.opacity(0.22)).offset(x: 1)
            }
    }
}

struct SecretaryChatHeader: View {
    @ObservedObject var store: SecretaryChatStore
    @Binding var showsSettings: Bool
    var showsConversations: Binding<Bool>?
    var showsInspector: Binding<Bool>?
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity

    var body: some View {
        HStack(spacing: 0) {
            if let showsConversations {
                Button {
                    SecretaryKeyboard.resign()
                    showsConversations.wrappedValue = true
                } label: {
                    Image(systemName: "sidebar.left")
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(SecretaryHeaderButtonStyle())
                .accessibilityLabel("打开会话列表")
            } else {
                Color.clear.frame(width: 40, height: 40)
            }

            Spacer(minLength: 10)
            Text(store.activeSecretaryName)
                .font(.system(size: 18, weight: .semibold, design: .serif))
                .foregroundStyle(Color.secretaryIvory)
                .lineLimit(1)
                .onTapGesture { SecretaryKeyboard.resign() }
            Spacer(minLength: 10)

            if let showsInspector {
                Button {
                    SecretaryKeyboard.resign()
                    showsInspector.wrappedValue = true
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(SecretaryHeaderButtonStyle())
                .accessibilityLabel("打开设置")
            } else {
                Color.clear.frame(width: 40, height: 40)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 7)
        .background(Color.secretaryPanelJade.opacity(surfaceOpacity))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.secretaryIvory.opacity(0.10))
                .frame(height: 1)
        }
    }
}

private struct SecretaryHeaderButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Color.secretaryIvory.opacity(configuration.isPressed ? 0.58 : 0.88))
            .background(Color.secretaryIvory.opacity(configuration.isPressed ? 0.11 : 0.055), in: Circle())
            .contentShape(Circle())
    }
}

struct SecretaryJadeBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.secretaryBarJade,
                    Color.secretaryCanvasMid,
                    Color.secretaryCanvasEnd,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [Color.secretaryJade.opacity(0.16), .clear],
                center: .topTrailing,
                startRadius: 12,
                endRadius: 360
            )
            Canvas { context, size in
                var thread = Path()
                thread.move(to: CGPoint(x: size.width * 0.12, y: 0))
                thread.addCurve(
                    to: CGPoint(x: size.width * 0.03, y: size.height),
                    control1: CGPoint(x: size.width * 0.25, y: size.height * 0.32),
                    control2: CGPoint(x: -size.width * 0.02, y: size.height * 0.62)
                )
                context.stroke(thread, with: .color(Color.secretaryJade.opacity(0.09)), lineWidth: 1)
            }
        }
        .ignoresSafeArea()
    }
}

extension Color {
    // Semantic colors mirror the web workbench's 玄夜 / 晴岚 source palette.
    static let secretaryJade = secretaryDynamicColor(
        light: UIColor(red: 0.153, green: 0.427, blue: 0.400, alpha: 1),
        dark: UIColor(red: 0.494, green: 0.788, blue: 0.753, alpha: 1)
    )
    static let secretaryDeepJade = secretaryDynamicColor(
        light: UIColor(red: 0.969, green: 0.980, blue: 0.973, alpha: 1),
        dark: UIColor(red: 0.071, green: 0.125, blue: 0.149, alpha: 1)
    )
    static let secretaryBarJade = secretaryDynamicColor(
        light: UIColor(red: 0.933, green: 0.953, blue: 0.941, alpha: 1),
        dark: UIColor(red: 0.024, green: 0.051, blue: 0.063, alpha: 1)
    )
    static let secretaryPanelJade = secretaryDynamicColor(
        light: UIColor(red: 0.988, green: 1.000, blue: 0.992, alpha: 1),
        dark: UIColor(red: 0.055, green: 0.110, blue: 0.125, alpha: 1)
    )
    static let secretaryInputJade = secretaryDynamicColor(
        light: UIColor(red: 0.980, green: 0.992, blue: 0.984, alpha: 1),
        dark: UIColor(red: 0.043, green: 0.082, blue: 0.094, alpha: 1)
    )
    static let secretaryIvory = secretaryDynamicColor(
        light: UIColor(red: 0.094, green: 0.188, blue: 0.184, alpha: 1),
        dark: UIColor(red: 0.929, green: 0.949, blue: 0.937, alpha: 1)
    )
    static let secretaryAmber = secretaryDynamicColor(
        light: UIColor(red: 0.502, green: 0.380, blue: 0.176, alpha: 1),
        dark: UIColor(red: 0.831, green: 0.769, blue: 0.604, alpha: 1)
    )
    static let secretaryCanvasMid = secretaryDynamicColor(
        light: UIColor(red: 0.894, green: 0.925, blue: 0.910, alpha: 1),
        dark: UIColor(red: 0.039, green: 0.078, blue: 0.094, alpha: 1)
    )
    static let secretaryCanvasEnd = secretaryDynamicColor(
        light: UIColor(red: 0.969, green: 0.980, blue: 0.973, alpha: 1),
        dark: UIColor(red: 0.020, green: 0.039, blue: 0.047, alpha: 1)
    )
    static let secretaryHairline = secretaryDynamicColor(
        light: UIColor(red: 0.149, green: 0.294, blue: 0.282, alpha: 0.14),
        dark: UIColor(red: 0.690, green: 0.816, blue: 0.816, alpha: 0.11)
    )
    static let secretaryBackdropTint = secretaryDynamicColor(light: .white, dark: .black)
    static let secretaryUserBubbleTop = secretaryDynamicColor(
        light: UIColor(red: 0.918, green: 0.898, blue: 0.824, alpha: 1),
        dark: UIColor(red: 0.349, green: 0.553, blue: 0.510, alpha: 1)
    )
    static let secretaryUserBubbleBottom = secretaryDynamicColor(
        light: UIColor(red: 0.969, green: 0.945, blue: 0.875, alpha: 1),
        dark: UIColor(red: 0.243, green: 0.431, blue: 0.404, alpha: 1)
    )
    static let secretaryUserBubbleInk = secretaryDynamicColor(
        light: UIColor(red: 0.094, green: 0.188, blue: 0.184, alpha: 1),
        dark: UIColor(red: 0.929, green: 0.949, blue: 0.937, alpha: 1)
    )
    static let secretarySignalRed = secretaryDynamicColor(
        light: UIColor(red: 0.73, green: 0.16, blue: 0.20, alpha: 1),
        dark: UIColor(red: 0.96, green: 0.45, blue: 0.48, alpha: 1)
    )
}

private func secretaryDynamicColor(light: UIColor, dark: UIColor) -> Color {
    Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? dark : light
    })
}
