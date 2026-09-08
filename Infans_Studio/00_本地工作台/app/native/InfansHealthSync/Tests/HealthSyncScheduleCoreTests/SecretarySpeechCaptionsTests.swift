import XCTest
@testable import HealthSyncScheduleCore
final class SecretarySpeechCaptionsTests: XCTestCase {
    func testLosslessBoundedMixedLanguagePages() {
        let text = "前辈，今日はいい天気ですね。我们慢慢说，不着急。👩‍👩‍👦一起去散步吧！" + String(repeating: "很长的内容", count: 20)
        for limit in [18, 36] {
            let pages = SecretarySpeechCaptions.pages(text, limit: limit)
            XCTAssertEqual(pages.joined(), text)
            XCTAssertTrue(pages.allSatisfy { $0.count <= limit })
        }
    }
    func testPositionBoundariesAndInvalidProgress() {
        XCTAssertEqual(SecretarySpeechCaptions.current("", progress: 1), "")
        let text = String(repeating: "甲", count: 36) + "乙"
        XCTAssertEqual(SecretarySpeechCaptions.current(text, progress: .nan), String(repeating: "甲", count: 36))
        XCTAssertEqual(SecretarySpeechCaptions.current(text, progress: 1), "乙")
        XCTAssertEqual(SecretarySpeechCaptions.current(text, progress: -1), String(repeating: "甲", count: 36))
    }

    func testTypedPrefixFollowsSpeechProgress() {
        XCTAssertEqual(SecretarySpeechCaptions.typedPrefix("", progress: 0.4), "")
        XCTAssertEqual(SecretarySpeechCaptions.typedPrefix("梅凝在", progress: 0), "梅")
        XCTAssertEqual(SecretarySpeechCaptions.typedPrefix("梅凝在", progress: 0.5), "梅凝")
        XCTAssertEqual(SecretarySpeechCaptions.typedPrefix("梅凝在", progress: 1), "梅凝在")
        XCTAssertEqual(SecretarySpeechCaptions.typedPrefix("梅凝在", progress: .nan), "梅")
    }
}

final class SecretaryConversationDisplayTitleTests: XCTestCase {
    func testAutomaticDateTitleShowsSecretaryName() {
        XCTAssertEqual(
            SecretaryConversationDisplayTitle.listTitle(
                storedTitle: "9月6日 · 和梅凝聊聊",
                secretaryName: "梅凝"
            ),
            "梅凝"
        )
        XCTAssertEqual(
            SecretaryConversationDisplayTitle.nextStoredTitle(secretaryName: "银月"),
            "银月"
        )
        XCTAssertEqual(
            SecretaryConversationDisplayTitle.nextStoredTitle(secretaryName: "梅凝"),
            "梅凝"
        )
    }
}
