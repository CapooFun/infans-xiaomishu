import Foundation

enum SecretarySharedConfiguration {
    static let appGroupIdentifier = PendingYingningIntakeStore.appGroupIdentifier
    static let serverURLKey = "codexCommand.serverURL"
    static let mailboxServerURLKey = "secretary.mailboxServerURL"
    static let deviceIDKey = "codexCommand.deviceID"
    static let detailedSharingKey = "secretary.sharing.detailed"

    static var usesDetailedSharing: Bool { defaults.bool(forKey: detailedSharingKey) }
    static let fallbackServerURL = ""
    static let fallbackMailboxServerURL = ""

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }

    static var shareBackgroundURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
            .appendingPathComponent("Library/Application Support/SecretaryAppearance/share-background.jpg")
    }

    static func saveShareBackground(_ data: Data?) throws {
        guard let url = shareBackgroundURL else { throw CocoaError(.fileNoSuchFile) }
        if let data {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    static func serverURL(legacyDefaults: UserDefaults = .standard) -> String {
        defaults.string(forKey: serverURLKey)
            ?? legacyDefaults.string(forKey: serverURLKey)
            ?? fallbackServerURL
    }

    static func mailboxServerURL(legacyDefaults: UserDefaults = .standard) -> String {
        if let shared = defaults.string(forKey: mailboxServerURLKey), !shared.isEmpty { return shared }
        if let legacy = legacyDefaults.string(forKey: mailboxServerURLKey), !legacy.isEmpty {
            defaults.set(legacy, forKey: mailboxServerURLKey)
            return legacy
        }
        if fallbackMailboxServerURL.isEmpty { return "" }
        defaults.set(fallbackMailboxServerURL, forKey: mailboxServerURLKey)
        return fallbackMailboxServerURL
    }

    static func deviceID(legacyDefaults: UserDefaults = .standard) -> String {
        if let shared = defaults.string(forKey: deviceIDKey), !shared.isEmpty { return shared }
        if let legacy = legacyDefaults.string(forKey: deviceIDKey), !legacy.isEmpty {
            defaults.set(legacy, forKey: deviceIDKey)
            return legacy
        }
        let generated = UUID().uuidString.lowercased()
        defaults.set(generated, forKey: deviceIDKey)
        return generated
    }

    static func synchronize(
        serverURL: String,
        mailboxServerURL: String? = nil,
        deviceID: String,
        legacyDefaults: UserDefaults = .standard
    ) {
        defaults.set(serverURL, forKey: serverURLKey)
        defaults.set(deviceID, forKey: deviceIDKey)
        legacyDefaults.set(serverURL, forKey: serverURLKey)
        legacyDefaults.set(deviceID, forKey: deviceIDKey)
        if let mailboxServerURL {
            defaults.set(mailboxServerURL, forKey: mailboxServerURLKey)
            legacyDefaults.set(mailboxServerURL, forKey: mailboxServerURLKey)
        }
    }
}
