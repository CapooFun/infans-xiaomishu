import Foundation

enum InfansProductIdentity {
    static var urlScheme: String {
        string(for: "InfansURLScheme") ?? "infans-secretary"
    }

    static var appGroupIdentifier: String {
        string(for: "InfansAppGroup") ?? "group.com.example.infans.secretary"
    }

    static var isOpenSource: Bool {
        string(for: "InfansProductEdition") == "opensource"
    }

    private static func string(for key: String) -> String? {
        let value = Bundle.main.object(forInfoDictionaryKey: key) as? String
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty || trimmed.contains("$(") ? nil : trimmed
    }
}
