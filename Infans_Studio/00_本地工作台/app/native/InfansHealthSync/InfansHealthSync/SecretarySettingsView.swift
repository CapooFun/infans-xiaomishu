import SwiftUI
import UIKit
import UserNotifications

struct SecretarySettingsView: View {
    @Environment(\.dismiss) private var dismiss
    let secretaryID: String
    let secretaryName: String
    let secretaryAvatarURL: URL?
    var chatStore: SecretaryChatStore?
    var showsOrdinaryModelList = false
    var onClose: (() -> Void)?
    @StateObject private var model = SyncCoordinator.shared
    @StateObject private var settings = SettingsStore.shared
    @StateObject private var commandBridge = PhoneCommandBridge.shared
    @StateObject private var commandSettings = CodexCommandSettings.shared
    @StateObject private var intakeCoordinator = YingningIntakeCoordinator.shared
    @StateObject private var reminderAuthorization = UnifiedReminderAuthorizationStore.shared
    @StateObject private var speechPreferences = SecretarySpeechPreferences.shared
    @StateObject private var chatNotifications = SecretaryChatNotificationController.shared
    @State private var tokenInput = ""
    @State private var tokenMessage: String?
    @State private var commandTokenInput = ""
    @State private var commandTokenMessage: String?
    @State private var showsMaintenance = false
    @State private var showsOutbox = false
    @AppStorage(SecretarySharedConfiguration.detailedSharingKey, store: SecretarySharedConfiguration.defaults)
    private var detailedSharing = false
    @AppStorage("secretary.debugMode") private var debugMode = false
    @AppStorage("secretary.appearanceTheme") private var appearanceThemeRaw = SecretaryAppearanceTheme.night.rawValue
    @AppStorage("secretary.surfaceOpacity") private var surfaceOpacity = 0.84

    private var appearanceTheme: SecretaryAppearanceTheme {
        SecretaryAppearanceTheme.normalized(appearanceThemeRaw)
    }

    init(
        secretaryID: String = "yinyue",
        secretaryName: String = "银月",
        secretaryAvatarURL: URL? = nil,
        chatStore: SecretaryChatStore? = nil,
        showsOrdinaryModelList: Bool = false,
        onClose: (() -> Void)? = nil
    ) {
        self.secretaryID = secretaryID
        self.secretaryName = secretaryName
        self.secretaryAvatarURL = secretaryAvatarURL
        self.chatStore = chatStore
        self.showsOrdinaryModelList = showsOrdinaryModelList
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("分享方式", selection: $detailedSharing) {
                        Text("快速分享").tag(false)
                        Text("细细说来").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Text(detailedSharing ? "分享时可以先留一句，再交给银月。" : "点“发给秘书”就收下，备注以后再补。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button { showsOutbox = true } label: {
                        Label("发件箱", systemImage: "tray.and.arrow.up")
                    }
                } header: { Text("分享") }
                Section("外观") {
                    Picker("主题", selection: $appearanceThemeRaw) {
                        ForEach(SecretaryAppearanceTheme.allCases) { theme in
                            Label(theme.name, systemImage: theme.symbol).tag(theme.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        Label(appearanceTheme.name, systemImage: appearanceTheme.symbol)
                            .font(.system(.body, design: .rounded, weight: .semibold))
                        Spacer()
                        Text(appearanceTheme.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    LabeledContent("界面透明度") {
                        Text("\(Int((surfaceOpacity * 100).rounded()))%")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $surfaceOpacity, in: 0.64...1, step: 0.04)
                        .tint(Color.secretaryJade)
                        .accessibilityLabel("界面透明度")
                }

                Section("秘书形象") {
                    NavigationLink {
                        SecretaryAppearancePhotosView(
                            secretaryID: secretaryID,
                            secretaryName: secretaryName,
                            defaultAvatarURL: secretaryAvatarURL
                        )
                    } label: {
                        Label("\(secretaryName)的头像与背景", systemImage: "person.crop.square.filled.and.at.rectangle")
                    }
                }

                if showsMaintenance {
                    Section("小秘书连接") {
                    TextField("私有 HTTPS 地址", text: $commandSettings.serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    TextField("NAS 信箱 HTTPS 地址", text: $commandSettings.mailboxServerURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    if InfansProductIdentity.allowsCommandTokenPaste {
                    SecureField("小秘书指令令牌", text: $commandTokenInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                    Button(commandSettings.tokenConfigured ? "更新小秘书指令令牌" : "保存小秘书指令令牌") {
                        persistCommandToken(commandTokenInput)
                    }
                    .disabled(commandTokenInput.isEmpty)
                    Button("从剪贴板导入小秘书指令令牌") {
                        guard let clipboard = UIPasteboard.general.string else {
                            commandTokenMessage = "剪贴板里没有文本"
                            return
                        }
                        persistCommandToken(clipboard)
                    }
                    } else {
                    LabeledContent("指令配对", value: commandSettings.tokenConfigured ? "已由电脑配对" : "还没配对")
                    }
                    if let commandTokenMessage {
                        Text(commandTokenMessage).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text(InfansProductIdentity.allowsCommandTokenPaste
                         ? "聊天大脑连 Mac；离线发件与回复同步走 NAS 信箱。系统分享仍复用 Mac 私有连接；它们都不使用 Apple 健康同步令牌。"
                         : "聊天大脑连 Mac；离线发件与回复同步走 NAS 信箱。正式包配对只靠电脑推送，不必在手机上粘贴。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }

                Section("视频感") {
                    Picker("要／不要吗？", selection: $speechPreferences.videoFeelEnabled) {
                        Text("要").tag(true as Bool)
                        Text("不要吗？").tag(false as Bool)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("视频感")
                    Text("假装在视频。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("聊天体验") {
                    if showsOrdinaryModelList, let chatStore {
                        SecretaryOrdinaryModelSettingsList(store: chatStore)
                    }
                    Toggle("秘书回复完后自动朗读", isOn: $speechPreferences.automaticallyReadsReplies)
                    Picker("朗读速度", selection: $speechPreferences.rate) {
                        ForEach(SecretarySpeechRateSetting.allCases, id: \.self) { rate in
                            Text(rate.label).tag(rate)
                        }
                    }
                    .pickerStyle(.segmented)
                    Toggle("后台收到完整回复时提醒我", isOn: $chatNotifications.enabled)
                    LabeledContent("系统权限", value: chatNotifications.authorizationText)
                    if chatNotifications.authorizationStatus == .notDetermined {
                        Button("允许聊天通知") {
                            Task { await chatNotifications.requestAuthorization() }
                        }
                    } else if chatNotifications.authorizationStatus == .denied {
                        Button("打开 iPhone 通知设置") {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                            UIApplication.shared.open(url)
                        }
                    }
                    if let error = chatNotifications.lastError {
                        Text(error).foregroundStyle(.red)
                    }
                }

                if showsMaintenance {
                    Section("分享送达") {
                    Text("Safari、抖音、B站、小红书等 App 只要愿意交给系统分享 URL 或文字，就能从分享面板选择“发给秘书”。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("待重试", value: "\(intakeCoordinator.pendingCount)")
                    Text(intakeCoordinator.statusText).foregroundStyle(.secondary)
                    if let error = intakeCoordinator.lastError { Text(error).foregroundStyle(.red) }
                    Button("重试待送达分享") {
                        Task { _ = await intakeCoordinator.retryPending() }
                    }
                    .disabled(intakeCoordinator.pendingCount == 0)
                    Text("只有 Mac 回执为 mac_persisted 时才会清除本地队列。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }

                    Section("健康自动同步") {
                    LabeledContent("计划", value: "每天 12:00 后尽快")
                    LabeledContent("范围", value: "近 35 天·非医疗数据")
                    LabeledContent("后台 App 刷新", value: settings.backgroundRefreshState)
                    LabeledContent("HealthKit 唤醒", value: settings.healthKitBackgroundState)
                    LabeledContent("同步令牌", value: settings.tokenAccessState)
                    if let date = settings.nextRefreshAt {
                        LabeledContent("下次最早运行", value: date.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let date = settings.lastBackgroundAttemptAt {
                        LabeledContent("后台最近活动", value: date.formatted(date: .abbreviated, time: .shortened))
                        Text(settings.lastBackgroundAttemptText).font(.footnote).foregroundStyle(.secondary)
                    }
                    LabeledContent("最新完整覆盖", value: settings.lastCompleteThrough.isEmpty ? "尚未同步" : settings.lastCompleteThrough)
                    if let date = settings.lastSuccessAt {
                        LabeledContent("上次成功", value: date.formatted(date: .abbreviated, time: .shortened))
                    }
                    Text(model.statusText).foregroundStyle(.secondary)
                    if let error = model.lastError { Text(error).foregroundStyle(.red) }
                    Button {
                        Task { await model.syncNow() }
                    } label: {
                        if model.isSyncing { ProgressView() } else { Text("立即同步") }
                    }
                    .disabled(model.isSyncing || !settings.authorizationRequested || !settings.tokenConfigured)
                    }
                }

                if showsMaintenance {
                    Section("系统权限") {
                        LabeledContent("Apple 提醒事项", value: reminderAuthorization.remindersState)
                        LabeledContent("Apple 日历", value: reminderAuthorization.calendarState)
                        LabeledContent("强提醒与计时器", value: reminderAuthorization.alarmState)
                        Button("授权 Apple 提醒事项") { Task { await reminderAuthorization.requestReminders() } }
                        Button("授权 Apple 日历") { Task { await reminderAuthorization.requestCalendar() } }
                        Button("授权强提醒与计时器") { Task { await reminderAuthorization.requestAlarms() } }
                        if let error = reminderAuthorization.lastError { Text(error).foregroundStyle(.red) }
                        Button(settings.authorizationRequested ? "重新检查 Apple 健康授权" : "授权读取 Apple 健康") {
                            Task { await model.requestAuthorization() }
                        }
                    }
                }

                if showsMaintenance {
                    Section("健康同步私有入口") {
                    TextField("HTTPS 地址", text: $settings.serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("健康同步配对令牌", text: $tokenInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                    Button(settings.tokenConfigured ? "更新配对令牌" : "保存配对令牌") {
                        persistToken(tokenInput)
                    }
                    .disabled(tokenInput.isEmpty)
                    Button("从剪贴板导入并保存") {
                        guard let clipboard = UIPasteboard.general.string else {
                            tokenMessage = "剪贴板里没有文本"
                            return
                        }
                        persistToken(clipboard)
                    }
                    if let tokenMessage { Text(tokenMessage).font(.footnote).foregroundStyle(.secondary) }
                    Text("传输只走 Tailscale HTTPS；这枚令牌只用于 Apple 健康同步。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }

                Section {
                    DisclosureGroup("维护与诊断", isExpanded: $showsMaintenance) {
                        Toggle("显示详细发送状态", isOn: $debugMode)
                        Text("连接、队列、系统权限与同步状态只在这里展开。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.secretaryBarJade.ignoresSafeArea())
            .tint(Color.secretaryJade)
            .navigationTitle("设置")
            .sheet(isPresented: $showsOutbox) { QuickPhotoHistoryView() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        if let onClose {
                            onClose()
                        } else {
                            dismiss()
                        }
                    }
                }
            }
        }
        .preferredColorScheme(appearanceTheme.colorScheme)
        .task {
            commandBridge.start()
            reminderAuthorization.refresh()
            await chatNotifications.refreshAuthorization()
        }
    }

    private func persistToken(_ raw: String) {
        do {
            try settings.saveToken(raw)
            tokenInput = ""
            tokenMessage = "令牌已存入 iPhone 钥匙串"
        } catch {
            tokenMessage = error.localizedDescription
        }
    }

    private func persistCommandToken(_ raw: String) {
        do {
            try commandSettings.saveToken(raw)
            commandTokenInput = ""
            commandTokenMessage = "小秘书指令令牌已存入共享钥匙串"
            Task {
                _ = await intakeCoordinator.retryPending()
            }
        } catch {
            commandTokenMessage = error.localizedDescription
        }
    }
}

private struct SecretaryOrdinaryModelSettingsList: View {
    @ObservedObject var store: SecretaryChatStore

    private var currentLabel: String {
        SecretaryOrdinaryChannelSwitch.entryLabel(
            backend: store.currentOrdinaryBackend,
            secretaryID: store.displaySecretaryID
        )
    }

    var body: some View {
        Picker(SecretaryOrdinaryChannelSwitch.listTitle, selection: Binding(
            get: { store.currentOrdinaryBackend },
            set: { backend in
                Task { await store.chooseOrdinaryBackend(backend) }
            }
        )) {
            ForEach(store.ordinaryChannelSwitchBackends, id: \.self) { backend in
                Text(SecretaryOrdinaryChannelSwitch.entryLabel(
                    backend: backend,
                    secretaryID: store.displaySecretaryID
                ))
                .tag(backend)
            }
        }
        .pickerStyle(.navigationLink)
        .disabled(store.isManagingConversation || store.isStreaming)
        .accessibilityLabel("\(SecretaryOrdinaryChannelSwitch.listTitle)，当前 \(currentLabel)")
    }
}
