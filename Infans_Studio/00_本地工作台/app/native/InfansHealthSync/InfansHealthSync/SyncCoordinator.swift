import BackgroundTasks
import Foundation
import UIKit

actor PendingBatchStore {
    private let fileURL: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = base.appendingPathComponent("InfansHealthSync", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("pending-batches.json")
    }

    func enqueue(_ payload: HealthSyncPayload) throws {
        var rows = load()
        if !rows.contains(where: { $0.batchId == payload.batchId }) { rows.append(payload) }
        try save(Array(rows.suffix(3)))
    }

    func all() -> [HealthSyncPayload] { load() }

    func remove(batchID: String) throws {
        try save(load().filter { $0.batchId != batchID })
    }

    private func load() -> [HealthSyncPayload] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([HealthSyncPayload].self, from: data)) ?? []
    }

    private func save(_ rows: [HealthSyncPayload]) throws {
        let data = try JSONEncoder().encode(rows)
        try data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path)
    }
}

struct HealthSyncClient: Sendable {
    func send(_ payload: HealthSyncPayload, serverURL: String, token: String) async throws -> HealthSyncResponse {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: raw), base.scheme == "https" || base.host == "127.0.0.1" else {
            throw HealthSyncError.invalidServerURL
        }
        let url = base.appendingPathComponent("api/apple-health/device-sync")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 45
        request.httpBody = try JSONEncoder().encode(payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = try? JSONDecoder().decode(HealthSyncResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HealthSyncError.server(decoded?.error ?? "小秘书接收健康数据失败")
        }
        guard decoded?.ok == true else { throw HealthSyncError.server(decoded?.error ?? "同步响应不完整") }
        return decoded!
    }
}

extension HealthSyncSchedule {
    @discardableResult
    static func submitNext() throws -> Date {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        let earliest = nextNoon()
        request.earliestBeginDate = earliest
        try BGTaskScheduler.shared.submit(request)
        return earliest
    }
}

@MainActor
final class SyncCoordinator: ObservableObject {
    static let shared = SyncCoordinator()

    @Published private(set) var isSyncing = false
    @Published private(set) var statusText = "等待首次同步"
    @Published private(set) var lastError: String?

    let settings = SettingsStore.shared
    private let reader = HealthKitReader()
    private let pending = PendingBatchStore()
    private let client = HealthSyncClient()
    func syncForegroundIfDue() {
        Task { await syncIfDue(trigger: .appLaunch) }
    }

    func configureBackgroundServices(refreshStatus: UIBackgroundRefreshStatus) {
        recordBackgroundRefreshStatus(refreshStatus)
        reader.registerBackgroundObservers(
            onChange: {
                await SyncCoordinator.shared.syncIfDue(trigger: .healthKitObserver)
            },
            onError: { message in
                Task { @MainActor in
                    SyncCoordinator.shared.settings.recordHealthKitBackgroundState("观察失败：\(message)")
                }
            }
        )
        enableHealthKitBackgroundDelivery()
        scheduleNextBackgroundRefresh()
    }

    func recordBackgroundRefreshStatus(_ status: UIBackgroundRefreshStatus) {
        switch status {
        case .available:
            settings.recordBackgroundRefreshState("可用")
        case .denied:
            settings.recordBackgroundRefreshState("已关闭")
        case .restricted:
            settings.recordBackgroundRefreshState("受系统限制")
        @unknown default:
            settings.recordBackgroundRefreshState("未知")
        }
    }

    @discardableResult
    func scheduleNextBackgroundRefresh() -> Bool {
        do {
            let earliest = try HealthSyncSchedule.submitNext()
            settings.recordNextRefresh(earliest)
            return true
        } catch {
            settings.recordNextRefresh(nil, error: error.localizedDescription)
            return false
        }
    }

    func recordBackgroundTaskExpiration() {
        settings.recordBackgroundAttempt(trigger: .backgroundRefresh, text: "系统时间用尽，已取消并等待下次补跑")
    }

    private func enableHealthKitBackgroundDelivery() {
        Task { @MainActor in
            do {
                try await reader.enableBackgroundDelivery()
                settings.recordHealthKitBackgroundState("已启用·每小时最多唤醒一次")
            } catch {
                settings.recordHealthKitBackgroundState("启用失败：\(error.localizedDescription)")
            }
        }
    }

    func requestAuthorization() async {
        do {
            try await reader.requestAuthorization()
            settings.authorizationRequested = true
            enableHealthKitBackgroundDelivery()
            statusText = "Apple 健康读取授权已请求"
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func syncNow() async { _ = await performSync(force: true, trigger: .manual) }

    func syncIfDue(trigger: HealthSyncTrigger) async {
        _ = await performSync(force: false, trigger: trigger)
    }

    func performBackgroundSync() async -> Bool {
        let success = await performSync(force: false, trigger: .backgroundRefresh)
        scheduleNextBackgroundRefresh()
        return success
    }

    private func performSync(force: Bool, trigger: HealthSyncTrigger) async -> Bool {
        let unattended = trigger == .backgroundRefresh || trigger == .healthKitObserver
        if unattended {
            settings.recordBackgroundAttempt(trigger: trigger, text: "已唤醒，开始检查")
        }
        guard !isSyncing else {
            if unattended { settings.recordBackgroundAttempt(trigger: trigger, text: "已有同步正在运行") }
            return true
        }
        guard settings.authorizationRequested else {
            let message = "Apple 健康授权尚未完成"
            lastError = message
            if unattended { settings.recordBackgroundAttempt(trigger: trigger, text: message) }
            return false
        }
        guard settings.tokenConfigured else {
            let message = "配对令牌缺失或在当前锁屏状态不可读"
            lastError = message
            if unattended { settings.recordBackgroundAttempt(trigger: trigger, text: message) }
            return false
        }
        if !force && !HealthSyncSchedule.isDue(now: Date(), lastSuccess: settings.lastSuccessAt) {
            let success = await flushPending()
            if unattended {
                let text = success ? "已检查；今天尚未到时间或已经成功" : (lastError ?? "待发批次重试失败")
                settings.recordBackgroundAttempt(trigger: trigger, text: text)
            }
            return success
        }
        isSyncing = true
        lastError = nil
        defer { isSyncing = false }
        do {
            let payload = try await reader.makePayload(
                deviceID: settings.deviceID,
                runID: UUID(),
                trigger: trigger,
                startedAt: Date()
            )
            try await pending.enqueue(payload)
            let success = await flushPending()
            if unattended {
                let text = success ? "同步成功并送达 Mac" : "已保留待重试：\(lastError ?? "发送失败")"
                settings.recordBackgroundAttempt(trigger: trigger, text: text)
            }
            return success
        } catch is CancellationError {
            let message = "系统提前结束了后台运行"
            lastError = message
            statusText = "本次同步已中止，稍后会重试"
            if unattended { settings.recordBackgroundAttempt(trigger: trigger, text: message) }
            return false
        } catch {
            lastError = error.localizedDescription
            statusText = "本次同步已保留，稍后会重试"
            if unattended { settings.recordBackgroundAttempt(trigger: trigger, text: error.localizedDescription) }
            return false
        }
    }

    private func flushPending() async -> Bool {
        guard let token = settings.token() else {
            lastError = HealthSyncError.tokenMissing.localizedDescription
            return false
        }
        do {
            let payloads = await pending.all()
            guard !payloads.isEmpty else { return true }
            for payload in payloads {
                let response = try await client.send(payload, serverURL: settings.serverURL, token: token)
                try await pending.remove(batchID: payload.batchId)
                settings.lastSuccessAt = Date()
                settings.lastCompleteThrough = response.completeThrough ?? payload.completeThrough
            }
            statusText = "已同步到小秘书"
            lastError = nil
            return true
        } catch {
            lastError = error.localizedDescription
            statusText = "等待 Tailscale 或 Mac 恢复后重试"
            return false
        }
    }
}
