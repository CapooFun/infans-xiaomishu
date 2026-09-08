import Foundation

enum HealthSyncToken {
    private static let prefix = "INFANS_HEALTH_SYNC_TOKEN="

    static func normalize(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate: String
        if trimmed.hasPrefix(prefix) {
            candidate = String(trimmed.dropFirst(prefix.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            candidate = trimmed
        }

        guard (43...128).contains(candidate.count) else { return nil }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard candidate.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return candidate
    }
}
