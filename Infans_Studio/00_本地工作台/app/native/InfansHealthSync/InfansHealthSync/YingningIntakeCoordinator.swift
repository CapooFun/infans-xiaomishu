import BackgroundTasks
import Foundation

enum InboxIntakeRetrySchedule {
    static let taskIdentifier = "com.example.infans.secretary.intake.retry"

    static func submit() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

@MainActor
final class YingningIntakeCoordinator: ObservableObject {
    static let shared = YingningIntakeCoordinator()

    @Published private(set) var pendingCount = 0
    @Published private(set) var awaitingMacCount = 0
    @Published private(set) var failedCount = 0
    @Published private(set) var statusText = "没有待送达的分享"
    @Published private(set) var lastError: String?

    private let service = InboxIntakeDeliveryService()
    private var flushTask: Task<Bool, Never>?

    func start() {
        Task { _ = await retryPending() }
    }

    func retryPending() async -> Bool {
        if let flushTask { return await flushTask.value }
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            let rows = await service.pending()
            pendingCount = rows.count
            guard !rows.isEmpty else {
                awaitingMacCount = 0
                failedCount = 0
                statusText = "没有待送达的分享"
                lastError = nil
                return true
            }
            statusText = "正在核对 \(rows.count) 条分享的收件状态"
            let result = await service.flush(
                serverURL: SecretarySharedConfiguration.mailboxServerURL(),
                token: CodexCommandTokenKeychain.read()
            )
            pendingCount = result.remaining
            awaitingMacCount = result.awaitingMac
            failedCount = result.failed
            lastError = result.lastError
            if result.remaining == 0 {
                statusText = result.delivered > 0 ? "已送达收件箱" : "没有待送达的分享"
            } else {
                var parts: [String] = []
                if result.awaitingMac > 0 { parts.append("\(result.awaitingMac) 条已在信箱，等待 Mac 保存") }
                if result.failed > 0 { parts.append("\(result.failed) 条发送失败，已保留待重试") }
                let awaitingSend = result.remaining - result.awaitingMac - result.failed
                if awaitingSend > 0 { parts.append("\(awaitingSend) 条已保留，等待发送") }
                statusText = parts.joined(separator: "；")
                InboxIntakeRetrySchedule.submit()
            }
            // Waiting for Mac is a successful custody check, not a failed
            // background transfer. Continue scheduling while originals remain.
            return result.lastError == nil
        }
        flushTask = task
        let result = await task.value
        flushTask = nil
        return result
    }
}
