import Foundation
import Testing
@testable import HealthSyncScheduleCore

@Suite("日本时间每日同步")
struct HealthSyncScheduleTests {
    private let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    @Test("中午以前不执行")
    func beforeNoonIsNotDue() throws {
        let now = try #require(formatter.date(from: "2026-08-27T02:59:59Z")) // 11:59:59 JST
        #expect(!HealthSyncSchedule.isDue(now: now, lastSuccess: nil))
    }

    @Test("中午整首次执行")
    func noonIsDue() throws {
        let now = try #require(formatter.date(from: "2026-08-27T03:00:00Z")) // 12:00 JST
        #expect(HealthSyncSchedule.isDue(now: now, lastSuccess: nil))
    }

    @Test("同一日本日期只成功一次")
    func sameTokyoDayIsNotDueAgain() throws {
        let now = try #require(formatter.date(from: "2026-08-27T08:00:00Z"))
        let lastSuccess = try #require(formatter.date(from: "2026-08-27T03:05:00Z"))
        #expect(!HealthSyncSchedule.isDue(now: now, lastSuccess: lastSuccess))
    }

    @Test("上一日本日期的成功不阻止今天")
    func previousTokyoDayIsDue() throws {
        let now = try #require(formatter.date(from: "2026-08-27T03:00:00Z"))
        let lastSuccess = try #require(formatter.date(from: "2026-08-26T14:59:59Z")) // 23:59:59 JST
        #expect(HealthSyncSchedule.isDue(now: now, lastSuccess: lastSuccess))
    }

    @Test("中午前安排到当天中午")
    func nextNoonBeforeNoon() throws {
        let now = try #require(formatter.date(from: "2026-08-27T02:00:00Z"))
        let expected = try #require(formatter.date(from: "2026-08-27T03:00:00Z"))
        #expect(HealthSyncSchedule.nextNoon(after: now) == expected)
    }

    @Test("中午整以后安排到次日中午")
    func nextNoonAtNoon() throws {
        let now = try #require(formatter.date(from: "2026-08-27T03:00:00Z"))
        let expected = try #require(formatter.date(from: "2026-08-28T03:00:00Z"))
        #expect(HealthSyncSchedule.nextNoon(after: now) == expected)
    }
}

@Suite("配对令牌规范化")
struct HealthSyncTokenTests {
    private let token = String(repeating: "a", count: 43)

    @Test("接受纯令牌与首尾空白")
    func acceptsPlainToken() {
        #expect(HealthSyncToken.normalize("  \n\(token)\t") == token)
    }

    @Test("接受本机配置行")
    func acceptsConfigLine() {
        #expect(HealthSyncToken.normalize("INFANS_HEALTH_SYNC_TOKEN=\(token)\n") == token)
    }

    @Test("拒绝密码和非法字符")
    func rejectsInvalidContent() {
        #expect(HealthSyncToken.normalize("short-password") == nil)
        #expect(HealthSyncToken.normalize(String(repeating: "a", count: 42) + "！") == nil)
    }
}

@Suite("同步运行触发来源")
struct HealthSyncRunAuditTests {
    @Test("四条运行路径有稳定编码")
    func triggerCodesAreStable() {
        #expect(Set(HealthSyncTrigger.allCases.map(\.rawValue)) == [
            "background-refresh", "healthkit-observer", "app-launch", "manual",
        ])
    }
}
