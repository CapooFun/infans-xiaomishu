import EventKit
import Foundation
import SwiftUI

#if canImport(AlarmKit)
import AlarmKit
#endif

@MainActor
final class UnifiedReminderExecutor {
    static let shared = UnifiedReminderExecutor()

    private let eventStore: EKEventStore
    private let registry: UnifiedReminderNativeIDRegistry

    init(
        eventStore: EKEventStore = EKEventStore(),
        registry: UnifiedReminderNativeIDRegistry? = nil
    ) {
        self.eventStore = eventStore
        self.registry = registry ?? UnifiedReminderNativeIDRegistry()
    }

    func execute(_ request: UnifiedReminderExecutionRequest) async throws -> UnifiedReminderExecutionResult {
        let issues = request.validationIssues()
        guard issues.isEmpty else { throw UnifiedReminderExecutionError.invalid(issues) }

        let primary = try await executePrimary(request)
        guard request.executor == .alarmKitAlarm,
              request.safeguardExecutors?.contains(.appleReminders) == true else {
            return primary
        }
        let safeguardActionID = "\(request.actionID).safeguard.apple-reminders"
        let safeguardNativeID = request.operation == .create ? nil : registry.nativeID(for: safeguardActionID)
        let safeguard = UnifiedReminderExecutionRequest(
            actionID: safeguardActionID,
            executor: .appleReminders,
            operation: request.operation,
            title: request.title,
            fireAt: request.fireAt,
            notes: request.notes,
            containerTitle: request.containerTitle,
            nativeID: safeguardNativeID
        )
        do {
            let safeguardResult = try await executeReminder(safeguard)
            return UnifiedReminderExecutionResult(
                schemaVersion: primary.schemaVersion,
                actionID: primary.actionID,
                executor: primary.executor,
                operation: primary.operation,
                nativeID: primary.nativeID,
                completedAt: primary.completedAt,
                summary: "\(primary.summary)；\(safeguardResult.summary)",
                safeguardNativeIDs: safeguardResult.nativeID.map { [UnifiedReminderExecutorKind.appleReminders.rawValue: $0] }
            )
        } catch {
            return UnifiedReminderExecutionResult(
                schemaVersion: primary.schemaVersion,
                actionID: primary.actionID,
                executor: primary.executor,
                operation: primary.operation,
                nativeID: primary.nativeID,
                completedAt: primary.completedAt,
                summary: primary.summary,
                warnings: ["Apple 提醒事项防漏未完成：\(error.localizedDescription)"]
            )
        }
    }

    private func executePrimary(_ request: UnifiedReminderExecutionRequest) async throws -> UnifiedReminderExecutionResult {
        switch request.executor {
        case .appleReminders:
            return try await executeReminder(request)
        case .appleCalendar:
            return try executeCalendar(request)
        case .alarmKitAlarm, .alarmKitTimer:
            if #available(iOS 26.0, *) {
                return try await executeAlarmKit(request)
            }
            throw UnifiedReminderExecutionError.unsupported("AlarmKit 需要 iOS 26 或更高版本")
        case .secretaryMonitor:
            throw UnifiedReminderExecutionError.unsupported("外部状态监控应由小秘书监控器执行，不能写成固定到点提醒")
        }
    }

    private func executeReminder(_ request: UnifiedReminderExecutionRequest) async throws -> UnifiedReminderExecutionResult {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
            throw UnifiedReminderExecutionError.permissionRequired("Apple 提醒事项")
        }

        let reminder: EKReminder
        var reusedExisting = false
        if request.operation == .create {
            if let storedID = registry.nativeID(for: request.actionID),
               let existing = eventStore.calendarItem(withIdentifier: storedID) as? EKReminder {
                reminder = existing
                reusedExisting = true
            } else {
                registry.remove(actionID: request.actionID)
                reminder = EKReminder(eventStore: eventStore)
                reminder.calendar = reminderCalendar(named: request.containerTitle)
            }
        } else {
            guard let nativeID = request.nativeID,
                  let existing = eventStore.calendarItem(withIdentifier: nativeID) as? EKReminder else {
                throw UnifiedReminderExecutionError.itemNotFound
            }
            reminder = existing
        }

        switch request.operation {
        case .create, .update, .snooze:
            reminder.title = request.title
            reminder.notes = request.notes
            reminder.dueDateComponents = request.fireAt.map(tokyoComponents)
            reminder.alarms = request.fireAt.map { [EKAlarm(absoluteDate: $0)] }
            try eventStore.save(reminder, commit: true)
            registry.store(nativeID: reminder.calendarItemIdentifier, for: request.actionID)
            return result(for: request, nativeID: reminder.calendarItemIdentifier, summary: "已\(reusedExisting ? "确认存在" : request.operation == .create ? "创建" : "更新") Apple 提醒事项：\(request.title)")
        case .cancel:
            try eventStore.remove(reminder, commit: true)
            registry.remove(actionID: request.actionID)
            return result(for: request, nativeID: request.nativeID, summary: "已取消 Apple 提醒事项：\(request.title)")
        case .complete:
            reminder.isCompleted = true
            reminder.completionDate = Date()
            try eventStore.save(reminder, commit: true)
            return result(for: request, nativeID: reminder.calendarItemIdentifier, summary: "已完成 Apple 提醒事项：\(request.title)")
        }
    }

    private func executeCalendar(_ request: UnifiedReminderExecutionRequest) throws -> UnifiedReminderExecutionResult {
        let status = EKEventStore.authorizationStatus(for: .event)
        guard status == .fullAccess || status == .writeOnly else {
            throw UnifiedReminderExecutionError.permissionRequired("Apple 日历")
        }

        let event: EKEvent
        var reusedExisting = false
        if request.operation == .create {
            if let storedID = registry.nativeID(for: request.actionID),
               let existing = eventStore.event(withIdentifier: storedID) {
                event = existing
                reusedExisting = true
            } else {
                registry.remove(actionID: request.actionID)
                event = EKEvent(eventStore: eventStore)
                event.calendar = eventCalendar(named: request.containerTitle)
            }
        } else {
            guard let nativeID = request.nativeID,
                  let existing = eventStore.event(withIdentifier: nativeID) else {
                throw UnifiedReminderExecutionError.itemNotFound
            }
            event = existing
        }

        switch request.operation {
        case .create, .update:
            event.title = request.title
            event.notes = request.notes
            event.startDate = request.fireAt
            event.endDate = request.endAt
            event.timeZone = TimeZone(identifier: UnifiedReminderExecutionRequest.tokyoTimeZone)
            try eventStore.save(event, span: .thisEvent, commit: true)
            registry.store(nativeID: event.eventIdentifier, for: request.actionID)
            return result(for: request, nativeID: event.eventIdentifier, summary: "已\(reusedExisting ? "确认存在" : request.operation == .create ? "创建" : "更新") Apple 日历事件：\(request.title)")
        case .cancel:
            try eventStore.remove(event, span: .thisEvent, commit: true)
            registry.remove(actionID: request.actionID)
            return result(for: request, nativeID: request.nativeID, summary: "已取消 Apple 日历事件：\(request.title)")
        case .complete, .snooze:
            throw UnifiedReminderExecutionError.unsupported("日历事件不支持完成或延后提醒")
        }
    }

    private func reminderCalendar(named title: String?) -> EKCalendar {
        if let title, let match = eventStore.calendars(for: .reminder).first(where: { $0.title == title }) {
            return match
        }
        return eventStore.defaultCalendarForNewReminders()!
    }

    private func eventCalendar(named title: String?) -> EKCalendar {
        if let title, let match = eventStore.calendars(for: .event).first(where: { $0.title == title && matchAllowsWrite($0) }) {
            return match
        }
        return eventStore.defaultCalendarForNewEvents!
    }

    private func matchAllowsWrite(_ calendar: EKCalendar) -> Bool {
        calendar.allowsContentModifications
    }

    private func tokyoComponents(_ date: Date) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: UnifiedReminderExecutionRequest.tokyoTimeZone)!
        var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        components.timeZone = calendar.timeZone
        return components
    }

    private func result(
        for request: UnifiedReminderExecutionRequest,
        nativeID: String?,
        summary: String
    ) -> UnifiedReminderExecutionResult {
        UnifiedReminderExecutionResult(
            schemaVersion: UnifiedReminderExecutionRequest.schemaVersion,
            actionID: request.actionID,
            executor: request.executor,
            operation: request.operation,
            nativeID: nativeID,
            completedAt: Date(),
            summary: summary
        )
    }
}

@MainActor
final class UnifiedReminderNativeIDRegistry {
    private static let key = "unifiedReminder.nativeIDs.v1"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func nativeID(for actionID: String) -> String? {
        dictionary()[actionID]
    }

    func store(nativeID: String?, for actionID: String) {
        guard let nativeID, !nativeID.isEmpty else { return }
        var rows = dictionary()
        rows[actionID] = nativeID
        defaults.set(rows, forKey: Self.key)
    }

    func remove(actionID: String) {
        var rows = dictionary()
        rows.removeValue(forKey: actionID)
        defaults.set(rows, forKey: Self.key)
    }

    private func dictionary() -> [String: String] {
        defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:]
    }
}

#if canImport(AlarmKit)
@available(iOS 26.0, *)
private struct SecretaryAlarmMetadata: AlarmMetadata {
    let actionID: String
    let title: String
}

@available(iOS 26.0, *)
private extension UnifiedReminderExecutor {
    func executeAlarmKit(_ request: UnifiedReminderExecutionRequest) async throws -> UnifiedReminderExecutionResult {
        guard AlarmManager.shared.authorizationState == .authorized else {
            throw UnifiedReminderExecutionError.permissionRequired("强提醒与计时器")
        }
        guard let alarmID = request.nativeID.flatMap(UUID.init(uuidString:)) ?? UUID(uuidString: request.actionID) ?? (request.operation == .create ? UUID() : nil) else {
            throw UnifiedReminderExecutionError.itemNotFound
        }

        switch request.operation {
        case .cancel:
            try AlarmManager.shared.cancel(id: alarmID)
            registry.remove(actionID: request.actionID)
            return result(for: request, nativeID: alarmID.uuidString.lowercased(), summary: "已取消：\(request.title)")
        case .complete:
            try AlarmManager.shared.stop(id: alarmID)
            return result(for: request, nativeID: alarmID.uuidString.lowercased(), summary: "已停止：\(request.title)")
        case .update, .snooze:
            try? AlarmManager.shared.cancel(id: alarmID)
            fallthrough
        case .create:
            if request.operation == .create,
               (try? AlarmManager.shared.alarms.contains(where: { $0.id == alarmID })) == true {
                registry.store(nativeID: alarmID.uuidString.lowercased(), for: request.actionID)
                return result(for: request, nativeID: alarmID.uuidString.lowercased(), summary: "已确认存在：\(request.title)")
            }
            let title = LocalizedStringResource(stringLiteral: request.title)
            let alert: AlarmPresentation.Alert
            if #available(iOS 26.1, *) {
                alert = .init(title: title)
            } else {
                let stopButton = AlarmButton(
                    text: LocalizedStringResource(stringLiteral: "停止"),
                    textColor: .white,
                    systemImageName: "stop.circle.fill"
                )
                alert = .init(title: title, stopButton: stopButton)
            }
            let presentation = AlarmPresentation(alert: alert)
            let attributes = AlarmAttributes(
                presentation: presentation,
                metadata: SecretaryAlarmMetadata(actionID: request.actionID, title: request.title),
                tintColor: .indigo
            )
            let configuration: AlarmManager.AlarmConfiguration<SecretaryAlarmMetadata>
            if request.executor == .alarmKitTimer {
                configuration = .timer(duration: request.durationSeconds!, attributes: attributes)
            } else {
                configuration = .alarm(schedule: .fixed(request.fireAt!), attributes: attributes)
            }
            _ = try await AlarmManager.shared.schedule(id: alarmID, configuration: configuration)
            registry.store(nativeID: alarmID.uuidString.lowercased(), for: request.actionID)
            let kind = request.executor == .alarmKitTimer ? "计时器" : "强提醒"
            return result(for: request, nativeID: alarmID.uuidString.lowercased(), summary: "已\(request.operation == .create ? "创建" : "更新")\(kind)：\(request.title)")
        }
    }
}
#else
private extension UnifiedReminderExecutor {
    func executeAlarmKit(_ request: UnifiedReminderExecutionRequest) async throws -> UnifiedReminderExecutionResult {
        throw UnifiedReminderExecutionError.unsupported("当前 SDK 不支持 AlarmKit")
    }
}
#endif
