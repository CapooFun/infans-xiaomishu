import Foundation
import UniformTypeIdentifiers

enum SecretaryAttachmentCacheError: LocalizedError {
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .tooLarge: return "这个附件太大，请在 Mac 上打开。"
        }
    }
}

actor SecretaryAttachmentCache {
    static let shared = SecretaryAttachmentCache()

    private let fileManager: FileManager
    private let directoryURL: URL
    private let maximumBytes = 80 * 1_024 * 1_024

    init(fileManager: FileManager = .default, directoryURL: URL? = nil) {
        self.fileManager = fileManager
        let base = directoryURL
            ?? fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        self.directoryURL = base
            .appendingPathComponent("InfansHealthSync", isDirectory: true)
            .appendingPathComponent("SecretaryAttachments", isDirectory: true)
    }

    func localURL(
        for attachment: SecretaryChatAttachment,
        client: SecretaryChatClient,
        connection: SecretaryChatConnection
    ) async throws -> URL {
        try prepareDirectory()
        let destination = cachedURL(for: attachment)
        if fileManager.fileExists(atPath: destination.path) { return destination }

        let resource = try await client.attachmentResource(path: attachment.resourcePath, connection: connection)
        guard resource.data.count <= maximumBytes else { throw SecretaryAttachmentCacheError.tooLarge }
        try resource.data.write(to: destination, options: .atomic)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDestination = destination
        try? mutableDestination.setResourceValues(values)
        return destination
    }

    private func prepareDirectory() throws {
        try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDirectory = directoryURL
        try? mutableDirectory.setResourceValues(values)
    }

    private func cachedURL(for attachment: SecretaryChatAttachment) -> URL {
        cachedURL(
            cacheKey: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType
        )
    }

    private func cachedURL(cacheKey: String, fileName: String, mimeType: String) -> URL {
        let stem = cacheKey.unicodeScalars.map { scalar in
            CharacterSet.alphanumerics.contains(scalar) ? String(scalar) : "-"
        }.joined()
        let originalExtension = URL(fileURLWithPath: fileName).pathExtension
        let inferredExtension = UTType(mimeType: mimeType)?.preferredFilenameExtension
        let fileExtension = originalExtension.isEmpty ? inferredExtension : originalExtension
        let filename = fileExtension.map { "\(stem).\($0)" } ?? stem
        return directoryURL.appendingPathComponent(filename, isDirectory: false)
    }

}
