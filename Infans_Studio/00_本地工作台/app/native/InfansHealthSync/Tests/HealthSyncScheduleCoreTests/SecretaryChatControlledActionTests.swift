import Foundation
import XCTest
@testable import HealthSyncScheduleCore

final class SecretaryChatControlledActionTests: XCTestCase {
    func testKnownCardAndCompletedActionsDecodeWhileUnknownCardFallsBack() throws {
        let known = try JSONDecoder().decode(
            SecretaryChatStreamEvent.self,
            from: Data(#"{"type":"attachment","card":{"actionId":"action_12345678","conversationId":"conversation_1","generationId":"generation_1","assistantMessageId":"assistant_1","order":0,"label":"更新原件","publicPreview":{"kind":"vault_write","targetLabel":"项目原件","targetPath":"30_事业顺利/项目.md","summary":"更新一条已确认状态","before":"旧状态","after":"新状态","expiresAt":"2026-09-03T01:00:00.000Z","requiresConfirm":true},"state":"pending"}}"#.utf8)
        )
        XCTAssertEqual(known.card?.controlledAction?.actionId, "action_12345678")
        XCTAssertEqual(known.card?.controlledAction?.publicPreview.targetPath, "30_事业顺利/项目.md")

        let completed = try JSONDecoder().decode(
            SecretaryChatStreamEvent.self,
            from: Data(#"{"type":"completed","actions":[{"actionId":"action_12345678","conversationId":"conversation_1","generationId":"generation_1","assistantMessageId":"assistant_1","order":0,"label":"更新原件","publicPreview":{"kind":"vault_write","targetLabel":"项目原件","summary":"更新一条状态","before":"旧","after":"新","requiresConfirm":true},"state":"completed","result":{"ok":true,"targetLabel":"项目原件"}}]}"#.utf8)
        )
        XCTAssertEqual(completed.actions?.first?.state, "completed")

        let unknown = try JSONDecoder().decode(
            SecretaryChatStreamEvent.self,
            from: Data(#"{"type":"attachment","card":{"kind":"future_card","fallbackText":"请在 Mac 查看"}}"#.utf8)
        )
        XCTAssertNotNil(unknown.card)
        XCTAssertNil(unknown.card?.controlledAction)
    }

    func testControlledActionFeatureAndProtocolEndpointsAreBackwardCompatible() throws {
        let legacyFeatures = try JSONDecoder().decode(
            SecretaryChatFeatures.self,
            from: Data(#"{"textChat":true,"streamingReplies":true,"reliableRetry":true,"cancellation":true,"conversationList":true,"attachments":true,"voice":true,"notifications":true}"#.utf8)
        )
        XCTAssertNil(legacyFeatures.controlledActions)

        let legacyProtocol = try JSONDecoder().decode(
            SecretaryChatProtocolInfo.self,
            from: Data(#"{"id":"secretary-mobile","version":1,"minimumClientVersion":"1.0","eventTypes":[]}"#.utf8)
        )
        XCTAssertNil(legacyProtocol.endpoints)
    }

    func testListAndDecisionRequestsUseBearerExpectedPathsAndStrictFourFieldBody() async throws {
        let recorder = ControlledActionRequestRecorder()
        ControlledActionURLProtocolStub.handler = { request in
            recorder.append(request)
            if request.httpMethod == "GET" {
                return (200, Data("{\"actions\":[\(Self.actionJSON(state: "pending"))]}".utf8))
            }
            return (200, Data("{\"duplicate\":false,\"stale\":false,\"action\":\(Self.actionJSON(state: "completed"))}".utf8))
        }
        defer { ControlledActionURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ControlledActionURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let connection = SecretaryChatConnection(serverURL: "https://mac.example.test", bearerToken: "private-token")

        let listed = try await client.controlledActions(conversationId: "conversation_1", connection: connection)
        let response = try await client.decideControlledAction(
            actionId: "action_12345678",
            request: .init(
                protocolVersion: 1,
                conversationId: "conversation_1",
                generationId: "generation_1",
                decision: "confirm"
            ),
            connection: connection
        )

        XCTAssertEqual(listed.first?.actionId, "action_12345678")
        XCTAssertEqual(response.action.state, "completed")
        XCTAssertEqual(recorder.requests.count, 2)
        XCTAssertEqual(recorder.requests[0].url?.path, "/api/secretary-mobile/conversations/conversation_1/actions")
        XCTAssertEqual(recorder.requests[0].httpMethod, "GET")
        XCTAssertEqual(recorder.requests[1].url?.path, "/api/secretary-mobile/actions/action_12345678/decision")
        XCTAssertEqual(recorder.requests[1].httpMethod, "POST")
        for request in recorder.requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer private-token")
        }
        let body = try XCTUnwrap(recorder.requests[1].httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["protocolVersion", "conversationId", "generationId", "decision"])
        XCTAssertNil(object["token"])
        XCTAssertNil(object["rawAction"])
        XCTAssertNil(object["path"])
        XCTAssertNil(object["content"])
    }

    func testStaleConflictReturnsRefreshedPreviewAndStillNeedsConfirmation() async throws {
        ControlledActionURLProtocolStub.handler = { _ in
            let action = Self.actionJSON(state: "pending", summary: "Mac 更新后的公开预览")
            return (409, Data("{\"duplicate\":false,\"stale\":true,\"action\":\(action)}".utf8))
        }
        defer { ControlledActionURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ControlledActionURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let response = try await client.decideControlledAction(
            actionId: "action_12345678",
            request: .init(protocolVersion: 1, conversationId: "conversation_1", generationId: "generation_1", decision: "confirm"),
            connection: .init(serverURL: "https://mac.example.test", bearerToken: "private-token")
        )

        XCTAssertTrue(response.stale)
        XCTAssertEqual(response.action.publicPreview.summary, "Mac 更新后的公开预览")
        XCTAssertTrue(response.action.isPending)
    }

    func testQueueBlocksSendSerializesDecisionsAndRetainsTerminalHistory() {
        let second = Self.action(id: "action_second", order: 1, state: "pending")
        let first = Self.action(id: "action_first", order: 0, state: "pending")
        var actions = [second, first]

        XCTAssertEqual(SecretaryChatActionQueue.earliestPending(in: actions, conversationId: "conversation_1")?.actionId, "action_first")
        XCTAssertFalse(SecretaryChatActionQueue.canSend(actions: actions, conversationId: "conversation_1", decidingActionId: nil))
        XCTAssertTrue(SecretaryChatActionQueue.canDecide(actionId: "action_first", actions: actions, conversationId: "conversation_1", decidingActionId: nil))
        XCTAssertFalse(SecretaryChatActionQueue.canDecide(actionId: "action_second", actions: actions, conversationId: "conversation_1", decidingActionId: nil))
        XCTAssertFalse(SecretaryChatActionQueue.canDecide(actionId: "action_first", actions: actions, conversationId: "conversation_1", decidingActionId: "action_first"))

        actions = SecretaryChatActionQueue.upserting(Self.action(id: "action_first", order: 0, state: "completed"), into: actions)
        XCTAssertEqual(SecretaryChatActionQueue.earliestPending(in: actions, conversationId: "conversation_1")?.actionId, "action_second")
        XCTAssertEqual(actions.first(where: { $0.actionId == "action_first" })?.state, "completed")
        actions = SecretaryChatActionQueue.upserting(Self.action(id: "action_second", order: 1, state: "cancelled"), into: actions)
        XCTAssertTrue(SecretaryChatActionQueue.canSend(actions: actions, conversationId: "conversation_1", decidingActionId: nil))
        XCTAssertEqual(actions.map(\.state), ["completed", "cancelled"])

        let failed = Self.action(id: "action_failed", order: 2, state: "failed")
        actions = SecretaryChatActionQueue.upserting(failed, into: actions)
        XCTAssertEqual(actions.last?.state, "failed")
        XCTAssertTrue(SecretaryChatActionQueue.canSend(actions: actions, conversationId: "conversation_1", decidingActionId: nil))
    }

    func testLegacyCacheDefaultsToNoActionsAndAuthoritativeSyncReplacesOnlyOneConversation() throws {
        let legacy = try JSONDecoder().decode(SecretaryChatDeviceCache.self, from: Data("{}".utf8))
        XCTAssertEqual(legacy.controlledActions, [])

        let other = Self.action(id: "action_other", conversationId: "conversation_2", order: 0, state: "completed")
        let stale = Self.action(id: "action_stale", order: 0, state: "pending")
        let refreshed = Self.action(id: "action_refreshed", order: 0, state: "cancelled")
        let reconciled = SecretaryChatActionQueue.replacingConversation(
            in: [stale, other],
            conversationId: "conversation_1",
            with: [refreshed]
        )
        XCTAssertEqual(Set(reconciled.map(\.actionId)), ["action_other", "action_refreshed"])

        var cache = SecretaryChatDeviceCache.empty
        cache.controlledActions = reconciled
        let restored = try JSONDecoder().decode(SecretaryChatDeviceCache.self, from: JSONEncoder().encode(cache))
        XCTAssertEqual(restored.controlledActions, reconciled)
    }

    private static func action(
        id: String,
        conversationId: String = "conversation_1",
        order: Int,
        state: String
    ) -> SecretaryChatControlledAction {
        .init(
            actionId: id,
            conversationId: conversationId,
            generationId: "generation_1",
            assistantMessageId: "assistant_1",
            order: order,
            label: "更新原件",
            publicPreview: .init(
                kind: "vault_write",
                targetLabel: "项目原件",
                targetPath: "30_事业顺利/项目.md",
                summary: "更新一条状态",
                before: "旧",
                after: "新",
                expiresAt: nil,
                requiresConfirm: true
            ),
            state: state,
            result: state == "completed" ? .init(ok: true, targetLabel: "项目原件", cancelled: nil) : nil,
            error: state == "failed" ? .init(code: "write_failed", message: "Mac 写入失败") : nil
        )
    }

    private static func actionJSON(state: String, summary: String = "更新一条状态") -> String {
        #"{"actionId":"action_12345678","conversationId":"conversation_1","generationId":"generation_1","assistantMessageId":"assistant_1","order":0,"label":"更新原件","publicPreview":{"kind":"vault_write","targetLabel":"项目原件","targetPath":"30_事业顺利/项目.md","summary":"\#(summary)","before":"旧","after":"新","requiresConfirm":true},"state":"\#(state)"}"#
    }
}

private final class ControlledActionRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URLRequest] = []

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ request: URLRequest) {
        var captured = request
        if captured.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            captured.httpBody = data
        }
        lock.lock()
        storage.append(captured)
        lock.unlock()
    }
}

private final class ControlledActionURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
