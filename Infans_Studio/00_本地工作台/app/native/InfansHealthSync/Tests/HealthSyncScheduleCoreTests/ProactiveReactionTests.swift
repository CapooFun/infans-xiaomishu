import Foundation
import Testing
@testable import HealthSyncScheduleCore

@Test func lightReactionSurvivesOfflineRestartAndFirstTapWins() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let outbox = ProactiveReactionOutbox(fileURL: dir.appendingPathComponent("reactions.json"))
    let event = ProactiveReaction(interactionId: "interaction-qa", type: .pat, deviceId: "watch-qa")
    try outbox.enqueue(event)
    let restarted = ProactiveReactionOutbox(fileURL: outbox.fileURL)
    for _ in 0..<20 {
        let returned = try restarted.enqueue(ProactiveReaction(interactionId: event.interactionId, type: .hug, deviceId: "watch-qa"))
        #expect(returned == event)
    }
    #expect(try restarted.all().count == 1)
    #expect(try restarted.all()[0].deliveryStatus == "pending")
    try restarted.acknowledge(event.reactionId)
    #expect(try restarted.all()[0].deliveryStatus == "mac_persisted")
    try restarted.enqueue(event)
    #expect(try restarted.all().count == 1)
    #expect(try restarted.all()[0].deliveryStatus == "mac_persisted")
}

@Test func lightReactionPayloadCannotBecomeCommandOrRecording() throws {
    for type in ProactiveReactionType.allCases {
        let event = ProactiveReaction(interactionId: "interaction-qa", type: type, deviceId: "watch-qa")
        #expect(ProactiveReaction.fromConnectivityPayload(event.connectivityPayload) == event)
        #expect(CodexCommand.fromConnectivityPayload(event.connectivityPayload) == nil)
        #expect(event.reactionId == "reaction-interaction-qa")
    }
    #expect(ProactiveReaction.fromConnectivityPayload(["kind": "proactiveReaction", "text": "生成一句话"]) == nil)
}

@Test func corruptedReactionQueueFailsClosedInsteadOfLosingHistory() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("reactions.json")
    try Data("invalid".utf8).write(to: file)
    let box = ProactiveReactionOutbox(fileURL: file)
    #expect(throws: (any Error).self) { try box.enqueue(ProactiveReaction(interactionId: "interaction-qa", type: .pat, deviceId: "watch")) }
    #expect(try String(contentsOf: file, encoding: .utf8) == "invalid")
}
