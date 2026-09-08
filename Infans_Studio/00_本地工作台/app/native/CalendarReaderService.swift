import AppKit
import Darwin
import EventKit
import Foundation

// EventKit and its permission belong to the stable signed app, never to node/osascript.
// The private Unix socket accepts read-only date windows; it has no mutation operation.
final class CalendarReaderService {
    private let store = EKEventStore()
    private let queue = DispatchQueue(label: "com.ifans.secretary.calendar", qos: .userInitiated)
    private let cacheURL: URL
    private var listener: Int32 = -1
    private var observer: NSObjectProtocol?
    private var revision = UUID().uuidString
    private var changeWork: DispatchWorkItem?
    private var lastPermission = "unknown"
    private var permissionRequested = false

    private var socketPath: String { cacheURL.appendingPathComponent("calendar-eventkit.sock").path }
    private var statusURL: URL { cacheURL.appendingPathComponent("calendar-eventkit-status.json") }

    init(cacheDirectory: URL? = nil) {
        if let cacheDirectory {
            cacheURL = cacheDirectory
        } else if let env = ProcessInfo.processInfo.environment["INFANS_CALENDAR_CACHE_DIR"], !env.isEmpty {
            cacheURL = URL(fileURLWithPath: env, isDirectory: true)
        } else {
            cacheURL = FileManager.default.temporaryDirectory.appendingPathComponent("infans-calendar-unconfigured", isDirectory: true)
        }
    }

    func start() {
        let osEnabled = ProcessInfo.processInfo.environment["INFANS_CALENDAR_OS"] == "1"
        let configured = ProcessInfo.processInfo.environment["INFANS_CALENDAR_CACHE_DIR"]?.isEmpty == false
        guard osEnabled, configured else { return }
        do {
            try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cacheURL.path)
            listener = socket(AF_UNIX, SOCK_STREAM, 0)
            guard listener >= 0 else { throw POSIXError(.EIO) }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let bytes = socketPath.utf8CString
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
            withUnsafeMutableBytes(of: &address.sun_path) { buffer in
                for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
            }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            // Never unlink a live owner's endpoint (e.g. an accidental second app instance).
            let probe = socket(AF_UNIX, SOCK_STREAM, 0)
            let live = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
                }
            }
            close(probe)
            guard !live else { close(listener); listener = -1; return }
            unlink(socketPath)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard bound == 0, chmod(socketPath, 0o600) == 0, listen(listener, 16) == 0 else { throw POSIXError(.EIO) }
            let fd = listener
            DispatchQueue(label: "com.ifans.secretary.calendar.socket").async { [weak self] in
                while true {
                    let client = accept(fd, nil, nil)
                    if client < 0 { break }
                    self?.handle(client)
                }
            }
            observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { [weak self] _ in
                self?.queue.async { self?.scheduleChange() }
            }
            queue.async { self.publishStatus() }
            requestPermissionIfNeeded()
        } catch {
            if listener >= 0 { close(listener); listener = -1 }
            NSLog("calendar: native reader could not start")
        }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        if listener >= 0 { shutdown(listener, SHUT_RDWR); close(listener); listener = -1; unlink(socketPath) }
    }

    func requestPermissionIfNeeded() {
        guard ProcessInfo.processInfo.environment["INFANS_CALENDAR_OS"] == "1",
              ProcessInfo.processInfo.environment["INFANS_CALENDAR_CACHE_DIR"]?.isEmpty == false else { return }
        let status = EKEventStore.authorizationStatus(for: .event)
        let needsRequest: Bool
        if #available(macOS 14.0, *) { needsRequest = status == .notDetermined || status == .writeOnly }
        else { needsRequest = status == .notDetermined }
        guard needsRequest, !permissionRequested else {
            queue.async {
                if self.permission() != self.lastPermission { self.revision = UUID().uuidString; self.publishStatus() }
            }
            return
        }
        permissionRequested = true
        let completion: (Bool, Error?) -> Void = { [weak self] _, _ in
            guard let self else { return }
            self.queue.async {
                self.store.reset()
                self.revision = UUID().uuidString
                self.publishStatus()
            }
        }
        if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: completion) }
        else { store.requestAccess(to: .event, completion: completion) }
    }

    private func permission() -> String {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) {
            if status == .fullAccess { return "granted" }
        } else if status == .authorized { return "granted" }
        return status == .denied || status == .restricted ? "denied" : "unknown"
    }

    private func publishStatus() {
        lastPermission = permission()
        let status: [String: Any] = ["schemaVersion": 1, "backend": "eventkit", "revision": revision,
            "permission": lastPermission, "changedAt": ISO8601DateFormatter().string(from: Date())]
        do {
            let data = try JSONSerialization.data(withJSONObject: status)
            try data.write(to: statusURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statusURL.path)
        } catch { NSLog("calendar: could not publish change status") }
    }

    private func scheduleChange() {
        changeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.revision = UUID().uuidString
            self.publishStatus()
        }
        changeWork = work
        queue.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func handle(_ client: Int32) {
        // I/O stays off the UI and EventKit queues. Limit stalled/malformed local clients.
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var noSignal: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while data.count <= 4096 {
            let count = read(client, &buffer, buffer.count)
            if count <= 0 { close(client); return }
            data.append(contentsOf: buffer.prefix(count))
            if data.contains(10) { break }
        }
        guard data.count <= 4096, let line = data.split(separator: 10).first,
              let request = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else {
            close(client); return
        }
        queue.async {
            let result = self.readEvents(request)
            let output = ((try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)) + Data([10])
            output.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let sent = write(client, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if sent <= 0 { break }
                    offset += sent
                }
            }
            close(client)
        }
    }

    private func readEvents(_ request: [String: Any]) -> [String: Any] {
        let access = permission()
        var result: [String: Any] = ["available": false, "permission": access, "backend": "eventkit",
            "revision": revision, "calendars": [String](), "events": [[String: Any]]()]
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func date(_ value: Any?) -> Date? {
            guard let text = value as? String else { return nil }
            return iso.date(from: text) ?? ISO8601DateFormatter().date(from: text)
        }
        guard request["operation"] as? String == "events", let from = date(request["from"]),
              let to = date(request["to"]), to > from, to.timeIntervalSince(from) <= 366 * 86400 else {
            result["message"] = "日历读取日期范围无效。"; return result
        }
        guard access == "granted" else {
            result["message"] = access == "denied"
                ? "请在系统设置的日历权限中允许小秘书读取日程。" : "请在 Mac 小秘书中完成日历读取授权。"
            return result
        }
        let calendars = store.calendars(for: .event).filter {
            $0.type != .birthday && $0.title.range(of: "生日|Birthdays", options: [.regularExpression, .caseInsensitive]) == nil
                && ($0.allowsContentModifications || isHoliday($0.title))
        }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
        let events = calendars.isEmpty ? [] : store.events(matching: predicate).filter { $0.startDate < to && $0.endDate > from }
        result["available"] = true
        result["calendars"] = calendars.filter { $0.allowsContentModifications && !isHoliday($0.title) }.map(\.title)
        result["events"] = events.sorted { $0.startDate < $1.startDate }.map { event -> [String: Any] in
            let holiday = isHoliday(event.calendar.title)
            let recurring = event.hasRecurrenceRules
            let externalID = event.calendarItemExternalIdentifier
            return ["id": externalID ?? "eventkit:\(event.eventIdentifier ?? event.calendarItemIdentifier)",
                "calendar": event.calendar.title, "title": event.title ?? "未命名日程",
                "start": iso.string(from: event.startDate), "end": iso.string(from: event.endDate),
                "allDay": event.isAllDay, "recurring": recurring, "holiday": holiday,
                "editable": !holiday && !recurring && externalID != nil && event.calendar.allowsContentModifications]
        }
        return result
    }

    private func isHoliday(_ title: String) -> Bool {
        title.range(of: "节假日|Holidays|祝日", options: [.regularExpression, .caseInsensitive]) != nil
    }
}
