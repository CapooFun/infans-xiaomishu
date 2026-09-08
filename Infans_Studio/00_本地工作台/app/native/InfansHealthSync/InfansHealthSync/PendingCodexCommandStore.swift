import Foundation

actor PendingCodexCommandStore {
    private let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let directory = base.appendingPathComponent("InfansHealthSync", isDirectory: true)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            self.fileURL = directory.appendingPathComponent("pending-codex-commands.json")
        }
    }

    func enqueue(_ command: CodexCommand) throws -> Bool {
        var rows = load()
        guard !rows.contains(where: { $0.id == command.id }) else { return false }
        rows.append(command)
        try save(Array(rows.suffix(100)))
        return true
    }

    func pending() -> [CodexCommand] { load() }

    func mark(
        _ id: String,
        state: CodexCommandDeliveryState,
        error: String? = nil,
        reply: SecretaryReply? = nil
    ) throws {
        var rows = load()
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].state = state
        rows[index].lastError = error
        if let reply { rows[index].reply = reply }
        if state == .retryPending { rows[index].retryCount += 1 }
        try save(rows)
    }

    func remove(_ id: String) throws {
        try save(load().filter { $0.id != id })
    }

    private func load() -> [CodexCommand] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([CodexCommand].self, from: data)) ?? []
    }

    private func save(_ rows: [CodexCommand]) throws {
        let data = try JSONEncoder().encode(rows)
        try data.write(to: fileURL, options: .atomic)
#if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
#endif
    }
}
