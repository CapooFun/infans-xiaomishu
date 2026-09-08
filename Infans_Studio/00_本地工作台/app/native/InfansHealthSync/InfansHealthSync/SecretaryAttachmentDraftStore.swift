import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct SecretaryAttachmentDraft: Codable, Identifiable, Equatable, Sendable {
    static let maximumCount = 4

    let id: String
    let conversationId: String
    let name: String
    let mimeType: String
    let kind: String
    let sizeBytes: Int
    let localFileName: String
    let durationMs: Int?
    var transcript: String?
    var uploadedAttachment: SecretaryChatAttachment?
    var lastError: String?

    init(
        id: String = "iosasset_\(UUID().uuidString.lowercased())",
        conversationId: String,
        name: String,
        mimeType: String,
        kind: String,
        sizeBytes: Int,
        localFileName: String? = nil,
        durationMs: Int? = nil,
        transcript: String? = nil,
        uploadedAttachment: SecretaryChatAttachment? = nil,
        lastError: String? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.name = name
        self.mimeType = mimeType
        self.kind = kind
        self.sizeBytes = sizeBytes
        self.localFileName = localFileName ?? "\(id).\(SecretaryAttachmentMIME.preferredExtension(for: mimeType) ?? "data")"
        self.durationMs = durationMs
        self.transcript = transcript
        self.uploadedAttachment = uploadedAttachment
        self.lastError = lastError
    }

    var isValid: Bool {
        id.range(of: #"^[0-9A-Za-z_-]{8,80}$"#, options: .regularExpression) != nil
            && !id.contains("..")
            && !conversationId.isEmpty
            && name == SecretaryAttachmentMIME.safeBaseName(name)
            && SecretaryAttachmentMIME.kind(for: mimeType) == kind
            && sizeBytes > 0
            && sizeBytes <= SecretaryAttachmentMIME.maximumBytes(for: kind)
            && (kind != "audio" || (durationMs.map { (1...SecretaryVoiceRecording.maximumDurationMs).contains($0) } ?? false))
            && localFileName.hasPrefix(id + ".")
            && !localFileName.contains("/")
            && !localFileName.contains("..")
    }

    var messageAttachment: SecretaryChatAttachment {
        let resourcePath = uploadedAttachment?.resourcePath ?? "local-draft:\(id)"
        let fallback = normalizedTranscript
            ?? (lastError == nil ? "正在识别这段原声…" : "原声已保留，可以重试识别")
        return SecretaryChatAttachment(
            id: id,
            kind: kind,
            name: name,
            mimeType: mimeType,
            resourcePath: resourcePath,
            fallbackText: kind == "audio" ? fallback : name,
            durationMs: durationMs,
            transcript: normalizedTranscript
        )
    }

    var normalizedTranscript: String? {
        guard let clean = transcript?.trimmingCharacters(in: .whitespacesAndNewlines), !clean.isEmpty else { return nil }
        return clean
    }

    var requiresTranscript: Bool { kind == "audio" && normalizedTranscript == nil }
}

enum SecretaryAttachmentSelectionPolicy {
    static func canAccept(existingCount: Int, incomingCount: Int = 1) -> Bool {
        existingCount >= 0
            && incomingCount > 0
            && existingCount + incomingCount <= SecretaryAttachmentDraft.maximumCount
    }
}

enum SecretaryAttachmentMIME {
    static let imageMaximumBytes = 8 * 1_024 * 1_024
    static let audioMaximumBytes = 5 * 1_024 * 1_024
    static let fileMaximumBytes = 15 * 1_024 * 1_024

    private static let byExtension: [String: String] = [
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
        "pdf": "application/pdf",
        "txt": "text/plain",
        "md": "text/markdown",
        "csv": "text/csv",
        "json": "application/json",
        "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt": "application/vnd.ms-powerpoint",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]

    static let importedContentTypes: [UTType] = byExtension.keys.sorted().compactMap {
        UTType(filenameExtension: $0)
    }

    static func mimeType(forFileName name: String) -> String? {
        byExtension[(name as NSString).pathExtension.lowercased()]
    }

    static func kind(for mimeType: String) -> String? {
        if mimeType == "image/jpeg"
            || mimeType == "image/png"
            || mimeType == "image/webp"
            || mimeType == "image/gif" { return "image" }
        if mimeType == "audio/mp4" { return "audio" }
        if byExtension.values.contains(mimeType) { return "file" }
        return nil
    }

    static func maximumBytes(for kind: String) -> Int {
        if kind == "image" { return imageMaximumBytes }
        if kind == "audio" { return audioMaximumBytes }
        return fileMaximumBytes
    }

    static func preferredExtension(for mimeType: String) -> String? {
        if mimeType == "image/jpeg" { return "jpg" }
        if mimeType == "audio/mp4" { return "m4a" }
        return byExtension.first(where: { $0.value == mimeType })?.key
    }

    static func safeBaseName(_ raw: String) -> String {
        let base = (raw as NSString).lastPathComponent
            .replacingOccurrences(of: #"[\\/:*?\"<>|\u{0000}]"#, with: "_", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let clean = String(base.drop(while: { $0 == "." }).prefix(120))
        return clean.isEmpty ? "附件" : clean
    }
}

struct SecretaryNormalizedPhoto: Equatable, Sendable {
    let data: Data
    let fileName: String
    let mimeType: String
}

enum SecretaryPhotoNormalizer {
    static func normalize(
        _ data: Data,
        sourceTypeIdentifier: String? = nil,
        suggestedName: String = "照片"
    ) throws -> SecretaryNormalizedPhoto {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0 else {
            throw SecretaryAttachmentDraftError.imageUnreadable
        }
        let detectedType = (CGImageSourceGetType(source) as String?)?.lowercased() ?? ""
        let declaredType = sourceTypeIdentifier?.lowercased() ?? ""
        let isHEIC = [detectedType, declaredType].contains { type in
            type.contains("heic") || type.contains("heif")
        }
        let detectedMime = mimeType(forImageType: detectedType)
        if !isHEIC,
           let detectedMime,
           data.count <= SecretaryAttachmentMIME.imageMaximumBytes {
            let ext = SecretaryAttachmentMIME.preferredExtension(for: detectedMime) ?? "jpg"
            return SecretaryNormalizedPhoto(
                data: data,
                fileName: normalizedPhotoName(suggestedName, extension: ext),
                mimeType: detectedMime
            )
        }
        return try reencodeJPEG(source, suggestedName: suggestedName)
    }

    private static func reencodeJPEG(
        _ source: CGImageSource,
        suggestedName: String
    ) throws -> SecretaryNormalizedPhoto {
        let pixelSizes = [4_096, 3_200, 2_560, 2_048, 1_600, 1_280, 960, 720]
        let qualities: [CGFloat] = [0.90, 0.82, 0.74, 0.66, 0.56, 0.46]
        for pixelSize in pixelSizes {
            let thumbnailOptions: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
                continue
            }
            for quality in qualities {
                let output = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(
                    output,
                    UTType.jpeg.identifier as CFString,
                    1,
                    nil
                ) else { continue }
                // Only pixels and compression quality are written. Source EXIF,
                // GPS, capture time and provider metadata are never copied.
                CGImageDestinationAddImage(
                    destination,
                    image,
                    [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
                )
                guard CGImageDestinationFinalize(destination) else { continue }
                let encoded = output as Data
                if !encoded.isEmpty, encoded.count <= SecretaryAttachmentMIME.imageMaximumBytes {
                    return SecretaryNormalizedPhoto(
                        data: encoded,
                        fileName: normalizedPhotoName(suggestedName, extension: "jpg"),
                        mimeType: "image/jpeg"
                    )
                }
            }
        }
        throw SecretaryAttachmentDraftError.imageTooLarge
    }

    private static func mimeType(forImageType identifier: String) -> String? {
        if identifier.contains("jpeg") || identifier.contains("jpg") { return "image/jpeg" }
        if identifier.contains("png") { return "image/png" }
        if identifier.contains("webp") { return "image/webp" }
        if identifier.contains("gif") { return "image/gif" }
        return nil
    }

    private static func normalizedPhotoName(_ raw: String, extension ext: String) -> String {
        let base = SecretaryAttachmentMIME.safeBaseName(raw)
        let stem = (base as NSString).deletingPathExtension
        return SecretaryAttachmentMIME.safeBaseName("\(stem.isEmpty ? "照片" : stem).\(ext)")
    }
}

actor SecretaryAttachmentDraftStore {
    let directoryURL: URL

    init(directoryURL: URL = SecretaryAttachmentDraftStore.defaultDirectoryURL()) {
        self.directoryURL = directoryURL
    }

    static func defaultDirectoryURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("SecretaryAttachmentDrafts", isDirectory: true)
            .appendingPathComponent("private-staging", isDirectory: true)
    }

    func stagePhoto(
        data: Data,
        sourceTypeIdentifier: String?,
        suggestedName: String,
        conversationId: String
    ) throws -> SecretaryAttachmentDraft {
        let normalized = try SecretaryPhotoNormalizer.normalize(
            data,
            sourceTypeIdentifier: sourceTypeIdentifier,
            suggestedName: suggestedName
        )
        return try stage(
            data: normalized.data,
            name: normalized.fileName,
            mimeType: normalized.mimeType,
            conversationId: conversationId
        )
    }

    func stageImportedFile(_ sourceURL: URL, conversationId: String) throws -> SecretaryAttachmentDraft {
        let accessed = sourceURL.startAccessingSecurityScopedResource()
        defer { if accessed { sourceURL.stopAccessingSecurityScopedResource() } }
        let name = SecretaryAttachmentMIME.safeBaseName(sourceURL.lastPathComponent)
        guard let mimeType = SecretaryAttachmentMIME.mimeType(forFileName: name),
              let kind = SecretaryAttachmentMIME.kind(for: mimeType) else {
            throw SecretaryAttachmentDraftError.typeUnsupported
        }
        let values = try sourceURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile != false else { throw SecretaryAttachmentDraftError.fileUnreadable }
        let maximum = SecretaryAttachmentMIME.maximumBytes(for: kind)
        if let size = values.fileSize, size > maximum { throw SecretaryAttachmentDraftError.fileTooLarge }
        let data = try Data(contentsOf: sourceURL, options: .mappedIfSafe)
        return try stage(data: data, name: name, mimeType: mimeType, conversationId: conversationId)
    }

    func stageVoice(
        from sourceURL: URL,
        recording: SecretaryVoiceRecording,
        conversationId: String
    ) throws -> SecretaryAttachmentDraft {
        guard recording.isValid else { throw SecretaryVoiceStorageError.invalidRecording }
        let data = try Data(contentsOf: sourceURL, options: .mappedIfSafe)
        return try stage(
            data: data,
            name: "语音 · \(Self.durationLabel(recording.durationMs))",
            mimeType: SecretaryVoiceRecording.mimeType,
            conversationId: conversationId,
            id: recording.recordingId,
            durationMs: recording.durationMs
        )
    }

    func loadAll() throws -> [SecretaryAttachmentDraft] {
        try ensureDirectory()
        return try FileManager.default.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(SecretaryAttachmentDraft.self, from: Data(contentsOf: $0)) }
            .filter(\.isValid)
    }

    func save(_ draft: SecretaryAttachmentDraft) throws {
        guard draft.isValid else { throw SecretaryAttachmentDraftError.invalidDraft }
        try ensureDirectory()
        let data = try JSONEncoder().encode(draft)
        let url = metadataURL(for: draft.id)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func localURL(for draft: SecretaryAttachmentDraft) throws -> URL {
        guard draft.isValid else { throw SecretaryAttachmentDraftError.invalidDraft }
        let url = directoryURL.appendingPathComponent(draft.localFileName, isDirectory: false)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw SecretaryAttachmentDraftError.fileMissing
        }
        return url
    }

    func remove(_ draft: SecretaryAttachmentDraft) throws {
        for url in [
            directoryURL.appendingPathComponent(draft.localFileName, isDirectory: false),
            metadataURL(for: draft.id),
        ] where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func stage(
        data: Data,
        name: String,
        mimeType: String,
        conversationId: String,
        id: String? = nil,
        durationMs: Int? = nil
    ) throws -> SecretaryAttachmentDraft {
        guard let kind = SecretaryAttachmentMIME.kind(for: mimeType) else {
            throw SecretaryAttachmentDraftError.typeUnsupported
        }
        guard !data.isEmpty else { throw SecretaryAttachmentDraftError.fileUnreadable }
        guard data.count <= SecretaryAttachmentMIME.maximumBytes(for: kind) else {
            throw SecretaryAttachmentDraftError.fileTooLarge
        }
        let draft = SecretaryAttachmentDraft(
            id: id ?? "iosasset_\(UUID().uuidString.lowercased())",
            conversationId: conversationId,
            name: SecretaryAttachmentMIME.safeBaseName(name),
            mimeType: mimeType,
            kind: kind,
            sizeBytes: data.count,
            durationMs: durationMs
        )
        guard draft.isValid else { throw SecretaryAttachmentDraftError.invalidDraft }
        try ensureDirectory()
        let url = directoryURL.appendingPathComponent(draft.localFileName, isDirectory: false)
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            try save(draft)
            return draft
        } catch {
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.removeItem(at: metadataURL(for: draft.id))
            throw error
        }
    }

    nonisolated private static func durationLabel(_ durationMs: Int) -> String {
        let totalSeconds = max(1, Int((Double(durationMs) / 1_000).rounded()))
        return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
    }

    private func metadataURL(for id: String) -> URL {
        directoryURL.appendingPathComponent("\(id).json", isDirectory: false)
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directoryURL.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directoryURL
        try mutable.setResourceValues(values)
    }
}

enum SecretaryAttachmentDraftError: LocalizedError {
    case tooMany
    case typeUnsupported
    case fileTooLarge
    case imageTooLarge
    case imageUnreadable
    case fileUnreadable
    case fileMissing
    case invalidDraft

    var errorDescription: String? {
        switch self {
        case .tooMany: "一次最多发 4 个附件，请先移除一个"
        case .typeUnsupported: "这种文件还不能发给秘书"
        case .fileTooLarge: "图片需在 8 MiB、语音需在 5 MiB、其他文件需在 15 MiB 以内"
        case .imageTooLarge: "这张图经过压缩仍超过 8 MiB"
        case .imageUnreadable: "这张照片暂时无法读取"
        case .fileUnreadable: "这份文件暂时无法读取"
        case .fileMissing: "本地附件已不在，请删除后重新选择"
        case .invalidDraft: "本地附件草稿不完整"
        }
    }
}
