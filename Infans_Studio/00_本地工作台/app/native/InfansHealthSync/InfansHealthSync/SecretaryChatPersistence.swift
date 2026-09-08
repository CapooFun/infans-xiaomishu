import Foundation

actor SecretaryChatPersistence {
    private let directoryURL: URL
    private let cacheURL: URL
    private var latestSavedRevision = 0

    init(directoryURL: URL? = nil) {
        let resolved: URL
        if let directoryURL {
            resolved = directoryURL
        } else if let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: PendingYingningIntakeStore.appGroupIdentifier
        ) {
            resolved = container.appendingPathComponent("SecretaryChat", isDirectory: true)
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            resolved = support
                .appendingPathComponent("InfansHealthSync", isDirectory: true)
                .appendingPathComponent("SecretaryChat", isDirectory: true)
        }
        self.directoryURL = resolved
        self.cacheURL = resolved.appendingPathComponent("device-cache.v1.json")
    }

    func load() -> SecretaryChatDeviceCache {
        guard let data = try? Data(contentsOf: cacheURL),
              let cache = try? JSONDecoder().decode(SecretaryChatDeviceCache.self, from: data) else {
            return .empty
        }
        return cache
    }

    func save(_ cache: SecretaryChatDeviceCache, revision: Int) throws {
        guard revision >= latestSavedRevision else { return }
        latestSavedRevision = revision
        try prepareDirectory()
        let data = try JSONEncoder().encode(cache)
        try data.write(to: cacheURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cacheURL.path)
#if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: cacheURL.path
        )
#endif
    }

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directoryURL.path)
    }
}
