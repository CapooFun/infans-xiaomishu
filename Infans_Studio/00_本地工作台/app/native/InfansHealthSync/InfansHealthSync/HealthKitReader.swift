import Foundation
import HealthKit

final class HealthKitReader: @unchecked Sendable {
    private struct QuantityMetric {
        let identifier: HKQuantityTypeIdentifier
        let key: String
        let unit: HKUnit
        let average: Bool
    }

    private let store = HKHealthStore()
    private var observers: [HKObserverQuery] = []
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!

    private var quantityMetrics: [QuantityMetric] {
        [
            .init(identifier: .stepCount, key: "steps", unit: .count(), average: false),
            .init(identifier: .activeEnergyBurned, key: "activeEnergy", unit: .kilocalorie(), average: false),
            .init(identifier: .appleExerciseTime, key: "exerciseMinutes", unit: .minute(), average: false),
            .init(identifier: .appleStandTime, key: "standMinutes", unit: .minute(), average: false),
            .init(identifier: .restingHeartRate, key: "restingHeartRate", unit: .count().unitDivided(by: .minute()), average: true),
        ]
    }

    private var bodyMetrics: [(HKQuantityTypeIdentifier, String, HKUnit)] {
        [
            (.bodyMass, "weightKg", .gramUnit(with: .kilo)),
            (.waistCircumference, "waistCm", .meterUnit(with: .centi)),
            (.bodyFatPercentage, "bodyFatPercent", .percent()),
        ]
    }

    private var readTypes: Set<HKObjectType> {
        var result = Set<HKObjectType>()
        for metric in quantityMetrics { if let type = HKObjectType.quantityType(forIdentifier: metric.identifier) { result.insert(type) } }
        for metric in bodyMetrics { if let type = HKObjectType.quantityType(forIdentifier: metric.0) { result.insert(type) } }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { result.insert(sleep) }
        result.insert(HKObjectType.workoutType())
        return result
    }

    private var wakeTypes: [HKSampleType] {
        [
            HKObjectType.quantityType(forIdentifier: .stepCount),
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis),
            HKObjectType.workoutType(),
        ].compactMap { $0 }
    }

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw HealthSyncError.server("这台设备没有可用的 Apple 健康数据")
        }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    func registerBackgroundObservers(
        onChange: @escaping @Sendable () async -> Void,
        onError: @escaping @Sendable (String) -> Void
    ) {
        guard observers.isEmpty else { return }
        for type in wakeTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                if let error {
                    onError(error.localizedDescription)
                    completion()
                    return
                }
                Task {
                    await onChange()
                    completion()
                }
            }
            observers.append(query)
            store.execute(query)
        }
    }

    func enableBackgroundDelivery() async throws {
        for type in wakeTypes {
            try await store.enableBackgroundDelivery(for: type, frequency: .hourly)
        }
    }

    func makePayload(
        deviceID: String,
        runID: UUID,
        trigger: HealthSyncTrigger,
        startedAt: Date,
        now: Date = Date()
    ) async throws -> HealthSyncPayload {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tokyo
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -34, to: today)!
        let end = calendar.date(byAdding: .day, value: 1, to: today)!
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate])

        var dailyValues: [String: [String: [String: [Double]]]] = [:]
        var sampleCount = 0
        for metric in quantityMetrics {
            try Task.checkCancellation()
            guard let type = HKObjectType.quantityType(forIdentifier: metric.identifier) else { continue }
            let samples = try await query(type: type, predicate: predicate).compactMap { $0 as? HKQuantitySample }
            sampleCount += samples.count
            for sample in samples {
                let day = dayString(sample.startDate)
                let source = sample.sourceRevision.source.name
                let value = sample.quantity.doubleValue(for: metric.unit)
                guard value.isFinite, value >= 0 else { continue }
                dailyValues[day, default: [:]][metric.key, default: [:]][source, default: []].append(value)
            }
        }

        var sleepIntervals: [String: [String: [DateInterval]]] = [:]
        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            let samples = try await query(type: sleepType, predicate: predicate).compactMap { $0 as? HKCategorySample }
            sampleCount += samples.count
            for sample in samples where isAsleep(sample.value) && sample.endDate > sample.startDate {
                let day = dayString(sample.endDate)
                let source = sample.sourceRevision.source.name
                sleepIntervals[day, default: [:]][source, default: []].append(DateInterval(start: sample.startDate, end: sample.endDate))
            }
        }

        let allDays = Set(dailyValues.keys).union(sleepIntervals.keys)
        let daily: [HealthSyncDaily] = allDays.sorted().map { day in
            var values: [String: Double] = [:]
            var sources: [String: String] = [:]
            for metric in quantityMetrics {
                guard let bySource = dailyValues[day]?[metric.key], let source = preferredSource(Array(bySource.keys)) else { continue }
                let rows = bySource[source] ?? []
                values[metric.key] = rounded(metric.average ? rows.reduce(0, +) / Double(max(rows.count, 1)) : rows.reduce(0, +))
                sources[metric.key] = source
            }
            if let bySource = sleepIntervals[day], let source = preferredSource(Array(bySource.keys)) {
                let minutes = rounded(unionDuration(bySource[source] ?? []) / 60)
                values["sleepMinutes"] = minutes
                values["asleepMinutes"] = minutes
                sources["sleepMinutes"] = source
                sources["asleepMinutes"] = source
            }
            return HealthSyncDaily(
                date: day,
                steps: values["steps"],
                activeEnergy: values["activeEnergy"],
                exerciseMinutes: values["exerciseMinutes"],
                standMinutes: values["standMinutes"],
                restingHeartRate: values["restingHeartRate"],
                sleepMinutes: values["sleepMinutes"],
                asleepMinutes: values["asleepMinutes"],
                sources: sources
            )
        }

        var body: [HealthSyncBody] = []
        for (identifier, metric, unit) in bodyMetrics {
            try Task.checkCancellation()
            guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { continue }
            let samples = try await query(type: type, predicate: predicate).compactMap { $0 as? HKQuantitySample }
            sampleCount += samples.count
            for sample in samples {
                var value = sample.quantity.doubleValue(for: unit)
                if metric == "bodyFatPercent", value <= 1 { value *= 100 }
                guard value.isFinite else { continue }
                body.append(.init(
                    id: sample.uuid.uuidString.lowercased(),
                    date: dayString(sample.startDate),
                    metric: metric,
                    value: rounded(value),
                    source: sample.sourceRevision.source.name
                ))
            }
        }

        try Task.checkCancellation()
        let workoutSamples = try await query(type: HKObjectType.workoutType(), predicate: predicate).compactMap { $0 as? HKWorkout }
        sampleCount += workoutSamples.count
        let activeEnergyType = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!
        let workouts = workoutSamples.compactMap { workout -> HealthSyncWorkout? in
            guard let type = workoutName(workout.workoutActivityType) else { return nil }
            let energy = workout.statistics(for: activeEnergyType)?.sumQuantity()?.doubleValue(for: .kilocalorie())
            return .init(
                id: workout.uuid.uuidString.lowercased(),
                day: dayString(workout.startDate),
                date: isoString(workout.startDate),
                end: isoString(workout.endDate),
                type: type,
                durationMinutes: rounded(workout.duration / 60),
                energyKcal: energy.map(rounded),
                source: workout.sourceRevision.source.name
            )
        }

        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        let finishedAt = Date()
        return HealthSyncPayload(
            schemaVersion: 1,
            batchId: UUID().uuidString.lowercased(),
            deviceId: deviceID.lowercased(),
            generatedAt: isoString(now),
            windowStart: dayString(start),
            windowEnd: dayString(today),
            completeThrough: dayString(yesterday),
            timeZone: "Asia/Tokyo",
            sampleCount: sampleCount,
            run: HealthSyncRunAudit(
                runId: runID.uuidString.lowercased(),
                trigger: trigger,
                startedAt: isoString(startedAt),
                finishedAt: isoString(finishedAt)
            ),
            daily: daily,
            body: body.sorted { ($0.date, $0.metric, $0.id) < ($1.date, $1.metric, $1.id) },
            workouts: workouts.sorted { $0.date > $1.date }
        )
    }

    private func query(type: HKSampleType, predicate: NSPredicate) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: samples ?? []) }
            }
            store.execute(query)
        }
    }

    private func dayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = tokyo
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func preferredSource(_ sources: [String]) -> String? {
        sources.max { lhs, rhs in
            let left = sourceRank(lhs), right = sourceRank(rhs)
            return left == right ? lhs.localizedCompare(rhs) == .orderedAscending : left < right
        }
    }

    private func sourceRank(_ source: String) -> Int {
        if source.localizedCaseInsensitiveContains("Apple Watch") { return 3 }
        if source.localizedCaseInsensitiveContains("iPhone") { return 2 }
        return 1
    }

    private func isAsleep(_ value: Int) -> Bool {
        [
            HKCategoryValueSleepAnalysis.asleep.rawValue,
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue,
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
        ].contains(value)
    }

    private func unionDuration(_ intervals: [DateInterval]) -> TimeInterval {
        let sorted = intervals.sorted { $0.start < $1.start }
        guard var current = sorted.first else { return 0 }
        var total: TimeInterval = 0
        for interval in sorted.dropFirst() {
            if interval.start <= current.end {
                current = DateInterval(start: current.start, end: max(current.end, interval.end))
            } else {
                total += current.duration
                current = interval
            }
        }
        return total + current.duration
    }

    private func rounded(_ value: Double) -> Double { (value * 10).rounded() / 10 }

    private func workoutName(_ type: HKWorkoutActivityType) -> String? {
        switch type {
        case .walking: return "步行"
        case .running: return "跑步"
        case .cycling: return "骑行"
        case .hiking: return "徒步"
        case .traditionalStrengthTraining: return "传统力量训练"
        case .functionalStrengthTraining: return "功能性力量训练"
        case .coreTraining: return "核心训练"
        case .yoga: return "瑜伽"
        case .cooldown: return "整理放松"
        case .swimming: return "游泳"
        case .other: return "其他训练"
        default: return nil
        }
    }
}
