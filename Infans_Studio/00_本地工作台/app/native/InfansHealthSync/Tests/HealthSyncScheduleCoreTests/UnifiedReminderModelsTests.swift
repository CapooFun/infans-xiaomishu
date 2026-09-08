import XCTest
@testable import HealthSyncScheduleCore

final class UnifiedReminderModelsTests: XCTestCase {
    private let reference = Date(timeIntervalSince1970: 1_800_000_000)

    func testValidReminderAndAlarmPlans() {
        let reminder = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .appleReminders,
            title: "交水电费",
            fireAt: reference.addingTimeInterval(3_600)
        )
        XCTAssertEqual(reminder.validationIssues(referenceDate: reference), [])

        let alarm = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .alarmKitAlarm,
            title: "出门抢票",
            fireAt: reference.addingTimeInterval(600)
        )
        XCTAssertEqual(alarm.validationIssues(referenceDate: reference), [])

        let guardedAlarm = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .alarmKitAlarm,
            title: "出门抢票",
            fireAt: reference.addingTimeInterval(600),
            safeguardExecutors: [.appleReminders]
        )
        XCTAssertEqual(guardedAlarm.validationIssues(referenceDate: reference), [])
    }

    func testCalendarRequiresOrderedStartAndEnd() {
        let request = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .appleCalendar,
            title: "和朋友看电影",
            fireAt: reference.addingTimeInterval(7_200),
            endAt: reference.addingTimeInterval(3_600)
        )
        XCTAssertEqual(request.validationIssues(referenceDate: reference), ["日历结束时间必须晚于开始时间"])
    }

    func testMutationRequiresStableNativeIdentifier() {
        let request = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .appleReminders,
            operation: .cancel,
            title: "交水电费"
        )
        XCTAssertEqual(request.validationIssues(referenceDate: reference), ["修改、取消或完成必须指向现有系统项"])
    }

    func testTimerBoundsAndMonitorBoundary() {
        let timer = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .alarmKitTimer,
            title: "关火",
            durationSeconds: 0
        )
        XCTAssertEqual(timer.validationIssues(referenceDate: reference), ["计时器时长必须在 1 秒到 7 天之间"])

        let monitor = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .secretaryMonitor,
            title: "有票就通知"
        )
        XCTAssertEqual(monitor.validationIssues(referenceDate: reference), ["秘书监控不能由 iPhone 本机提醒执行器创建"])

        let invalidSafeguard = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .appleCalendar,
            title: "看电影",
            fireAt: reference.addingTimeInterval(3_600),
            endAt: reference.addingTimeInterval(7_200),
            safeguardExecutors: [.appleReminders]
        )
        XCTAssertEqual(invalidSafeguard.validationIssues(referenceDate: reference), ["只有强提醒可以附加 Apple 提醒事项防漏"])
    }

    func testJSONRoundTripUsesStableExecutorNames() throws {
        let request = UnifiedReminderExecutionRequest(
            actionID: UUID().uuidString,
            executor: .alarmKitTimer,
            title: "20 分钟后关火",
            durationSeconds: 1_200
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(request)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("alarmkit_timer"))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertEqual(try decoder.decode(UnifiedReminderExecutionRequest.self, from: data), request)
    }
}
