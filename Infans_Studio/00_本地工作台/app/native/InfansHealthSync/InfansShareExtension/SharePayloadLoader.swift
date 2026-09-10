import Foundation
import ImageIO
import UniformTypeIdentifiers

struct SharePayload: Equatable {
    let url: String
    let title: String
    let text: String
    let sourceApp: String
    let attachments: [YingningIntakeAttachmentPayload]
    let loadError: String?

    var images: [YingningIntakeAttachmentPayload] {
        attachments.filter(\.attachment.isImage)
    }

    var files: [YingningIntakeAttachmentPayload] {
        attachments.filter(\.attachment.isFile)
    }

    var hasSupportedContent: Bool { !url.isEmpty || !text.isEmpty || !attachments.isEmpty }

    var sourceSemantic: InboxIntakeSourceSemantic {
        if attachments.contains(where: \.attachment.isFile) { return .fileShare }
        if !attachments.isEmpty { return .photoShare }
        return .sharedContent
    }
}

enum SharePayloadLoader {
    private static let extensionByMIME: [String: String] = [
        "application/pdf": "pdf",
        "text/plain": "txt",
        "text/markdown": "md",
        "text/csv": "csv",
        "application/json": "json",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-powerpoint": "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    ]

    static func load(from inputItems: [Any]) async -> SharePayload {
        let extensionItems = inputItems.compactMap { $0 as? NSExtensionItem }
        var url = ""
        var text = extensionItems.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        var title = extensionItems.compactMap { $0.attributedTitle?.string }.first ?? ""
        var attachments: [YingningIntakeAttachmentPayload] = []
        var loadError: String?

        for item in extensionItems {
            if title.isEmpty { title = item.attributedContentText?.string ?? "" }
            for provider in item.attachments ?? [] {
                if url.isEmpty,
                   provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                   let loaded = await loadItem(provider, typeIdentifier: UTType.url.identifier),
                   let candidate = urlString(from: loaded) { url = candidate }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   !looksLikeDocument(provider),
                   let loaded = await loadItem(provider, typeIdentifier: UTType.plainText.identifier),
                   let candidate = textString(from: loaded), !text.contains(candidate) {
                    text += (text.isEmpty ? "" : "\n") + candidate
                }
            }
        }

        if url.isEmpty, let candidate = firstHTTPURL(in: text) {
            url = candidate
            if text.trimmingCharacters(in: .whitespacesAndNewlines) == candidate { text = "" }
        }
        // URL shares often carry a preview image. It is metadata, not a requested photo.
        if url.isEmpty {
            for item in extensionItems {
                for provider in item.attachments ?? [] {
                    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                        guard attachments.count < YingningIntakeAttachment.maximumCount else {
                            loadError = "一次最多可以收下 4 个附件。"
                            continue
                        }
                        do {
                            attachments.append(try await loadImage(provider))
                        } catch {
                            loadError = error.localizedDescription
                        }
                    }
                }
            }
        }
        for item in extensionItems {
            for provider in item.attachments ?? [] {
                guard looksLikeDocument(provider) else { continue }
                guard attachments.count < YingningIntakeAttachment.maximumCount else {
                    loadError = "一次最多可以收下 4 个附件。"
                    continue
                }
                do {
                    attachments.append(try await loadDocument(provider))
                } catch {
                    loadError = error.localizedDescription
                }
            }
        }
        if attachments.reduce(0, { $0 + $1.data.count }) > YingningIntakeAttachment.maximumTotalBytes {
            loadError = "这些附件合起来超过 32 MB，请分两次分享。"
        }
        return SharePayload(
            url: String(url.prefix(4_096)),
            title: String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300)),
            text: String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8_000)),
            sourceApp: "",
            attachments: attachments,
            loadError: loadError
        )
    }

    private static func looksLikeDocument(_ provider: NSItemProvider) -> Bool {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) { return false }
        if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) { return true }
        if hasAllowedDocumentMIME(provider) { return true }
        if hasAllowedDocumentFileName(provider) { return true }
        return provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    }

    private static func hasAllowedDocumentMIME(_ provider: NSItemProvider) -> Bool {
        provider.registeredTypeIdentifiers.contains { identifier in
            guard let type = UTType(identifier), let mime = type.preferredMIMEType?.lowercased() else { return false }
            if type.conforms(to: .image) || type.conforms(to: .url) { return false }
            if mime == "text/plain",
               !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
               !hasAllowedDocumentFileName(provider) {
                return false
            }
            return YingningIntakeAttachment.allowedFileTypes.contains(mime)
        }
    }

    private static func hasAllowedDocumentFileName(_ provider: NSItemProvider) -> Bool {
        let name = (provider.suggestedName ?? "").lowercased()
        return extensionByMIME.values.contains { name.hasSuffix(".\($0)") }
    }

    private static func documentType(for provider: NSItemProvider) -> UTType? {
        if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) { return .pdf }
        for identifier in provider.registeredTypeIdentifiers {
            guard let type = UTType(identifier), let mime = type.preferredMIMEType?.lowercased() else { continue }
            if type.conforms(to: .image) || type.conforms(to: .url) { continue }
            if mime == "text/plain" { continue }
            if YingningIntakeAttachment.allowedFileTypes.contains(mime) { return type }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return .fileURL }
        if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) { return .data }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           hasAllowedDocumentFileName(provider) || provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            return .plainText
        }
        return nil
    }

    private static func documentLoadTypes(for provider: NSItemProvider) -> [UTType] {
        var types: [UTType] = []
        func add(_ type: UTType) {
            guard provider.hasItemConformingToTypeIdentifier(type.identifier) else { return }
            guard !types.contains(where: { $0.identifier == type.identifier }) else { return }
            types.append(type)
        }
        if let declared = documentType(for: provider) { add(declared) }
        add(.pdf)
        add(.fileURL)
        if hasAllowedDocumentFileName(provider) || provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            add(.plainText)
        }
        add(.data)
        return types
    }

    private static func loadImage(_ provider: NSItemProvider) async throws -> YingningIntakeAttachmentPayload {
        let declaredType = provider.registeredTypeIdentifiers
            .compactMap(UTType.init)
            .first(where: { $0.conforms(to: .image) }) ?? .image
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: declaredType.identifier) { fileURL, error in
                do {
                    if let error { throw error }
                    guard let fileURL else { throw YingningIntakeError.attachmentUnavailable }
                    let data = try Data(contentsOf: fileURL)
                    guard data.count <= YingningIntakeAttachment.maximumBytesPerFile else {
                        throw NSError(domain: "com.example.infans.secretary.share", code: 413, userInfo: [NSLocalizedDescriptionKey: "单张照片不能超过 24 MB。"])
                    }
                    let source = CGImageSourceCreateWithData(data as CFData, nil)
                    let properties = source.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }
                    let width = properties?[kCGImagePropertyPixelWidth] as? Int
                    let height = properties?[kCGImagePropertyPixelHeight] as? Int
                    let detectedType = source.flatMap(CGImageSourceGetType).flatMap { UTType($0 as String) }
                    let contentType = detectedType?.preferredMIMEType ?? declaredType.preferredMIMEType ?? ""
                    guard YingningIntakeAttachment.allowedImageTypes.contains(contentType) else {
                        throw NSError(domain: "com.example.infans.secretary.share", code: 415, userInfo: [NSLocalizedDescriptionKey: "这张照片的格式暂不支持。"])
                    }
                    let ext = detectedType?.preferredFilenameExtension ?? declaredType.preferredFilenameExtension ?? "image"
                    var fileName = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if fileName.isEmpty { fileName = fileURL.lastPathComponent }
                    if URL(fileURLWithPath: fileName).pathExtension.isEmpty { fileName += ".\(ext)" }
                    continuation.resume(returning: YingningIntakeAttachmentPayload(
                        fileName: fileName,
                        contentType: contentType,
                        data: data,
                        pixelWidth: width,
                        pixelHeight: height
                    ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func loadDocument(_ provider: NSItemProvider) async throws -> YingningIntakeAttachmentPayload {
        let types = documentLoadTypes(for: provider)
        guard !types.isEmpty else { throw YingningIntakeError.attachmentUnavailable }
        var lastError: Error = YingningIntakeError.attachmentUnavailable
        for declaredType in types {
            do {
                let loaded = try await loadDocumentBytes(provider, type: declaredType)
                guard loaded.data.count <= YingningIntakeAttachment.maximumBytesPerFile else {
                    throw NSError(domain: "com.example.infans.secretary.share", code: 413, userInfo: [NSLocalizedDescriptionKey: "单个文件不能超过 24 MB。"])
                }
                var fileName = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if fileName.isEmpty { fileName = loaded.fileURL?.lastPathComponent ?? "" }
                let contentType = mimeType(for: loaded.data, fileName: fileName, declared: declaredType)
                guard YingningIntakeAttachment.allowedFileTypes.contains(contentType) else {
                    throw NSError(domain: "com.example.infans.secretary.share", code: 415, userInfo: [NSLocalizedDescriptionKey: "这个文件格式暂不支持。"])
                }
                if fileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fileName = "file.\(extensionByMIME[contentType] ?? "bin")"
                } else if URL(fileURLWithPath: fileName).pathExtension.isEmpty {
                    fileName += ".\(extensionByMIME[contentType] ?? "bin")"
                }
                return YingningIntakeAttachmentPayload(
                    fileName: fileName,
                    contentType: contentType,
                    data: loaded.data
                )
            } catch {
                lastError = error
                let nsError = error as NSError
                if nsError.domain == "com.example.infans.secretary.share", nsError.code == 413 || nsError.code == 415 {
                    throw error
                }
            }
        }
        throw lastError
    }

    private static func loadDocumentBytes(_ provider: NSItemProvider, type: UTType) async throws -> (fileURL: URL?, data: Data) {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { fileURL, error in
                    do {
                        if let error { throw error }
                        guard let fileURL else { throw YingningIntakeError.attachmentUnavailable }
                        continuation.resume(returning: (fileURL, try Data(contentsOf: fileURL)))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } catch {
            if let item = await loadItem(provider, typeIdentifier: type.identifier) {
                if let fileURL = fileURL(from: item) {
                    return (fileURL, try Data(contentsOf: fileURL))
                }
                if let data = item as? Data { return (nil, data) }
                if let data = item as? NSData { return (nil, data as Data) }
            }
            throw error
        }
    }

    private static func mimeType(for data: Data, fileName: String, declared: UTType) -> String {
        let bytes = [UInt8](data.prefix(5))
        if bytes.count >= 5, bytes[0] == 0x25, bytes[1] == 0x50, bytes[2] == 0x44, bytes[3] == 0x46, bytes[4] == 0x2d {
            return "application/pdf"
        }
        let ext = URL(fileURLWithPath: fileName).pathExtension.lowercased()
        if let fromExtension = extensionByMIME.first(where: { $0.value == ext })?.key {
            return fromExtension
        }
        if let mime = declared.preferredMIMEType?.lowercased(), YingningIntakeAttachment.allowedFileTypes.contains(mime) {
            return mime
        }
        if looksLikeJSON(data) { return "application/json" }
        if looksLikeTextFile(data) { return "text/plain" }
        return ""
    }

    private static func looksLikeJSON(_ data: Data) -> Bool {
        let trimmed = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard trimmed.count >= 2 else { return false }
        return (trimmed.hasPrefix("{") && trimmed.hasSuffix("}")) || (trimmed.hasPrefix("[") && trimmed.hasSuffix("]"))
    }

    private static func looksLikeTextFile(_ data: Data) -> Bool {
        if data.isEmpty { return false }
        if data.count >= 2, data[0] == 0xFF, data[1] == 0xFE { return true }
        if data.count >= 2, data[0] == 0xFE, data[1] == 0xFF { return true }
        if data.contains(0) { return false }
        return String(data: data, encoding: .utf8) != nil
    }

    private static func fileURL(from item: NSSecureCoding) -> URL? {
        if let value = item as? URL, value.isFileURL { return value }
        if let value = item as? NSURL, value.isFileURL { return value as URL }
        if let value = item as? String, let parsed = URL(string: value), parsed.isFileURL { return parsed }
        if let value = item as? Data,
           let string = String(data: value, encoding: .utf8),
           let parsed = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
           parsed.isFileURL {
            return parsed
        }
        return nil
    }

    private static func loadItem(_ provider: NSItemProvider, typeIdentifier: String) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in continuation.resume(returning: item) }
        }
    }

    private static func urlString(from item: NSSecureCoding) -> String? {
        let raw: String?
        if let value = item as? URL { raw = value.absoluteString }
        else if let value = item as? NSURL { raw = value.absoluteString }
        else if let value = item as? String { raw = value }
        else if let value = item as? NSString { raw = value as String }
        else if let value = item as? Data { raw = String(data: value, encoding: .utf8) }
        else { raw = nil }
        guard let raw, let parsed = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""), parsed.host != nil else { return nil }
        return parsed.absoluteString
    }

    private static func textString(from item: NSSecureCoding) -> String? {
        if let value = item as? String { return value }
        if let value = item as? NSString { return value as String }
        if let value = item as? NSAttributedString { return value.string }
        if let value = item as? Data { return String(data: value, encoding: .utf8) }
        return nil
    }

    private static func firstHTTPURL(in text: String) -> String? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector.matches(in: text, range: range).compactMap { match in
            guard let url = match.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  url.host != nil else { return nil }
            return url.absoluteString
        }.first
    }
}
