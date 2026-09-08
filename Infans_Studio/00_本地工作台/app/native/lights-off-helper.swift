import AppKit
import CoreGraphics
import Darwin
import Foundation

private let builtinTarget: Float = 0.07
private let dimThreshold: Float = 0.12
private let stateSchema = 1

private typealias BrightnessGet = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
private typealias BrightnessSet = @convention(c) (CGDirectDisplayID, Float) -> Int32
private typealias BrightnessCan = @convention(c) (CGDirectDisplayID) -> Bool
private typealias BrightnessChanged = @convention(c) (CGDirectDisplayID, Float) -> Void

private struct DisplayServicesAPI {
  var get: BrightnessGet?
  var set: BrightnessSet?
  var can: BrightnessCan?
  var changed: BrightnessChanged?

  static func load() -> DisplayServicesAPI {
    var api = DisplayServicesAPI()
    let handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY)
    guard handle != nil else { return api }
    if let symbol = dlsym(handle, "DisplayServicesGetBrightness") {
      api.get = unsafeBitCast(symbol, to: BrightnessGet.self)
    }
    if let symbol = dlsym(handle, "DisplayServicesSetBrightness") {
      api.set = unsafeBitCast(symbol, to: BrightnessSet.self)
    }
    if let symbol = dlsym(handle, "DisplayServicesCanChangeBrightness") {
      api.can = unsafeBitCast(symbol, to: BrightnessCan.self)
    }
    if let symbol = dlsym(handle, "DisplayServicesBrightnessChanged") {
      api.changed = unsafeBitCast(symbol, to: BrightnessChanged.self)
    }
    return api
  }
}

private struct LightsOffState: Codable {
  var schemaVersion: Int
  var applied: Bool
  var builtinDisplayID: UInt32?
  var builtinBrightness: Float?
  var toggleKeyCode: Int64?
  var toggleModifiers: Int64?
}

private final class ShieldWindow: NSWindow {
  var onInterrupt: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  override func mouseDown(with event: NSEvent) {
    onInterrupt?()
  }
}

@main
enum LightsOffHelper {
  static func main() {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3 else {
      FileHandle.standardError.write(Data("usage: lights-off-helper <on|off> <state-json>\n".utf8))
      exit(2)
    }
    let command = arguments[1]
    let stateURL = URL(fileURLWithPath: arguments[2])
    let session = LightsOffSession(stateURL: stateURL)
    if command == "off" {
      session.restore()
      exit(0)
    }
    guard command == "on" else {
      FileHandle.standardError.write(Data("unknown command\n".utf8))
      exit(2)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    session.apply()
    print("ready", terminator: "\n")
    fflush(stdout)
    app.run()
  }
}

private final class LightsOffSession: NSObject {
  private let stateURL: URL
  private let api = DisplayServicesAPI.load()
  private var overlays: [NSWindow] = []
  private var restored = false
  private var interruptReady = false
  private var localKeyMonitor: Any?
  private var globalKeyMonitor: Any?
  private var brightnessWatch: Timer?
  private var lastSeenBrightness: Float?
  private var originalDisplayID: CGDirectDisplayID?
  private var originalBrightness: Float?

  init(stateURL: URL) {
    self.stateURL = stateURL
  }

  func apply() {
    var state = readState()
    captureOriginal(&state)
    originalDisplayID = state.builtinDisplayID.map { CGDirectDisplayID($0) }
    originalBrightness = state.builtinBrightness
    state.applied = true
    writeState(state)
    dimBuiltin()
    rebuildOverlays()
    listenForDisplayChanges()
    listenForToggleKey()
    startInterruptWatch()
    trapTermination()
  }

  func restore() {
    guard !restored else { return }
    restored = true
    interruptReady = false
    brightnessWatch?.invalidate()
    brightnessWatch = nil
    if let localKeyMonitor { NSEvent.removeMonitor(localKeyMonitor) }
    if let globalKeyMonitor { NSEvent.removeMonitor(globalKeyMonitor) }
    localKeyMonitor = nil
    globalKeyMonitor = nil
    overlays.forEach { $0.orderOut(nil) }
    overlays.removeAll()
    let state = readState()
    let displayID = originalDisplayID ?? state.builtinDisplayID.map { CGDirectDisplayID($0) } ?? builtinDisplayID()
    let brightness = originalBrightness ?? state.builtinBrightness
    if let displayID, let brightness, brightness > dimThreshold {
      for _ in 0..<3 {
        writeBrightness(displayID, brightness)
      }
    }
    writeState(LightsOffState(
      schemaVersion: stateSchema,
      applied: false,
      builtinDisplayID: nil,
      builtinBrightness: nil,
      toggleKeyCode: state.toggleKeyCode,
      toggleModifiers: state.toggleModifiers
    ))
  }

  private func captureOriginal(_ state: inout LightsOffState) {
    if let saved = state.builtinBrightness, saved > dimThreshold {
      if state.builtinDisplayID == nil, let builtin = builtinDisplayID() {
        state.builtinDisplayID = builtin
      }
      return
    }
    guard let builtin = builtinDisplayID(), let current = readBrightness(builtin) else { return }
    guard current > dimThreshold else { return }
    state.builtinDisplayID = builtin
    state.builtinBrightness = current
  }

  private func trapTermination() {
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler { [weak self] in
      self?.restore()
      NSApp.terminate(nil)
    }
    signal(SIGTERM, SIG_IGN)
    source.resume()
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    interrupt.setEventHandler { [weak self] in
      self?.restore()
      NSApp.terminate(nil)
    }
    signal(SIGINT, SIG_IGN)
    interrupt.resume()
  }

  private func listenForToggleKey() {
    localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, self.matchesToggle(event) else { return event }
      self.restore()
      NSApp.terminate(nil)
      return nil
    }
    globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, self.matchesToggle(event) else { return }
      DispatchQueue.main.async {
        self.restore()
        NSApp.terminate(nil)
      }
    }
  }

  private func startInterruptWatch() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      guard let self, !self.restored else { return }
      self.interruptReady = true
      self.lastSeenBrightness = self.currentBuiltinBrightness()
      self.brightnessWatch = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
        self?.checkBrightnessInterrupt()
      }
    }
  }

  private func checkBrightnessInterrupt() {
    guard interruptReady, !restored else { return }
    guard let current = currentBuiltinBrightness() else { return }
    let previous = lastSeenBrightness
    lastSeenBrightness = current
    guard let previous, current - previous > 0.12 else { return }
    handleInterrupt()
  }

  private func handleInterrupt() {
    guard interruptReady, !restored else { return }
    restore()
    NSApp.terminate(nil)
  }

  private func matchesToggle(_ event: NSEvent) -> Bool {
    let state = readState()
    let expectedKey = state.toggleKeyCode ?? 53
    let expectedMods = state.toggleModifiers ?? (1 << 20)
    let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
    var raw: Int64 = 0
    if flags.contains(.command) { raw |= 1 << 20 }
    if flags.contains(.shift) { raw |= 1 << 17 }
    if flags.contains(.option) { raw |= 1 << 19 }
    if flags.contains(.control) { raw |= 1 << 18 }
    let keyCode = Int64(event.keyCode)
    return (keyCode == expectedKey && raw == expectedMods)
      || (keyCode == 53 && raw == (1 << 20))
  }

  private func listenForDisplayChanges() {
    CGDisplayRegisterReconfigurationCallback({ _, _, context in
      guard let context else { return }
      let session = Unmanaged<LightsOffSession>.fromOpaque(context).takeUnretainedValue()
      DispatchQueue.main.async {
        guard !session.restored else { return }
        session.rebuildOverlays()
      }
    }, Unmanaged.passUnretained(self).toOpaque())
  }

  private func dimBuiltin() {
    guard let displayID = originalDisplayID ?? builtinDisplayID() else { return }
    writeBrightness(displayID, builtinTarget)
  }

  private func currentBuiltinBrightness() -> Float? {
    guard let displayID = originalDisplayID ?? builtinDisplayID() else { return nil }
    return readBrightness(displayID)
  }

  private func rebuildOverlays() {
    overlays.forEach { $0.orderOut(nil) }
    overlays.removeAll()
    let builtin = builtinDisplayID()
    let builtinCanDim = builtin.map { canChange($0) } ?? false
    for screen in NSScreen.screens {
      guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
      let displayID = CGDirectDisplayID(number.uint32Value)
      let isBuiltin = builtin.map { $0 == displayID } ?? false
      if isBuiltin && builtinCanDim { continue }
      let window = ShieldWindow(
        contentRect: screen.frame,
        styleMask: .borderless,
        backing: .buffered,
        defer: false,
        screen: screen
      )
      window.onInterrupt = { [weak self] in self?.handleInterrupt() }
      window.setFrame(screen.frame, display: true)
      window.isOpaque = true
      window.hasShadow = false
      window.backgroundColor = .black
      window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
      window.ignoresMouseEvents = false
      window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
      window.isReleasedWhenClosed = false
      window.makeKeyAndOrderFront(nil)
      overlays.append(window)
    }
    if NSApp.isRunning {
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  private func builtinDisplayID() -> CGDirectDisplayID? {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    guard count > 0 else { return nil }
    var ids = Array(repeating: CGDirectDisplayID(0), count: Int(count))
    CGGetOnlineDisplayList(count, &ids, &count)
    return ids.first { CGDisplayIsBuiltin($0) != 0 }
  }

  private func canChange(_ displayID: CGDirectDisplayID) -> Bool {
    api.can?(displayID) ?? false
  }

  private func readBrightness(_ displayID: CGDirectDisplayID) -> Float? {
    guard canChange(displayID), let get = api.get else { return nil }
    var value: Float = 0
    guard get(displayID, &value) == 0 else { return nil }
    return value
  }

  private func writeBrightness(_ displayID: CGDirectDisplayID, _ value: Float) {
    guard canChange(displayID), let set = api.set else { return }
    _ = set(displayID, value)
    api.changed?(displayID, value)
  }

  private func readState() -> LightsOffState {
    guard let data = try? Data(contentsOf: stateURL),
          let state = try? JSONDecoder().decode(LightsOffState.self, from: data),
          state.schemaVersion == stateSchema else {
      return LightsOffState(
        schemaVersion: stateSchema,
        applied: false,
        builtinDisplayID: nil,
        builtinBrightness: nil,
        toggleKeyCode: 53,
        toggleModifiers: 1 << 20
      )
    }
    return state
  }

  private func writeState(_ state: LightsOffState) {
    let directory = stateURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(state) {
      try? data.write(to: stateURL, options: .atomic)
    }
  }
}
