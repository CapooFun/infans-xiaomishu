import Foundation

@MainActor
final class CodexCommandSettings: ObservableObject {
    static let shared = CodexCommandSettings()

    private let defaults = UserDefaults.standard

    @Published var serverURL: String {
        didSet {
            SecretarySharedConfiguration.synchronize(
                serverURL: serverURL,
                mailboxServerURL: mailboxServerURL,
                deviceID: deviceID,
                legacyDefaults: defaults
            )
        }
    }
    @Published var mailboxServerURL: String {
        didSet {
            SecretarySharedConfiguration.synchronize(
                serverURL: serverURL,
                mailboxServerURL: mailboxServerURL,
                deviceID: deviceID,
                legacyDefaults: defaults
            )
        }
    }
    @Published private(set) var tokenConfigured: Bool
    let deviceID: String

    private init() {
        let resolvedServerURL = SecretarySharedConfiguration.serverURL(legacyDefaults: defaults)
        let resolvedMailboxServerURL = SecretarySharedConfiguration.mailboxServerURL(legacyDefaults: defaults)
        let resolvedDeviceID = SecretarySharedConfiguration.deviceID(legacyDefaults: defaults)
        serverURL = resolvedServerURL
        mailboxServerURL = resolvedMailboxServerURL
        deviceID = resolvedDeviceID
        tokenConfigured = false
        SecretarySharedConfiguration.synchronize(
            serverURL: resolvedServerURL,
            mailboxServerURL: resolvedMailboxServerURL,
            deviceID: resolvedDeviceID,
            legacyDefaults: defaults
        )
        try? CodexCommandTokenKeychain.migrateLegacyItemIfNeeded()
        tokenConfigured = CodexCommandTokenKeychain.read() != nil
    }

    func saveToken(_ raw: String) throws {
        guard let token = HealthSyncToken.normalize(raw.replacingOccurrences(of: "INFANS_CODEX_COMMAND_TOKEN=", with: "")) else {
            throw HealthSyncError.server("小秘书指令令牌格式不对")
        }
        try CodexCommandTokenKeychain.save(token)
        tokenConfigured = true
    }

#if DEBUG
    func importDeveloperPairingFileIfPresent() throws -> Bool {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let fileURL = base
            .appendingPathComponent("InfansHealthSync", isDirectory: true)
            .appendingPathComponent(".codex-command-pairing.txt")
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return false }
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
        let raw = try String(contentsOf: fileURL, encoding: .utf8)
        try saveToken(raw)
        return true
    }
#endif

    func token() -> String? { CodexCommandTokenKeychain.read() }
}
