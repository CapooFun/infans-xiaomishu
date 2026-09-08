import Foundation

enum HealthSyncSchedule {
    static let taskIdentifier = "com.example.infans.secretary.daily"

    static func tokyoDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func isDue(now: Date, lastSuccess: Date?) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        guard calendar.component(.hour, from: now) >= 12 else { return false }
        return lastSuccess.map { tokyoDay($0) != tokyoDay(now) } ?? true
    }

    static func nextNoon(after now: Date = Date()) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let today = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: now)!
        return today > now ? today : calendar.date(byAdding: .day, value: 1, to: today)!
    }
}
