import Foundation
import Testing
@testable import HealthSyncScheduleCore

private func custodyReceipt(_ item: YingningIntakeItem, boundary: String) -> YingningIntakeReceipt {
    YingningIntakeReceipt(ok: true, duplicate: true, intakeId: item.id, canonicalItemId: item.id,
                         status: "delivered", deliveredAt: "2026-09-05T03:00:00Z", deliveryBoundary: boundary)
}

@Test func relayCustodyRetainsOriginalBeyondCacheAgeAndCountUntilFinalMacReceipt() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("intake-custody-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixedNow = Date(timeIntervalSince1970: 1_788_577_200)
    let store = PendingYingningIntakeStore(directoryURL: directory, now: { fixedNow })
    let data = Data("original awaiting final receipt".utf8)
    let payload = YingningIntakeAttachmentPayload(fileName: "photo.heic", contentType: "image/heic", data: data)
    let original = YingningIntakeItem(note: "frozen original note", source: .iOSQuickPhoto,
                                    sourceSemantic: .quickPhotoInbox, deviceID: "fixture", deviceName: "Fixture",
                                    createdAt: fixedNow.addingTimeInterval(-40 * 86_400), attachments: [payload.attachment])
    #expect(try await store.enqueue(original, attachmentPayloads: [payload]))
    try await store.recordReceipt(custodyReceipt(original, boundary: "mailbox_persisted"), for: original.id)
    for index in 0..<102 {
        let item = YingningIntakeItem(text: "confirmed \(index)", source: .iOSShareExtension,
                                     deviceID: "fixture", deviceName: "Fixture", createdAt: fixedNow)
        _ = try await store.enqueue(item)
        try await store.recordReceipt(custodyReceipt(item, boundary: "mac_persisted"), for: item.id)
    }
    #expect(await store.pending().map(\.id) == [original.id])
    #expect(await store.item(id: original.id)?.state == .mailboxPersisted)
    #expect(try await store.attachmentData(for: original)[payload.attachment.id] == data)
    try await store.updateNote(original.id, note: "local review note")
    let revised = try #require(await store.item(id: original.id))
    #expect(revised.request.note == "frozen original note")
    #expect(revised.localNote == "local review note")
    try await store.recordReceipt(custodyReceipt(original, boundary: "mac_persisted"), for: original.id)
    #expect(await store.pending().isEmpty)
    let trigger = YingningIntakeItem(text: "trigger cache prune", source: .iOSShareExtension,
                                  deviceID: "fixture", deviceName: "Fixture", createdAt: fixedNow)
    _ = try await store.enqueue(trigger)
    #expect(await store.item(id: original.id) == nil)
}

@Test func legacyDeliveredWithoutBoundaryMustReconcileAndMalformedReceiptCannotDiscardOriginal() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("intake-legacy-custody-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingYingningIntakeStore(directoryURL: directory)
    let item = YingningIntakeItem(text: "legacy", source: .iOSShareExtension, deviceID: "fixture", deviceName: "Fixture")
    _ = try await store.enqueue(item)
    var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
    json["state"] = "delivered"
    json.removeValue(forKey: "deliveryBoundary")
    try JSONSerialization.data(withJSONObject: json).write(to: directory.appendingPathComponent("\(item.id).json"))
    #expect(await store.pending().map(\.id) == [item.id])
    #expect(await store.item(id: item.id)?.state == .mailboxPersisted)
    await #expect(throws: YingningIntakeError.incompleteMacReceipt) {
        try await store.recordReceipt(custodyReceipt(item, boundary: "http_accepted"), for: item.id)
    }
    #expect(await store.pending().count == 1)
    try await store.recordReceipt(custodyReceipt(item, boundary: "mac_persisted"), for: item.id)
    let reloaded = PendingYingningIntakeStore(directoryURL: directory)
    #expect(await reloaded.pending().isEmpty)
}

@Test func editedShareNotesKeepOriginalPayloadAndSurviveRestartWithCorrectSource() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("intake-note-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingYingningIntakeStore(directoryURL: directory)
    let original = YingningIntakeItem(text: "real content fixture", note: "original note", source: .iPadOSQuickPhoto,
                                     sourceSemantic: .quickPhotoInbox, deviceID: "fixture", deviceName: "Fixture")
    _ = try await store.enqueue(original)
    let correction = try #require(try await store.reviseNote(original.id, note: "new note", expectedNote: "original note"))
    #expect(correction.source == .iPadOSShareExtension)
    #expect(correction.request.schemaVersion == 1)
    #expect(correction.relatedIntakeID == original.id)
    #expect(correction.text.contains(original.id))
    let restored = PendingYingningIntakeStore(directoryURL: directory)
    #expect(await restored.item(id: original.id)?.localNote == "new note")
    #expect(await restored.item(id: original.id)?.request == original.request)
    #expect(await restored.pending().count == 2)
    #expect(try await restored.reviseNote(original.id, note: "new note", expectedNote: "new note") == nil)
    await #expect(throws: YingningIntakeError.server("备注已更新，请刷新后再编辑")) {
        try await restored.reviseNote(original.id, note: "stale edit", expectedNote: "original note")
    }
    let cleared = try #require(try await restored.reviseNote(original.id, note: "", expectedNote: "new note"))
    #expect(cleared.isValid)
    #expect(cleared.text.contains("已清空"))
    #expect(await restored.item(id: original.id)?.localNote == "")
    #expect(await restored.item(id: original.id)?.request == original.request)
}
