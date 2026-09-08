import EventKit
import Foundation

#if canImport(AlarmKit)
import AlarmKit
#endif

@MainActor
final class UnifiedReminderAuthorizationStore: ObservableObject {
    static let shared = UnifiedReminderAuthorizationStore()

    @Published private(set) var remindersState = "尚未检查"
    @Published private(set) var calendarState = "尚未检查"
    @Published private(set) var alarmState = "尚未检查"
    @Published private(set) var lastError: String?

    private let eventStore = EKEventStore()

    private init() {
        refresh()
    }

    func refresh() {
        remindersState = Self.eventKitState(EKEventStore.authorizationStatus(for: .reminder), fullAccessName: "完全访问")
        calendarState = Self.eventKitState(EKEventStore.authorizationStatus(for: .event), fullAccessName: "完全访问")
#if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            alarmState = Self.alarmKitState(AlarmManager.shared.authorizationState)
        } else {
            alarmState = "系统不支持（需要 iOS 26）"
        }
#else
        alarmState = "当前 SDK 不支持"
#endif
    }

    func requestReminders() async {
        lastError = nil
        do {
            let granted = try await eventStore.requestFullAccessToReminders()
            remindersState = granted ? "完全访问" : "已拒绝"
        } catch {
            lastError = "提醒事项授权失败：\(error.localizedDescription)"
            refresh()
        }
    }

    func requestCalendar() async {
        lastError = nil
        do {
            let granted = try await eventStore.requestFullAccessToEvents()
            calendarState = granted ? "完全访问" : "已拒绝"
        } catch {
            lastError = "日历授权失败：\(error.localizedDescription)"
            refresh()
        }
    }

    func requestAlarms() async {
        lastError = nil
#if canImport(AlarmKit)
        guard #available(iOS 26.0, *) else {
            alarmState = "系统不支持（需要 iOS 26）"
            return
        }
        do {
            alarmState = Self.alarmKitState(try await AlarmManager.shared.requestAuthorization())
        } catch {
            lastError = "强提醒授权失败：\(error.localizedDescription)"
            refresh()
        }
#else
        alarmState = "当前 SDK 不支持"
#endif
    }

    private static func eventKitState(_ status: EKAuthorizationStatus, fullAccessName: String) -> String {
        switch status {
        case .notDetermined: "尚未询问"
        case .restricted: "系统限制"
        case .denied: "已拒绝"
        case .fullAccess, .authorized: fullAccessName
        case .writeOnly: "仅可新增"
        @unknown default: "未知状态"
        }
    }

#if canImport(AlarmKit)
    @available(iOS 26.0, *)
    private static func alarmKitState(_ status: AlarmManager.AuthorizationState) -> String {
        switch status {
        case .notDetermined: "尚未询问"
        case .denied: "已拒绝"
        case .authorized: "已授权"
        @unknown default: "未知状态"
        }
    }
#endif
}

