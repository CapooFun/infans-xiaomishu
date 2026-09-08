import CryptoKit
import ImageIO
import PhotosUI
import SwiftUI

struct SecretaryCharacterPhoto: Codable, Identifiable {
    let assetId: String
    let subject: String?
    let width: Int
    let height: Int
    let sha256: String
    let mime: String
    var id: String { assetId }
}

struct SecretaryCharacterCatalog: Codable {
    var revision = 0
    var assets: [SecretaryCharacterPhoto] = []
    var selections: [String: String] = [:]
}

enum SecretaryAppearancePhotoSlot: String, Identifiable {
    case avatar
    case background
    case shareBackground

    var id: String { rawValue }
    var title: String {
        switch self { case .avatar: "头像"; case .background: "聊天背景"; case .shareBackground: "分享页背景" }
    }
    var detail: String {
        switch self {
        case .avatar: "用于消息头像和沉浸朗读的大图。"
        case .background: "用于单聊背景，iPhone 和 iPad 会按屏幕自动裁切。"
        case .shareBackground: "用于“发给秘书”的分享页。其他设备打开小秘书后同步。"
        }
    }
    var symbol: String { self == .avatar ? "person.crop.square" : "rectangle.landscape" }

}

@MainActor
final class SecretaryCharacterPhotos: ObservableObject {
    static let shared = SecretaryCharacterPhotos()
    @Published private(set) var catalog = SecretaryCharacterCatalog()
    @Published private(set) var images: [String: UIImage] = [:]
    @Published private(set) var busy = false
    @Published var error: String?
    private var refreshing = false
    private var selectedImages: [String: UIImage] = [:]
    private let directory: URL

    init() {
        directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SecretaryCharacterPhotos", isDirectory: true)
        if let data = try? Data(contentsOf: directory.appendingPathComponent("catalog.json")),
           let saved = try? JSONDecoder().decode(SecretaryCharacterCatalog.self, from: data) {
            catalog = saved
            for asset in saved.assets {
                if let data = try? Data(contentsOf: directory.appendingPathComponent(asset.id + ".thumb")) {
                    images[asset.id] = Self.thumbnail(data)
                }
                if saved.selections.values.contains(asset.id),
                   let data = try? Data(contentsOf: directory.appendingPathComponent(asset.id)),
                   Self.digest(data) == asset.sha256 {
                    selectedImages[asset.id] = Self.thumbnail(data)
                }
            }
        }
    }

    private func selectionKey(subjectID: String, slot: SecretaryAppearancePhotoSlot) -> String {
        "\(subjectID):\(slot.rawValue)"
    }

    private func selectedAssetID(subjectID: String, slot: SecretaryAppearancePhotoSlot) -> String? {
        catalog.selections[selectionKey(subjectID: subjectID, slot: slot)]
            ?? (subjectID == "yinyue" ? catalog.selections[slot.rawValue] : nil)
    }

    func image(for slot: SecretaryAppearancePhotoSlot, subjectID: String?) -> UIImage? {
        guard let subjectID,
              let id = selectedAssetID(subjectID: subjectID, slot: slot) else { return nil }
        return selectedImages[id] ?? images[id]
    }

    func hasCustomImage(for slot: SecretaryAppearancePhotoSlot, subjectID: String) -> Bool {
        selectedAssetID(subjectID: subjectID, slot: slot) != nil
    }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1600
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private func request(_ suffix: String = "", body: [String: Any]? = nil) async throws -> Data {
        let raw = CodexCommandSettings.shared.serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let bearer = CodexCommandTokenKeychain.read()
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1",
              let token = bearer, !token.isEmpty else {
            throw PhotoError.message("请先连接小秘书，再更换图片。")
        }
        var request = URLRequest(url: base.appendingPathComponent("api/secretary-mobile/character-photos" + suffix))
        request.timeoutInterval = 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PhotoError.message("暂时连不上小秘书，请稍后重试。")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 409 {
                throw PhotoError.message("另一台设备刚刚更换了图片，请刷新后重试。")
            }
            if http.statusCode == 400,
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = object["error"] as? String {
                throw PhotoError.message(text)
            }
            throw PhotoError.message("图片还没有换好，请稍后重试。")
        }
        return data
    }

    private func accept(_ data: Data) throws {
        let snapshot = try JSONDecoder().decode(SecretaryCharacterCatalog.self, from: data)
        guard snapshot.revision >= catalog.revision else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(
            to: directory.appendingPathComponent("catalog.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        catalog = snapshot
        let ids = Set(snapshot.assets.map(\.id))
        let selectedIDs = Set(snapshot.selections.values)
        images = images.filter { ids.contains($0.key) }
        selectedImages = selectedImages.filter { selectedIDs.contains($0.key) }
        try synchronizeShareBackground()
        for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            let name = url.lastPathComponent
            let keepThumbnail = url.pathExtension == "thumb" && ids.contains(url.deletingPathExtension().lastPathComponent)
            let keepOriginal = selectedIDs.contains(name)
            if name != "catalog.json" && !keepThumbnail && !keepOriginal {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private func synchronizeShareBackground() throws {
        let image = selectedAssetID(subjectID: "yinyue", slot: .shareBackground)
            .flatMap { selectedImages[$0] }
        try SecretarySharedConfiguration.saveShareBackground(image?.jpegData(compressionQuality: 0.9))
    }

    private func load(_ asset: SecretaryCharacterPhoto) async {
        let selected = catalog.selections.values.contains(asset.id)
        guard images[asset.id] == nil || (selected && selectedImages[asset.id] == nil) else { return }
        do {
            let data = try await request("/\(asset.id)/" + (selected ? "content" : "thumbnail"))
            guard (!selected || Self.digest(data) == asset.sha256),
                  let image = Self.thumbnail(data) else {
                throw PhotoError.message("图片没有完整取回，请重试。")
            }
            guard catalog.assets.contains(where: { $0.id == asset.id }) else { return }
            if selected {
                guard catalog.selections.values.contains(asset.id) else { return }
                try data.write(
                    to: directory.appendingPathComponent(asset.id),
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
                )
                selectedImages[asset.id] = image
                try synchronizeShareBackground()
            } else {
                try data.write(
                    to: directory.appendingPathComponent(asset.id + ".thumb"),
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
                )
            }
            images[asset.id] = image
        } catch {
            self.error = "图片暂时取不到，安装包里的默认图片仍可使用。"
        }
    }

    func refresh() async {
        guard !refreshing, !busy else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            try accept(await request())
            error = nil
            for id in Set(catalog.selections.values) {
                if let asset = catalog.assets.first(where: { $0.id == id }) {
                    await load(asset)
                }
            }
        } catch {
            self.error = "暂时连不上小秘书。已有选择继续生效，更换请稍后重试。"
        }
    }

    func replace(
        _ data: Data,
        id: String,
        subjectID: String,
        slot: SecretaryAppearancePhotoSlot
    ) async -> Bool {
        await change("/import", body: [
            "assetId": id,
            "subject": subjectID,
            "slot": slot.rawValue,
            "data": data.base64EncodedString(),
            "sha256": Self.digest(data),
            "source": ["kind": "photos"]
        ])
    }

    func restoreDefault(subjectID: String, slot: SecretaryAppearancePhotoSlot) async {
        _ = await change("/reset", body: ["subject": subjectID, "slot": slot.rawValue])
    }

    private func change(_ suffix: String, body: [String: Any]) async -> Bool {
        guard !busy else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            var payload = body
            payload["expectedRevision"] = catalog.revision
            try accept(await request(suffix, body: payload))
            for asset in catalog.assets where catalog.selections.values.contains(asset.id) {
                await load(asset)
            }
            if selectedAssetID(subjectID: "yinyue", slot: .shareBackground) != nil,
               image(for: .shareBackground, subjectID: "yinyue") == nil {
                throw PhotoError.message("图片已保存，但还没有取回本设备，请刷新后重试。")
            }
            try synchronizeShareBackground()
            return true
        } catch {
            self.error = (error as? PhotoError)?.localizedDescription ?? "这次没有换好，请稍后重试。"
            return false
        }
    }

    private enum PhotoError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            if case let .message(text) = self { return text }
            return nil
        }
    }
}

struct SecretaryAppearancePhotosView: View {
    let secretaryID: String
    let secretaryName: String
    let defaultAvatarURL: URL?
    @ObservedObject private var photos = SecretaryCharacterPhotos.shared
    @State private var avatarItem: PhotosPickerItem?
    @State private var backgroundItem: PhotosPickerItem?
    @State private var shareBackgroundItem: PhotosPickerItem?
    @State private var draft: SecretaryAppearancePhotoDraft?
    @State private var pickerError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(secretaryName)的外观")
                        .font(.system(.title2, design: .serif, weight: .semibold))
                    Text("选择头像、聊天背景或分享页背景。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                appearanceCard(.avatar, pickerItem: $avatarItem)
                appearanceCard(.background, pickerItem: $backgroundItem)
                if secretaryID == "yinyue" {
                    appearanceCard(.shareBackground, pickerItem: $shareBackgroundItem)
                }

                if let error = pickerError ?? photos.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
        .navigationTitle("头像与背景")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await photos.refresh() }
        .task { await photos.refresh() }
        .onChange(of: avatarItem) { _, item in
            prepare(item, slot: .avatar)
        }
        .onChange(of: backgroundItem) { _, item in
            prepare(item, slot: .background)
        }
        .onChange(of: shareBackgroundItem) { _, item in
            prepare(item, slot: .shareBackground)
        }
        .sheet(item: $draft) { draft in
            SecretaryAppearancePhotoConfirmation(
                draft: draft,
                secretaryID: secretaryID,
                secretaryName: secretaryName,
                onSaved: { self.draft = nil }
            )
        }
    }

    @ViewBuilder
    private func appearanceCard(
        _ slot: SecretaryAppearancePhotoSlot,
        pickerItem: Binding<PhotosPickerItem?>
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                appearancePreview(slot)
                VStack(alignment: .leading, spacing: 5) {
                    Label(slot.title, systemImage: slot.symbol)
                        .font(.system(.headline, design: .rounded))
                    Text(slot.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                PhotosPicker(selection: pickerItem, matching: .images) {
                    Label("更换\(slot.title)", systemImage: "photo.badge.plus")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.secretaryJade)
                .disabled(photos.busy)

                if photos.hasCustomImage(for: slot, subjectID: secretaryID) {
                    Button("恢复默认") {
                        Task { await photos.restoreDefault(subjectID: secretaryID, slot: slot) }
                    }
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
                    .disabled(photos.busy)
                }
            }
        }
        .padding(16)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.secretaryJade.opacity(0.14), lineWidth: 1)
        }
    }

    @ViewBuilder
    private func appearancePreview(_ slot: SecretaryAppearancePhotoSlot) -> some View {
        Group {
            if let image = photos.image(for: slot, subjectID: secretaryID) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if slot == .avatar {
                AsyncImage(url: defaultAvatarURL) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                    else { Image(SecretaryBundledArt.avatarAssetName(for: secretaryID)).resizable().scaledToFill() }
                }
            } else {
                Image(SecretaryBundledArt.backgroundAssetName(for: secretaryID, landscape: true)).resizable().scaledToFill()
            }
        }
        .frame(width: slot == .avatar ? 82 : 118, height: 82)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .accessibilityLabel("当前\(secretaryName)\(slot.title)")
    }

    private func prepare(_ item: PhotosPickerItem?, slot: SecretaryAppearancePhotoSlot) {
        guard let item else { return }
        Task {
            defer {
                switch slot {
                case .avatar: avatarItem = nil
                case .background: backgroundItem = nil
                case .shareBackground: shareBackgroundItem = nil
                }
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      data.count <= 24 * 1024 * 1024,
                      SecretaryCharacterPhotos.thumbnail(data) != nil else {
                    pickerError = "请选择小于 24 MB 的静态照片。"
                    return
                }
                draft = SecretaryAppearancePhotoDraft(
                    id: "photo-" + UUID().uuidString.lowercased(),
                    data: data,
                    slot: slot
                )
                pickerError = nil
            } catch {
                pickerError = "这张照片暂时无法读取，请重新选择。"
            }
        }
    }
}

struct SecretaryAppearancePhotoDraft: Identifiable {
    let id: String
    let data: Data
    let slot: SecretaryAppearancePhotoSlot
}

private struct SecretaryAppearancePhotoConfirmation: View {
    let draft: SecretaryAppearancePhotoDraft
    let secretaryID: String
    let secretaryName: String
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var photos = SecretaryCharacterPhotos.shared

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if let image = SecretaryCharacterPhotos.thumbnail(draft.data) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                Text("只会替换\(secretaryName)的\(draft.slot.title)。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let error = photos.error {
                    Text(error).font(.footnote).foregroundStyle(.secondary)
                }
                Button(photos.busy ? "正在更换…" : "设为\(draft.slot.title)") {
                    Task {
                        if await photos.replace(
                            draft.data,
                            id: draft.id,
                            subjectID: secretaryID,
                            slot: draft.slot
                        ) {
                            onSaved()
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, minHeight: 44)
                .disabled(photos.busy)
            }
            .padding(20)
            .navigationTitle("确认更换\(draft.slot.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }.disabled(photos.busy)
                }
            }
        }
        .interactiveDismissDisabled(photos.busy)
    }
}
