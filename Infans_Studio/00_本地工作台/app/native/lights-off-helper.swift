import AppKit
import CoreGraphics
import Darwin
import Foundation

private let builtinTarget: Float = 0.07
private let dimThreshold: Float = 0.12
private let stateSchema = 2

private typealias BrightnessGet = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
private typealias BrightnessSet = @convention(c) (CGDirectDisplayID, Float) -> Int32
private typealias BrightnessCan = @convention(c) (CGDirectDisplayID) -> Bool
private typealias BrightnessChanged = @convention(c) (CGDirectDisplayID, Float) -> Void
private typealias ConfigureEnabled = @convention(c) (CGDisplayConfigRef?, CGDirectDisplayID, Bool) -> Int32

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

private struct SavedDisplay: Codable {
  var displayID: UInt32
  var vendorNumber: UInt32
  var modelNumber: UInt32
  var serialNumber: UInt32
  var name: String
  var originX: Double
  var originY: Double
  var width: Double
  var height: Double
}

private struct LightsOffState: Codable {
  var schemaVersion: Int
  var applied: Bool
  var builtinDisplayID: UInt32?
  var builtinBrightness: Float?
  var toggleKeyCode: Int64?
  var toggleModifiers: Int64?
  var disabledDisplays: [SavedDisplay]?
}

private struct DisplayInfo {
  let id: CGDirectDisplayID
  let name: String
  let bounds: CGRect
  let vendor: UInt32
  let model: UInt32
  let serial: UInt32
  let builtin: Bool
  let active: Bool

  func saved() -> SavedDisplay {
    SavedDisplay(
      displayID: id,
      vendorNumber: vendor,
      modelNumber: model,
      serialNumber: serial,
      name: name,
      originX: Double(bounds.origin.x),
      originY: Double(bounds.origin.y),
      width: Double(bounds.width),
      height: Double(bounds.height)
    )
  }
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
  private let configureEnabled = configureEnabledSymbol()
  private var overlays: [NSWindow] = []
  private var restored = false
  private var interruptReady = false
  private var brightnessWatch: Timer?
  private var lastSeenBrightness: Float?
  private var originalDisplayID: CGDirectDisplayID?
  private var originalBrightness: Float?
  private var disablingExternals = false

  init(stateURL: URL) {
    self.stateURL = stateURL
  }

  func apply() {
    var state = readState()
    captureOriginal(&state)
    originalDisplayID = state.builtinDisplayID.map { CGDirectDisplayID($0) }
    originalBrightness = state.builtinBrightness
    let externals = listOnlineDisplays().filter { !$0.builtin && $0.active }
    state.disabledDisplays = mergeSaved(state.disabledDisplays ?? [], externals.map { $0.saved() })
    state.applied = true
    writeState(state)
    if !externals.isEmpty, let error = setDisplaysEnabled(externals.map(\.id), enabled: false) {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      exit(1)
    }
    dimBuiltin()
    rebuildOverlays()
    listenForDisplayChanges()
    startInterruptWatch()
    trapTermination()
  }

  func restore() {
    guard !restored else { return }
    restored = true
    interruptReady = false
    brightnessWatch?.invalidate()
    brightnessWatch = nil
    overlays.forEach { $0.orderOut(nil) }
    overlays.removeAll()
    let state = readState()
    let targetIDs = restoreTargetIDs(state)
    _ = setDisplaysEnabled(targetIDs, enabled: true)
    restoreArrangement(state)
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
      toggleModifiers: state.toggleModifiers,
      disabledDisplays: nil
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

  private func listenForDisplayChanges() {
    CGDisplayRegisterReconfigurationCallback({ _, _, context in
      guard let context else { return }
      let session = Unmanaged<LightsOffSession>.fromOpaque(context).takeUnretainedValue()
      DispatchQueue.main.async {
        guard !session.restored, !session.disablingExternals else { return }
        session.disableHotPluggedExternals()
        session.rebuildOverlays()
      }
    }, Unmanaged.passUnretained(self).toOpaque())
  }

  private func disableHotPluggedExternals() {
    let externals = listOnlineDisplays().filter { !$0.builtin && $0.active }
    guard !externals.isEmpty else { return }
    var state = readState()
    state.disabledDisplays = mergeSaved(state.disabledDisplays ?? [], externals.map { $0.saved() })
    state.applied = true
    writeState(state)
    _ = setDisplaysEnabled(externals.map(\.id), enabled: false)
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
    guard let builtin, !builtinCanDim else { return }
    guard let screen = NSScreen.screens.first(where: { screen in
      guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
      return CGDirectDisplayID(number.uint32Value) == builtin
    }) else { return }
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

  private func displayName(_ id: CGDirectDisplayID) -> String {
    for screen in NSScreen.screens {
      if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
         number.uint32Value == id {
        return screen.localizedName
      }
    }
    return "Display \(id)"
  }

  private func listOnlineDisplays() -> [DisplayInfo] {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(16, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(max(count, 16)))
    CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count)
    return ids.prefix(Int(count)).map { id in
      DisplayInfo(
        id: id,
        name: displayName(id),
        bounds: CGDisplayBounds(id),
        vendor: CGDisplayVendorNumber(id),
        model: CGDisplayModelNumber(id),
        serial: CGDisplaySerialNumber(id),
        builtin: CGDisplayIsBuiltin(id) != 0,
        active: CGDisplayIsActive(id) != 0
      )
    }
  }

  private func restoreTargetIDs(_ state: LightsOffState) -> [CGDirectDisplayID] {
    var ids: [CGDirectDisplayID] = (state.disabledDisplays ?? []).map { CGDirectDisplayID($0.displayID) }
    let live = listOnlineDisplays()
    for display in live where !display.builtin && !display.active {
      if !ids.contains(display.id) { ids.append(display.id) }
    }
    return ids
  }

  private func restoreArrangement(_ state: LightsOffState) {
    let saved = state.disabledDisplays ?? []
    guard !saved.isEmpty else { return }
    let live = listOnlineDisplays().filter(\.active)
    var config: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&config) == .success else { return }
    var changed = false
    for item in saved {
      let match = live.first(where: { $0.id == item.displayID })
        ?? live.first(where: { $0.vendor == item.vendorNumber && $0.model == item.modelNumber && (item.serialNumber == 0 || $0.serial == 0 || $0.serial == item.serialNumber) })
      guard let match else { continue }
      if CGConfigureDisplayOrigin(config, match.id, Int32(item.originX.rounded()), Int32(item.originY.rounded())) == .success {
        changed = true
      }
    }
    if changed {
      _ = CGCompleteDisplayConfiguration(config, .forSession)
    } else {
      CGCancelDisplayConfiguration(config)
    }
  }

  private func setDisplaysEnabled(_ ids: [CGDirectDisplayID], enabled: Bool) -> String? {
    let unique = Array(Set(ids)).filter { CGDisplayIsBuiltin($0) == 0 }
    guard !unique.isEmpty else { return nil }
    guard let configure = configureEnabled else {
      return "这台 Mac 不能单独关掉副屏。"
    }
    disablingExternals = true
    defer { disablingExternals = false }
    var config: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&config) == .success else {
      return "显示器配置没有开始。"
    }
    for id in unique {
      let code = configure(config, id, enabled)
      if code != 0 {
        CGCancelDisplayConfiguration(config)
        return "副屏\(enabled ? "恢复" : "切掉")失败（\(code)）。"
      }
    }
    let complete = CGCompleteDisplayConfiguration(config, .forSession)
    if complete != .success {
      return "显示器配置没有完成。"
    }
    return nil
  }

  private func mergeSaved(_ existing: [SavedDisplay], _ incoming: [SavedDisplay]) -> [SavedDisplay] {
    var result = existing
    for item in incoming {
      if let index = result.firstIndex(where: { $0.displayID == item.displayID }) {
        result[index] = item
      } else {
        result.append(item)
      }
    }
    return result
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
          let state = try? JSONDecoder().decode(LightsOffState.self, from: data) else {
      return LightsOffState(
        schemaVersion: stateSchema,
        applied: false,
        builtinDisplayID: nil,
        builtinBrightness: nil,
        toggleKeyCode: 53,
        toggleModifiers: 1 << 20,
        disabledDisplays: nil
      )
    }
    return state
  }

  private func writeState(_ state: LightsOffState) {
    let directory = stateURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var writing = state
    writing.schemaVersion = stateSchema
    if let data = try? JSONEncoder().encode(writing) {
      try? data.write(to: stateURL, options: .atomic)
    }
  }
}

private func configureEnabledSymbol() -> ConfigureEnabled? {
  let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
  guard handle != nil, let symbol = dlsym(handle, "CGSConfigureDisplayEnabled") else { return nil }
  return unsafeBitCast(symbol, to: ConfigureEnabled.self)
}
