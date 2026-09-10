import SwiftUI

enum SecretaryConversationInspectorPresentation: Equatable {
    case full
}

struct SecretaryConversationInspectorView: View {
    @ObservedObject var store: SecretaryChatStore
    var presentation: SecretaryConversationInspectorPresentation = .full
    var onClose: (() -> Void)? = nil
    @State private var controlDraft: SecretaryControlDraft?

    @ViewBuilder
    var body: some View {
        fullInspector
    }

    private var fullInspector: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                inspectorHeader
                membersSection
                controlsSection
            }
            .padding(16)
        }
        .background(Color.black.opacity(0.16))
        .task(id: store.currentConversation?.version) { synchronizeDraft() }
    }

    private var inspectorHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("与\(store.activeSecretaryName)聊天")
                .font(.system(size: 18, weight: .semibold, design: .serif))
                .foregroundStyle(Color.secretaryIvory)
            Text("一对一会话。模型位由你自行接入。")
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.46))
            if let onClose {
                Button("关闭", action: onClose)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.secretaryJade)
            }
        }
    }

    private var membersSection: some View {
        inspectorSection(title: "这一边", caption: "你和值班秘书") {
            VStack(spacing: 8) {
                memberRow(name: "我", characterId: "self", role: "本人")
                ForEach(store.currentMembers) { character in
                    memberRow(
                        name: character.displayName,
                        characterId: character.id,
                        role: "秘书"
                    )
                }
            }
        }
    }

    private var controlsSection: some View {
        inspectorSection(title: "这次聊天", caption: "用量由 Mac 回传，模型空着时请自行接入") {
            VStack(spacing: 13) {
                if let draft = controlDraft, !allowedCurrentBackends.isEmpty {
                    protocolPicker(
                        title: "模型",
                        selection: Binding(
                            get: { draft.ordinaryBackend ?? "" },
                            set: { controlDraft?.ordinaryBackend = $0 }
                        ),
                        values: allowedCurrentBackends
                    )

                    Button {
                        guard let controlDraft else { return }
                        Task {
                            await store.saveControls(
                                qualityMode: controlDraft.qualityMode,
                                ordinaryBackend: controlDraft.ordinaryBackend,
                                cursorModel: controlDraft.cursorModel
                            )
                        }
                    } label: {
                        HStack {
                            if store.isManagingConversation { ProgressView().tint(.black) }
                            Text("保存")
                        }
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(Color(red: 0.015, green: 0.11, blue: 0.09))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.secretaryJade, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(store.isManagingConversation)
                }

                usageSummary
            }
        }
    }

    private func memberRow(name: String, characterId: String, role: String) -> some View {
        HStack(spacing: 9) {
            SecretaryAvatarView(url: store.avatarURL(for: characterId), name: name, size: 28, subjectID: characterId)
            Text(name)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.86))
            Spacer()
            Text(role)
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(Color.secretaryJade.opacity(0.7))
        }
    }

    private func protocolPicker(title: String, selection: Binding<String>, values: [String]) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.58))
            Spacer()
            Picker(title, selection: selection) {
                ForEach(values, id: \.self) { value in
                    Text(displayLabel(value)).tag(value)
                }
            }
            .labelsHidden()
            .tint(Color.secretaryJade)
        }
    }

    private func inspectorSection<Content: View>(
        title: String,
        caption: String?,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.68))
            if let caption {
                Text(caption)
                    .font(.system(size: 9, design: .rounded))
                    .foregroundStyle(Color.secretaryIvory.opacity(0.34))
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 2)
    }

    private var mutationInfo: SecretaryChatConversationMutationInfo? {
        store.bootstrap?.protocolInfo.conversationMutation
    }

    private var allowedCurrentBackends: [String] {
        let available = store.bootstrap?.modelRuntime?.ordinary.options.filter(\.available).map(\.backend) ?? []
        let declared = mutationInfo?.allowedOrdinaryBackends?.filter(available.contains) ?? available
        return protocolValues(declared, current: controlDraft?.ordinaryBackend)
    }

    private var allowedCursorModels: [String] {
        protocolValues(mutationInfo?.allowedCursorModels, current: controlDraft?.cursorModel)
    }

    private func protocolValues(_ values: [String]?, current: String?) -> [String] {
        let provided = values ?? []
        if let current, !provided.contains(current) { return [current] + provided }
        return provided.isEmpty ? current.map { [$0] } ?? [] : provided
    }

    private func synchronizeDraft() {
        guard let state = store.currentControls else {
            controlDraft = nil
            return
        }
        controlDraft = SecretaryControlDraft(
            qualityMode: state.qualityMode,
            ordinaryBackend: state.ordinaryBackend ?? store.bootstrap?.modelRuntime?.ordinary.selected,
            cursorModel: state.cursorModel ?? mutationInfo?.allowedCursorModels?.first
        )
    }

    private func displayLabel(_ value: String) -> String {
        _ = value
        return "未配置"
    }

    @ViewBuilder
    private var usageSummary: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("当前会话执行（只读）")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.58))
            Text("最近模型：\(store.currentExecutionMetrics?.latestModel ?? "未知")")
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.45))
            Text(conversationTokenText)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.45))
            Text(conversationCostText)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.45))
            if let usage = store.bootstrap?.usage {
                Text(openRouterUsageText(usage.openrouter))
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(Color.secretaryIvory.opacity(0.38))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.secretaryIvory.opacity(0.025), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var conversationTokenText: String {
        guard let metrics = store.currentExecutionMetrics else { return "本次累计 token：未知" }
        if metrics.tokensComplete { return "本次累计 token：\(metrics.totalTokens)" }
        return metrics.totalTokens > 0
            ? "本次累计 token：\(metrics.totalTokens)（仅已报告部分）"
            : "本次累计 token：未知"
    }

    private var conversationCostText: String {
        guard let metrics = store.currentExecutionMetrics else { return "本次累计费用：未知" }
        if metrics.costComplete {
            return String(format: "本次累计费用：$%.4f", metrics.reportedCostUSD)
        }
        return metrics.reportedCostUSD > 0
            ? String(format: "本次累计费用：$%.4f（仅已报告部分）", metrics.reportedCostUSD)
            : "本次累计费用：未知"
    }

    private func openRouterUsageText(_ usage: SecretaryChatProviderUsage) -> String {
        guard usage.available else { return "OpenRouter：当前没有可读用量。" }
        if let used = usage.usageUsd, let limit = usage.limitUsd {
            return String(format: "OpenRouter：已用 $%.2f / $%.2f", used, limit)
        }
        if let remaining = usage.limitRemainingUsd {
            return String(format: "OpenRouter：剩余 $%.2f", remaining)
        }
        return "OpenRouter：Mac 已返回只读用量。"
    }
}

private struct SecretaryControlDraft {
    var qualityMode: String
    var ordinaryBackend: String?
    var cursorModel: String?
}
