import Foundation
import ImageIO
import UniformTypeIdentifiers

struct SharePayload: Equatable {
    let url: String
    let title: String
    let text: String
    let sourceApp: String
    let images: [YingningIntakeAttachmentPayload]
    let loadError: String?

    var hasSupportedContent: Bool { !url.isEmpty || !text.isEmpty || !images.isEmpty }
}

enum SharePayloadLoader {
    static func load(from inputItems: [Any]) async -> SharePayload {
        let extensionItems = inputItems.compactMap { $0 as? NSExtensionItem }
        var url = ""
        var text = extensionItems.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        var title = extensionItems.compactMap { $0.attributedTitle?.string }.first ?? ""
        var images: [YingningIntakeAttachmentPayload] = []
        var loadError: String?

        for item in extensionItems {
            if title.isEmpty { title = item.attributedContentText?.string ?? "" }
            for provider in item.attachments ?? [] {
                if url.isEmpty,
                   provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let loaded = await loadItem(provider, typeIdentifier: UTType.url.identifier),
                   let candidate = urlString(from: loaded) { url = candidate }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
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
                    guard images.count < YingningIntakeAttachment.maximumCount else {
                        loadError = "一次最多可以收下 4 张照片。"
                        continue
                    }
                    do {
                        images.append(try await loadImage(provider))
                    } catch {
                        loadError = error.localizedDescription
                    }
                }
                }
            }
        }
        if images.reduce(0, { $0 + $1.data.count }) > YingningIntakeAttachment.maximumTotalBytes {
            loadError = "这些照片合起来超过 32 MB，请分两次分享。"
        }
        return SharePayload(
            url: String(url.prefix(4_096)),
            title: String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300)),
            text: String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8_000)),
            sourceApp: "",
            images: images,
            loadError: loadError
        )
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
                    guard YingningIntakeAttachment.allowedContentTypes.contains(contentType) else {
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
