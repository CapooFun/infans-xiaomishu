import SwiftUI

struct SecretaryConversationListView: View {
    @ObservedObject var store: SecretaryChatStore
    var onSelect: (() -> Void)?
    var onOpenSettings: (() -> Void)?

    @State private var showsRename = false
    @State private var renameTitle = ""
    @State private var showsDeleteConfirmation = false
    @State private var deleteTarget: SecretaryChatConversationSummary?
    @State private var searchQuery = ""
    @State private var showsQuickPhotoHistory = false
    @Environment(\.secretarySurfaceOpacity) private var surfaceOpacity

    var body: some View {
        VStack(spacing: 0) {
            listHeader
            newConversationRail
            conversationSearchField
            ScrollView {
                LazyVStack(spacing: 2) {
                    if visibleConversationSummaries.isEmpty {
                        emptyState
                    } else if filteredConversationSummaries.isEmpty {
                        searchEmptyState
                    } else {
                        ForEach(filteredConversationSummaries) { conversation in
                            conversationButton(conversation)
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .scrollIndicators(.hidden)
            HStack(spacing: 8) {
                settingsAndConnectionEntry
                quickPhotoEntry
            }
            .padding(10)
            .overlay(alignment: .top) { Rectangle().fill(Color.secretaryHairline).frame(height: 1) }
        }
        .background(
            LinearGradient(
                colors: [
                    Color.secretaryBarJade.opacity(surfaceOpacity),
                    Color.secretaryPanelJade.opacity(surfaceOpacity),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        .alert("重命名会话", isPresented: $showsRename) {
            TextField("会话标题", text: $renameTitle)
            Button("取消", role: .cancel) {}
            Button("保存") { Task { await store.renameCurrentConversation(renameTitle) } }
        }
        .alert(
            "删除“\(deleteTarget.map(displayedConversationTitle) ?? "这个会话")”？",
            isPresented: $showsDeleteConfirmation,
            presenting: deleteTarget
        ) { conversation in
            Button("删除会话", role: .destructive) {
                Task { _ = await store.deleteConversation(conversation) }
            }
            Button("取消", role: .cancel) {}
        } message: { conversation in
            Text("“\(displayedConversationTitle(conversation))”会从 Mac 删除，其中已分享的文件也会一起清理，而且不能撤销。")
        }
        .sheet(isPresented: $showsQuickPhotoHistory) { QuickPhotoHistoryView() }
    }

    private var listHeader: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("会话")
                    .font(.system(size: 19, weight: .semibold, design: .serif))
                    .foregroundStyle(Color.secretaryIvory)
                Text(conversationCountLabel)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.secretaryIvory.opacity(0.45))
            }
            Spacer()
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.secretaryJade.opacity(0.17)).frame(height: 1)
        }
    }

    private var newConversationRail: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 11) {
                ForEach(store.availableSecretaries) { secretary in
                    secretarySeatButton(secretary)
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
        .scrollIndicators(.hidden)
        .frame(height: 52)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.secretaryHairline).frame(height: 1)
        }
    }

    private func secretarySeatButton(_ secretary: SecretaryChatCharacter) -> some View {
        Button {
            createConversationWithoutNamingPrompt(secretary: secretary)
        } label: {
            ZStack(alignment: .bottomTrailing) {
                SecretarySeatAvatar(
                    url: store.avatarURL(for: secretary.id),
                    name: secretary.displayName,
                    size: 44
                )
                Image(systemName: "plus")
                    .font(.system(size: 8, weight: .black))
                    .foregroundStyle(Color.secretaryDeepJade)
                    .frame(width: 16, height: 16)
                    .background(Color.secretaryJade, in: Circle())
                    .overlay { Circle().stroke(Color.secretaryDeepJade.opacity(0.9), lineWidth: 2) }
                    .offset(x: 2, y: 2)
            }
            .frame(width: 50, height: 50)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(store.isManagingConversation)
        .accessibilityLabel("和\(secretary.displayName)新建会话")
        .accessibilityHint("双击后直接打开与\(secretary.displayName)的新会话")
    }

    private var conversationSearchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.secretaryIvory.opacity(0.38))
            TextField("搜索会话", text: $searchQuery)
                .font(.system(size: 13, weight: .regular, design: .rounded))
                .foregroundStyle(Color.secretaryIvory)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityLabel("搜索会话")
            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.secretaryIvory.opacity(0.38))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清空会话搜索")
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(Color.secretaryIvory.opacity(0.055), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.secretaryHairline, lineWidth: 1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.secretaryHairline).frame(height: 1)
        }
    }

    private var normalizedSearchTerms: [String] {
        searchQuery
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
    }

    private var filteredConversationSummaries: [SecretaryChatConversationSummary] {
        let terms = normalizedSearchTerms
        guard !terms.isEmpty else { return visibleConversationSummaries }
        return visibleConversationSummaries.filter { conversation in
            let memberNames = conversation.memberIds.compactMap(memberDisplayName).joined(separator: " ")
            let searchableText = [
                displayedConversationTitle(conversation),
                conversation.title,
                conversation.lastMessage?.fallbackText ?? "",
                memberNames,
            ].joined(separator: " ")
            return terms.allSatisfy { searchableText.localizedCaseInsensitiveContains($0) }
        }
    }

    private var visibleConversationSummaries: [SecretaryChatConversationSummary] {
        SecretaryConversationVisibilityPolicy.phoneConversations(store.conversationSummaries)
    }

    private var conversationCountLabel: String {
        guard !normalizedSearchTerms.isEmpty else {
            return "\(visibleConversationSummaries.count) 个会话"
        }
        return "找到 \(filteredConversationSummaries.count) / \(visibleConversationSummaries.count) 个会话"
    }

    private func memberDisplayName(_ memberId: String) -> String? {
        if memberId == "capoo" { return "我" }
        return store.bootstrap?.characters.first(where: { $0.id == memberId })?.displayName
    }

    private func displayedConversationTitle(_ conversation: SecretaryChatConversationSummary) -> String {
        let secretaryName = memberDisplayName(conversation.activeSecretaryId) ?? store.activeSecretaryName
        return SecretaryConversationDisplayTitle.listTitle(
            storedTitle: conversation.title,
            secretaryName: secretaryName
        )
    }

    @ViewBuilder
    private func conversationButton(_ conversation: SecretaryChatConversationSummary) -> some View {
        let selected = conversation.id == store.currentConversationId
        Button {
            Task {
                await store.selectConversation(conversation.id)
                onSelect?()
            }
        } label: {
            HStack(spacing: 11) {
                ZStack {
                    SecretaryAvatarView(
                        url: store.avatarURL(for: conversation.activeSecretaryId),
                        name: memberDisplayName(conversation.activeSecretaryId) ?? store.activeSecretaryName,
                        size: 42,
                        subjectID: conversation.activeSecretaryId
                    )
                }
                .frame(width: 42, height: 42)
                .overlay(alignment: .topTrailing) {
                    if store.hasUnreadReply(in: conversation) {
                        Circle()
                            .fill(Color.secretarySignalRed)
                            .frame(width: 9, height: 9)
                            .overlay { Circle().stroke(Color.secretaryPanelJade, lineWidth: 1.5) }
                            .offset(x: 2, y: -2)
                            .accessibilityLabel("有未读回复")
                    }
                }

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(displayedConversationTitle(conversation))
                            .font(.system(size: 15, weight: selected ? .semibold : .medium, design: .rounded))
                            .foregroundStyle(Color.secretaryIvory.opacity(selected ? 1 : 0.88))
                            .lineLimit(1)
                        if conversation.privacy == "private" {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 8))
                                .foregroundStyle(Color.secretaryAmber.opacity(0.78))
                        }
                        Spacer(minLength: 4)
                        Text(updatedLabel(conversation.updatedAt))
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .foregroundStyle(Color.secretaryIvory.opacity(0.34))
                    }

                    HStack(spacing: 6) {
                        Text(conversation.lastMessage?.fallbackText ?? "还没有消息")
                            .font(.system(size: 12, weight: .regular, design: .rounded))
                            .foregroundStyle(Color.secretaryIvory.opacity(0.46))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if store.pendingCount(for: conversation.id) > 0 {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Color.secretaryAmber)
                                .accessibilityLabel("\(store.pendingCount(for: conversation.id))句话待送出")
                        }
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .background(
                selected ? Color.secretaryDeepJade.opacity(0.66) : Color.clear,
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(selected ? Color.secretaryJade.opacity(0.28) : .clear, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(displayedConversationTitle(conversation))
        .accessibilityHint("打开这条会话")
        .accessibilityValue(selected ? "当前会话" : "")
        .contextMenu {
            Button {
                Task {
                    await store.selectConversation(conversation.id)
                    renameTitle = conversation.title
                    showsRename = true
                }
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleteTarget = conversation
                showsDeleteConfirmation = true
            } label: {
                Label("删除", systemImage: "trash")
            }
            .disabled(store.pendingCount(for: conversation.id) > 0 || store.isStreaming)
        }
    }

    private var quickPhotoEntry: some View {
        utilityEntry("最近收件", symbol: "photo.stack") { showsQuickPhotoHistory = true }
            .accessibilityLabel("打开发件箱")
    }

    @ViewBuilder
    private var settingsAndConnectionEntry: some View {
        if let onOpenSettings {
            utilityEntry("设置", symbol: "gearshape.fill", action: onOpenSettings)
                .accessibilityLabel("打开设置")
        }
    }

    private func utilityEntry(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
                Text(title).font(.system(size: 13, weight: .semibold, design: .rounded))
            }
            .foregroundStyle(Color.secretaryIvory.opacity(0.9))
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Color.secretaryIvory.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain)
    }

    private var emptyState: some View {
        VStack(spacing: 9) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(Color.secretaryJade.opacity(0.7))
            Text("没有可显示的会话")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.55))
            Text("从上方头像选择一位秘书")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.38))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 50)
    }

    private var searchEmptyState: some View {
        VStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(Color.secretaryJade.opacity(0.7))
            Text("没找到匹配的会话")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.55))
            Text("可以换个标题、消息关键词或成员名试试。")
                .font(.system(size: 11, weight: .regular, design: .rounded))
                .foregroundStyle(Color.secretaryIvory.opacity(0.38))
                .multilineTextAlignment(.center)
            Button("清空搜索") { searchQuery = "" }
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.secretaryJade)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.vertical, 50)
    }

    private var connectionStatusColor: Color {
        switch store.connectionState {
        case .online: return Color.secretaryJade.opacity(0.76)
        case .loading: return Color.secretaryIvory.opacity(0.46)
        case .offline, .needsPairing: return Color.secretaryAmber.opacity(0.84)
        }
    }

    private func createConversationWithoutNamingPrompt(secretary: SecretaryChatCharacter) {
        let title = fallbackConversationTitle(for: secretary)
        Task {
            await store.createConversation(title: title, secretaryId: secretary.id)
            if store.managementError == nil { onSelect?() }
        }
    }

    private func fallbackConversationTitle(for secretary: SecretaryChatCharacter) -> String {
        SecretaryConversationDisplayTitle.nextStoredTitle(secretaryName: secretary.displayName)
    }

    private func updatedLabel(_ rawValue: String?) -> String {
        guard let rawValue,
              let date = try? Date(rawValue, strategy: .iso8601) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "昨天" }
        if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
            return date.formatted(.dateTime.month().day())
        }
        return date.formatted(.dateTime.year().month().day())
    }
}

private struct SecretarySeatAvatar: View {
    let url: URL?
    let name: String
    let size: CGFloat

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                ZStack {
                    LinearGradient(
                        colors: [Color.secretaryJade.opacity(0.86), Color.secretaryDeepJade],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    Text(String(name.prefix(1)))
                        .font(.system(size: size * 0.38, weight: .semibold, design: .serif))
                        .foregroundStyle(Color.secretaryIvory)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay { Circle().stroke(Color.secretaryJade.opacity(0.42), lineWidth: 1) }
        .shadow(color: Color.black.opacity(0.2), radius: 7, y: 3)
    }
}

struct SecretaryQuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Color.secretaryIvory.opacity(configuration.isPressed ? 0.55 : 0.86))
            .background(Color.secretaryIvory.opacity(configuration.isPressed ? 0.12 : 0.055), in: Circle())
            .contentShape(Circle())
    }
}
