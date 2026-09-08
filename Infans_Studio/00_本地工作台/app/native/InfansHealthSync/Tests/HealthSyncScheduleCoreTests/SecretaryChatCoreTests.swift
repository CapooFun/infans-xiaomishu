import Foundation
import XCTest
@testable import HealthSyncScheduleCore

final class SecretaryChatCoreTests: XCTestCase {
    func testAvatarPresentationIsOptionalAndMatchesCoverTransformGeometry() throws {
        let old = try JSONDecoder().decode(SecretaryChatCharacterAssets.self, from: Data(#"{"avatar":"/theme/old.png","source":"registry"}"#.utf8))
        XCTAssertNil(old.avatarPresentation)
        let current = try JSONDecoder().decode(SecretaryChatCharacterAssets.self, from: Data(#"{"avatar":"/theme/avatar-yinyue-public.svg","source":"registry","avatarPresentation":{"position":"center top","scale":1.7,"origin":"12% 20%"}}"#.utf8))
        let portrait = try XCTUnwrap(current.avatarPresentation).frame(imageWidth: 200, imageHeight: 400, side: 40)
        XCTAssertEqual(portrait.width, 68, accuracy: 0.001)
        XCTAssertEqual(portrait.height, 136, accuracy: 0.001)
        XCTAssertEqual(portrait.x, -3.36, accuracy: 0.001)
        XCTAssertEqual(portrait.y, -5.6, accuracy: 0.001)
        let center = SecretaryAvatarPresentation(position: "center", scale: 1, origin: "center")
            .frame(imageWidth: 400, imageHeight: 200, side: 40)
        XCTAssertEqual(center.x, -20, accuracy: 0.001)
        XCTAssertEqual(center.y, 0, accuracy: 0.001)
    }

    func testMailboxFailureIsTerminalAndKeepsOriginalForCorrection() throws {
        let data = Data(#"{"protocolVersion":1,"conversationId":"native_default","messageId":"msg-failed","generationId":"gen-failed","createdAt":"2026-09-05T00:00:00Z","text":"原始内容","expectedConversationVersion":"v1","attachments":[],"status":"failed","lastError":"attachment_unavailable"}"#.utf8)
        let failed = try JSONDecoder().decode(SecretaryChatMailboxMessage.self, from: data)
        XCTAssertEqual(failed.localDeliveryState, .failedQuarantined)
        XCTAssertEqual(failed.lastError, "attachment_unavailable")
        var original = PendingSecretaryChatTurn.make(conversationId: "native_default", text: failed.text, expectedConversationVersion: "v1")
        original.state = failed.localDeliveryState
        original.lastError = failed.lastError
        XCTAssertFalse(original.needsTransmission)
        let cached = conversation(version: "v2", messages: [.localUserMessage(from: original, sequence: 1)])
        XCTAssertEqual(SecretaryChatRecovery.reconciled(pending: [original], with: cached), [original])
        XCTAssertEqual(SecretaryChatMessage.localUserMessage(from: original, sequence: 1).text, "原始内容")
        let corrected = PendingSecretaryChatTurn.make(conversationId: original.conversationId, text: "修正后的内容", expectedConversationVersion: "v2")
        XCTAssertNotEqual(corrected.messageId, original.messageId)
        XCTAssertTrue(corrected.needsTransmission)
    }

    func testOlderMailboxResponseWithoutFailureFieldsStillDecodes() throws {
        let data = Data(#"{"protocolVersion":1,"conversationId":"native_default","messageId":"msg-old","generationId":"gen-old","createdAt":"2026-09-05T00:00:00Z","text":"旧响应","expectedConversationVersion":"v1","attachments":[]}"#.utf8)
        let message = try JSONDecoder().decode(SecretaryChatMailboxMessage.self, from: data)
        XCTAssertNil(message.status)
        XCTAssertNil(message.lastError)
        XCTAssertEqual(message.localDeliveryState, .macPersisted)
    }

    func testOpenSourceBundledSeatsAreYinyueAndMeining() {
        let seats = SecretaryBundledArt.seats(merging: [])
        XCTAssertEqual(seats.map(\.id), ["yinyue", "meining"])
        XCTAssertEqual(seats.map(\.displayName), ["银月", "梅凝"])
        XCTAssertFalse(seats.contains(where: { $0.id == "yingning" }))
        let remoteExtra = SecretaryChatCharacter(
            id: "remote-extra",
            displayName: "额外席位",
            kind: "secretary",
            secretaryEligible: false,
            fallbackText: "额外席位",
            accent: "jade",
            assets: SecretaryChatCharacterAssets(avatar: "/extra.png", portrait: nil, source: "secretary-profile", mediaMode: nil, manifestPath: nil)
        )
        let remoteMeining = SecretaryChatCharacter(
            id: "meining",
            displayName: "梅凝",
            kind: "secretary",
            secretaryEligible: true,
            fallbackText: "梅凝",
            accent: "plum",
            assets: SecretaryChatCharacterAssets(avatar: "/meining.png", portrait: nil, source: "secretary-profile", mediaMode: nil, manifestPath: nil)
        )
        let merged = SecretaryBundledArt.seats(merging: [remoteExtra, remoteMeining])
        XCTAssertEqual(merged.map(\.id), ["yinyue", "meining"])
        XCTAssertEqual(merged[1].assets.avatar, "/meining.png")
        XCTAssertEqual(SecretaryBundledArt.resolvedSeatID(nil), "yinyue")
        XCTAssertEqual(SecretaryBundledArt.resolvedSeatID("yingning"), "yinyue")
        XCTAssertEqual(SecretaryBundledArt.resolvedSeatID("unknown"), "yinyue")
        XCTAssertEqual(SecretaryBundledArt.resolvedSeatID("meining"), "meining")
        XCTAssertEqual(
            SecretaryBundledArt.backgroundAssetName(for: "yinyue", landscape: true),
            "YinyueChatBackgroundLandscape"
        )
        XCTAssertEqual(
            SecretaryBundledArt.backgroundAssetName(for: "meining", landscape: false),
            "MeiningChatBackgroundPortrait"
        )
        XCTAssertEqual(
            SecretaryBundledArt.backgroundAssetName(for: "yingning", landscape: false),
            "YinyueChatBackgroundPortrait"
        )
        XCTAssertFalse(SecretaryBundledArt.backgroundAssetName(for: "yingning", landscape: true).contains("Yingning"))
        XCTAssertFalse(SecretaryBundledArt.backgroundAssetName(for: nil, landscape: false).contains("Yingning"))
    }

    func testOrdinaryConversationVisibilityKeepsOnlyDirectStandardChats() {
        func summary(
            id: String,
            type: String = "direct",
            privacy: String = "standard",
            members: [String] = ["capoo", "yinyue"],
            preview: String = "晚安"
        ) -> SecretaryChatConversationSummary {
            SecretaryChatConversationSummary(
                id: id,
                version: "v1",
                type: type,
                title: id,
                privacy: privacy,
                activeSecretaryId: "yinyue",
                memberIds: members,
                updatedAt: nil,
                messageCount: 1,
                lastMessage: SecretaryChatLastMessage(
                    id: "message-\(id)",
                    sender: .init(id: "yinyue", kind: "secretary", displayName: "银月"),
                    createdAt: nil,
                    fallbackText: preview
                )
            )
        }

        let rows = [
            summary(id: "ordinary"),
            summary(id: "threaded", type: "thread"),
            summary(id: "private", privacy: "private"),
            summary(id: "placeholder", preview: " 内容已隐藏 "),
            summary(id: "extra-members", members: ["capoo", "yinyue", "meining"]),
        ]

        XCTAssertEqual(
            SecretaryConversationVisibilityPolicy.ordinaryConversations(rows).map(\.id),
            ["ordinary"]
        )
        XCTAssertEqual(
            SecretaryConversationVisibilityPolicy.visibleConversations(rows).map(\.id),
            ["ordinary"]
        )
        XCTAssertEqual(
            SecretaryConversationVisibilityPolicy.phoneConversations(rows).map(\.id),
            ["ordinary"]
        )

        let exitCandidates = [
            summary(id: "exited-private", privacy: "private"),
            summary(id: "unknown-type", type: "future"),
            summary(id: "unknown-privacy", privacy: "future"),
            summary(id: "latest-ordinary"),
            summary(id: "older-ordinary"),
        ]
        XCTAssertEqual(
            SecretaryConversationVisibilityPolicy.ordinaryConversations(exitCandidates).map(\.id),
            ["latest-ordinary", "older-ordinary"]
        )
        XCTAssertTrue(SecretaryConversationVisibilityPolicy.ordinaryConversations(Array(exitCandidates.prefix(3))).isEmpty)
    }

    func testBootstrapIgnoresNewSelfDescribingFields() throws {
        let data = Data(#"""
        {
          "protocol":{"id":"infans.secretary-chat.v1","version":1,"minimumClientVersion":"1.0.0","eventTypes":["started","delta","completed"]},
          "service":{"version":"1.20.0","reachable":true},
          "identity":{"valid":true,"needsPairing":false},
          "product":{"id":"infans-secretary","name":"小秘书"},
          "activeSecretaryId":"yinyue",
          "defaultConversationId":"native_yingning_default",
          "characters":[{"id":"yinyue","displayName":"银月","kind":"secretary","secretaryEligible":true,"fallbackText":"银月","accent":"jade","assets":{"avatar":"/theme/avatar-yinyue-public.svg","portrait":null,"source":"secretary-profile"}}],
          "assets":{"version":"registry-v1","manifestAvailable":false},
          "features":{"textChat":true,"streamingReplies":true,"reliableRetry":true,"cancellation":true,"conversationList":true,"attachments":false,"voice":false,"notifications":false},
          "recentConversations":[],
          "warnings":[],
          "endpoints":{"bootstrap":"/api/secretary-mobile/bootstrap","stream":"/api/secretary-mobile/turns/stream"},
          "auth":{"scheme":"bearer"},
          "idempotency":{"messageId":"stable"},
          "resume":{"mode":"read-conversation"},
          "boundaries":{"persisted":"mac_persisted"}
        }
        """#.utf8)

        let decoded = try JSONDecoder().decode(SecretaryChatBootstrap.self, from: data)
        XCTAssertEqual(decoded.protocolInfo.version, 1)
        XCTAssertEqual(decoded.activeSecretaryId, "yinyue")
        XCTAssertEqual(decoded.characters.first?.displayName, "银月")
    }

    func testNDJSONDecodesMultipleEventsAndRequiresTerminalBoundary() throws {
        let data = Data(#"""
        {"type":"started","conversationId":"native_yingning_default","generationId":"gen-12345678","userMessageId":"msg-12345678","deliveryStage":"mac_persisted","conversationVersion":"v2","cursor":1}
        {"type":"delta","conversationId":"native_yingning_default","generationId":"gen-12345678","messageId":"reply-gen-12345678","text":"在呢。","cursor":2}
        {"type":"completed","conversationId":"native_yingning_default","generationId":"gen-12345678","conversationVersion":"v3","messages":[],"cursor":3}
        """#.utf8)

        let events = try SecretaryChatNDJSON.decode(data)
        XCTAssertEqual(events.map(\.type), [.started, .delta, .completed])
        XCTAssertEqual(events.first?.deliveryStage, "mac_persisted")
        XCTAssertFalse(SecretaryChatNDJSON.isTerminal(events[1]))
        XCTAssertTrue(SecretaryChatNDJSON.isTerminal(events[2]))
    }

    func testResyncTreatsMacPersistedStableMessageAsReplyRecoveryInsteadOfResubmission() {
        let fixedID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
        let original = PendingSecretaryChatTurn.make(
            conversationId: "native_yingning_default",
            text: "前辈回来了",
            expectedConversationVersion: "v1",
            now: Date(timeIntervalSince1970: 1_788_300_000),
            id: fixedID
        )
        let user = SecretaryChatMessage.localUserMessage(from: original, sequence: 1)
        XCTAssertEqual(user.sender.displayName, "我")
        let conversation = conversation(version: "v2", messages: [user])

        let reconciled = SecretaryChatRecovery.reconciled(pending: [original], with: conversation)
        XCTAssertEqual(reconciled.count, 1)
        XCTAssertEqual(reconciled[0].messageId, original.messageId)
        XCTAssertEqual(reconciled[0].generationId, original.generationId)
        XCTAssertEqual(reconciled[0].expectedConversationVersion, "v2")
        XCTAssertEqual(reconciled[0].state, .macPersisted)
        XCTAssertFalse(reconciled[0].needsTransmission)

        let resynced = SecretaryChatRecovery.resynced(reconciled[0], conversationVersion: "v3")
        XCTAssertEqual(resynced.messageId, original.messageId)
        XCTAssertEqual(resynced.generationId, original.generationId)
        XCTAssertEqual(resynced.expectedConversationVersion, "v3")
    }

    func testUnreadReplyClearsOnReadAndSurvivesCacheRoundTrip() throws {
        let reply = chatMessage(id: "reply-unread-1", sequence: 1, role: "assistant", senderId: "meining", displayName: "梅凝", text: "测试回复", deliveryStage: "device_available")
        let first = conversation(version: "v1", messages: [reply]).summary
        var state = SecretaryConversationUnreadState()
        XCTAssertTrue(state.isUnread(first))
        state.markRead(first)
        XCTAssertFalse(state.isUnread(first))
        let second = chatMessage(id: "reply-unread-2", sequence: 2, role: "assistant", senderId: "meining", displayName: "梅凝", text: "下一条", deliveryStage: "device_available")
        let next = conversation(version: "v2", messages: [reply, second]).summary
        XCTAssertTrue(state.isUnread(next))
        var cache = SecretaryChatDeviceCache.empty
        cache.unreadState = state
        let restored = try JSONDecoder().decode(SecretaryChatDeviceCache.self, from: JSONEncoder().encode(cache))
        XCTAssertFalse(restored.unreadState.isUnread(first))
        XCTAssertTrue(restored.unreadState.isUnread(next))
    }

    func testOwnMessagesAndLegacyHistoryDoNotBecomeUnread() throws {
        let own = chatMessage(id: "user-read", sequence: 1, role: "user", senderId: "user", displayName: "我", text: "测试", deliveryStage: "mac_persisted")
        XCTAssertFalse(SecretaryConversationUnreadState().isUnread(conversation(version: "v1", messages: [own]).summary))
        let reply = chatMessage(id: "old-reply", sequence: 2, role: "assistant", senderId: "meining", displayName: "梅凝", text: "历史回复", deliveryStage: "device_available")
        var cache = SecretaryChatDeviceCache.empty
        cache.conversationSummaries = [conversation(version: "v1", messages: [own, reply]).summary]
        var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(cache)) as! [String: Any]
        legacy.removeValue(forKey: "unreadState")
        let restored = try JSONDecoder().decode(SecretaryChatDeviceCache.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertFalse(restored.unreadState.isUnread(cache.conversationSummaries[0]))
    }

    func testDeliveryStatesOnlyPromoteAndDoNotDowngradeSuccessfulReceipts() {
        XCTAssertEqual(
            SecretaryChatLocalDeliveryState.merging("device_available", with: "mac_persisted"),
            "device_available"
        )
        XCTAssertEqual(
            SecretaryChatLocalDeliveryState.merging("mac_persisted", with: "reply_generating"),
            "reply_generating"
        )
        XCTAssertEqual(
            SecretaryChatLocalDeliveryState.merging("reply_generating", with: "mac_persisted"),
            "reply_generating"
        )
        XCTAssertEqual(
            SecretaryChatLocalDeliveryState.merging("failed_quarantined", with: "device_available"),
            "failed_quarantined"
        )
        XCTAssertEqual(
            SecretaryChatLocalDeliveryState.merging("device_available", with: "failed_retry_pending"),
            "failed_retry_pending"
        )
    }

    func testPromotingReadReceiptsMarksRepliedUserMessagesReadWithoutTouchingFailures() {
        let failed = chatMessage(
            id: "msg-failed",
            sequence: 1,
            role: "user",
            senderId: "capoo",
            displayName: "我",
            text: "失败",
            deliveryStage: SecretaryChatLocalDeliveryState.failedRetryPending.rawValue
        )
        let firstReply = chatMessage(
            id: "reply-failed",
            sequence: 2,
            role: "assistant",
            senderId: "yinyue",
            displayName: "银月",
            text: "这条不该抬失败态",
            deliveryStage: SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
        )
        let replied = chatMessage(
            id: "msg-replied",
            sequence: 3,
            role: "user",
            senderId: "capoo",
            displayName: "我",
            text: "回来了",
            deliveryStage: SecretaryChatLocalDeliveryState.macPersisted.rawValue
        )
        let secondReply = chatMessage(
            id: "reply-ok",
            sequence: 4,
            role: "assistant",
            senderId: "yinyue",
            displayName: "银月",
            text: "在。",
            deliveryStage: SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
        )
        let waiting = chatMessage(
            id: "msg-waiting",
            sequence: 5,
            role: "user",
            senderId: "capoo",
            displayName: "我",
            text: "还在吗",
            deliveryStage: SecretaryChatLocalDeliveryState.macPersisted.rawValue
        )
        let promoted = SecretaryChatRecovery.promotingReadReceipts(
            in: [failed, firstReply, replied, secondReply, waiting]
        )
        XCTAssertEqual(promoted[0].deliveryStage, SecretaryChatLocalDeliveryState.failedRetryPending.rawValue)
        XCTAssertEqual(promoted[2].deliveryStage, SecretaryChatLocalDeliveryState.deviceAvailable.rawValue)
        XCTAssertEqual(promoted[4].deliveryStage, SecretaryChatLocalDeliveryState.macPersisted.rawValue)
    }

    func testAttachmentOnlyLocalMessageHasReadableGenericFallbackAndCard() {
        let attachment = SecretaryChatAttachment(
            id: "image-attachment-1",
            kind: "image",
            name: "photo.jpg",
            mimeType: "image/jpeg",
            resourcePath: "/attachments/photo",
            fallbackText: "photo.jpg"
        )
        let message = SecretaryChatMessage(
            id: "message-attachment-1",
            sequence: 1,
            role: "user",
            sender: .init(id: "capoo", kind: "user", displayName: "我"),
            createdAt: nil,
            createdAtKnown: false,
            text: "",
            fallbackText: "",
            attachments: [attachment],
            deliveryStage: SecretaryChatLocalDeliveryState.replyGenerating.rawValue
        )

        XCTAssertEqual(message.spokenText, "")
        XCTAssertEqual(SecretaryChatMessageFallback.attachmentText(for: message.attachments), "发送了一张图片")
        XCTAssertEqual(message.attachments, [attachment])
    }

    func testCompletedReplyRemovesSameIDPendingTurn() {
        let turn = PendingSecretaryChatTurn.make(
            conversationId: "native_yingning_default",
            text: "你在吗",
            expectedConversationVersion: "v1",
            id: UUID(uuidString: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")!
        )
        var reply = SecretaryChatMessage.localUserMessage(from: turn, sequence: 2)
        reply = SecretaryChatMessage(
            id: "reply-\(turn.generationId)",
            sequence: 2,
            role: "assistant",
            sender: .init(id: "yinyue", kind: "secretary", displayName: "银月"),
            createdAt: nil,
            createdAtKnown: false,
            text: "我在。",
            fallbackText: "我在。",
            attachments: [],
            deliveryStage: "device_available"
        )

        let reconciled = SecretaryChatRecovery.reconciled(
            pending: [turn],
            with: conversation(version: "v3", messages: [reply])
        )
        XCTAssertTrue(reconciled.isEmpty)
    }

    func testMailboxProcessingStatusMapsToReplyGenerating() throws {
        let data = Data(#"{"protocolVersion":1,"conversationId":"native_default","messageId":"msg-p","generationId":"gen-p","createdAt":"2026-09-07T00:00:00Z","text":"在处理","expectedConversationVersion":"v1","attachments":[],"status":"processing"}"#.utf8)
        let message = try JSONDecoder().decode(SecretaryChatMailboxMessage.self, from: data)
        XCTAssertEqual(message.localDeliveryState, .replyGenerating)
        XCTAssertEqual(message.localDeliveryState.userFacingText, "已读")
        XCTAssertEqual(SecretaryChatLocalDeliveryState.macPersisted.userFacingText, "未读")
    }

    func testCompletedMailboxReplyWithDifferentIDClearsPending() {
        let turn = PendingSecretaryChatTurn.make(
            conversationId: "native_yingning_default",
            text: "你在吗",
            expectedConversationVersion: "v1",
            id: UUID(uuidString: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")!
        )
        let user = SecretaryChatMessage.localUserMessage(from: turn, sequence: 1)
        let reply = SecretaryChatMessage(
            id: "mac-reply-different-id",
            sequence: 2,
            role: "assistant",
            sender: .init(id: "yinyue", kind: "secretary", displayName: "银月"),
            createdAt: nil,
            createdAtKnown: false,
            text: "我在。",
            fallbackText: "我在。",
            attachments: [],
            deliveryStage: "device_available"
        )
        let reconciled = SecretaryChatRecovery.reconciled(
            pending: [turn],
            with: conversation(version: "v3", messages: [user, reply])
        )
        XCTAssertTrue(reconciled.isEmpty)
    }

    func testPersistenceRejectsLateOlderRevision() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("secretary-chat-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = SecretaryChatPersistence(directoryURL: directory)
        var older = SecretaryChatDeviceCache.empty
        older.draft = "old"
        var newer = SecretaryChatDeviceCache.empty
        newer.draft = "new"

        try await persistence.save(newer, revision: 2)
        try await persistence.save(older, revision: 1)

        let loaded = await persistence.load()
        XCTAssertEqual(loaded.draft, "new")
    }

    func testBootstrapDescribesConversationControlsWithoutClientRoleFacts() throws {
        let data = Data(#"""
        {
          "protocol":{
            "id":"infans.secretary-chat.v1","version":1,"minimumClientVersion":"1.0.0","eventTypes":[],
            "conversationMutation":{
              "expectedVersionField":"expectedConversationVersion","mutableFields":["title","chatState"],
              "mutableChatStateFields":["privacy","qualityMode"],
              "allowedPrivacy":["standard"],
              "allowedQualityModes":["light"]
            }
          },
          "service":{"version":"1.20.0","reachable":true},
          "identity":{"valid":true,"needsPairing":false},
          "product":{"id":"infans-secretary","name":"小秘书"},
          "activeSecretaryId":"yinyue","defaultConversationId":"native_yingning_default",
          "characters":[],
          "features":{"textChat":true,"streamingReplies":true,"reliableRetry":true,"cancellation":true,"conversationList":true,"attachments":false,"voice":false,"notifications":false},
          "recentConversations":[],"warnings":[]
        }
        """#.utf8)

        let bootstrap = try JSONDecoder().decode(SecretaryChatBootstrap.self, from: data)
        let mutation = try XCTUnwrap(bootstrap.protocolInfo.conversationMutation)
        XCTAssertEqual(mutation.allowedPrivacy, ["standard"])
        XCTAssertEqual(mutation.allowedQualityModes, ["light"])
    }

    func testBootstrapDecodesOneOnOneProtocol() throws {
        let data = Data(#"""
        {
          "protocol":{
            "id":"infans.secretary-chat.v1","version":1,"minimumClientVersion":"1.0.0","eventTypes":[]
          },
          "service":{"version":"1.20.0","reachable":true},
          "identity":{"valid":true,"needsPairing":false},
          "product":{"id":"infans-secretary","name":"小秘书"},
          "activeSecretaryId":"yinyue","defaultConversationId":"native_yinyue_default",
          "characters":[],
          "features":{"textChat":true,"streamingReplies":true,"reliableRetry":true,"cancellation":true,"conversationList":true,"attachments":true,"voice":false,"notifications":false},
          "recentConversations":[],"warnings":[]
        }
        """#.utf8)
        let bootstrap = try JSONDecoder().decode(SecretaryChatBootstrap.self, from: data)
        XCTAssertEqual(bootstrap.protocolInfo.id, "infans.secretary-chat.v1")
        XCTAssertEqual(bootstrap.activeSecretaryId, "yinyue")
    }

    func testAutomaticContinuationRequestAndEventsStaySilentAndStable() throws {
        let turn = PendingSecretaryChatTurn.make(
            conversationId: "native_auto",
            text: "由 bootstrap 下发的内部续聊",
            expectedConversationVersion: "v3",
            autoChat: true,
            id: UUID(uuidString: "12345678-1234-4234-9234-123456789abc")!
        )
        XCTAssertEqual(turn.request.autoChat, true)
        XCTAssertEqual(turn.request.messageId, turn.messageId)
        XCTAssertEqual(turn.request.generationId, turn.generationId)

        let started = try XCTUnwrap(SecretaryChatNDJSON.decodeLine(
            #"{"type":"started","conversationId":"native_auto","generationId":"gen-stable-1234","autoContinuation":true,"deliveryStage":"reply_generating","conversationVersion":"v4"}"#
        ))
        XCTAssertEqual(started.autoContinuation, true)
        let completed = try XCTUnwrap(SecretaryChatNDJSON.decodeLine(
            #"{"type":"completed","conversationId":"native_auto","generationId":"gen-stable-1234","autoContinuation":true,"conversationVersion":"v5","messages":[],"execution":{"backend":"openrouter","model":"model-from-mac","usage":{"total_tokens":12,"cost":0.001}}}"#
        ))
        XCTAssertEqual(completed.autoContinuation, true)
        XCTAssertEqual(completed.execution?.usage?.totalTokens, 12)
        XCTAssertEqual(completed.execution?.usage?.cost, 0.001)
    }

    func testLegacyDeviceCacheKeepsDraftPendingTurnAndConversation() throws {
        let data = Data(#"""
        {
          "currentConversationId":"native_yingning_default",
          "conversation":{
            "id":"native_yingning_default","version":"v1","type":"direct","title":"与银月的对话",
            "privacy":"standard","activeSecretaryId":"yinyue","memberIds":["capoo","yinyue"],
            "updatedAt":null,"messageCount":0,"messages":[]
          },
          "draft":"别丢掉这句话",
          "pendingTurns":[{
            "conversationId":"native_yingning_default","messageId":"msg-11111111-2222-3333-4444-555555555555",
            "generationId":"gen-11111111-2222-3333-4444-555555555555","createdAt":"2026-09-02T12:00:00Z",
            "text":"等连上再发","expectedConversationVersion":"v1","state":"failed_retry_pending",
            "lastError":"offline","retryCount":1
          }]
        }
        """#.utf8)

        let cache = try JSONDecoder().decode(SecretaryChatDeviceCache.self, from: data)
        XCTAssertEqual(cache.draft, "别丢掉这句话")
        XCTAssertEqual(cache.pendingTurns.count, 1)
        XCTAssertEqual(cache.conversation?.chatState.privacy, "standard")
        XCTAssertEqual(cache.cachedConversations["native_yingning_default"]?.title, "与银月的对话")
    }

    func testConversationClientUsesListCreatePatchDeleteContract() async throws {
        let recorder = SecretaryRequestRecorder()
        SecretaryURLProtocolStub.handler = { request in
            recorder.append(request)
            let path = request.url?.path ?? ""
            switch (request.httpMethod ?? "", path) {
            case ("GET", "/api/secretary-mobile/conversations"):
                return (200, Data(#"{"conversations":[],"errors":[],"complete":true}"#.utf8))
            case ("POST", "/api/secretary-mobile/conversations"):
                return (201, Self.createResponseData)
            case ("PATCH", "/api/secretary-mobile/conversations/native_contract_test"):
                return (200, Self.updateResponseData)
            case ("DELETE", "/api/secretary-mobile/conversations/native_contract_test"):
                return (200, Data(#"{"id":"native_contract_test","deleted":true,"removedAttachments":[],"attachmentCleanupDeferred":false}"#.utf8))
            default:
                return (404, Data(#"{"error":"unexpected"}"#.utf8))
            }
        }
        defer { SecretaryURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SecretaryURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let connection = SecretaryChatConnection(serverURL: "https://mac.example.test", bearerToken: "token-value")

        let listed = try await client.conversations(connection: connection)
        XCTAssertTrue(listed.complete)
        _ = try await client.createConversation(
            .init(protocolVersion: 1, conversationId: "native_contract_test", title: "横版会话"),
            connection: connection
        )
        _ = try await client.updateConversation(
            id: "native_contract_test",
            payload: .init(
                protocolVersion: 1,
                expectedConversationVersion: "v1",
                title: nil,
                chatState: .init(
                    activeSecretaryId: nil,
                    privacy: "standard",
                    qualityMode: "light"
                )
            ),
            connection: connection
        )
        let deleted = try await client.deleteConversation(
            id: "native_contract_test",
            payload: .init(protocolVersion: 1, expectedConversationVersion: "v2"),
            connection: connection
        )
        XCTAssertTrue(deleted.deleted)

        let requests = recorder.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "PATCH", "DELETE"])
        XCTAssertTrue(requests.allSatisfy { $0.authorization == "Bearer token-value" })
        let createBody = try XCTUnwrap(requests[1].body)
        let create = try JSONDecoder().decode(SecretaryChatCreateConversationRequest.self, from: createBody)
        XCTAssertEqual(create.conversationId, "native_contract_test")
        let patchBody = try XCTUnwrap(requests[2].body)
        let update = try JSONDecoder().decode(SecretaryChatUpdateConversationRequest.self, from: patchBody)
        XCTAssertEqual(update.chatState?.privacy, "standard")
        XCTAssertEqual(update.chatState?.qualityMode, "light")
        let deleteBody = try XCTUnwrap(requests[3].body)
        let delete = try JSONDecoder().decode(SecretaryChatDeleteConversationRequest.self, from: deleteBody)
        XCTAssertEqual(delete.expectedConversationVersion, "v2")
    }

    func testArchivedAttachmentsChooseImageAudioAndFileCards() {
        let rows = [
            SecretaryChatAttachment(id: "image-1", kind: "file", name: "photo.jpg", mimeType: "image/jpeg", resourcePath: "/private/photo", fallbackText: "图片"),
            SecretaryChatAttachment(id: "audio-1", kind: "audio", name: "reply.m4a", mimeType: "application/octet-stream", resourcePath: "/private/audio", fallbackText: "录音"),
            SecretaryChatAttachment(id: "file-1", kind: "file", name: "notes.pdf", mimeType: "application/pdf", resourcePath: "/private/file", fallbackText: "文件"),
        ]
        XCTAssertEqual(rows.map(\.presentationKind), [.image, .audio, .file])
    }

    func testAttachmentReadKeepsBearerOnPrivateMacOriginAndRejectsCrossOrigin() async throws {
        let recorder = SecretaryRequestRecorder()
        SecretaryURLProtocolStub.handler = { request in
            recorder.append(request)
            return (200, Data("private-bytes".utf8))
        }
        defer { SecretaryURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SecretaryURLProtocolStub.self]
        let client = SecretaryChatClient(session: URLSession(configuration: configuration))
        let connection = SecretaryChatConnection(serverURL: "https://mac.example.test", bearerToken: "attachment-token")

        let resource = try await client.attachmentResource(
            path: "/api/secretary-mobile/attachments/file-1",
            connection: connection
        )
        XCTAssertEqual(String(decoding: resource.data, as: UTF8.self), "private-bytes")
        XCTAssertEqual(recorder.requests.last?.path, "/api/secretary-mobile/attachments/file-1")
        XCTAssertEqual(recorder.requests.last?.authorization, "Bearer attachment-token")

        do {
            _ = try await client.attachmentResource(path: "https://tracker.example/secret", connection: connection)
            XCTFail("跨来源附件不应发起请求")
        } catch SecretaryChatClientError.invalidServerURL {
            XCTAssertEqual(recorder.requests.count, 1)
        }
    }

    func testReplyNotificationRequiresBackgroundDeviceAvailableAndRedactsPrivateConversation() throws {
        let message = SecretaryChatMessage(
            id: "reply-stable-1",
            sequence: 4,
            role: "assistant",
            sender: .init(id: "yinyue", kind: "secretary", displayName: "银月"),
            createdAt: nil,
            createdAtKnown: false,
            text: "前辈，我回来啦。",
            fallbackText: "银月有回复",
            attachments: [],
            deliveryStage: SecretaryChatLocalDeliveryState.deviceAvailable.rawValue
        )
        let privatePlan = try XCTUnwrap(SecretaryChatNotificationPolicy.plan(
            for: message,
            conversationIsPrivate: true,
            appIsActive: false,
            notificationsEnabled: true,
            authorizationGranted: true,
            handledMessageIDs: []
        ))
        XCTAssertEqual(privatePlan.identifier, "secretary-chat-reply-stable-1")
        XCTAssertEqual(privatePlan.title, "小秘书")
        XCTAssertFalse(privatePlan.body.contains("前辈"))
        XCTAssertNil(SecretaryChatNotificationPolicy.plan(
            for: message,
            conversationIsPrivate: false,
            appIsActive: true,
            notificationsEnabled: true,
            authorizationGranted: true,
            handledMessageIDs: []
        ))
        XCTAssertNil(SecretaryChatNotificationPolicy.plan(
            for: message,
            conversationIsPrivate: false,
            appIsActive: false,
            notificationsEnabled: true,
            authorizationGranted: true,
            handledMessageIDs: [message.id]
        ))
        XCTAssertEqual(Set(SecretarySpeechRateSetting.allCases.map(\.rateMultiplier)).count, 3)
    }

    private func chatMessage(
        id: String,
        sequence: Int,
        role: String,
        senderId: String,
        displayName: String,
        text: String,
        deliveryStage: String
    ) -> SecretaryChatMessage {
        SecretaryChatMessage(
            id: id,
            sequence: sequence,
            role: role,
            sender: .init(
                id: senderId,
                kind: role == "user" ? "user" : "character",
                displayName: displayName
            ),
            createdAt: nil,
            createdAtKnown: false,
            text: text,
            fallbackText: text,
            attachments: [],
            deliveryStage: deliveryStage
        )
    }

    private func conversation(version: String, messages: [SecretaryChatMessage]) -> SecretaryChatConversation {
        SecretaryChatConversation(
            id: "native_yingning_default",
            version: version,
            type: "direct",
            title: "与银月的对话",
            privacy: "standard",
            activeSecretaryId: "yinyue",
            memberIds: ["capoo", "yinyue"],
            updatedAt: nil,
            messageCount: messages.count,
            messages: messages,
            chatState: SecretaryChatConversationState(
                activeSecretaryId: "yinyue",
                qualityMode: "light",
                privacy: "standard"
            )
        )
    }

    private static let conversationData = #"""
    {
      "id":"native_contract_test","version":"v2","type":"direct","title":"横版会话","privacy":"standard",
      "activeSecretaryId":"yinyue","memberIds":["capoo","yinyue"],
      "chatState":{
        "activeSecretaryId":"yinyue","privacy":"standard","qualityMode":"light"
      },
      "updatedAt":"2026-09-02T12:00:00.000Z","messageCount":0,"messages":[]
    }
    """#

    private static let createResponseData = Data(
        "{\"created\":true,\"duplicate\":false,\"conversation\":\(conversationData)}".utf8
    )
    private static let updateResponseData = Data("{\"conversation\":\(conversationData)}".utf8)
}

private final class SecretaryRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [SecretaryRecordedRequest] = []

    var requests: [SecretaryRecordedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ request: URLRequest) {
        let recorded = SecretaryRecordedRequest(
            httpMethod: request.httpMethod,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            path: request.url?.path,
            body: request.httpBody ?? Self.readBody(from: request.httpBodyStream)
        )
        lock.lock()
        storage.append(recorded)
        lock.unlock()
    }

    private static func readBody(from stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { return nil }
            if count == 0 { return data }
            data.append(buffer, count: count)
        }
    }
}

private struct SecretaryRecordedRequest: Sendable {
    let httpMethod: String?
    let authorization: String?
    let path: String?
    let body: Data?
}

private final class SecretaryURLProtocolStub: URLProtocol, @unchecked Sendable {
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
