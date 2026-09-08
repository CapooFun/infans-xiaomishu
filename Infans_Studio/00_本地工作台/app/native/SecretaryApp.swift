import AppKit
import AVFoundation
import Foundation
import QuartzCore
import Speech
import WebKit

private let workbenchURL = URL(string: "http://localhost:5173/")!
private let legacyWorkbenchURL = URL(string: "http://127.0.0.1:5173/")!
private let healthURL = URL(string: "http://127.0.0.1:5173/api/health")!
private let workbenchOriginMigrationKey = "secretary.workbench-origin.localhost.v1"
private let displayModeStorageKey = "infans-display-mode-v1"
private let petWindowScale: CGFloat = 0.7
private let petWindowSize = NSSize(
    width: 168 * petWindowScale,
    height: 182 * petWindowScale
)
private let petPositionXKey = "secretary.pet.origin.x"
private let petPositionYKey = "secretary.pet.origin.y"

private struct PetAnimationManifest: Decodable {
    let cellWidth: Int
    let cellHeight: Int
    let columns: Int
    let rows: Int
    let animations: [PetAnimation]
}

private struct PetAnimation: Decodable {
    let id: String
    let row: Int
    let frameCount: Int
    let durationsMs: [Int]
    let loop: Bool
    let fallback: String
}

private struct PetVideoManifest: Decodable {
    let version: Int
    let canvasWidth: Int
    let canvasHeight: Int
    let fps: Int
    let clips: [PetVideoClip]
}

private struct PetVideoClip: Decodable {
    let id: String
    let file: String
    let fps: Int
    let frameCount: Int
    let loop: Bool
}

private final class PetVideoSlot: NSObject {
    let clip: PetVideoClip
    let player = AVQueuePlayer()
    let playerLayer: AVPlayerLayer
    private var asset: AVURLAsset?
    private var looper: AVPlayerLooper?
    private var currentItemObservation: NSKeyValueObservation?
    private var itemStatusObservation: NSKeyValueObservation?
    private var displayObservation: NSKeyValueObservation?
    private var playerStatusObservation: NSKeyValueObservation?
    private var looperStatusObservation: NSKeyValueObservation?
    private var notificationObservers: [NSObjectProtocol] = []
    private var preparationCompletion: ((Bool) -> Void)?
    private var preparationFinished = false
    private var prerollStarted = false
    private var invalidated = false

    var ready = false
    var onPlaybackEnded: (() -> Void)?
    var onPlaybackFailed: ((String) -> Void)?

    init(clip: PetVideoClip) {
        self.clip = clip
        playerLayer = AVPlayerLayer(player: player)
        super.init()
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
        player.actionAtItemEnd = clip.loop ? .advance : .pause
        playerLayer.videoGravity = .resizeAspect
        playerLayer.backgroundColor = NSColor.clear.cgColor
        playerLayer.isOpaque = false
        playerLayer.opacity = 0
        playerStatusObservation = player.observe(\.status, options: [.new]) { [weak self] player, _ in
            guard player.status == .failed else { return }
            self?.reportFailure("player failed")
        }
    }

    deinit {
        invalidate()
    }

    func prepare(url: URL, completion: @escaping (Bool) -> Void) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?.prepare(url: url, completion: completion)
            }
            return
        }
        guard !invalidated, preparationCompletion == nil else {
            completion(false)
            return
        }
        preparationCompletion = completion
        let asset = AVURLAsset(url: url)
        self.asset = asset
        asset.loadValuesAsynchronously(forKeys: ["duration", "playable"]) { [weak self, weak asset] in
            DispatchQueue.main.async {
                guard let self, let asset, !self.invalidated else { return }
                var durationError: NSError?
                var playableError: NSError?
                let durationStatus = asset.statusOfValue(forKey: "duration", error: &durationError)
                let playableStatus = asset.statusOfValue(forKey: "playable", error: &playableError)
                guard
                    durationStatus == .loaded,
                    playableStatus == .loaded,
                    asset.isPlayable,
                    asset.duration.isValid,
                    asset.duration.isNumeric,
                    asset.duration.seconds > 0
                else {
                    self.finishPreparation(false)
                    return
                }
                self.installPlayerItem(asset: asset)
            }
        }
    }

    func seekToStart(completion: @escaping (Bool) -> Void) {
        guard ready, !invalidated, player.currentItem != nil else {
            completion(false)
            return
        }
        player.pause()
        player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, !self.invalidated else { return }
                completion(finished)
            }
        }
    }

    func play() {
        guard ready else { return }
        player.playImmediately(atRate: 1)
    }

    func pause() {
        player.pause()
    }

    func invalidate() {
        guard !invalidated else { return }
        invalidated = true
        preparationCompletion = nil
        currentItemObservation = nil
        itemStatusObservation = nil
        displayObservation = nil
        playerStatusObservation = nil
        looperStatusObservation = nil
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        notificationObservers.removeAll()
        looper = nil
        player.pause()
        player.removeAllItems()
        asset = nil
    }

    private func installPlayerItem(asset: AVURLAsset) {
        guard !invalidated else { return }
        let template = AVPlayerItem(asset: asset)
        template.preferredForwardBufferDuration = 0.25
        if clip.loop {
            let looper = AVPlayerLooper(player: player, templateItem: template)
            self.looper = looper
            looperStatusObservation = looper.observe(\.status, options: [.new]) { [weak self] looper, _ in
                guard looper.status == .failed else { return }
                self?.reportFailure("looper failed")
            }
            waitForCurrentItem()
        } else {
            player.insert(template, after: nil)
            prepareCurrentItem(template)
        }
    }

    private func waitForCurrentItem() {
        if let item = player.currentItem {
            prepareCurrentItem(item)
            return
        }
        currentItemObservation = player.observe(\.currentItem, options: [.new]) { [weak self] player, _ in
            guard let self, let item = player.currentItem else { return }
            self.currentItemObservation = nil
            self.prepareCurrentItem(item)
        }
        if let item = player.currentItem {
            currentItemObservation = nil
            prepareCurrentItem(item)
        }
    }

    private func prepareCurrentItem(_ item: AVPlayerItem) {
        guard !invalidated, !prerollStarted else { return }
        installPlaybackNotifications(for: item)
        itemStatusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            self?.handleItemStatus(item)
        }
        handleItemStatus(item)
    }

    private func handleItemStatus(_ item: AVPlayerItem) {
        guard !invalidated else { return }
        switch item.status {
        case .readyToPlay:
            startPreroll()
        case .failed:
            reportFailure("item failed")
        default:
            break
        }
    }

    private func startPreroll() {
        guard !invalidated, !prerollStarted else { return }
        prerollStarted = true
        player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            guard let self else { return }
            guard finished else {
                DispatchQueue.main.async { self.finishPreparation(false) }
                return
            }
            self.player.preroll(atRate: 1) { [weak self] success in
                DispatchQueue.main.async {
                    guard let self, !self.invalidated, success else {
                        self?.finishPreparation(false)
                        return
                    }
                    if self.playerLayer.isReadyForDisplay {
                        self.finishPreparation(true)
                        return
                    }
                    self.displayObservation = self.playerLayer.observe(
                        \.isReadyForDisplay,
                        options: [.new]
                    ) { [weak self] layer, _ in
                        guard let self, layer.isReadyForDisplay else { return }
                        self.finishPreparation(true)
                    }
                    if self.playerLayer.isReadyForDisplay {
                        self.finishPreparation(true)
                    }
                }
            }
        }
    }

    private func installPlaybackNotifications(for initialItem: AVPlayerItem) {
        let center = NotificationCenter.default
        notificationObservers.append(center.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self, self.owns(notification.object as? AVPlayerItem) else { return }
            self.reportFailure("failed to play to end")
        })
        notificationObservers.append(center.addObserver(
            forName: .AVPlayerItemPlaybackStalled,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self, self.owns(notification.object as? AVPlayerItem) else { return }
            self.reportFailure("playback stalled")
        })
        if !clip.loop {
            notificationObservers.append(center.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: initialItem,
                queue: .main
            ) { [weak self] _ in
                self?.onPlaybackEnded?()
            })
        }
    }

    private func owns(_ item: AVPlayerItem?) -> Bool {
        guard let item else { return false }
        return player.currentItem === item || player.items().contains(where: { $0 === item })
    }

    private func reportFailure(_ reason: String) {
        guard !invalidated else { return }
        if preparationFinished {
            onPlaybackFailed?(reason)
        } else {
            finishPreparation(false)
        }
    }

    private func finishPreparation(_ success: Bool) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?.finishPreparation(success)
            }
            return
        }
        guard !invalidated, !preparationFinished else { return }
        preparationFinished = true
        ready = success
        let completion = preparationCompletion
        preparationCompletion = nil
        currentItemObservation = nil
        displayObservation = nil
        completion?(success)
    }
}

private final class SecretaryPetView: NSView {
    var onActivate: (() -> Void)?
    var menuProvider: (() -> NSMenu)?
    var onPositionChanged: ((NSPoint) -> Void)?

    private let manifest: PetAnimationManifest
    private let frames: [String: [NSImage]]
    private var videoSlots: [String: PetVideoSlot] = [:]
    private var videoEnabled = false
    private var activeVideoID: String?
    private var videoPreparationGeneration = 0
    private var videoTransitionGeneration = 0
    private var videoReadyCount = 0
    private var videoExpectedCount = 0
    private var animationTimer: Timer?
    private var drawsAtlas = true
    private var animationID = "idle"
    private var frameIndex = 0
    private var hovering = false
    private var dragging = false
    private var launching = false
    private var speaking = false
    private var dragStartMouse = NSPoint.zero
    private var dragStartWindowOrigin = NSPoint.zero
    private var movedDuringDrag = false
    private var trackingAreaRef: NSTrackingArea?

    init?(
        frame: NSRect,
        atlasURL: URL,
        manifestURL: URL,
        videoManifestURL: URL?,
        videoDirectoryURL: URL?
    ) {
        guard
            let manifestData = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(PetAnimationManifest.self, from: manifestData),
            let atlasImage = NSImage(contentsOf: atlasURL),
            let atlasCG = atlasImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else {
            return nil
        }

        self.manifest = manifest
        var decodedFrames: [String: [NSImage]] = [:]
        for animation in manifest.animations {
            decodedFrames[animation.id] = (0..<animation.frameCount).compactMap { column in
                let rect = CGRect(
                    x: column * manifest.cellWidth,
                    y: animation.row * manifest.cellHeight,
                    width: manifest.cellWidth,
                    height: manifest.cellHeight
                )
                guard let cropped = atlasCG.cropping(to: rect) else { return nil }
                return NSImage(
                    cgImage: cropped,
                    size: NSSize(width: manifest.cellWidth, height: manifest.cellHeight)
                )
            }
        }
        self.frames = decodedFrames
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.isOpaque = false
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("小秘书，打开工作台")
        configureVideo(
            manifestURL: videoManifestURL,
            directoryURL: videoDirectoryURL
        )
        startAnimation("idle")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        animationTimer?.invalidate()
        videoPreparationGeneration += 1
        videoSlots.values.forEach { $0.invalidate() }
    }

    override var acceptsFirstResponder: Bool { false }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        videoSlots.values.forEach { $0.playerLayer.frame = bounds }
        CATransaction.commit()
    }

    override func updateTrackingAreas() {
        if let trackingAreaRef {
            removeTrackingArea(trackingAreaRef)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingAreaRef = area
        super.updateTrackingAreas()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        dirtyRect.fill(using: .copy)
        guard drawsAtlas else { return }
        guard let image = frames[animationID]?[safe: frameIndex] else { return }
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(
            in: bounds,
            from: NSRect(origin: .zero, size: image.size),
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: true,
            hints: [.interpolation: NSImageInterpolation.high]
        )
    }

    func setSpeaking(_ active: Bool) {
        speaking = active
        resolveState()
    }

    func playLaunching() {
        guard !launching else { return }
        launching = true
        resolveState()
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        resolveState()
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        resolveState()
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        dragStartMouse = NSEvent.mouseLocation
        dragStartWindowOrigin = window.frame.origin
        movedDuringDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        let mouse = NSEvent.mouseLocation
        let deltaX = mouse.x - dragStartMouse.x
        let deltaY = mouse.y - dragStartMouse.y
        if !movedDuringDrag && hypot(deltaX, deltaY) < 5 { return }
        movedDuringDrag = true
        dragging = true
        let origin = NSPoint(x: dragStartWindowOrigin.x + deltaX, y: dragStartWindowOrigin.y + deltaY)
        window.setFrameOrigin(origin)
        startAnimation(deltaX >= 0 ? "dragging-right" : "dragging-left")
    }

    override func mouseUp(with event: NSEvent) {
        if movedDuringDrag {
            dragging = false
            if let origin = window?.frame.origin {
                onPositionChanged?(origin)
            }
            resolveState()
            return
        }
        playLaunching()
        onActivate?()
    }

    override func rightMouseDown(with event: NSEvent) {
        guard let menu = menuProvider?() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    private func resolveState() {
        if dragging { return }
        if launching {
            startAnimation("launching")
        } else if speaking {
            startAnimation("talking")
        } else if hovering {
            startAnimation("hover")
        } else {
            startAnimation("idle")
        }
    }

    private func startAnimation(_ id: String) {
        guard animationID != id || (animationTimer == nil && activeVideoID != id) else { return }
        animationTimer?.invalidate()
        animationID = id
        frameIndex = 0
        needsDisplay = true
        scheduleNextFrame()
        activateVideoIfReady(id)
    }

    private func scheduleNextFrame() {
        animationTimer?.invalidate()
        guard
            let animation = manifest.animations.first(where: { $0.id == animationID }),
            animation.frameCount > 0
        else { return }
        let durationIndex = min(frameIndex, animation.durationsMs.count - 1)
        let duration = animation.durationsMs.isEmpty ? 100 : animation.durationsMs[durationIndex]
        let timer = Timer(timeInterval: Double(duration) / 1000, repeats: false) { [weak self] _ in
            self?.advanceFrame()
        }
        animationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func advanceFrame() {
        guard let animation = manifest.animations.first(where: { $0.id == animationID }) else { return }
        if frameIndex + 1 < animation.frameCount {
            frameIndex += 1
            needsDisplay = true
            scheduleNextFrame()
            return
        }
        if animation.loop {
            frameIndex = 0
            needsDisplay = true
            scheduleNextFrame()
            return
        }
        if animationID == "launching" {
            launching = false
            resolveState()
        } else {
            startAnimation(animation.fallback)
        }
    }

    private func configureVideo(manifestURL: URL?, directoryURL: URL?) {
        guard !CommandLine.arguments.contains("--pet-renderer=atlas") else {
            NSLog("Secretary: forced atlas pet renderer")
            return
        }
        guard
            let manifestURL,
            let directoryURL,
            let data = try? Data(contentsOf: manifestURL),
            let videoManifest = try? JSONDecoder().decode(PetVideoManifest.self, from: data),
            videoManifest.version == 1,
            videoManifest.canvasWidth == 384,
            videoManifest.canvasHeight == 416,
            videoManifest.fps == 30
        else {
            NSLog("Secretary: transparent pet video package unavailable; using atlas")
            return
        }
        let expectedIDs = Set(manifest.animations.map(\.id))
        let clipIDs = Set(videoManifest.clips.map(\.id))
        guard
            videoManifest.clips.count == expectedIDs.count,
            clipIDs == expectedIDs,
            videoManifest.clips.allSatisfy({ clip in
                clip.fps == 30
                    && clip.frameCount > 0
                    && manifest.animations.first(where: { $0.id == clip.id })?.loop == clip.loop
                    && FileManager.default.fileExists(
                        atPath: directoryURL.appendingPathComponent(clip.file).path
                    )
            })
        else {
            NSLog("Secretary: incomplete transparent pet video package; using atlas")
            return
        }

        videoEnabled = true
        videoPreparationGeneration += 1
        videoReadyCount = 0
        videoExpectedCount = videoManifest.clips.count
        let generation = videoPreparationGeneration
        for clip in videoManifest.clips {
            let slot = PetVideoSlot(clip: clip)
            slot.playerLayer.frame = bounds
            layer?.addSublayer(slot.playerLayer)
            slot.onPlaybackEnded = { [weak self] in
                guard
                    let self,
                    self.videoEnabled,
                    self.activeVideoID == clip.id,
                    self.animationID == "launching"
                else { return }
                self.launching = false
                self.resolveState()
            }
            slot.onPlaybackFailed = { [weak self] reason in
                self?.disableVideo(reason: "\(clip.id): \(reason)")
            }
            videoSlots[clip.id] = slot
            let url = directoryURL.appendingPathComponent(clip.file)
            slot.prepare(url: url) { [weak self] success in
                guard let self, generation == self.videoPreparationGeneration else { return }
                guard success else {
                    self.disableVideo(reason: "clip failed: \(clip.id)")
                    return
                }
                self.videoReadyCount += 1
                if self.videoReadyCount == self.videoExpectedCount {
                    NSLog("Secretary: transparent pet video ready (\(self.videoReadyCount) clips, 30 fps)")
                    self.activateVideoIfReady(self.animationID)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard
                let self,
                self.videoEnabled,
                generation == self.videoPreparationGeneration,
                self.videoSlots.values.contains(where: { !$0.ready })
            else { return }
            self.disableVideo(reason: "preload timeout")
        }
    }

    private func activateVideoIfReady(_ id: String) {
        guard videoEnabled, let next = videoSlots[id], next.ready else { return }
        if activeVideoID == id {
            animationTimer?.invalidate()
            animationTimer = nil
            return
        }
        videoTransitionGeneration += 1
        let generation = videoTransitionGeneration
        next.seekToStart { [weak self, weak next] success in
            guard
                let self,
                let next,
                success,
                self.videoEnabled,
                generation == self.videoTransitionGeneration,
                self.animationID == id
            else { return }
            let previous = self.activeVideoID.flatMap { self.videoSlots[$0] }
            self.drawsAtlas = false
            self.needsDisplay = true
            self.displayIfNeeded()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            next.playerLayer.opacity = 1
            previous?.playerLayer.opacity = 0
            CATransaction.commit()
            self.activeVideoID = id
            next.play()
            previous?.pause()
            self.animationTimer?.invalidate()
            self.animationTimer = nil
        }
    }

    private func disableVideo(reason: String) {
        guard videoEnabled else { return }
        videoEnabled = false
        videoPreparationGeneration += 1
        videoTransitionGeneration += 1
        frameIndex = 0
        drawsAtlas = true
        needsDisplay = true
        displayIfNeeded()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        videoSlots.values.forEach { $0.playerLayer.opacity = 0 }
        CATransaction.commit()
        videoSlots.values.forEach { $0.invalidate() }
        activeVideoID = nil
        scheduleNextFrame()
        NSLog("Secretary: transparent pet video disabled (\(reason)); using atlas")
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private enum WorkbenchOriginMigrationState {
        case idle
        case loadingLegacy
        case loadingLocalhost
        case complete
    }

    private var workbenchWindow: NSWindow?
    private var petWindow: NSPanel?
    private var petView: SecretaryPetView?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private let calendarReader = CalendarReaderService()
    private var healthAttempts = 0
    private var healthGeneration = 0
    private var requestedFullScreen = false
    private var workbenchRequested = false
    private var workbenchOriginMigrationState: WorkbenchOriginMigrationState = .idle
    private let nativeSpeechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let nativeSpeechEngine = AVAudioEngine()
    private var nativeSpeechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var nativeSpeechTask: SFSpeechRecognitionTask?
    private var nativeSpeechTapInstalled = false
    private var nativeSpeechStartPending = false
    private var lastNativeTranscript = ""
    private var nativeSpeechSilenceWorkItem: DispatchWorkItem?
    private var guidePrintOperation: NSPrintOperation?
    private var codexShortcutController: CodexShortcutController?
    private var workbenchSpeechActive = false
    private var codexReadAloudActive = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if ProcessInfo.processInfo.environment["INFANS_CALENDAR_OS"] == "1",
           let cache = ProcessInfo.processInfo.environment["INFANS_CALENDAR_CACHE_DIR"], !cache.isEmpty {
            calendarReader.start()
        }
        configureMenu()
        createPetWindow()
        configureCodexShortcuts()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenConfigurationChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        if !CommandLine.arguments.contains("--pet-only") {
            openWorkbench()
        } else {
            log("native: pet-only mode ready")
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        calendarReader.requestPermissionIfNeeded()
        showPet()
        openWorkbench()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        calendarReader.stop()
        NotificationCenter.default.removeObserver(self)
        codexShortcutController?.stop()
        cleanupNativeSpeechRecognition(cancelTask: true)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "secretaryPet")
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "打开工作台", action: #selector(openWorkbenchFromMenu), keyEquivalent: "o")
        appMenu.addItem(withTitle: "显示浮动小秘书", action: #selector(showPetFromMenu), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出小秘书", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        func addResponderItem(
            _ title: String,
            action: Selector,
            key: String,
            modifiers: NSEvent.ModifierFlags = [.command]
        ) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.target = nil
            editMenu.addItem(item)
        }
        addResponderItem("撤销", action: Selector(("undo:")), key: "z")
        addResponderItem("重做", action: Selector(("redo:")), key: "z", modifiers: [.command, .shift])
        editMenu.addItem(.separator())
        addResponderItem("剪切", action: #selector(NSText.cut(_:)), key: "x")
        addResponderItem("复制", action: #selector(NSText.copy(_:)), key: "c")
        addResponderItem("粘贴", action: #selector(NSText.paste(_:)), key: "v")
        editMenu.addItem(.separator())
        addResponderItem("全选", action: #selector(NSText.selectAll(_:)), key: "a")
        editMenuItem.submenu = editMenu

        let navigationMenuItem = NSMenuItem()
        mainMenu.addItem(navigationMenuItem)
        let navigationMenu = NSMenu(title: "导航")
        func addWorkbenchShortcut(_ title: String, key: String, command: String) {
            let item = NSMenuItem(title: title, action: #selector(performWorkbenchShortcut(_:)), keyEquivalent: key)
            item.keyEquivalentModifierMask = [.command]
            item.target = self
            item.representedObject = command
            navigationMenu.addItem(item)
        }
        for slot in 1...6 {
            addWorkbenchShortcut("打开书签 \(slot)", key: String(slot), command: "bookmark-\(slot)")
        }
        navigationMenu.addItem(.separator())
        addWorkbenchShortcut("返回上一页", key: "[", command: "history-back")
        addWorkbenchShortcut("前进下一页", key: "]", command: "history-forward")
        addWorkbenchShortcut("显示或隐藏侧边栏", key: "`", command: "toggle-sidebar")
        navigationMenuItem.submenu = navigationMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "重新载入工作台", action: #selector(reloadWorkbench), keyEquivalent: "r")
        viewMenuItem.submenu = viewMenu
        NSApp.mainMenu = mainMenu
    }

    private func createPetWindow() {
        guard petWindow == nil else {
            showPet()
            return
        }
        let videoDirectoryURL = Bundle.main.resourceURL?
            .appendingPathComponent("secretary-pet-video", isDirectory: true)
        let videoManifestURL = videoDirectoryURL?
            .appendingPathComponent("video-manifest.json", isDirectory: false)
        guard
            let atlasURL = Bundle.main.url(forResource: "secretary-pet-atlas", withExtension: "png"),
            let manifestURL = Bundle.main.url(forResource: "animation-manifest", withExtension: "json"),
            let petView = SecretaryPetView(
                frame: NSRect(origin: .zero, size: petWindowSize),
                atlasURL: atlasURL,
                manifestURL: manifestURL,
                videoManifestURL: videoManifestURL,
                videoDirectoryURL: videoDirectoryURL
            )
        else {
            log("native: pet assets missing or invalid")
            return
        }

        let panel = NSPanel(
            contentRect: NSRect(origin: restoredPetOrigin(), size: petWindowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.contentView = petView
        panel.isReleasedWhenClosed = false

        petView.onActivate = { [weak self] in self?.openWorkbench() }
        petView.onPositionChanged = { [weak self] origin in self?.savePetOrigin(origin) }
        petView.menuProvider = { [weak self] in self?.makePetMenu() ?? NSMenu() }
        petWindow = panel
        self.petView = petView
        clampPetWindowToVisibleScreen()
        panel.orderFrontRegardless()
        log("native: floating pet ready")
        if let debugStateArgument = CommandLine.arguments.first(where: { $0.hasPrefix("--pet-state=") }) {
            let debugState = String(debugStateArgument.dropFirst("--pet-state=".count))
            switch debugState {
            case "talking":
                petView.setSpeaking(true)
            case "launching":
                petView.playLaunching()
            default:
                log("native: ignored unknown pet debug state \(debugState)")
            }
        }
    }

    private func makePetMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(withTitle: "打开工作台", action: #selector(openWorkbenchFromMenu), keyEquivalent: "")
        menu.addItem(withTitle: "暂时收起", action: #selector(hidePetFromMenu), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出小秘书", action: #selector(quitSecretary), keyEquivalent: "")
        for item in menu.items where item.action != nil {
            item.target = self
        }
        return menu
    }

    @objc private func openWorkbenchFromMenu() {
        openWorkbench()
    }

    @objc private func showPetFromMenu() {
        showPet()
    }

    @objc private func hidePetFromMenu() {
        petWindow?.orderOut(nil)
    }

    @objc private func quitSecretary() {
        NSApp.terminate(nil)
    }

    private func showPet() {
        if petWindow == nil {
            createPetWindow()
        }
        clampPetWindowToVisibleScreen()
        petWindow?.orderFrontRegardless()
    }

    private func configureCodexShortcuts() {
        let controller = CodexShortcutController()
        controller.onEnsureSpeechService = { [weak self] completion in
            guard let self else {
                completion(false)
                return
            }
            self.ensureSpeechService(completion: completion)
        }
        controller.onSpeakingChanged = { [weak self] active in
            guard let self else { return }
            self.codexReadAloudActive = active
            self.updatePetSpeakingState()
        }
        controller.onStatus = { [weak self] message in
            self?.log("native: \(message)")
        }
        codexShortcutController = controller
        controller.start(promptForPermission: true)
    }

    @objc private func screenConfigurationChanged() {
        clampPetWindowToVisibleScreen()
    }

    private func restoredPetOrigin() -> NSPoint {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: petPositionXKey) != nil, defaults.object(forKey: petPositionYKey) != nil {
            return NSPoint(x: defaults.double(forKey: petPositionXKey), y: defaults.double(forKey: petPositionYKey))
        }
        let frame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: frame.maxX - petWindowSize.width - 28, y: frame.minY + 24)
    }

    private func savePetOrigin(_ origin: NSPoint) {
        UserDefaults.standard.set(origin.x, forKey: petPositionXKey)
        UserDefaults.standard.set(origin.y, forKey: petPositionYKey)
    }

    private func clampPetWindowToVisibleScreen() {
        guard let panel = petWindow else { return }
        let currentFrame = panel.frame
        let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(currentFrame.insetBy(dx: 24, dy: 24)) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        let x = min(max(currentFrame.minX, visible.minX), visible.maxX - currentFrame.width)
        let y = min(max(currentFrame.minY, visible.minY), visible.maxY - currentFrame.height)
        let origin = NSPoint(x: x, y: y)
        panel.setFrameOrigin(origin)
        savePetOrigin(origin)
    }

    func openWorkbench() {
        showPet()
        petView?.playLaunching()
        if workbenchWindow == nil {
            createWorkbenchWindow()
        }
        guard let window = workbenchWindow else { return }
        workbenchRequested = true
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)

        checkWorkbenchHealth { [weak self] ready in
            guard let self else { return }
            if ready {
                self.loadWorkbenchAndPresent()
            } else {
                self.startWorkbenchService()
                self.beginWaitingForWorkbench()
            }
        }

        if !window.styleMask.contains(.fullScreen) {
            placeWindowAndEnterFullScreen()
        }
    }

    private func createWorkbenchWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        configuration.userContentController.add(self, name: "secretaryPet")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        showLoadingPage(in: webView)

        let initialFrame = preferredScreen()?.visibleFrame ?? NSRect(x: 80, y: 80, width: 1280, height: 800)
        let window = NSWindow(
            contentRect: initialFrame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "小秘书"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.024, green: 0.051, blue: 0.063, alpha: 1)
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrame(initialFrame, display: false)

        workbenchWindow = window
        self.webView = webView
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
            self?.placeWindowAndEnterFullScreen()
        }
    }

    @objc private func reloadWorkbench() {
        webView?.reloadFromOrigin()
    }

    @objc private func performWorkbenchShortcut(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? String else { return }
        publishWorkbenchShortcut(command)
    }

    private func publishWorkbenchShortcut(_ command: String) {
        let allowed = Set([
            "bookmark-1", "bookmark-2", "bookmark-3", "bookmark-4", "bookmark-5", "bookmark-6",
            "history-back", "history-forward", "toggle-sidebar",
        ])
        guard allowed.contains(command),
              let data = try? JSONSerialization.data(withJSONObject: ["command": command]),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('infans:workbench-shortcut',{detail:\(json)}));"
        )
    }

    private func preferredScreen() -> NSScreen? {
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return nil }
        let primaryID = CGMainDisplayID()
        let externalScreens = screens.filter { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                return screen != NSScreen.main
            }
            return CGDirectDisplayID(number.uint32Value) != primaryID
        }
        return externalScreens.max {
            ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height)
        } ?? screens.first
    }

    private func placeWindowAndEnterFullScreen() {
        guard workbenchRequested, let window = workbenchWindow, !window.styleMask.contains(.fullScreen) else { return }
        guard let screen = preferredScreen() else { return }
        requestedFullScreen = true
        window.setFrame(screen.visibleFrame, display: true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak window] in
            guard let self, let window, !window.styleMask.contains(.fullScreen) else { return }
            window.toggleFullScreen(nil)
            self.log(
                "native: requested system fullscreen screen=\(Int(screen.frame.width))x\(Int(screen.frame.height))@\(Int(screen.frame.minX)),\(Int(screen.frame.minY))"
            )
        }
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        requestedFullScreen = false
        log("native: entered system fullscreen")
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        requestedFullScreen = false
        log("native: FAILED to enter system fullscreen")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.placeWindowAndEnterFullScreen()
        }
    }

    private func workbenchDirectory() -> URL? {
        let bundleURL = Bundle.main.bundleURL.resolvingSymlinksInPath()
        let parent = bundleURL.deletingLastPathComponent()
        let marker = parent.appendingPathComponent("启动Infans本地工作台.command")
        return FileManager.default.isExecutableFile(atPath: marker.path) ? parent : nil
    }

    private func nativeLogURL() -> URL? {
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/state/infans", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            return directory.appendingPathComponent("native-secretary.log")
        } catch {
            return nil
        }
    }

    private func startWorkbenchService() {
        guard serverProcess?.isRunning != true else { return }
        guard let directory = workbenchDirectory() else {
            showError("找不到工作台目录。请从 Vault 内的「小秘书.app」启动。")
            return
        }
        let startScript = directory.appendingPathComponent("启动Infans本地工作台.command")
        guard let logFile = nativeLogURL() else {
            showError("无法创建工作台运行日志目录。")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [
            "-c",
            "INFANS_WORKBENCH_SKIP_BROWSER=1 INFANS_WORKBENCH_FOREGROUND=1 /bin/bash \"$1\" >>\"$2\" 2>&1",
            "secretary-native",
            startScript.path,
            logFile.path,
        ]
        process.currentDirectoryURL = directory
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                self?.serverProcess = nil
                self?.log("native: service launcher exited status=\(finished.terminationStatus)")
            }
        }
        do {
            try process.run()
            serverProcess = process
            log("native: service start requested")
        } catch {
            showError("工作台服务启动失败：\(error.localizedDescription)")
        }
    }

    private func ensureSpeechService(completion: @escaping (Bool) -> Void) {
        checkWorkbenchHealth { [weak self] ready in
            guard let self else {
                completion(false)
                return
            }
            if ready {
                completion(true)
                return
            }
            self.startWorkbenchService()
            self.waitForSpeechService(attempt: 0, completion: completion)
        }
    }

    private func waitForSpeechService(attempt: Int, completion: @escaping (Bool) -> Void) {
        guard attempt < 80 else {
            log("native: speech service was not ready after 40 seconds")
            completion(false)
            return
        }
        checkWorkbenchHealth { [weak self] ready in
            guard let self else {
                completion(false)
                return
            }
            if ready {
                self.log("native: speech service ready for Codex read aloud")
                completion(true)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.waitForSpeechService(attempt: attempt + 1, completion: completion)
            }
        }
    }

    private func checkWorkbenchHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { completion((200..<300).contains(status)) }
        }.resume()
    }

    private func beginWaitingForWorkbench() {
        healthAttempts = 0
        healthGeneration += 1
        waitForWorkbench(generation: healthGeneration)
    }

    private func waitForWorkbench(generation: Int) {
        guard generation == healthGeneration else { return }
        healthAttempts += 1
        checkWorkbenchHealth { [weak self] ready in
            guard let self, generation == self.healthGeneration else { return }
            if ready {
                self.loadWorkbenchAndPresent()
                return
            }
            if self.healthAttempts >= 160 {
                self.showError("工作台服务未能在 80 秒内就绪。请查看 ~/.local/state/infans/native-secretary.log。")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.waitForWorkbench(generation: generation)
            }
        }
    }

    private func loadWorkbenchAndPresent() {
        log("native: workbench ready")
        loadWorkbenchRespectingOriginMigration()
        NSApp.activate(ignoringOtherApps: true)
        workbenchWindow?.makeKeyAndOrderFront(nil)
    }

    private func loadWorkbenchRespectingOriginMigration() {
        guard let webView else { return }
        if UserDefaults.standard.bool(forKey: workbenchOriginMigrationKey) {
            workbenchOriginMigrationState = .complete
            webView.isHidden = false
            if webView.url?.host != workbenchURL.host {
                webView.load(URLRequest(url: workbenchURL))
            }
            return
        }
        guard case .idle = workbenchOriginMigrationState else { return }
        workbenchOriginMigrationState = .loadingLegacy
        webView.isHidden = true
        log("native: migrating workbench browser storage to localhost")
        webView.load(URLRequest(url: legacyWorkbenchURL))
    }

    private func captureWorkbenchStorage(in webView: WKWebView) {
        let source = """
        (() => {
          const copy = (storage) => {
            const values = {};
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (key !== null) values[key] = storage.getItem(key);
            }
            return values;
          };
          return JSON.stringify({ local: copy(localStorage), session: copy(sessionStorage) });
        })();
        """
        webView.evaluateJavaScript(source) { [weak self] result, error in
            guard let self else { return }
            let fallback = "{\"local\":{\"\(displayModeStorageKey)\":\"on\"},\"session\":{}}"
            let snapshot = error == nil ? (result as? String ?? fallback) : fallback
            if error != nil {
                self.log("native: legacy storage read failed; preserving display mode")
            }
            self.loadLocalhostAfterMigration(snapshot: snapshot)
        }
    }

    private func loadLocalhostAfterMigration(snapshot: String) {
        guard case .loadingLegacy = workbenchOriginMigrationState, let webView else { return }
        let encoded = Data(snapshot.utf8).base64EncodedString()
        let source = """
        (() => {
          if (location.hostname !== "localhost" || location.port !== "5173") return;
          try {
            const binary = atob("\(encoded)");
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            const snapshot = JSON.parse(new TextDecoder().decode(bytes));
            const merge = (storage, values) => {
              for (const [key, value] of Object.entries(values || {})) {
                if (typeof value !== "string") continue;
                const current = storage.getItem(key);
                if (key === "\(displayModeStorageKey)") {
                  if (current === "on" || value === "on") storage.setItem(key, "on");
                  else if (current === null) storage.setItem(key, value);
                } else if (current === null) {
                  storage.setItem(key, value);
                }
              }
            };
            merge(localStorage, snapshot.local);
            merge(sessionStorage, snapshot.session);
          } catch {}
        })();
        """
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        workbenchOriginMigrationState = .loadingLocalhost
        webView.load(URLRequest(url: workbenchURL))
    }

    private func handleWorkbenchMigrationFailure(_ webView: WKWebView) {
        switch workbenchOriginMigrationState {
        case .loadingLegacy:
            let fallback = "{\"local\":{\"\(displayModeStorageKey)\":\"on\"},\"session\":{}}"
            log("native: legacy origin unavailable; preserving display mode")
            loadLocalhostAfterMigration(snapshot: fallback)
        case .loadingLocalhost:
            workbenchOriginMigrationState = .idle
            webView.isHidden = false
            showError("无法使用 localhost 打开工作台，请重新打开小秘书。")
        default:
            break
        }
    }

    private func showLoadingPage(in webView: WKWebView) {
        webView.loadHTMLString(
            """
            <!doctype html><meta charset="utf-8">
            <style>html,body{height:100%;margin:0;background:#060d10;color:#d7c5a4;font:15px -apple-system}
            body{display:grid;place-items:center}main{text-align:center;letter-spacing:.08em}
            i{display:block;width:30px;height:30px;margin:0 auto 18px;border:1px solid #8e7651;
            transform:rotate(45deg);animation:p 1.4s ease-in-out infinite}@keyframes p{50%{opacity:.35;transform:rotate(45deg) scale(.82)}}</style>
            <main><i></i>小秘书正在准备工作台</main>
            """,
            baseURL: nil
        )
    }

    private func showError(_ message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView?.loadHTMLString(
            """
            <!doctype html><meta charset="utf-8">
            <style>html,body{height:100%;margin:0;background:#060d10;color:#d7c5a4;font:15px -apple-system}
            body{display:grid;place-items:center}main{max-width:560px;text-align:center;line-height:1.8}</style>
            <main><strong>小秘书暂时没有打开</strong><br>\(escaped)</main>
            """,
            baseURL: nil
        )
        log("native: ERROR \(message)")
    }

    private func log(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        guard let url = nativeLogURL() else { return }
        guard let data = line.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: data)
            return
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {}
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "secretaryPet", let payload = message.body as? [String: Any] else { return }
        let type = payload["type"] as? String ?? ""
        if type == "request-microphone" {
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    self?.log("native: microphone system permission \(granted ? "granted" : "denied")")
                }
            }
            requestNativeSpeechAuthorization()
            return
        }
        if type == "voice-recognition" {
            if payload["action"] as? String == "start" {
                startNativeSpeechRecognition()
            } else {
                stopNativeSpeechRecognition()
            }
            return
        }
        if type == "companion-presence" {
            petView?.playLaunching()
            return
        }
        if type == "print-guide" {
            let jobTitle = (payload["jobTitle"] as? String ?? "日本活动攻略")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            openGuidePrintPanel(jobTitle: jobTitle.isEmpty ? "日本活动攻略" : jobTitle)
            return
        }
        guard type == "speech-state" else { return }
        let speaker = payload["speaker"] as? String ?? "yinyue"
        let active = payload["active"] as? Bool ?? false
        workbenchSpeechActive = active && (speaker == "meining" || speaker == "yinyue")
        updatePetSpeakingState()
    }

    private func updatePetSpeakingState() {
        petView?.setSpeaking(workbenchSpeechActive || codexReadAloudActive)
    }

    private func openGuidePrintPanel(jobTitle: String) {
        guard guidePrintOperation == nil, let webView, let workbenchWindow else {
            publishGuidePrintEvent("infans:guide-print-finished", success: false)
            return
        }
        let printInfo = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo()
        printInfo.paperSize = NSSize(width: 595.276, height: 841.89)
        printInfo.orientation = .portrait
        printInfo.topMargin = 0
        printInfo.bottomMargin = 0
        printInfo.leftMargin = 0
        printInfo.rightMargin = 0
        printInfo.horizontalPagination = .fit
        printInfo.verticalPagination = .automatic
        printInfo.isHorizontallyCentered = true
        printInfo.isVerticallyCentered = false

        let operation = webView.printOperation(with: printInfo)
        operation.jobTitle = jobTitle
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        guidePrintOperation = operation
        publishGuidePrintEvent("infans:guide-print-started", success: true)
        operation.runModal(
            for: workbenchWindow,
            delegate: self,
            didRun: #selector(guidePrintOperationDidRun(_:success:contextInfo:)),
            contextInfo: nil
        )
    }

    @objc private func guidePrintOperationDidRun(
        _ printOperation: NSPrintOperation,
        success: Bool,
        contextInfo: UnsafeMutableRawPointer?
    ) {
        guidePrintOperation = nil
        publishGuidePrintEvent("infans:guide-print-finished", success: success)
        log("native: guide print panel closed success=\(success)")
    }

    private func publishGuidePrintEvent(_ name: String, success: Bool) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: ["success": success]),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('\(name)',{detail:\(json)}));"
        )
    }

    private func requestNativeSpeechAuthorization(completion: ((Bool) -> Void)? = nil) {
        let finish: (SFSpeechRecognizerAuthorizationStatus) -> Void = { [weak self] status in
            DispatchQueue.main.async {
                self?.log("native: speech recognition permission status=\(status.rawValue)")
                completion?(status == .authorized)
            }
        }
        let status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            SFSpeechRecognizer.requestAuthorization(finish)
        } else {
            finish(status)
        }
    }

    private func startNativeSpeechRecognition() {
        nativeSpeechStartPending = true
        requestNativeSpeechAuthorization { [weak self] authorized in
            guard let self, self.nativeSpeechStartPending else { return }
            guard authorized else {
                self.nativeSpeechStartPending = false
                self.publishNativeTranscript("", final: true)
                return
            }
            self.beginAuthorizedNativeSpeechRecognition()
        }
    }

    private func beginAuthorizedNativeSpeechRecognition() {
        cleanupNativeSpeechRecognition(cancelTask: true)
        nativeSpeechStartPending = true
        lastNativeTranscript = ""

        guard let recognizer = nativeSpeechRecognizer, recognizer.isAvailable else {
            nativeSpeechStartPending = false
            publishNativeTranscript("", final: true)
            log("native: speech recognizer unavailable")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        nativeSpeechRequest = request
        let inputNode = nativeSpeechEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0 && format.channelCount > 0 else {
            nativeSpeechStartPending = false
            publishNativeTranscript("", final: true)
            log("native: speech input format unavailable")
            return
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        nativeSpeechTapInstalled = true
        nativeSpeechEngine.prepare()

        do {
            try nativeSpeechEngine.start()
        } catch {
            cleanupNativeSpeechRecognition(cancelTask: true)
            nativeSpeechStartPending = false
            publishNativeTranscript("", final: true)
            log("native: speech audio engine FAILED \(error.localizedDescription)")
            return
        }

        nativeSpeechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.nativeSpeechTask != nil else { return }
                if let result {
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    let transcriptChanged = !text.isEmpty && text != self.lastNativeTranscript
                    if !text.isEmpty { self.lastNativeTranscript = text }
                    self.publishNativeTranscript(self.lastNativeTranscript, final: result.isFinal)
                    if result.isFinal {
                        self.cleanupNativeSpeechRecognition(cancelTask: false)
                        self.nativeSpeechStartPending = false
                        return
                    }
                    if transcriptChanged { self.scheduleNativeSpeechFinalization() }
                }
                if let error {
                    self.log("native: speech recognition ended \(error.localizedDescription)")
                    self.publishNativeTranscript(self.lastNativeTranscript, final: true)
                    self.cleanupNativeSpeechRecognition(cancelTask: true)
                    self.nativeSpeechStartPending = false
                }
            }
        }
        log("native: speech recognition started")
    }

    /**
     SFSpeechAudioBufferRecognitionRequest 在持续收音时可能长期只给临时转写，
     不会因用户说完一句就自动给出 isFinal。短暂没有新文字时主动收句，
     让网页层拿到 final 事件后发给已接入的模型，再自动开始下一句。
     */
    private func scheduleNativeSpeechFinalization() {
        nativeSpeechSilenceWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.nativeSpeechTask != nil, !self.lastNativeTranscript.isEmpty else { return }
            self.nativeSpeechSilenceWorkItem = nil
            self.log("native: speech phrase finalized after silence")
            self.stopNativeSpeechRecognition()
        }
        nativeSpeechSilenceWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9, execute: workItem)
    }

    private func stopNativeSpeechRecognition() {
        nativeSpeechSilenceWorkItem?.cancel()
        nativeSpeechSilenceWorkItem = nil
        nativeSpeechStartPending = false
        if nativeSpeechEngine.isRunning { nativeSpeechEngine.stop() }
        if nativeSpeechTapInstalled {
            nativeSpeechEngine.inputNode.removeTap(onBus: 0)
            nativeSpeechTapInstalled = false
        }
        nativeSpeechRequest?.endAudio()
        nativeSpeechTask?.finish()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self, self.nativeSpeechTask != nil else { return }
            self.publishNativeTranscript(self.lastNativeTranscript, final: true)
            self.cleanupNativeSpeechRecognition(cancelTask: true)
        }
    }

    private func cleanupNativeSpeechRecognition(cancelTask: Bool) {
        nativeSpeechSilenceWorkItem?.cancel()
        nativeSpeechSilenceWorkItem = nil
        if nativeSpeechEngine.isRunning { nativeSpeechEngine.stop() }
        if nativeSpeechTapInstalled {
            nativeSpeechEngine.inputNode.removeTap(onBus: 0)
            nativeSpeechTapInstalled = false
        }
        nativeSpeechRequest?.endAudio()
        if cancelTask { nativeSpeechTask?.cancel() }
        nativeSpeechRequest = nil
        nativeSpeechTask = nil
    }

    private func publishNativeTranscript(_ text: String, final: Bool) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: ["text": text, "final": final]),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('infans:secretary-native-transcript',{detail:\(json)}));"
        )
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isWorkbenchURL(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.allow)
            return
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("native: webview loaded \(webView.url?.absoluteString ?? "unknown")")
        switch workbenchOriginMigrationState {
        case .loadingLegacy where webView.url?.host == legacyWorkbenchURL.host:
            captureWorkbenchStorage(in: webView)
        case .loadingLocalhost where webView.url?.host == workbenchURL.host:
            UserDefaults.standard.set(true, forKey: workbenchOriginMigrationKey)
            workbenchOriginMigrationState = .complete
            webView.isHidden = false
            log("native: workbench browser storage migrated to localhost")
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("native: webview load FAILED \(error.localizedDescription)")
        handleWorkbenchMigrationFailure(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("native: webview provisional load FAILED \(error.localizedDescription)")
        handleWorkbenchMigrationFailure(webView)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isWorkbenchURL(url) {
            webView.load(URLRequest(url: url))
        } else {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let workbenchWindow else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: workbenchWindow) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let host = origin.host.lowercased()
        let isLocalWorkbench = (host == "127.0.0.1" || host == "localhost") && origin.port == 5173
        if isLocalWorkbench && type == .microphone {
            log("native: microphone capture granted for \(host):\(origin.port)")
            decisionHandler(.grant)
        } else {
            log("native: media capture denied for \(host):\(origin.port) type=\(type.rawValue)")
            decisionHandler(.deny)
        }
    }

    private func isWorkbenchURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return (host == "127.0.0.1" || host == "localhost") && url.port == 5173
    }
}

@main
enum SecretaryApplication {
    static func main() {
        if CommandLine.arguments.contains("--codex-shortcut-self-test") {
            let passed = CodexShortcutController.shortcutMappingSelfTest()
            print(passed ? "codex shortcut mapping: ok" : "codex shortcut mapping: failed")
            if !passed { exit(1) }
            return
        }
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
