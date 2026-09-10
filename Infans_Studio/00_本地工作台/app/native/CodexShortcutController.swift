import AppKit
import ApplicationServices
import AVFoundation
import Foundation

private let codexBundleIdentifier = "com.openai.codex"
private let cursorBundleIdentifier = "com.todesktop.230313mzl4w4u92"
private let supportedShortcutBundleIdentifiers: Set<String> = [
    codexBundleIdentifier,
    cursorBundleIdentifier,
]
private let codexReadAloudURL = URL(string: "http://127.0.0.1:5173/api/tts")!
private let secretaryStateURL = URL(string: "http://127.0.0.1:5173/api/secretary")!
private let lightsOffURL = URL(string: "http://127.0.0.1:5173/api/tools/lights-off")!
private let readAloudSpeakerFallback = "yinyue"
private let readAloudSpeakerIDs: Set<String> = ["yinyue", "meining"]

private enum CodexShortcutAction: Equatable {
    case lightsOff
    case readAloud
    case dictation
}

private enum CodexAccessibilityError: Error {
    case permissionRequired
    case codexNotFrontmost
    case windowUnavailable
    case replyUnavailable
    case dictationUnavailable
}

private struct CodexAccessibilityBridge {
    private let messageCopyLabels = [
        "copy message", "copy response", "复制消息", "复制回复", "複製訊息", "複製回覆",
        "メッセージをコピー", "返信をコピー",
    ]
    private let ignoredExactTexts = Set([
        "copy", "复制", "複製", "コピー", "copiar", "copier",
        "good response", "bad response", "thumbs up", "thumbs down",
        "重新生成", "再试一次", "更多", "more",
        "审查已更改的文件", "review changes", "撤销", "undo", "审核", "审核回复",
        "再显示", "show more",
    ])

    func readLatestAssistantReply() throws -> String {
        let window = try focusedAgentWindow(requireFrontmost: true)
        var copyButtons: [AXUIElement] = []
        var remainingNodes = 30_000
        findControls(
            in: window,
            depth: 0,
            remainingNodes: &remainingNodes,
            matching: isAssistantCopyControl,
            result: &copyButtons
        )
        let windowFrame = elementFrame(window)
        let visible = copyButtons.filter { button in
            let frame = elementFrame(button)
            return !frame.isNull
                && frame.width >= 16
                && frame.height >= 16
                && windowFrame.intersects(frame)
        }
        let pool = visible.isEmpty ? copyButtons : visible
        guard let latest = pool.enumerated().max(by: { lhs, rhs in
            let leftY = elementMaxY(lhs.element)
            let rightY = elementMaxY(rhs.element)
            if leftY != rightY { return leftY < rightY }
            return lhs.offset < rhs.offset
        })?.element else {
            throw CodexAccessibilityError.replyUnavailable
        }
        if let text = replyText(around: latest), !text.isEmpty { return text }
        throw CodexAccessibilityError.replyUnavailable
    }

    func pressDictationButton() throws -> String {
        let window = try focusedAgentWindow(requireFrontmost: true)
        let windowFrame = elementFrame(window)
        var buttons: [AXUIElement] = []
        var remainingNodes = 30_000
        findControls(
            in: window,
            depth: 0,
            remainingNodes: &remainingNodes,
            matching: isDictationControl,
            result: &buttons
        )
        let candidates = buttons.compactMap { button -> (AXUIElement, Int, CGRect)? in
            let label = controlLabel(button).lowercased()
            let score = dictationScore(label)
            let frame = elementFrame(button)
            return score > 0
                && !frame.isNull
                && frame.width >= 12
                && frame.height >= 12
                && windowFrame.intersects(frame)
                ? (button, score, frame)
                : nil
        }
        guard let best = candidates.max(by: { lhs, rhs in
            if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
            let leftComposer = composerBias(lhs.2, window: windowFrame)
            let rightComposer = composerBias(rhs.2, window: windowFrame)
            if leftComposer != rightComposer { return leftComposer < rightComposer }
            return lhs.2.maxY < rhs.2.maxY
        }) else {
            throw CodexAccessibilityError.dictationUnavailable
        }
        let label = controlLabel(best.0)
        _ = pressAccessibilityControl(best.0)
        clickPoint(CGPoint(x: best.2.midX, y: best.2.midY))
        return label
    }

    private func clickPoint(_ point: CGPoint) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        let events: [(CGEventType, CGMouseButton)] = [
            (.mouseMoved, .left),
            (.leftMouseDown, .left),
            (.leftMouseUp, .left),
        ]
        for (type, button) in events {
            guard let event = CGEvent(
                mouseEventSource: source,
                mouseType: type,
                mouseCursorPosition: point,
                mouseButton: button
            ) else { continue }
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.post(tap: .cghidEventTap)
        }
    }

    static func fileLabelSelfTest() -> Bool {
        simplifiedFileLabel(from: "AGENTS.md") == "AGENTS.md"
            && simplifiedFileLabel(from: "/Users/example/project/AGENTS.md") == "AGENTS.md"
            && simplifiedFileLabel(from: "https://example.com/AGENTS.md") == nil
            && simplifiedFileLabel(from: "审核") == nil
            && !Self.isUserComposerLabel("复制")
            && Self.isUserComposerLabel("编辑消息")
            && Self.isUserComposerLabel("copy message edit message")
            && Self.isAssistantCopyLabel("复制")
            && Self.isAssistantCopyLabel("copy")
            && Self.isAssistantCopyLabel("copy message")
            && !Self.isAssistantCopyLabel("归档聊天")
    }

    private func focusedAgentWindow(requireFrontmost: Bool) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw CodexAccessibilityError.permissionRequired }
        let frontmostID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        if requireFrontmost, let frontmostID, !supportedShortcutBundleIdentifiers.contains(frontmostID) {
            throw CodexAccessibilityError.codexNotFrontmost
        }
        let targetID = (frontmostID.flatMap { supportedShortcutBundleIdentifiers.contains($0) ? $0 : nil })
            ?? supportedShortcutBundleIdentifiers.first(where: {
                !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty
            })
        guard let targetID,
              let app = NSRunningApplication.runningApplications(withBundleIdentifier: targetID).first else {
            throw CodexAccessibilityError.codexNotFrontmost
        }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        guard let window: AXUIElement = attribute(application, kAXFocusedWindowAttribute as CFString)
            ?? mainWindow(in: application) else {
            throw CodexAccessibilityError.windowUnavailable
        }
        return window
    }

    private func mainWindow(in application: AXUIElement) -> AXUIElement? {
        let windows: [AXUIElement] = attribute(application, kAXWindowsAttribute as CFString) ?? []
        return windows.first(where: { (attribute($0, kAXMainAttribute as CFString) as Bool?) == true })
            ?? windows.first
    }

    private func findControls(
        in element: AXUIElement,
        depth: Int,
        remainingNodes: inout Int,
        matching: (AXUIElement) -> Bool,
        result: inout [AXUIElement]
    ) {
        guard depth < 80, remainingNodes > 0, !isHidden(element) else { return }
        remainingNodes -= 1
        if matching(element) { result.append(element) }
        let children: [AXUIElement] = attribute(element, kAXChildrenAttribute as CFString) ?? []
        for child in children {
            findControls(
                in: child,
                depth: depth + 1,
                remainingNodes: &remainingNodes,
                matching: matching,
                result: &result
            )
            if remainingNodes <= 0 { break }
        }
    }

    private func isAssistantCopyControl(_ element: AXUIElement) -> Bool {
        let role: String = attribute(element, kAXRoleAttribute as CFString) ?? ""
        guard role == (kAXButtonRole as String) || role == (kAXCheckBoxRole as String) else { return false }
        let label = controlLabel(element)
        guard Self.isAssistantCopyLabel(label) else { return false }
        return !isUserMessageCopy(element)
    }

    private func isUserMessageCopy(_ element: AXUIElement) -> Bool {
        guard let parent: AXUIElement = attribute(element, kAXParentAttribute as CFString) else { return false }
        let children: [AXUIElement] = attribute(parent, kAXChildrenAttribute as CFString) ?? []
        guard let index = children.firstIndex(where: { CFEqual($0, element) }) else { return false }
        let lower = max(0, index - 3)
        let upper = min(children.count, index + 4)
        return children[lower..<upper].contains { child in
            Self.isUserComposerLabel(controlLabel(child))
        }
    }

    private func isUserComposerControl(_ element: AXUIElement) -> Bool {
        Self.isUserComposerLabel(controlLabel(element)) || isUserMessageCopy(element)
    }

    private static func isAssistantCopyLabel(_ raw: String) -> Bool {
        let label = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return false }
        if label == "copy" || label == "复制" || label == "複製" || label == "コピー" {
            return true
        }
        return [
            "copy message", "copy response", "复制消息", "复制回复", "複製訊息", "複製回覆",
            "メッセージをコピー", "返信をコピー",
        ].contains(where: { label == $0 || label.hasPrefix("\($0) ") || label.contains($0) })
    }

    private static func isUserComposerLabel(_ raw: String) -> Bool {
        let label = raw.lowercased()
        return [
            "edit message", "编辑消息", "編輯訊息", "メッセージを編集",
        ].contains(where: { label == $0 || label.contains($0) })
    }

    private func isCopyControl(_ element: AXUIElement) -> Bool {
        isAssistantCopyControl(element)
    }

    private func isMessageCopyControl(_ element: AXUIElement) -> Bool {
        let label = controlLabel(element).lowercased()
        return messageCopyLabels.contains(where: { label == $0 || label.hasPrefix("\($0) ") })
    }

    private func isDictationControl(_ element: AXUIElement) -> Bool {
        let role: String = attribute(element, kAXRoleAttribute as CFString) ?? ""
        let allowedRoles = [
            kAXButtonRole as String,
            kAXCheckBoxRole as String,
            "AXMenuButton",
            "AXToggle",
            "AXPopUpButton",
        ]
        guard allowedRoles.contains(role) else { return false }
        return dictationScore(controlLabel(element).lowercased()) > 0
    }

    private func pressAccessibilityControl(_ element: AXUIElement) -> Bool {
        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            return true
        }
        if let parent: AXUIElement = attribute(element, kAXParentAttribute as CFString),
           AXUIElementPerformAction(parent, kAXPressAction as CFString) == .success {
            return true
        }
        return false
    }

    private func composerBias(_ frame: CGRect, window: CGRect) -> CGFloat {
        guard !window.isNull, window.height > 0 else { return 0 }
        return frame.midY / window.maxY
    }

    private func dictationScore(_ label: String) -> Int {
        guard !label.isEmpty else { return 0 }
        if label.contains("voice chat")
            || label.contains("realtime voice")
            || label.contains("语音聊天")
            || label.contains("語音聊天") {
            return 0
        }
        var score = 0
        if label.contains("dictat") || label.contains("听写") || label.contains("聽寫") {
            score += 120
        }
        if label.contains("voice input")
            || label.contains("speech input")
            || label.contains("语音输入")
            || label.contains("語音輸入") {
            score += 100
        }
        if label.contains("microphone")
            || label.contains("麦克风")
            || label.contains("麥克風")
            || label.contains("听写")
            || label.contains("聽寫") {
            score += 70
        }
        if label.contains("start voice") || label.contains("voice input") {
            score += 40
        }
        guard score > 0 else { return 0 }
        if label.contains("start")
            || label.contains("stop")
            || label.contains("开始")
            || label.contains("停止")
            || label.contains("開啟") {
            score += 10
        }
        return score
    }

    private func replyText(around copyButton: AXUIElement) -> String? {
        if let text = replyTextBeforeCopy(copyButton), text.count >= 2 { return text }
        if let text = flattenedCompletedAssistantResponse(around: copyButton), text.count >= 2 { return text }
        if let text = groupedAssistantMessage(around: copyButton), text.count >= 2 { return text }
        return nil
    }

    private func replyTextBeforeCopy(_ copyButton: AXUIElement) -> String? {
        guard let container: AXUIElement = attribute(copyButton, kAXParentAttribute as CFString) else { return nil }
        let children: [AXUIElement] = attribute(container, kAXChildrenAttribute as CFString) ?? []
        if let text = collectPrecedingReply(in: children, before: copyButton), text.count >= 2 {
            return text
        }
        if isCompactActionRow(container),
           let parent: AXUIElement = attribute(container, kAXParentAttribute as CFString) {
            let siblings: [AXUIElement] = attribute(parent, kAXChildrenAttribute as CFString) ?? []
            if let index = siblings.firstIndex(where: { CFEqual($0, container) }) {
                for siblingIndex in stride(from: index - 1, through: 0, by: -1) {
                    let sibling = siblings[siblingIndex]
                    if containsAssistantCopy(sibling) { break }
                    let text = displayText(in: sibling, includeFileButtons: false)
                    if text.count >= 2 { return text }
                }
            }
        }
        return nil
    }

    private func collectPrecedingReply(in children: [AXUIElement], before target: AXUIElement) -> String? {
        guard let index = children.firstIndex(where: { CFEqual($0, target) }), index > 0 else { return nil }
        var reversedBlocks: [String] = []
        for childIndex in stride(from: index - 1, through: 0, by: -1) {
            let child = children[childIndex]
            if isAssistantCopyControl(child) || isUserComposerControl(child) { break }
            let role: String = attribute(child, kAXRoleAttribute as CFString) ?? ""
            if role == (kAXButtonRole as String) || role == (kAXCheckBoxRole as String) {
                continue
            }
            let text = displayText(in: child, includeFileButtons: false)
            if !text.isEmpty { reversedBlocks.append(text) }
        }
        guard !reversedBlocks.isEmpty else { return nil }
        return normalize(Array(reversedBlocks.reversed()))
    }

    private func isCompactActionRow(_ element: AXUIElement) -> Bool {
        let role: String = attribute(element, kAXRoleAttribute as CFString) ?? ""
        guard role == (kAXGroupRole as String) else { return false }
        let children: [AXUIElement] = attribute(element, kAXChildrenAttribute as CFString) ?? []
        guard (2...8).contains(children.count) else { return false }
        let controlCount = children.reduce(into: 0) { count, child in
            let childRole: String = attribute(child, kAXRoleAttribute as CFString) ?? ""
            if childRole == (kAXButtonRole as String) || childRole == (kAXCheckBoxRole as String) {
                count += 1
            }
        }
        return controlCount >= 2
    }

    private func containsAssistantCopy(_ element: AXUIElement) -> Bool {
        if isAssistantCopyControl(element) { return true }
        let children: [AXUIElement] = attribute(element, kAXChildrenAttribute as CFString) ?? []
        return children.contains(where: isAssistantCopyControl)
    }

    private func flattenedCompletedAssistantResponse(around copyButton: AXUIElement) -> String? {
        guard !isMessageCopyControl(copyButton) else { return nil }
        guard let container: AXUIElement = attribute(copyButton, kAXParentAttribute as CFString) else { return nil }
        let children: [AXUIElement] = attribute(container, kAXChildrenAttribute as CFString) ?? []
        guard let buttonIndex = children.firstIndex(where: { CFEqual($0, copyButton) }), buttonIndex > 0 else {
            return nil
        }

        let followingRoles = (1...5).compactMap { offset -> String? in
            let index = buttonIndex + offset
            guard children.indices.contains(index) else { return nil }
            return attribute(children[index], kAXRoleAttribute as CFString)
        }
        let followingLabels = (1...5).compactMap { offset -> String? in
            let index = buttonIndex + offset
            guard children.indices.contains(index) else { return nil }
            return controlLabel(children[index]).lowercased()
        }
        let looksLikeCompletedReply = followingRoles.filter({ $0 == (kAXCheckBoxRole as String) }).count >= 2
            || followingLabels.contains(where: {
                $0.contains("评价") || $0.contains("thumbs") || $0.contains("fork") || $0.contains("分支")
            })
        guard looksLikeCompletedReply else { return nil }

        var reversedBlocks: [String] = []
        var started = false
        for index in stride(from: buttonIndex - 1, through: max(0, buttonIndex - 64), by: -1) {
            let child = children[index]
            let role: String = attribute(child, kAXRoleAttribute as CFString) ?? ""
            let text = displayText(in: child, includeFileButtons: false)
            if !started {
                if text.isEmpty { continue }
                started = true
                reversedBlocks.append(text)
                continue
            }
            if text.isEmpty
                || role == (kAXButtonRole as String)
                || role == (kAXCheckBoxRole as String) { break }
            reversedBlocks.append(text)
        }
        guard !reversedBlocks.isEmpty else { return nil }
        return normalize(Array(reversedBlocks.reversed()))
    }

    private func groupedAssistantMessage(around copyButton: AXUIElement) -> String? {
        guard let toolbar: AXUIElement = attribute(copyButton, kAXParentAttribute as CFString),
              isResponseToolbar(toolbar),
              let container: AXUIElement = attribute(toolbar, kAXParentAttribute as CFString) else { return nil }
        let siblings: [AXUIElement] = attribute(container, kAXChildrenAttribute as CFString) ?? []
        guard let toolbarIndex = siblings.firstIndex(where: { CFEqual($0, toolbar) }) else { return nil }

        // Codex exposes each assistant segment as a compact action toolbar followed by
        // one display-content group. Reading only that adjacent group prevents code-copy
        // buttons, tool cards, earlier assistant segments, and earlier turns from leaking in.
        for index in [toolbarIndex + 1, toolbarIndex - 1] where siblings.indices.contains(index) {
            let candidate = siblings[index]
            guard !isResponseToolbar(candidate) else { continue }
            let text = displayText(in: candidate, includeFileButtons: false)
            if text.count >= 2 { return text }
        }
        return nil
    }

    private func isResponseToolbar(_ element: AXUIElement) -> Bool {
        let role: String = attribute(element, kAXRoleAttribute as CFString) ?? ""
        guard role == (kAXGroupRole as String) else { return false }
        let children: [AXUIElement] = attribute(element, kAXChildrenAttribute as CFString) ?? []
        let buttonCount = children.reduce(into: 0) { count, child in
            let childRole: String = attribute(child, kAXRoleAttribute as CFString) ?? ""
            if childRole == (kAXButtonRole as String) { count += 1 }
        }
        guard buttonCount >= 3 else { return false }
        return displayText(in: element, includeFileButtons: false).count <= 40
    }

    private func displayText(in element: AXUIElement, includeFileButtons: Bool = true) -> String {
        var parts: [String] = []
        var remainingNodes = 12_000
        collectDisplayText(
            in: element,
            depth: 0,
            remainingNodes: &remainingNodes,
            includeFileButtons: includeFileButtons,
            parts: &parts
        )
        return normalize(parts)
    }

    private func collectDisplayText(
        in element: AXUIElement,
        depth: Int,
        remainingNodes: inout Int,
        includeFileButtons: Bool,
        parts: inout [String]
    ) {
        guard depth < 80, remainingNodes > 0, !isHidden(element) else { return }
        remainingNodes -= 1
        let role: String = attribute(element, kAXRoleAttribute as CFString) ?? ""
        let children: [AXUIElement] = attribute(element, kAXChildrenAttribute as CFString) ?? []
        if role == (kAXStaticTextRole as String) || role == (kAXHeadingRole as String) {
            if let text = firstTextValue(element), !looksLikeURL(text) { parts.append(text) }
            return
        }
        if role == "AXLink" {
            if children.isEmpty, let text = linkLabel(element), !looksLikeURL(text) { parts.append(text) }
            for child in children {
                collectDisplayText(
                    in: child,
                    depth: depth + 1,
                    remainingNodes: &remainingNodes,
                    includeFileButtons: includeFileButtons,
                    parts: &parts
                )
            }
            return
        }
        if role == (kAXButtonRole as String) || role == (kAXCheckBoxRole as String) {
            if includeFileButtons, let fileLabel = visibleFileLabel(element) { parts.append(fileLabel) }
            return
        }
        if role == (kAXImageRole as String) { return }
        for child in children {
            collectDisplayText(
                in: child,
                depth: depth + 1,
                remainingNodes: &remainingNodes,
                includeFileButtons: includeFileButtons,
                parts: &parts
            )
            if remainingNodes <= 0 { break }
        }
    }

    private func firstTextValue(_ element: AXUIElement) -> String? {
        for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            if let text = stringAttribute(element, name as CFString), !text.isEmpty { return text }
        }
        return nil
    }

    private func linkLabel(_ element: AXUIElement) -> String? {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            if let text = stringAttribute(element, name as CFString), !text.isEmpty, !looksLikeURL(text) {
                return text
            }
        }
        return nil
    }

    private func controlLabel(_ element: AXUIElement) -> String {
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXValueAttribute, kAXIdentifierAttribute]
            .compactMap { stringAttribute(element, $0 as CFString) }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func visibleFileLabel(_ element: AXUIElement) -> String? {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
            guard let text = stringAttribute(element, name as CFString),
                  let label = Self.simplifiedFileLabel(from: text) else { continue }
            return label
        }
        return nil
    }

    private static func simplifiedFileLabel(from raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let lowered = text.lowercased()
        guard !lowered.hasPrefix("http://"),
              !lowered.hasPrefix("https://"),
              !lowered.hasPrefix("file://"),
              !lowered.hasPrefix("codex://") else { return nil }

        let extensions = "md|txt|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|json|yaml|yml|toml|swift|mjs|cjs|js|jsx|ts|tsx|py|rb|rs|go|java|kt|sh|zsh|css|scss|html|htm|xml|sql|png|jpg|jpeg|gif|webp|svg|mp3|wav|mp4|mov"
        let exactPattern = "(?i)^[^\\n]+\\.(?:\(extensions))$"
        if text.range(of: exactPattern, options: .regularExpression) != nil {
            return (text as NSString).lastPathComponent
        }
        let tokenPattern = "(?i)[^/\\\\\\s:：]+\\.(?:\(extensions))"
        guard let range = text.range(of: tokenPattern, options: [.regularExpression, .backwards]) else {
            return nil
        }
        return (String(text[range]) as NSString).lastPathComponent
    }

    private func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
        guard let value: AnyObject = attribute(element, name) else { return nil }
        if let text = value as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let text = value as? NSAttributedString {
            return text.string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private func isHidden(_ element: AXUIElement) -> Bool {
        (attribute(element, kAXHiddenAttribute as CFString) as Bool?) == true
    }

    private func elementMaxY(_ element: AXUIElement) -> CGFloat {
        elementFrame(element).maxY
    }

    private func elementFrame(_ element: AXUIElement) -> CGRect {
        guard let positionValue: AXValue = attribute(element, kAXPositionAttribute as CFString),
              let sizeValue: AXValue = attribute(element, kAXSizeAttribute as CFString) else { return .null }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position),
              AXValueGetValue(sizeValue, .cgSize, &size) else { return .null }
        return CGRect(origin: position, size: size)
    }

    private func looksLikeURL(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.hasPrefix("http://")
            || trimmed.hasPrefix("https://")
            || trimmed.hasPrefix("file://")
            || trimmed.hasPrefix("codex://")
            || trimmed.contains("%2f")
    }

    private func normalize(_ rawParts: [String]) -> String {
        var parts: [String] = []
        for raw in rawParts {
            let text = raw
                .replacingOccurrences(of: "\u{00a0}", with: " ")
                .replacingOccurrences(of: #"[ \t]+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty,
                  !looksLikeURL(text),
                  !isMetadataText(text),
                  !ignoredExactTexts.contains(text.lowercased()) else { continue }
            if parts.last != text { parts.append(text) }
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isMetadataText(_ text: String) -> Bool {
        let lowered = text.lowercased()
        let patterns = [
            #"^\d{1,2}:\d{2}$"#,
            #"^(用时|已处理)\s*\d"#,
            #"^(worked for|processed for)\s*\d"#,
            #"^再显示\s*\d+"#,
            #"^review(ed)?\s"#,
            #"^(thought|explored|exploring)\s"#,
        ]
        return patterns.contains(where: { lowered.range(of: $0, options: .regularExpression) != nil })
    }

    private func attribute<T>(_ element: AXUIElement, _ name: CFString) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success, let value else { return nil }
        return value as? T
    }
}

private func codexShortcutEventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let controller = Unmanaged<CodexShortcutController>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        controller.reenableEventTap()
        return Unmanaged.passUnretained(event)
    }
    if type == .flagsChanged || type == .keyDown {
        if controller.consumeDualCommandScreenshot(event) {
            DispatchQueue.main.async { controller.attachScreenshotToCursor() }
        }
    }
    guard type == .keyDown || type == .keyUp,
          let action = controller.action(for: event) else {
        return Unmanaged.passUnretained(event)
    }
    if action == .lightsOff {
        if type == .keyDown {
            DispatchQueue.main.async { controller.toggleLightsOff() }
        }
        return nil
    }
    guard let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
          supportedShortcutBundleIdentifiers.contains(frontmost) else {
        return Unmanaged.passUnretained(event)
    }
    if action == .dictation, frontmost == cursorBundleIdentifier {
        if type == .keyDown {
            DispatchQueue.main.async { controller.triggerCursorVoiceMode() }
        }
        return nil
    }
    if type == .keyDown {
        DispatchQueue.main.async { controller.perform(action, frontmostBundle: frontmost) }
    }
    return nil
}

final class CodexShortcutController: NSObject, AVAudioPlayerDelegate {
    var onEnsureSpeechService: ((@escaping (Bool) -> Void) -> Void)?
    var onSpeakingChanged: ((Bool) -> Void)?
    var onStatus: ((String) -> Void)?

    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var permissionRetryWorkItem: DispatchWorkItem?
    private var permissionPrompted = false
    private let accessibility = CodexAccessibilityBridge()
    private var chunks: [String] = []
    private var chunkIndex = 0
    private var player: AVAudioPlayer?
    private var request: URLSessionDataTask?
    private var cachedReadAloudSpeaker = readAloudSpeakerFallback
    private lazy var speechSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return URLSession(configuration: configuration)
    }()
    private var readGeneration = 0
    private(set) var isReading = false
    private var readAloudEnabled = true
    private var dictationEnabled = true
    private var agentScreenshotEnabled = true
    private var lightsOffEnabled = true
    private var readAloudKeyCode: Int64 = 47
    private var dictationKeyCode: Int64 = 43
    private var lightsOffKeyCode: Int64 = 53
    private var readAloudFlags: CGEventFlags = [.maskCommand]
    private var dictationFlags: CGEventFlags = [.maskCommand]
    private var lightsOffFlags: CGEventFlags = [.maskCommand]
    private var lastDictationAt: Date?
    private let dictationRepeatLimit: TimeInterval = 0.8
    private var lastLightsOffAt: Date?
    private let lightsOffRepeatLimit: TimeInterval = 0.8
    private var lastScreenshotAt: Date?
    private let screenshotRepeatLimit: TimeInterval = 1.2
    private var bothCommandsWereDown = false
    private var bindingsTimer: Timer?
    private var bindingsRevision = -1
    private let bindingsURL = URL(string: "http://127.0.0.1:5173/api/tools/computer-shortcuts")!

    static func shortcutMappingSelfTest() -> Bool {
        let controller = CodexShortcutController()
        func event(keyCode: CGKeyCode, flags: CGEventFlags) -> CGEvent? {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
            event?.flags = flags
            return event
        }
        guard let comma = event(keyCode: 43, flags: [.maskCommand]),
              let period = event(keyCode: 47, flags: [.maskCommand]),
              let shiftedComma = event(keyCode: 43, flags: [.maskCommand, .maskShift]),
              let barePeriod = event(keyCode: 47, flags: []),
              let lightsOff = event(keyCode: 53, flags: [.maskCommand]),
              let bareLightsOff = event(keyCode: 53, flags: []) else { return false }
        let leftCommand = CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x00000008)
        let bothCommands = CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x00000008 | 0x00000010)
        let bothWithShift = CGEventFlags(rawValue: bothCommands.rawValue | CGEventFlags.maskShift.rawValue)
        return controller.action(for: comma) == .dictation
            && controller.action(for: period) == .readAloud
            && controller.action(for: lightsOff) == .lightsOff
            && controller.action(for: shiftedComma) == nil
            && controller.action(for: barePeriod) == nil
            && controller.action(for: bareLightsOff) == nil
            && controller.consumeDualCommand(flags: leftCommand) == false
            && controller.consumeDualCommand(flags: bothCommands) == false
            && controller.consumeDualCommand(flags: bothWithShift) == true
            && controller.consumeDualCommand(flags: bothWithShift) == false
            && controller.consumeDualCommand(flags: bothCommands) == false
            && controller.consumeDualCommand(flags: []) == false
            && CodexAccessibilityBridge.fileLabelSelfTest()
    }

    func start(promptForPermission: Bool) {
        guard eventTap == nil else { return }
        if !AXIsProcessTrusted(), promptForPermission, !permissionPrompted {
            permissionPrompted = true
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        }
        guard AXIsProcessTrusted() else {
            onStatus?("shortcuts waiting for accessibility permission")
            schedulePermissionRetry()
            return
        }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
            | CGEventMask(1 << CGEventType.keyUp.rawValue)
            | CGEventMask(1 << CGEventType.flagsChanged.rawValue)
        let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: codexShortcutEventCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) ?? CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: codexShortcutEventCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )
        guard let tap else {
            onStatus?("shortcuts unavailable: accessibility or input monitoring permission required")
            schedulePermissionRetry()
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        eventTap = tap
        eventTapSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        refreshShortcutBindings(applyConflicts: true)
        startBindingsTimer()
        onStatus?("agent shortcuts ready: command-period read, command-comma dictate, command-escape lights-off, both-command screenshot")
    }

    func stop() {
        permissionRetryWorkItem?.cancel()
        permissionRetryWorkItem = nil
        bindingsTimer?.invalidate()
        bindingsTimer = nil
        stopReadAloud()
        if let source = eventTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: false) }
        eventTapSource = nil
        eventTap = nil
    }

    private func schedulePermissionRetry() {
        guard permissionRetryWorkItem == nil else { return }
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.permissionRetryWorkItem = nil
            self.start(promptForPermission: false)
        }
        permissionRetryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: workItem)
    }

    fileprivate func reenableEventTap() {
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
    }

    private func startBindingsTimer() {
        bindingsTimer?.invalidate()
        bindingsTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            self?.refreshShortcutBindings(applyConflicts: false)
        }
        bindingsTimer?.tolerance = 1
    }

    private func refreshShortcutBindings(applyConflicts: Bool) {
        var request = URLRequest(url: bindingsURL)
        request.timeoutInterval = 4
        request.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        speechSession.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let native = json?["native"] as? [String: Any]
            let revision = json?["revision"] as? Int ?? 0
            DispatchQueue.main.async {
                if let native { self.applyNativeBindings(native, revision: revision) }
                if applyConflicts { self.applyStoredConflicts() }
            }
        }.resume()
    }

    private func applyNativeBindings(_ native: [String: Any], revision: Int) {
        let read = native["readAloud"] as? [String: Any] ?? [:]
        let dictate = native["dictation"] as? [String: Any] ?? [:]
        let screenshot = native["agentScreenshot"] as? [String: Any] ?? [:]
        let lights = native["lightsOff"] as? [String: Any] ?? [:]
        readAloudEnabled = (read["enabled"] as? Bool) ?? true
        dictationEnabled = (dictate["enabled"] as? Bool) ?? true
        agentScreenshotEnabled = (screenshot["enabled"] as? Bool) ?? true
        lightsOffEnabled = (lights["enabled"] as? Bool) ?? true
        if let keyCode = intValue(read["keyCode"]) { readAloudKeyCode = keyCode }
        if let keyCode = intValue(dictate["keyCode"]) { dictationKeyCode = keyCode }
        if let keyCode = intValue(lights["keyCode"]) { lightsOffKeyCode = keyCode }
        readAloudFlags = eventFlags(from: intValue(read["modifiers"]) ?? (1 << 20))
        dictationFlags = eventFlags(from: intValue(dictate["modifiers"]) ?? (1 << 20))
        lightsOffFlags = eventFlags(from: intValue(lights["modifiers"]) ?? (1 << 20))
        bindingsRevision = revision
    }

    private func applyStoredConflicts() {
        var request = URLRequest(url: bindingsURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        speechSession.dataTask(with: request).resume()
    }

    private func intValue(_ value: Any?) -> Int64? {
        if let number = value as? NSNumber { return number.int64Value }
        if let number = value as? Int { return Int64(number) }
        return nil
    }

    private func eventFlags(from raw: Int64) -> CGEventFlags {
        var flags: CGEventFlags = []
        if raw & (1 << 20) != 0 { flags.insert(.maskCommand) }
        if raw & (1 << 17) != 0 { flags.insert(.maskShift) }
        if raw & (1 << 19) != 0 { flags.insert(.maskAlternate) }
        if raw & (1 << 18) != 0 { flags.insert(.maskControl) }
        return flags
    }

    fileprivate func action(for event: CGEvent) -> CodexShortcutAction? {
        guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { return nil }
        let relevantFlags: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn]
        let flags = event.flags.intersection(relevantFlags)
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flagsWithoutFn = flags.subtracting(.maskSecondaryFn)
        if lightsOffEnabled, keyCode == lightsOffKeyCode, flagsWithoutFn == lightsOffFlags { return .lightsOff }
        if readAloudEnabled, keyCode == readAloudKeyCode, flags == readAloudFlags { return .readAloud }
        if dictationEnabled, keyCode == dictationKeyCode, flags == dictationFlags { return .dictation }
        return nil
    }

    fileprivate func consumeDualCommandScreenshot(_ event: CGEvent) -> Bool {
        consumeDualCommand(flags: event.flags)
    }

    fileprivate func consumeDualCommand(flags: CGEventFlags) -> Bool {
        let leftCommandDeviceFlag: UInt64 = 0x00000008
        let rightCommandDeviceFlag: UInt64 = 0x00000010
        let extras: CGEventFlags = [.maskAlternate, .maskControl, .maskSecondaryFn]
        let bothDown = flags.rawValue & leftCommandDeviceFlag != 0
            && flags.rawValue & rightCommandDeviceFlag != 0
        let chordDown = bothDown
            && flags.contains(.maskShift)
            && flags.intersection(extras).isEmpty
        let fired = agentScreenshotEnabled && chordDown && !bothCommandsWereDown
        bothCommandsWereDown = bothDown && flags.contains(.maskShift)
        return fired
    }

    fileprivate func attachScreenshotToCursor() {
        let now = Date()
        if let lastScreenshotAt, now.timeIntervalSince(lastScreenshotAt) < screenshotRepeatLimit {
            return
        }
        lastScreenshotAt = now
        guard copyMouseDisplayToPasteboard() else {
            onStatus?("screenshot capture failed; grant screen recording if prompted")
            return
        }
        activateCursorThenPaste()
    }

    private func runningCursor() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == cursorBundleIdentifier }
    }

    private func activateCursorThenPaste() {
        pasteWhenChordReleased()
    }

    private func hardwareModifiersHeld() -> Bool {
        let flags = CGEventSource.flagsState(.hidSystemState)
        return flags.contains(.maskCommand) || flags.contains(.maskShift)
    }

    private func pasteWhenChordReleased() {
        let started = Date()
        func attempt() {
            if self.hardwareModifiersHeld() && Date().timeIntervalSince(started) < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: attempt)
                return
            }
            if self.hardwareModifiersHeld() {
                self.onStatus?("screenshot captured; release Shift and Command to paste into Cursor")
                return
            }
            self.bringCursorFrontAndPaste()
        }
        attempt()
    }

    private func bringCursorFrontAndPaste() {
        if let cursor = runningCursor() {
            cursor.activate(options: [.activateIgnoringOtherApps])
            let delay: TimeInterval = cursor.isActive ? 0.08 : 0.28
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.pasteIntoCursorComposer()
            }
            return
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: cursorBundleIdentifier) else {
            onStatus?("screenshot captured; Cursor is not installed")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { [weak self] _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if error != nil {
                    self.onStatus?("screenshot captured; Cursor did not open")
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                    self.pasteIntoCursorComposer()
                }
            }
        }
    }

    private func pasteIntoCursorComposer() {
        postPaste()
        onStatus?("screenshot pasted into \(cursorBundleIdentifier)")
    }

    private func copyMouseDisplayToPasteboard() -> Bool {
        let displayID = displayIDUnderMouse()
        if copyDisplayImageToPasteboard(displayID) { return true }
        if copyDisplayWithScreenCaptureTool(displayID) { return true }
        return copyDisplayWithScreenCaptureTool(nil)
    }

    private func displayIDUnderMouse() -> CGDirectDisplayID {
        let mouse = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }),
           let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            return CGDirectDisplayID(truncating: number)
        }
        return CGMainDisplayID()
    }

    private func copyDisplayImageToPasteboard(_ displayID: CGDirectDisplayID) -> Bool {
        guard let image = CGDisplayCreateImage(displayID) else { return false }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return false }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setData(png, forType: .png)
    }

    private func copyDisplayWithScreenCaptureTool(_ displayID: CGDirectDisplayID?) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        if let displayID, let index = screencaptureDisplayIndex(displayID) {
            process.arguments = ["-x", "-c", "-D", String(index)]
        } else if let displayID {
            process.arguments = ["-x", "-c", "-D", String(displayID)]
        } else {
            process.arguments = ["-x", "-c"]
        }
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return false
        }
        guard process.terminationStatus == 0 else { return false }
        let pasteboard = NSPasteboard.general
        return pasteboard.data(forType: .png) != nil || pasteboard.data(forType: .tiff) != nil
    }

    private func screencaptureDisplayIndex(_ displayID: CGDirectDisplayID) -> Int? {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        guard count > 0 else { return nil }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &displays, &count)
        guard let index = displays.prefix(Int(count)).firstIndex(of: displayID) else { return nil }
        return index + 1
    }

    private func postPaste() {
        guard let source = CGEventSource(stateID: .privateState) else { return }
        let key: CGKeyCode = 9
        let flags: CGEventFlags = [.maskCommand]
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { return }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    fileprivate func triggerCursorVoiceMode() {
        guard acceptDictationPress() else { return }
        onStatus?("dictation posted to Cursor voice mode")
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        let key: CGKeyCode = 49
        let flags: CGEventFlags = [.maskCommand, .maskShift]
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { return }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    fileprivate func toggleLightsOff() {
        let now = Date()
        if let lastLightsOffAt, now.timeIntervalSince(lastLightsOffAt) < lightsOffRepeatLimit {
            return
        }
        lastLightsOffAt = now
        var toggle = URLRequest(url: lightsOffURL)
        toggle.httpMethod = "POST"
        toggle.timeoutInterval = 8
        toggle.setValue("application/json", forHTTPHeaderField: "Content-Type")
        toggle.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        toggle.httpBody = try? JSONSerialization.data(withJSONObject: ["toggle": true])
        speechSession.dataTask(with: toggle) { [weak self] _, _, error in
            DispatchQueue.main.async {
                if error != nil {
                    self?.onStatus?("lights-off toggle failed")
                } else {
                    self?.onStatus?("lights-off toggled")
                }
            }
        }.resume()
    }

    fileprivate func perform(_ action: CodexShortcutAction, frontmostBundle: String) {
        switch action {
        case .lightsOff:
            toggleLightsOff()
        case .readAloud:
            isReading ? stopReadAloud() : beginReadAloud()
        case .dictation:
            guard acceptDictationPress() else { return }
            if isReading { stopReadAloud() }
            do {
                let label = try accessibility.pressDictationButton()
                onStatus?("dictation clicked in \(frontmostBundle) control=\(label)")
            } catch {
                onStatus?("dictation control unavailable in \(frontmostBundle)")
            }
        }
    }

    private func acceptDictationPress() -> Bool {
        let now = Date()
        if let lastDictationAt, now.timeIntervalSince(lastDictationAt) < dictationRepeatLimit {
            return false
        }
        lastDictationAt = now
        return true
    }

    private func beginReadAloud() {
        do {
            chunks = makeChunks(try accessibility.readLatestAssistantReply())
        } catch {
            onStatus?("read aloud could not find the current reply")
            return
        }
        guard !chunks.isEmpty else {
            onStatus?("read aloud found no visible text")
            return
        }
        readGeneration += 1
        let generation = readGeneration
        isReading = true
        chunkIndex = 0
        onSpeakingChanged?(true)
        onStatus?("read aloud captured current visible reply")
        guard let ensureService = onEnsureSpeechService else {
            failReadAloud("speech service callback unavailable")
            return
        }
        ensureService { [weak self] ready in
            guard let self, self.isReading, self.readGeneration == generation else { return }
            guard ready else {
                self.failReadAloud("speech service did not become ready")
                return
            }
            self.resolveReadAloudSpeaker { speaker in
                guard self.isReading, self.readGeneration == generation else { return }
                self.cachedReadAloudSpeaker = speaker
                self.requestCurrentChunk(generation: generation)
            }
        }
    }

    private func resolveReadAloudSpeaker(completion: @escaping (String) -> Void) {
        var urlRequest = URLRequest(url: secretaryStateURL)
        urlRequest.httpMethod = "GET"
        urlRequest.timeoutInterval = 4
        urlRequest.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        speechSession.dataTask(with: urlRequest) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                var speaker = self?.cachedReadAloudSpeaker ?? readAloudSpeakerFallback
                if let data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let id = json["activeSecretaryId"] as? String,
                   readAloudSpeakerIDs.contains(id) {
                    speaker = id
                }
                completion(speaker)
            }
        }.resume()
    }

    private func stopReadAloud() {
        guard isReading || request != nil || player != nil else { return }
        readGeneration += 1
        isReading = false
        request?.cancel()
        request = nil
        player?.stop()
        player = nil
        clearReadBuffer()
        onSpeakingChanged?(false)
        onStatus?("read aloud stopped")
    }

    private func requestCurrentChunk(generation: Int) {
        guard isReading, readGeneration == generation, chunkIndex < chunks.count else {
            finishReadAloud(generation: generation)
            return
        }
        var urlRequest = URLRequest(url: codexReadAloudURL)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        urlRequest.httpBody = try? JSONSerialization.data(withJSONObject: [
            "text": chunks[chunkIndex],
            "speaker": cachedReadAloudSpeaker,
            "provider": "edge",
        ])
        request = speechSession.dataTask(with: urlRequest) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, self.isReading, self.readGeneration == generation else { return }
                guard error == nil,
                      let http = response as? HTTPURLResponse,
                      http.statusCode == 200,
                      let data,
                      !data.isEmpty else {
                    self.failReadAloud("speech request failed")
                    return
                }
                do {
                    let player = try AVAudioPlayer(data: data)
                    self.player = player
                    self.request = nil
                    player.delegate = self
                    player.prepareToPlay()
                    guard player.play() else {
                        self.failReadAloud("audio player did not start")
                        return
                    }
                    self.onStatus?("read aloud playing chunk \(self.chunkIndex + 1) of \(self.chunks.count)")
                } catch {
                    self.failReadAloud("audio response could not be played")
                }
            }
        }
        request?.resume()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isReading else { return }
            let generation = self.readGeneration
            self.chunkIndex += 1
            self.requestCurrentChunk(generation: generation)
        }
    }

    private func finishReadAloud(generation: Int) {
        guard isReading, readGeneration == generation else { return }
        isReading = false
        request = nil
        player = nil
        clearReadBuffer()
        onSpeakingChanged?(false)
        onStatus?("read aloud finished")
    }

    private func failReadAloud(_ reason: String) {
        readGeneration += 1
        isReading = false
        request?.cancel()
        request = nil
        player?.stop()
        player = nil
        clearReadBuffer()
        onSpeakingChanged?(false)
        onStatus?("read aloud failed: \(reason)")
    }

    private func clearReadBuffer() {
        chunks.removeAll(keepingCapacity: false)
        chunkIndex = 0
    }

    private func makeChunks(_ raw: String) -> [String] {
        var result: [String] = []
        var buffer = ""
        let breaks = CharacterSet(charactersIn: "。！？!?；;\n")
        for scalar in raw.unicodeScalars {
            buffer.unicodeScalars.append(scalar)
            let canBreak = breaks.contains(scalar)
            if (buffer.count >= 560 && canBreak) || buffer.count >= 740 {
                let chunk = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
                if !chunk.isEmpty { result.append(chunk) }
                buffer = ""
            }
        }
        let tail = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { result.append(tail) }
        return result
    }
}
