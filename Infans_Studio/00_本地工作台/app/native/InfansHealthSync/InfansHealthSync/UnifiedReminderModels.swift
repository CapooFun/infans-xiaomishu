import Foundation

enum UnifiedReminderExecutorKind: String, Codable, CaseIterable, Hashable, Sendable {
    case appleReminders = "apple_reminders"
    case appleCalendar = "apple_calendar"
    case alarmKitAlarm = "alarmkit_alarm"
    case alarmKitTimer = "alarmkit_timer"
    case secretaryMonitor = "secretary_monitor"
}

enum UnifiedReminderOperation: String, Codable, CaseIterable, Sendable {
    case create
    case update
    case cancel
    case complete
    case snooze
}

struct UnifiedReminderExecutionRequest: Codable, Equatable, Sendable {
    static let schemaVersion = 1
    static let tokyoTimeZone = "Asia/Tokyo"

    let schemaVersion: Int
    let actionID: String
    let executor: UnifiedReminderExecutorKind
    let operation: UnifiedReminderOperation
    let title: String
    let timeZone: String
    let fireAt: Date?
    let endAt: Date?
    let durationSeconds: TimeInterval?
    let notes: String?
    let containerTitle: String?
    let nativeID: String?
    let safeguardExecutors: [UnifiedReminderExecutorKind]?

    init(
        schemaVersion: Int = Self.schemaVersion,
        actionID: String,
        executor: UnifiedReminderExecutorKind,
        operation: UnifiedReminderOperation = .create,
        title: String,
        timeZone: String = Self.tokyoTimeZone,
        fireAt: Date? = nil,
        endAt: Date? = nil,
        durationSeconds: TimeInterval? = nil,
        notes: String? = nil,
        containerTitle: String? = nil,
        nativeID: String? = nil,
        safeguardExecutors: [UnifiedReminderExecutorKind]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.actionID = actionID
        self.executor = executor
        self.operation = operation
        self.title = title
        self.timeZone = timeZone
        self.fireAt = fireAt
        self.endAt = endAt
        self.durationSeconds = durationSeconds
        self.notes = notes
        self.containerTitle = containerTitle
        self.nativeID = nativeID
        self.safeguardExecutors = safeguardExecutors
    }

    func validationIssues(referenceDate: Date = Date()) -> [String] {
        var issues: [String] = []
        if schemaVersion != Self.schemaVersion { issues.append("版本不受支持") }
        if actionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { issues.append("缺少动作 ID") }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanTitle.isEmpty || cleanTitle.count > 160 { issues.append("标题必须是 1–160 个字符") }
        if timeZone != Self.tokyoTimeZone { issues.append("时区必须是 Asia/Tokyo") }

        if operation != .create,
           nativeID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            issues.append("修改、取消或完成必须指向现有系统项")
        }
        if let safeguardExecutors, !safeguardExecutors.isEmpty {
            if executor != .alarmKitAlarm || Set(safeguardExecutors) != [.appleReminders] {
                issues.append("只有强提醒可以附加 Apple 提醒事项防漏")
            }
        }

        switch executor {
        case .appleReminders:
            if [.create, .update, .snooze].contains(operation), fireAt == nil {
                issues.append("提醒事项缺少到期时间")
            }
        case .appleCalendar:
            if [.create, .update].contains(operation) {
                guard let fireAt else {
                    issues.append("日历事件缺少开始时间")
                    break
                }
                guard let endAt else {
                    issues.append("日历事件缺少结束时间")
                    break
                }
                if endAt <= fireAt { issues.append("日历结束时间必须晚于开始时间") }
            }
            if [.complete, .snooze].contains(operation) {
                issues.append("日历事件不支持该动作")
            }
        case .alarmKitAlarm:
            if [.create, .update, .snooze].contains(operation) {
                guard let fireAt else {
                    issues.append("强提醒缺少触发时间")
                    break
                }
                if fireAt <= referenceDate { issues.append("强提醒时间必须在未来") }
            }
        case .alarmKitTimer:
            if operation == .create {
                guard let durationSeconds else {
                    issues.append("计时器缺少时长")
                    break
                }
                if durationSeconds < 1 || durationSeconds > 7 * 24 * 60 * 60 {
                    issues.append("计时器时长必须在 1 秒到 7 天之间")
                }
            }
            if [.update, .snooze].contains(operation) {
                issues.append("计时器延后将作为新计时器创建，不能直接修改")
            }
        case .secretaryMonitor:
            issues.append("秘书监控不能由 iPhone 本机提醒执行器创建")
        }
        return issues
    }
}

struct UnifiedReminderExecutionResult: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let actionID: String
    let executor: UnifiedReminderExecutorKind
    let operation: UnifiedReminderOperation
    let nativeID: String?
    let completedAt: Date
    let summary: String
    let safeguardNativeIDs: [String: String]?
    let warnings: [String]?

    init(
        schemaVersion: Int,
        actionID: String,
        executor: UnifiedReminderExecutorKind,
        operation: UnifiedReminderOperation,
        nativeID: String?,
        completedAt: Date,
        summary: String,
        safeguardNativeIDs: [String: String]? = nil,
        warnings: [String]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.actionID = actionID
        self.executor = executor
        self.operation = operation
        self.nativeID = nativeID
        self.completedAt = completedAt
        self.summary = summary
        self.safeguardNativeIDs = safeguardNativeIDs
        self.warnings = warnings
    }
}

enum UnifiedReminderExecutionError: LocalizedError, Equatable {
    case invalid([String])
    case permissionRequired(String)
    case itemNotFound
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let issues): issues.joined(separator: "；")
        case .permissionRequired(let name): "请先授权\(name)"
        case .itemNotFound: "找不到要操作的系统提醒"
        case .unsupported(let message): message
        }
    }
}
