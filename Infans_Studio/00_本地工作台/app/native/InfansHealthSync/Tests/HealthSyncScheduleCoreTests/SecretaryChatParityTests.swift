import Foundation
import XCTest
@testable import HealthSyncScheduleCore

final class SecretaryChatParityTests: XCTestCase {
    func testExecutionMetricsKeepUnknownUsageTruthful() {
        var metrics = SecretaryConversationExecutionMetrics()
        metrics.record(SecretaryChatExecutionSummary(
            backend: "openrouter",
            model: "example-model",
            usage: SecretaryChatTurnUsage(totalTokens: 12, cost: 0.001)
        ))
        metrics.record(SecretaryChatExecutionSummary(
            backend: "cursor",
            model: "cursor-grok",
            usage: nil
        ))

        XCTAssertEqual(metrics.latestModel, "cursor-grok")
        XCTAssertEqual(metrics.totalTokens, 12)
        XCTAssertEqual(metrics.reportedCostUSD, 0.001, accuracy: 0.000_001)
        XCTAssertEqual(metrics.completedTurns, 2)
        XCTAssertFalse(metrics.tokensComplete)
        XCTAssertFalse(metrics.costComplete)
    }

    func testConversationDecodesReplySpeakersForOneOnOne() throws {
        let data = Data(#"""
        {
          "id":"native_lights_0001","version":"version-0001","type":"direct","title":"会话","privacy":"standard",
          "activeSecretaryId":"yinyue","memberIds":["capoo","yinyue"],"updatedAt":null,"messageCount":0,"messages":[],
          "chatState":{"activeSecretaryId":"yinyue","activeReplySpeakers":["yinyue"],
            "qualityMode":"light","privacy":"standard"}
        }
        """#.utf8)
        let conversation = try JSONDecoder().decode(SecretaryChatConversation.self, from: data)
        XCTAssertEqual(conversation.chatState.activeReplySpeakers, ["yinyue"])
        XCTAssertEqual(conversation.chatState.privacy, "standard")
    }
}
