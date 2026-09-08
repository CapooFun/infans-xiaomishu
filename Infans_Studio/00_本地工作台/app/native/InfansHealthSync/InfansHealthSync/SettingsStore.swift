import Foundation
import Security

@MainActor
final class SettingsStore: ObservableObject {
    static let shared = SettingsStore()

    private enum Key {
        static let serverURL = "healthSync.serverURL"
        static let deviceID = "healthSync.deviceID"
        static let authorizationRequested = "healthSync.authorizationRequested"
        static let lastSuccessAt = "healthSync.lastSuccessAt"
        static let lastCompleteThrough = "healthSync.lastCompleteThrough"
        static let tokenAccessState = "healthSync.tokenAccessState"
        static let backgroundRefreshState = "healthSync.backgroundRefreshState"
        static let healthKitBackgroundState = "healthSync.healthKitBackgroundState"
        static let nextRefreshAt = "healthSync.nextRefreshAt"
        static let lastBackgroundAttemptAt = "healthSync.lastBackgroundAttemptAt"
        static let lastBackgroundAttemptText = "healthSync.lastBackgroundAttemptText"
    }

    private let defaults = UserDefaults.standard

    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Key.serverURL) }
    }
    @Published var authorizationRequested: Bool {
        didSet { defaults.set(authorizationRequested, forKey: Key.authorizationRequested) }
    }
    @Published var lastSuccessAt: Date? {
        didSet { defaults.set(lastSuccessAt, forKey: Key.lastSuccessAt) }
    }
    @Published var lastCompleteThrough: String {
        didSet { defaults.set(lastCompleteThrough, forKey: Key.lastCompleteThrough) }
    }
    @Published private(set) var tokenConfigured: Bool
    @Published private(set) var tokenAccessState: String
    @Published private(set) var backgroundRefreshState: String
    @Published private(set) var healthKitBackgroundState: String
    @Published private(set) var nextRefreshAt: Date?
    @Published private(set) var lastBackgroundAttemptAt: Date?
    @Published private(set) var lastBackgroundAttemptText: String

    let deviceID: String

    private init() {
        serverURL = defaults.string(forKey: Key.serverURL) ?? ""
        authorizationRequested = defaults.bool(forKey: Key.authorizationRequested)
        lastSuccessAt = defaults.object(forKey: Key.lastSuccessAt) as? Date
        lastCompleteThrough = defaults.string(forKey: Key.lastCompleteThrough) ?? ""
        let storedDeviceID = defaults.string(forKey: Key.deviceID)
        deviceID = storedDeviceID ?? UUID().uuidString.lowercased()
        if storedDeviceID == nil { defaults.set(deviceID, forKey: Key.deviceID) }
        let existingToken = KeychainToken.read()
        tokenConfigured = existingToken != nil
        tokenAccessState = existingToken == nil ? "未配置" : "正在升级后台访问"
        backgroundRefreshState = defaults.string(forKey: Key.backgroundRefreshState) ?? "尚未检查"
        healthKitBackgroundState = defaults.string(forKey: Key.healthKitBackgroundState) ?? "尚未注册"
        nextRefreshAt = defaults.object(forKey: Key.nextRefreshAt) as? Date
        lastBackgroundAttemptAt = defaults.object(forKey: Key.lastBackgroundAttemptAt) as? Date
        lastBackgroundAttemptText = defaults.string(forKey: Key.lastBackgroundAttemptText) ?? "尚无后台运行记录"

        if let existingToken {
            do {
                try KeychainToken.save(existingToken)
                tokenAccessState = "锁屏后台可用"
            } catch {
                tokenAccessState = "后台访问升级失败"
            }
            defaults.set(tokenAccessState, forKey: Key.tokenAccessState)
        }
    }

    func saveToken(_ raw: String) throws {
        guard let token = HealthSyncToken.normalize(raw) else {
            throw HealthSyncError.server("配对令牌格式不对（收到 \(raw.count) 个字符）")
        }
        try KeychainToken.save(token)
        tokenConfigured = true
        tokenAccessState = "锁屏后台可用"
        defaults.set(tokenAccessState, forKey: Key.tokenAccessState)
    }

    func token() -> String? { KeychainToken.read() }

    func recordBackgroundRefreshState(_ state: String) {
        backgroundRefreshState = state
        defaults.set(state, forKey: Key.backgroundRefreshState)
    }

    func recordHealthKitBackgroundState(_ state: String) {
        healthKitBackgroundState = state
        defaults.set(state, forKey: Key.healthKitBackgroundState)
    }

    func recordNextRefresh(_ date: Date?, error: String? = nil) {
        nextRefreshAt = date
        defaults.set(date, forKey: Key.nextRefreshAt)
        if let error {
            recordBackgroundAttempt(trigger: .backgroundRefresh, text: "后台任务登记失败：\(error)")
        }
    }

    func recordBackgroundAttempt(trigger: HealthSyncTrigger, text: String, at date: Date = Date()) {
        lastBackgroundAttemptAt = date
        lastBackgroundAttemptText = "\(trigger.rawValue)：\(text)"
        defaults.set(date, forKey: Key.lastBackgroundAttemptAt)
        defaults.set(lastBackgroundAttemptText, forKey: Key.lastBackgroundAttemptText)
    }
}

private enum KeychainToken {
    private static let service = "com.example.infans.secretary"
    private static let account = "device-sync-token"

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let data = Data(token.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(lookup as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = lookup
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
                throw HealthSyncError.server("无法把令牌保存到 iPhone 钥匙串")
            }
        } else if status != errSecSuccess {
            throw HealthSyncError.server("无法更新 iPhone 钥匙串中的令牌")
        }
    }
}
