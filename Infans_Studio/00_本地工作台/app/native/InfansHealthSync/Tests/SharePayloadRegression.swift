import Foundation
import UniformTypeIdentifiers

@main struct SharePayloadRegression {
    static func check(_ condition: Bool, _ message: String) {
        precondition(condition, message)
    }
    static func brokenImage() -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerFileRepresentation(forTypeIdentifier: UTType.image.identifier, fileOptions: [], visibility: .all) { completion in
            completion(nil, false, NSError(domain: "test-preview", code: 415))
            return nil
        }
        return provider
    }
    static func main() async {
        let card = NSExtensionItem()
        card.attachments = [brokenImage(), NSItemProvider(item: URL(string: "https://b23.tv/example")! as NSURL, typeIdentifier: UTType.url.identifier)]
        let link = await SharePayloadLoader.load(from: [card])
        check(link.url == "https://b23.tv/example" && link.images.isEmpty && link.loadError == nil, "link preview must not block URL")
        let textCard = NSExtensionItem()
        textCard.attributedContentText = NSAttributedString(string: "视频标题")
        textCard.attachments = [brokenImage(), NSItemProvider(item: "分享视频 https://b23.tv/example 更多介绍" as NSString, typeIdentifier: UTType.plainText.identifier)]
        let text = await SharePayloadLoader.load(from: [textCard])
        check(text.url == "https://b23.tv/example" && text.text.contains("视频标题") && text.loadError == nil, "embedded URL survives preview error")
        let onlyPhoto = NSExtensionItem()
        onlyPhoto.attachments = [brokenImage()]
        let photo = await SharePayloadLoader.load(from: [onlyPhoto])
        check(photo.url.isEmpty && photo.loadError != nil, "pure photo errors must remain visible")
        let bytesCard = NSExtensionItem()
        bytesCard.attachments = [NSItemProvider(item: Data("https://b23.tv/data".utf8) as NSData, typeIdentifier: UTType.url.identifier)]
        let bytes = await SharePayloadLoader.load(from: [bytesCard])
        check(bytes.url == "https://b23.tv/data", "data URL representation")
        let plain = NSExtensionItem()
        plain.attributedContentText = NSAttributedString(string: "普通文字")
        let plainResult = await SharePayloadLoader.load(from: [plain])
        check(plainResult.text == "普通文字" && plainResult.loadError == nil, "attributed-only text preserved")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try! png.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let imageProvider = NSItemProvider()
        imageProvider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { completion in
            completion(file, false, nil)
            return nil
        }
        let validPhoto = NSExtensionItem()
        validPhoto.attachments = [imageProvider]
        let valid = await SharePayloadLoader.load(from: [validPhoto])
        check(valid.images.count == 1 && valid.images[0].data == png && valid.loadError == nil, "pure PNG remains byte-for-byte original")
        let crowded = NSExtensionItem()
        crowded.attachments = Array(repeating: imageProvider, count: 5)
        let limit = await SharePayloadLoader.load(from: [crowded])
        check(limit.loadError != nil, "pure image count limit is retained")
        let pdfBytes = Data("%PDF-1.4 test".utf8)
        let pdfFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pdf")
        try! pdfBytes.write(to: pdfFile)
        defer { try? FileManager.default.removeItem(at: pdfFile) }
        let pdfProvider = NSItemProvider()
        pdfProvider.suggestedName = "notes.pdf"
        pdfProvider.registerFileRepresentation(forTypeIdentifier: UTType.pdf.identifier, fileOptions: [], visibility: .all) { completion in
            completion(pdfFile, false, nil)
            return nil
        }
        let pdfCard = NSExtensionItem()
        pdfCard.attachments = [pdfProvider]
        let pdf = await SharePayloadLoader.load(from: [pdfCard])
        check(pdf.files.count == 1 && pdf.files[0].data == pdfBytes && pdf.files[0].attachment.contentType == "application/pdf" && pdf.sourceSemantic == .fileShare && pdf.loadError == nil, "PDF file share keeps original bytes")
        print("PASS: 8 real NSItemProvider sharing regressions")
    }
}
