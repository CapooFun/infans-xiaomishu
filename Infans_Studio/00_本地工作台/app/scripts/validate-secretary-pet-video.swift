import AppKit
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

private enum ValidationError: Error, CustomStringConvertible {
    case usage
    case noVideoTrack
    case unexpectedAudioTrack
    case unexpectedSize(Int, Int)
    case noAlphaMetadata
    case cannotRead
    case noDecodedFrames
    case noTransparentPixels
    case noVisiblePixels
    case cannotLoadReference(String)
    case upsideDown(Double, Double)

    var description: String {
        switch self {
        case .usage: return "用法：validate-secretary-pet-video <视频.mov> [预期帧数] [首帧.png]"
        case .noVideoTrack: return "没有视频轨"
        case .unexpectedAudioTrack: return "宠物视频不应包含音轨"
        case .unexpectedSize(let width, let height): return "尺寸错误：\(width)×\(height)"
        case .noAlphaMetadata: return "视频没有透明通道标记"
        case .cannotRead: return "无法解码视频"
        case .noDecodedFrames: return "视频里没有可解码帧"
        case .noTransparentPixels: return "视频没有透明像素"
        case .noVisiblePixels: return "视频没有可见像素"
        case .cannotLoadReference(let path): return "无法读取首帧参考图：\(path)"
        case .upsideDown(let direct, let flipped):
            return String(format: "视频方向可能上下颠倒：正向差异 %.2f，翻转差异 %.2f", direct, flipped)
        }
    }
}

private let expectedWidth = 384
private let expectedHeight = 416

private func referenceAlpha(at url: URL) throws -> [UInt8] {
    guard
        let image = NSImage(contentsOf: url),
        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        throw ValidationError.cannotLoadReference(url.path)
    }
    let bytesPerRow = expectedWidth * 4
    let byteCount = bytesPerRow * expectedHeight
    let bytes = UnsafeMutablePointer<UInt8>.allocate(capacity: byteCount)
    defer { bytes.deallocate() }
    bytes.initialize(repeating: 0, count: byteCount)
    let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue
        | CGImageAlphaInfo.premultipliedFirst.rawValue
    guard let context = CGContext(
        data: bytes,
        width: expectedWidth,
        height: expectedHeight,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: bitmapInfo
    ) else {
        throw ValidationError.cannotLoadReference(url.path)
    }
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: expectedWidth, height: expectedHeight))
    return (0..<(expectedWidth * expectedHeight)).map { bytes[$0 * 4 + 3] }
}

private func orientationScores(decoded: [UInt8], reference: [UInt8]) -> (direct: Double, flipped: Double) {
    var directTotal: Int64 = 0
    var flippedTotal: Int64 = 0
    for y in 0..<expectedHeight {
        for x in 0..<expectedWidth {
            let decodedAlpha = Int(decoded[y * expectedWidth + x])
            directTotal += Int64(abs(decodedAlpha - Int(reference[y * expectedWidth + x])))
            flippedTotal += Int64(abs(decodedAlpha - Int(reference[(expectedHeight - 1 - y) * expectedWidth + x])))
        }
    }
    let pixels = Double(expectedWidth * expectedHeight)
    return (Double(directTotal) / pixels, Double(flippedTotal) / pixels)
}

private func validate(url: URL, expectedFrames: Int?, referenceURL: URL?) throws {
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
        throw ValidationError.noVideoTrack
    }
    guard asset.tracks(withMediaType: .audio).isEmpty else {
        throw ValidationError.unexpectedAudioTrack
    }
    let size = track.naturalSize.applying(track.preferredTransform)
    let width = Int(abs(size.width).rounded())
    let height = Int(abs(size.height).rounded())
    guard width == expectedWidth, height == expectedHeight else {
        throw ValidationError.unexpectedSize(width, height)
    }
    guard track.hasMediaCharacteristic(.containsAlphaChannel) else {
        throw ValidationError.noAlphaMetadata
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(
        track: track,
        outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
    )
    guard reader.canAdd(output) else { throw ValidationError.cannotRead }
    reader.add(output)
    guard reader.startReading() else { throw ValidationError.cannotRead }

    var frames = 0
    var transparentPixels: Int64 = 0
    var visiblePixels: Int64 = 0
    var partialPixels: Int64 = 0
    var minAlpha: UInt8 = 255
    var maxAlpha: UInt8 = 0
    var firstFrameAlpha: [UInt8]?
    while let sample = output.copyNextSampleBuffer(),
          let pixelBuffer = CMSampleBufferGetImageBuffer(sample) {
        frames += 1
        let frameWidth = CVPixelBufferGetWidth(pixelBuffer)
        let frameHeight = CVPixelBufferGetHeight(pixelBuffer)
        guard frameWidth == expectedWidth, frameHeight == expectedHeight else {
            throw ValidationError.unexpectedSize(frameWidth, frameHeight)
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        let base = CVPixelBufferGetBaseAddress(pixelBuffer)!.assumingMemoryBound(to: UInt8.self)
        var decodedAlpha = frames == 1 ? [UInt8](repeating: 0, count: frameWidth * frameHeight) : []
        for y in 0..<frameHeight {
            let row = base.advanced(by: y * bytesPerRow)
            for x in 0..<frameWidth {
                let alpha = row[x * 4 + 3]
                if frames == 1 { decodedAlpha[y * frameWidth + x] = alpha }
                minAlpha = min(minAlpha, alpha)
                maxAlpha = max(maxAlpha, alpha)
                if alpha == 0 { transparentPixels += 1 }
                if alpha > 0 { visiblePixels += 1 }
                if alpha > 0 && alpha < 255 { partialPixels += 1 }
            }
        }
        if frames == 1 { firstFrameAlpha = decodedAlpha }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
    }
    guard frames > 0 else { throw ValidationError.noDecodedFrames }
    if let expectedFrames, frames != expectedFrames {
        throw NSError(
            domain: "SecretaryVideoValidation",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "帧数错误：\(frames)，预期 \(expectedFrames)"]
        )
    }
    guard transparentPixels > 0 else { throw ValidationError.noTransparentPixels }
    guard visiblePixels > 0 else { throw ValidationError.noVisiblePixels }
    var orientationDescription = ""
    if let referenceURL, let firstFrameAlpha {
        let scores = orientationScores(
            decoded: firstFrameAlpha,
            reference: try referenceAlpha(at: referenceURL)
        )
        guard scores.direct + 2 < scores.flipped else {
            throw ValidationError.upsideDown(scores.direct, scores.flipped)
        }
        orientationDescription = String(
            format: " 方向差异=%.2f/%.2f",
            scores.direct,
            scores.flipped
        )
    }
    let duration = CMTimeGetSeconds(asset.duration)
    print(
        "验证通过：\(url.lastPathComponent)",
        "\(width)×\(height)",
        "\(frames) 帧",
        String(format: "%.3f 秒", duration),
        String(format: "%.1f fps", track.nominalFrameRate),
        "alpha=\(minAlpha)…\(maxAlpha)",
        "透明像素=\(transparentPixels)",
        "半透明像素=\(partialPixels)\(orientationDescription)"
    )
}

do {
    guard CommandLine.arguments.count >= 2 else { throw ValidationError.usage }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let expectedFrames = CommandLine.arguments.count >= 3 ? Int(CommandLine.arguments[2]) : nil
    let referenceURL = CommandLine.arguments.count >= 4
        ? URL(fileURLWithPath: CommandLine.arguments[3])
        : nil
    try validate(url: url, expectedFrames: expectedFrames, referenceURL: referenceURL)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
