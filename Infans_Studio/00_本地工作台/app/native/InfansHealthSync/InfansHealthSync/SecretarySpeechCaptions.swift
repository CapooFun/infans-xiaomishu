import Foundation

/// Short, lossless caption pages. Audio position drives estimated page timing; no independent timer.
enum SecretarySpeechCaptions {
    static func pages(_ text: String, limit: Int = 36) -> [String] {
        let limit = max(1, limit)
        var result: [String] = []
        var current = ""
        for character in text {
            current.append(character)
            if current.count >= limit || (current.count >= min(12, limit) && "。！？!?；;\n".contains(character)) {
                result.append(current)
                current = ""
            }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
    static func current(_ text: String, progress: Double, limit: Int = 36) -> String {
        let pages = pages(text, limit: limit)
        guard !pages.isEmpty else { return "" }
        let safe = progress.isFinite ? min(1, max(0, progress)) : 0
        let position = Int(Double(text.count) * safe)
        var offset = 0
        for page in pages {
            offset += page.count
            if position < offset { return page.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return pages.last!.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func typedPrefix(_ text: String, progress: Double) -> String {
        guard !text.isEmpty else { return "" }
        let safe = progress.isFinite ? min(1, max(0, progress)) : 0
        if safe <= 0 { return String(text.prefix(1)) }
        let characters = Array(text)
        let count = max(1, min(characters.count, Int((Double(characters.count) * safe).rounded(.up))))
        return String(characters.prefix(count))
    }
}
