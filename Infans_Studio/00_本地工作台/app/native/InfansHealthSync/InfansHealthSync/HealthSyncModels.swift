import Foundation

enum HealthSyncTrigger: String, Codable, CaseIterable, Sendable {
    case backgroundRefresh = "background-refresh"
    case healthKitObserver = "healthkit-observer"
    case appLaunch = "app-launch"
    case manual
}

struct HealthSyncRunAudit: Codable, Sendable {
    let runId: String
    let trigger: HealthSyncTrigger
    let startedAt: String
    let finishedAt: String
}

struct HealthSyncDaily: Codable, Sendable {
    let date: String
    var steps: Double?
    var activeEnergy: Double?
    var exerciseMinutes: Double?
    var standMinutes: Double?
    var restingHeartRate: Double?
    var sleepMinutes: Double?
    var asleepMinutes: Double?
    var sources: [String: String]
}

struct HealthSyncBody: Codable, Sendable {
    let id: String
    let date: String
    let metric: String
    let value: Double
    let source: String
}

struct HealthSyncWorkout: Codable, Sendable {
    let id: String
    let day: String
    let date: String
    let end: String
    let type: String
    let durationMinutes: Double
    let energyKcal: Double?
    let source: String
}

struct HealthSyncPayload: Codable, Sendable {
    let schemaVersion: Int
    let batchId: String
    let deviceId: String
    let generatedAt: String
    let windowStart: String
    let windowEnd: String
    let completeThrough: String
    let timeZone: String
    let sampleCount: Int
    let run: HealthSyncRunAudit
    let daily: [HealthSyncDaily]
    let body: [HealthSyncBody]
    let workouts: [HealthSyncWorkout]
}

struct HealthSyncResponse: Decodable, Sendable {
    let ok: Bool?
    let duplicate: Bool?
    let completeThrough: String?
    let lastSyncedAt: String?
    let error: String?
}

enum HealthSyncError: LocalizedError {
    case invalidServerURL
    case tokenMissing
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: return "请填写 HTTPS 小秘书地址"
        case .tokenMissing: return "请先粘贴 Mac 上生成的配对令牌"
        case .server(let message): return message
        }
    }
}
