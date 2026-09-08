import Foundation
import Testing
@testable import HealthSyncScheduleCore

private func orderingReply(_ id: String, _ createdAt: String, text: String = "回复") -> SecretaryReply {
    SecretaryReply(id: id, conversationKey: "watch:test", commandId: "command-\(id)",
                   speaker: "yinyue", speakerName: nil, presentation: nil,
                   text: text, createdAt: createdAt, confirmation: nil)
}

@Test func lateReplyDoesNotReplaceNewerHomeCardAndBothRemainStored() throws {
    let newer = orderingReply("new", "2026-09-03T16:02:46.582Z")
    let older = orderingReply("old", "2026-09-03T14:05:24.133Z")
    let rows = SecretaryReplyOrderingPolicy.retaining(older, in: [newer])
    #expect(rows.map(\.id) == ["old", "new"])
    let restored = try JSONDecoder().decode([SecretaryReply].self, from: JSONEncoder().encode(rows.reversed().map { $0 }))
    #expect(SecretaryReplyOrderingPolicy.ordered(restored).last?.id == "new")
    #expect(SecretaryReplyOrderingPolicy.retaining(older, in: rows).count == 2)
}

@Test func replyOrderingParsesFractionsTimezoneAndCrossMidnight() {
    let rows = [orderingReply("second", "2026-09-04T00:00:00.100+09:00"),
                orderingReply("first", "2026-09-03T14:59:59Z"),
                orderingReply("third", "2026-09-03T15:00:00.200Z")]
    #expect(SecretaryReplyOrderingPolicy.ordered(rows).map(\.id) == ["first", "second", "third"])
}

@Test func malformedLateReplyCannotDisplaceDatedReplyAndEqualDatesAreStable() {
    let current = orderingReply("current", "2026-09-03T15:00:00Z")
    #expect(SecretaryReplyOrderingPolicy.retaining(orderingReply("bad", "invalid"), in: [current]).last == current)
    #expect(SecretaryReplyOrderingPolicy.retaining(orderingReply("first", "invalid"), in: []).count == 1)
    let ties = [orderingReply("b", current.createdAt), orderingReply("a", current.createdAt)]
    #expect(SecretaryReplyOrderingPolicy.ordered(ties).map(\.id) == ["a", "b"])
    #expect(SecretaryReplyOrderingPolicy.ordered(ties.reversed()).map(\.id) == ["a", "b"])
}

@Test func replyHistoryKeepsNewestFortyAndDoesNotRegressSameID() {
    let rows = (0..<45).map { orderingReply(String(format: "%02d", $0), "2026-09-03T15:00:00Z") }
    let retained = SecretaryReplyOrderingPolicy.retaining(orderingReply("old", "2026-09-02T15:00:00Z"), in: rows)
    #expect(retained.count == 40)
    #expect(retained.first?.id == "05")
    #expect(retained.last?.id == "44")
    let current = orderingReply("one", "2026-09-03T15:00:01Z", text: "新的")
    #expect(SecretaryReplyOrderingPolicy.retaining(orderingReply("one", "2026-09-03T15:00:00Z"), in: [current]).last == current)
    let updated = orderingReply("one", current.createdAt, text: "确认后的内容")
    #expect(SecretaryReplyOrderingPolicy.retaining(updated, in: [current]) == [updated])
}

@Test func inboxIntakeKeepsStableIDAndOnlyTrustsMacPersistedReceipt() {
    let item = YingningIntakeItem(
        id: "72742e43-35ed-4c3e-8e65-753ce8dc7f42",
        url: "https://example.com/article",
        title: "值得回来看的文章",
        text: "分享文字",
        note: "晚上看",
        source: .iOSShareExtension,
        sourceApp: "Safari",
        deviceID: "capoo-iphone",
        deviceName: "iPhone",
        createdAt: Date(timeIntervalSince1970: 0)
    )
    #expect(item.isValid)
    #expect(item.request.intakeId == item.id)
    #expect(item.request.source == "ios_share_extension")

    let persisted = YingningIntakeReceipt(
        ok: true,
        duplicate: false,
        intakeId: item.id,
        canonicalItemId: item.id,
        status: "delivered",
        deliveredAt: "2026-09-02T03:00:04Z",
        deliveryBoundary: "mac_persisted"
    )
    let acceptedOnly = YingningIntakeReceipt(
        ok: true,
        duplicate: false,
        intakeId: item.id,
        canonicalItemId: item.id,
        status: "delivered",
        deliveredAt: "2026-09-02T03:00:04Z",
        deliveryBoundary: "http_accepted"
    )
    #expect(persisted.confirmsMacPersistence(for: item))
    #expect(!acceptedOnly.confirmsMacPersistence(for: item))
    let mailboxPersisted = YingningIntakeReceipt(
        ok: true, duplicate: false, intakeId: item.id, canonicalItemId: item.id,
        status: "delivered", deliveredAt: "2026-09-02T03:00:04Z", deliveryBoundary: "mailbox_persisted"
    )
    #expect(mailboxPersisted.confirmsDurablePersistence(for: item))
    #expect(!mailboxPersisted.confirmsMacPersistence(for: item))
}

@Test func inboxIntakeRequiresContentAndSupportsOriginalPhotoContract() {
    let empty = YingningIntakeItem(source: .iPadOSShareExtension, deviceID: "capoo-ipad", deviceName: "iPad")
    #expect(!empty.isValid)
    let data = Data("original-photo".utf8)
    let payload = YingningIntakeAttachmentPayload(fileName: "IMG_0001.heic", contentType: "image/heic", data: data, pixelWidth: 4032, pixelHeight: 3024)
    let photo = YingningIntakeItem(
        source: .iPadOSQuickPhoto,
        sourceSemantic: .quickPhotoInbox,
        deviceID: "capoo-ipad",
        deviceName: "iPad",
        attachments: [payload.attachment]
    )
    #expect(photo.isValid)
    #expect(photo.request(attachmentData: [payload.attachment.id: data]).schemaVersion == 2)
    #expect(photo.request(attachmentData: [payload.attachment.id: data]).attachments.first?.data == data)
}

@Test func inboxIntakeLegacyQueueDecodesWithoutAttachmentFields() throws {
    let legacy = Data(#"{"intakeId":"72742e43-35ed-4c3e-8e65-753ce8dc7f42","url":"","title":"","text":"legacy","note":"","source":"ios_share_extension","sourceApp":"","deviceId":"capoo-iphone","deviceName":"iPhone","createdAt":"2026-09-02T03:00:00Z","state":"pending","retryCount":0}"#.utf8)
    let decoded = try JSONDecoder().decode(YingningIntakeItem.self, from: legacy)
    #expect(decoded.attachments.isEmpty)
    #expect(decoded.sourceSemantic == .sharedContent)
    #expect(decoded.isValid)
}

@Test func inboxIntakeQueueRetainsSameIDAcrossFailureStateAndRemovesOnlyAfterReceipt() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("inbox-intake-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingYingningIntakeStore(directoryURL: directory)
    let id = "72742e43-35ed-4c3e-8e65-753ce8dc7f42"
    let item = YingningIntakeItem(
        id: id,
        text: "保留同一个 ID",
        source: .iOSShareExtension,
        deviceID: "capoo-iphone",
        deviceName: "iPhone"
    )
    #expect(try await store.enqueue(item))
    #expect(!(try await store.enqueue(item)))
    try await store.mark(id, state: .failedRetryPending, error: "离线")
    let retained = try #require(await store.item(id: id))
    #expect(retained.id == id)
    #expect(retained.retryCount == 1)
    #expect(retained.state == .failedRetryPending)
    try await store.remove(id)
    #expect(await store.pending().isEmpty)
}

@Test func yinyuePhotoQueuePersistsOriginalBytesAndRemovesThemOnlyAfterReceipt() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("yinyue-photo-intake-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingYingningIntakeStore(directoryURL: directory)
    let data = Data("byte-for-byte-original".utf8)
    let payload = YingningIntakeAttachmentPayload(fileName: "IMG_0002.heic", contentType: "image/heic", data: data)
    let item = YingningIntakeItem(
        id: "8d55b9db-1dd3-4d75-a644-2fe8951cd1a6",
        source: .iOSQuickPhoto,
        sourceSemantic: .quickPhotoInbox,
        deviceID: "capoo-iphone",
        deviceName: "iPhone",
        attachments: [payload.attachment]
    )
    #expect(try await store.enqueue(item, attachmentPayloads: [payload]))
    #expect(try await store.attachmentData(for: item)[payload.attachment.id] == data)
    try await store.mark(item.id, state: .failedRetryPending, error: "offline")
    #expect(try await store.attachmentData(for: item)[payload.attachment.id] == data)
    try await store.remove(item.id)
    #expect(await store.item(id: item.id) == nil)
    await #expect(throws: (any Error).self) { try await store.attachmentData(for: item) }
}

@Test func deliveredQuickPhotoLeavesPendingQueueButRemainsAvailableForReviewAndNotes() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("yinyue-photo-history-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingYingningIntakeStore(directoryURL: directory)
    let data = Data("reviewable-original".utf8)
    let payload = YingningIntakeAttachmentPayload(fileName: "IMG_0003.heic", contentType: "image/heic", data: data)
    let item = YingningIntakeItem(
        source: .iOSQuickPhoto,
        sourceSemantic: .quickPhotoInbox,
        deviceID: "capoo-iphone",
        deviceName: "iPhone",
        attachments: [payload.attachment]
    )
    #expect(try await store.enqueue(item, attachmentPayloads: [payload]))
    try await store.mark(item.id, state: .delivered)
    #expect(await store.pending().isEmpty)
    #expect(await store.recent().map(\.id) == [item.id])
    #expect(try await store.attachmentData(for: item)[payload.attachment.id] == data)
    try await store.updateNote(item.id, note: "事后补的备注")
    #expect(await store.item(id: item.id)?.localNote == "事后补的备注")
    #expect(await store.item(id: item.id)?.note == item.note)
}

@Test func commandNormalizesAndValidatesNaturalLanguage() {
    let command = CodexCommand(
        id: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        text: "  继续刚才那个任务  ",
        createdAt: Date(timeIntervalSince1970: 0),
        source: .watchApp,
        deviceID: "watch-01",
        route: .auto
    )
    #expect(command.text == "继续刚才那个任务")
    #expect(command.isValid)
    #expect(command.connectivityPayload["heartRate"] == nil)
    #expect(command.connectivityPayload["location"] == nil)
    #expect(command.connectivityPayload["route"] as? String == "auto")
    #expect(command.connectivityPayload["conversationKey"] as? String == "watch-default")
}

@Test func commandCorrectsSecretaryNameWithoutChangingOrdinaryShadowText() {
    let exactName = CodexCommand(text: "阴影", source: .watchApp, deviceID: "watch-01")
    let fullName = CodexCommand(text: "阴影小秘书，帮我看看", source: .watchApp, deviceID: "watch-01")
    let directAddress = CodexCommand(text: "英玲我跟你说话", source: .watchApp, deviceID: "watch-01")
    let anotherStandalone = CodexCommand(text: "迎您", source: .watchApp, deviceID: "watch-01")
    let fallbackName = CodexCommand(text: "伊米小秘书，帮我看看", source: .watchApp, deviceID: "watch-01")
    let dictationTypo = CodexCommand(text: "小秘书门帮我看看", source: .watchApp, deviceID: "watch-01")
    let ordinaryText = CodexCommand(text: "墙上的阴影很好看", source: .watchApp, deviceID: "watch-01")

    #expect(exactName.text == "银月")
    #expect(fullName.text == "银月，帮我看看")
    #expect(directAddress.text == "银月我跟你说话")
    #expect(anotherStandalone.text == "银月")
    #expect(fallbackName.text == "银月，帮我看看")
    #expect(dictationTypo.text == "银月能帮我看看")
    #expect(ordinaryText.text == "墙上的阴影很好看")
}

@Test func watchConversationUsesOneTokyoDayAndExtendsAcrossMidnightForThirtyMinutes() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    let start = calendar.date(from: DateComponents(year: 2026, month: 8, day: 28, hour: 23, minute: 50))!
    let sameDayLater = calendar.date(from: DateComponents(year: 2026, month: 8, day: 28, hour: 12, minute: 0))!
    let afterMidnight = calendar.date(from: DateComponents(year: 2026, month: 8, day: 29, hour: 0, minute: 10))!
    let extendedAgain = calendar.date(from: DateComponents(year: 2026, month: 8, day: 29, hour: 0, minute: 35))!
    let afterIdle = calendar.date(from: DateComponents(year: 2026, month: 8, day: 29, hour: 1, minute: 6))!

    let midday = WatchConversationWindowPolicy.updated(previous: nil, at: sameDayLater, calendar: calendar)
    let late = WatchConversationWindowPolicy.updated(previous: midday, at: start, calendar: calendar)
    let acrossMidnight = WatchConversationWindowPolicy.updated(previous: late, at: afterMidnight, calendar: calendar)
    let rollingExtension = WatchConversationWindowPolicy.updated(previous: acrossMidnight, at: extendedAgain, calendar: calendar)
    let newWindow = WatchConversationWindowPolicy.updated(previous: rollingExtension, at: afterIdle, calendar: calendar)

    #expect(midday.key == "watch-2026-08-28")
    #expect(late.key == midday.key)
    #expect(acrossMidnight.key == midday.key)
    #expect(rollingExtension.key == midday.key)
    #expect(newWindow.key == "watch-2026-08-29")
}

@Test func connectivityPayloadRoundTripsAndRejectsUnknownSources() {
    let command = CodexCommand(
        id: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        text: "安排一下某件事",
        source: .siri,
        deviceID: "watch-01"
    )
    let decoded = CodexCommand.fromConnectivityPayload(command.connectivityPayload)
    #expect(decoded?.id == command.id)
    #expect(decoded?.text == command.text)
    #expect(decoded?.conversationKey == "watch-default")
    var invalid = command.connectivityPayload
    invalid["source"] = "healthkit"
    #expect(CodexCommand.fromConnectivityPayload(invalid) == nil)
}

@Test func watchRetriesUnfinishedCommandsButWaitsForRouteChoice() {
    let base = CodexCommand(
        id: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        text: "银月在吗",
        source: .watchApp,
        deviceID: "watch-01"
    )
    let rows = [
        base,
        CodexCommand(id: "98cfe608-17e8-4d0d-a4ad-21ab20955aa2", text: "等待手机", source: .watchApp, deviceID: "watch-01", state: .phoneReceived),
        CodexCommand(id: "a8cfe608-17e8-4d0d-a4ad-21ab20955aa3", text: "需要选择", source: .watchApp, deviceID: "watch-01", state: .needsChoice),
        CodexCommand(id: "b8cfe608-17e8-4d0d-a4ad-21ab20955aa4", text: "已经收到", source: .watchApp, deviceID: "watch-01", state: .delivered),
    ]

    let retryIDs = WatchPendingCommandRetryPolicy.commandsToRetry(rows).map(\.id)
    #expect(retryIDs == [base.id, "98cfe608-17e8-4d0d-a4ad-21ab20955aa2"])
}

@Test func secretaryReplyDecodesFromPhoneConnectivityPayload() {
    let payload: [String: Any] = [
        "commandId": "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        "replyId": "watch-a-88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        "replyText": "我看到啦，前辈。",
        "replySpeaker": "yinyue",
        "replyCreatedAt": "2026-08-28T03:00:00Z",
        "conversationKey": "watch-default",
        "confirmationId": "7a89c0e2-4902-4982-bd14-a7c622d772d3",
        "confirmationKind": "addTodo",
        "confirmationLabel": "新增今天/本周待办",
        "confirmationSummary": "今天/本周待办：明天下午三点喝水",
        "confirmationState": "pending",
    ]
    let reply = SecretaryReply.fromConnectivityPayload(payload)
    #expect(reply?.commandId == payload["commandId"] as? String)
    #expect(reply?.speaker == "yinyue")
    #expect(reply?.speakerName == nil)
    #expect(reply?.resolvedSpeakerName == "银月")
    #expect(reply?.text == "我看到啦，前辈。")
    #expect(reply?.confirmation?.kind == "addTodo")
    #expect(reply?.confirmation?.state == .pending)
}

@Test func secretaryReplyUsesExplicitNameAndMeiningFallback() throws {
    let explicitPayload: [String: Any] = [
        "replyId": "reply-explicit",
        "commandId": "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        "replySpeaker": "yinyue",
        "replySpeakerName": "银月",
        "replyText": "我在。",
    ]
    let explicit = try #require(SecretaryReply.fromConnectivityPayload(explicitPayload))
    #expect(explicit.speakerName == "银月")
    #expect(explicit.resolvedSpeakerName == "银月")

    let legacyPayload: [String: Any] = [
        "replyId": "reply-meining",
        "commandId": "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        "replySpeaker": "meining",
        "replyText": "我也在。",
    ]
    let legacy = try #require(SecretaryReply.fromConnectivityPayload(legacyPayload))
    #expect(legacy.speakerName == nil)
    #expect(legacy.resolvedSpeakerName == "梅凝")
}

@Test func secretaryReplyNotificationPolicyKeepsForegroundTactileAndDeduplicatesReplyIDs() throws {
    let payload: [String: Any] = [
        "replyId": "reply-notification-1",
        "commandId": "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        "replySpeaker": "yinyue",
        "replyText": "后台收到我。",
    ]
    let reply = try #require(SecretaryReply.fromConnectivityPayload(payload))

    #expect(
        SecretaryReplyNotificationPolicy.decide(
            reply: reply,
            handledReplyIDs: [],
            applicationState: .active
        ) == .tactile
    )
    #expect(
        SecretaryReplyNotificationPolicy.decide(
            reply: reply,
            handledReplyIDs: [],
            applicationState: .background
        ) == .banner(title: "银月", body: "后台收到我。", playsSound: true)
    )
    #expect(
        SecretaryReplyNotificationPolicy.decide(
            reply: reply,
            handledReplyIDs: [reply.id],
            applicationState: .background
        ) == .duplicate
    )
}

@Test func ambientProactiveInteractionIsQuietInForegroundAndSilentInBackground() throws {
    let payload: [String: Any] = [
        "replyId": "interaction-1",
        "commandId": "interaction-1",
        "replySpeaker": "yinyue",
        "replyText": "银月来贴一下。",
        "replyPresentation": "ambient",
    ]
    let reply = try #require(SecretaryReply.fromConnectivityPayload(payload))
    #expect(reply.presentation == "ambient")
    #expect(SecretaryReplyNotificationPolicy.decide(reply: reply, handledReplyIDs: [], applicationState: .active) == .quiet)
    #expect(
        SecretaryReplyNotificationPolicy.decide(reply: reply, handledReplyIDs: [], applicationState: .background)
            == .banner(title: "银月", body: "银月来贴一下。", playsSound: false)
    )
}

@Test func proactiveInteractionEnvelopeBuildsStableWatchReplyPayload() throws {
    let json = """
    {
      "interactionId": "interaction-abc",
      "roleId": "meining",
      "roleName": "梅凝",
      "kind": "ritual",
      "text": "哥哥，我来值班了。",
      "plannedAt": "2026-08-30T01:30:00.000Z",
      "conversationKey": "proactive-meining-2026-08-30",
      "delivery": "ambient"
    }
    """
    let interaction = try JSONDecoder().decode(ProactiveInteractionEnvelope.self, from: Data(json.utf8))
    let reply = try #require(SecretaryReply.fromConnectivityPayload(interaction.watchPayload))
    #expect(reply.id == interaction.interactionId)
    #expect(reply.resolvedSpeakerName == "梅凝")
    #expect(reply.conversationKey == interaction.conversationKey)
    #expect(reply.presentation == "ambient")
}

@Test func secretaryReplyDecodesNestedConfirmationFromMacResponse() throws {
    let json = """
    {
      "id": "watch-a-88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
      "conversationKey": "watch-default",
      "commandId": "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
      "speaker": "yinyue",
      "speakerName": "银月",
      "text": "确认后我再记。",
      "createdAt": "2026-08-28T03:00:00Z",
      "confirmation": {
        "id": "7a89c0e2-4902-4982-bd14-a7c622d772d3",
        "kind": "calendarCreate",
        "label": "新增日程",
        "summary": "日程：喝水\\n日历：生活",
        "state": "completed",
        "result": "已写入苹果日历：喝水"
      }
    }
    """
    let reply = try JSONDecoder().decode(SecretaryReply.self, from: Data(json.utf8))
    #expect(reply.speakerName == "银月")
    #expect(reply.confirmation?.state == .completed)
    #expect(reply.confirmation?.result == "已写入苹果日历：喝水")
}

@Test func confirmationDecisionRoundTripsThroughWatchConnectivity() {
    let decision = SecretaryConfirmationDecision(
        commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        confirmationId: "7a89c0e2-4902-4982-bd14-a7c622d772d3",
        deviceID: "watch-01",
        decision: .confirm
    )
    let decoded = SecretaryConfirmationDecision.fromConnectivityPayload(decision.connectivityPayload)
    #expect(decoded == decision)
}

@Test func watchDeliveryAcknowledgementRoundTripsWithStableCommandAndReplyIDs() throws {
    let acknowledgement = SecretaryDeliveryAcknowledgement(
        commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        replyId: "watch-a-88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        deviceID: "watch-01",
        stage: .watchReplyPersisted,
        at: Date(timeIntervalSince1970: 1_788_142_400)
    )
    let decoded = try #require(SecretaryDeliveryAcknowledgement.fromConnectivityPayload(acknowledgement.connectivityPayload))
    #expect(decoded.commandId == acknowledgement.commandId)
    #expect(decoded.replyId == acknowledgement.replyId)
    #expect(decoded.deviceID == acknowledgement.deviceID)
    #expect(decoded.stage == .watchReplyPersisted)
}

@Test func phoneQueuePersistsDeduplicatesRetriesAndRemovesDeliveredRows() async throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("infans-command-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = PendingCodexCommandStore(fileURL: root.appendingPathComponent("pending.json"))
    let command = CodexCommand(
        id: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
        text: "继续刚才那个任务",
        source: .watchApp,
        deviceID: "watch-01"
    )

    #expect(try await store.enqueue(command))
    #expect(try await !store.enqueue(command))
    try await store.mark(command.id, state: .retryPending, error: "Mac 离线")
    var rows = await store.pending()
    #expect(rows.count == 1)
    #expect(rows[0].state == .retryPending)
    #expect(rows[0].retryCount == 1)
    #expect(rows[0].lastError == "Mac 离线")

    try await store.remove(command.id)
    rows = await store.pending()
    #expect(rows.isEmpty)
}
