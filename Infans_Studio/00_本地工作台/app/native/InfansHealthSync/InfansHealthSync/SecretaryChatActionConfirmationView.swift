import SwiftUI

struct SecretaryChatActionConfirmationView: View {
    @ObservedObject var store: SecretaryChatStore
    @State private var showsBefore = false
    @State private var showsAfter = false

    var body: some View {
        NavigationStack {
            Group {
                if let action = store.presentedControlledAction {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            header(action)
                            preview(action.publicPreview)
                            decisionStatus(action)
                            decisionButtons(action)
                        }
                        .padding(20)
                    }
                } else {
                    ContentUnavailableView(
                        "这项确认已更新",
                        systemImage: "checkmark.shield",
                        description: Text("请回到会话查看最新状态。")
                    )
                }
            }
            .background(SecretaryJadeBackground())
            .navigationTitle("受控写入确认")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { store.dismissControlledActionConfirmation() }
                        .disabled(store.decidingActionID != nil)
                }
            }
        }
        .interactiveDismissDisabled(store.decidingActionID != nil)
    }

    private func header(_ action: SecretaryChatControlledAction) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(action.label, systemImage: "checkmark.shield.fill")
                .font(.system(size: 22, weight: .semibold, design: .serif))
                .foregroundStyle(Color.secretaryIvory)
            Text("只会按 Mac 给出的这份公开预览决定，iPhone 和 iPad 不接收可执行正文。")
                .font(.system(size: 12, weight: .regular, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.58))
        }
    }

    private func preview(_ preview: SecretaryChatActionPublicPreview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            actionField("真实目标", value: preview.targetLabel)
            if let path = preview.targetPath, !path.isEmpty {
                actionField("目标路径", value: path)
            }
            actionField("要做什么", value: preview.summary.isEmpty ? "Mac 没有提供更多摘要" : preview.summary)

            if !preview.before.isEmpty {
                DisclosureGroup(isExpanded: $showsBefore) {
                    Text(preview.before)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 8)
                } label: {
                    Text("展开查看写入前")
                }
            }
            if !preview.after.isEmpty {
                DisclosureGroup(isExpanded: $showsAfter) {
                    Text(preview.after)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 8)
                } label: {
                    Text("展开查看写入后")
                }
            }
        }
        .font(.system(size: 14, weight: .regular, design: .rounded))
        .foregroundStyle(Color.secretaryIvory.opacity(0.9))
        .padding(16)
        .background(Color.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.secretaryJade.opacity(0.18), lineWidth: 1)
        }
    }

    @ViewBuilder
    private func decisionStatus(_ action: SecretaryChatControlledAction) -> some View {
        if let notice = store.actionDecisionNotice {
            Label(notice, systemImage: notice.contains("预览已更新") ? "arrow.triangle.2.circlepath" : "exclamationmark.triangle.fill")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.secretaryAmber)
        } else if let expiresAt = action.publicPreview.expiresAt {
            Text("预览有效期：\(expiresAt)")
                .font(.system(size: 11, weight: .regular, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.48))
        }
    }

    private func decisionButtons(_ action: SecretaryChatControlledAction) -> some View {
        HStack(spacing: 12) {
            Button {
                Task { await store.decideControlledAction(action.actionId, decision: "cancel") }
            } label: {
                Text("取消").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            Button {
                Task { await store.decideControlledAction(action.actionId, decision: "confirm") }
            } label: {
                HStack {
                    if store.decidingActionID == action.actionId { ProgressView() }
                    Text("确认写入")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.secretaryJade)
        }
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .disabled(store.decidingActionID != nil || store.nextPendingControlledAction?.actionId != action.actionId)
    }

    private func actionField(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.secretaryJade.opacity(0.72))
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SecretaryChatActionHistoryCard: View {
    @ObservedObject var store: SecretaryChatStore
    let action: SecretaryChatControlledAction

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: stateSymbol)
                Text(action.label).fontWeight(.semibold)
                Spacer(minLength: 8)
                Text(stateLabel)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(stateColor)
            }
            Text(action.publicPreview.targetLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.secretaryJade.opacity(0.78))
            if !action.publicPreview.summary.isEmpty {
                Text(action.publicPreview.summary)
                    .font(.caption)
                    .foregroundStyle(Color.secretaryIvory.opacity(0.74))
                    .lineLimit(3)
            }
            if let message = action.error?.message, action.state == "failed" {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(Color.secretaryAmber)
            }
            if action.isPending {
                Button("查看并确认") { store.presentControlledAction(action.actionId) }
                    .font(.caption.weight(.semibold))
                    .disabled(store.nextPendingControlledAction?.actionId != action.actionId)
            }
        }
        .font(.system(size: 13, weight: .regular, design: .rounded))
        .foregroundStyle(Color.secretaryIvory)
        .padding(12)
        .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(stateColor.opacity(0.34), lineWidth: 1)
        }
        .frame(maxWidth: 360, alignment: .leading)
    }

    private var stateLabel: String {
        switch action.state {
        case "pending": "待确认"
        case "preparing": "正在准备"
        case "committing": "正在写入"
        case "completed": "已完成"
        case "cancelled": "已取消"
        case "failed": "未完成"
        default: "Mac 状态：\(action.state)"
        }
    }

    private var stateSymbol: String {
        switch action.state {
        case "completed": "checkmark.circle.fill"
        case "cancelled": "xmark.circle"
        case "failed": "exclamationmark.triangle.fill"
        default: "checkmark.shield.fill"
        }
    }

    private var stateColor: Color {
        switch action.state {
        case "completed": Color.secretaryJade
        case "failed": Color.secretaryAmber
        case "cancelled": Color.secretaryIvory.opacity(0.5)
        default: Color.secretaryAmber
        }
    }
}
