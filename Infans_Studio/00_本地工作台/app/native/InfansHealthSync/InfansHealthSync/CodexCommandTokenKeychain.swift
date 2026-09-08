import Foundation
import Security

enum CodexCommandTokenKeychain {
    private static let service = "com.example.infans.secretary.codexcommand"
    private static let account = "remote-inbox-token"

    static func read() -> String? {
        if let accessGroup, let shared = read(accessGroup: accessGroup) { return shared }
        return read(accessGroup: nil)
    }

    static func save(_ token: String) throws {
        guard let accessGroup else {
            throw YingningIntakeError.server("共享钥匙串访问组没有写入构建配置")
        }
        try save(token, accessGroup: accessGroup)
    }

    static func migrateLegacyItemIfNeeded() throws {
        guard let accessGroup else { return }
        // Capoo authorized locked-device background delivery. Update only this
        // app's existing shared item, without deleting or exporting its value.
        let status = SecItemUpdate(lookup(accessGroup: accessGroup) as CFDictionary, [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary)
        if status == errSecSuccess { return }
        if status == errSecItemNotFound {
            if let legacy = read(accessGroup: nil) { try save(legacy, accessGroup: accessGroup) }
            return
        }
        throw YingningIntakeError.server("设备令牌后台访问尚未就绪（\(status)），解锁后会重试")
    }

    private static var accessGroup: String? {
        let value = Bundle.main.object(forInfoDictionaryKey: "InfansKeychainAccessGroup") as? String
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty || trimmed.contains("$(") ? nil : trimmed
    }

    private static func lookup(accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    private static func read(accessGroup: String?) -> String? {
        var query = lookup(accessGroup: accessGroup)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func save(_ token: String, accessGroup: String) throws {
        let query = lookup(accessGroup: accessGroup)
        let data = Data(token.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add.merge(attributes) { _, new in new }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
                throw YingningIntakeError.server("无法把小秘书指令令牌保存到共享钥匙串")
            }
        } else if status != errSecSuccess {
            throw YingningIntakeError.server("无法更新共享钥匙串中的小秘书指令令牌")
        }
    }
}
