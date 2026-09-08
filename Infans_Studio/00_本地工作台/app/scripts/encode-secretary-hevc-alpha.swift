import AppKit
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

private enum EncoderError: Error, CustomStringConvertible {
    case usage
    case noFrames(String)
    case cannotLoad(String)
    case cannotCreatePixelBuffer
    case invalidPixelBuffer
    case unsupportedSettings
    case cannotAddInput
    case appendFailed(Int, String)
    case writerFailed(String)

    var description: String {
        switch self {
        case .usage:
            return "用法：encode-secretary-hevc-alpha <帧目录> <输出.mov> [fps]"
        case .noFrames(let path):
            return "帧目录里没有 PNG：\(path)"
        case .cannotLoad(let path):
            return "无法读取图片：\(path)"
        case .cannotCreatePixelBuffer:
            return "无法创建视频像素缓冲区"
        case .invalidPixelBuffer:
            return "视频像素缓冲区格式无效"
        case .unsupportedSettings:
            return "这台 Mac 当前无法编码 HEVC 透明视频"
        case .cannotAddInput:
            return "无法把视频轨加入编码器"
        case .appendFailed(let frame, let message):
            return "第 \(frame) 帧写入失败：\(message)"
        case .writerFailed(let message):
            return "视频编码失败：\(message)"
        }
    }
}

private let width = 384
private let height = 416

private func writerMessage(_ writer: AVAssetWriter) -> String {
    guard let error = writer.error as NSError? else { return "未知错误" }
    return "\(error.domain) \(error.code) \(error.localizedDescription)"
}

private func loadCGImage(at url: URL) throws -> CGImage {
    guard
        let image = NSImage(contentsOf: url),
        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        throw EncoderError.cannotLoad(url.path)
    }
    return cgImage
}

private func premultipliedPixelBuffer(
    from image: CGImage,
    pool: CVPixelBufferPool
) throws -> CVPixelBuffer {
    var maybeBuffer: CVPixelBuffer?
    guard
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &maybeBuffer) == kCVReturnSuccess,
        let buffer = maybeBuffer
    else {
        throw EncoderError.cannotCreatePixelBuffer
    }

    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let baseAddress = CVPixelBufferGetBaseAddress(buffer) else {
        throw EncoderError.invalidPixelBuffer
    }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    memset(baseAddress, 0, bytesPerRow * height)
    let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue
        | CGImageAlphaInfo.premultipliedFirst.rawValue
    guard let context = CGContext(
        data: baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: bitmapInfo
    ) else {
        throw EncoderError.invalidPixelBuffer
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVBufferSetAttachment(
        buffer,
        kCVImageBufferAlphaChannelModeKey,
        kCVImageBufferAlphaChannelMode_PremultipliedAlpha,
        .shouldPropagate
    )
    return buffer
}

private func encode(frameDirectory: URL, outputURL: URL, fps: Int32) throws {
    let frameURLs = try FileManager.default.contentsOfDirectory(
        at: frameDirectory,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
    )
    .filter { $0.pathExtension.lowercased() == "png" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
    guard !frameURLs.isEmpty else {
        throw EncoderError.noFrames(frameDirectory.path)
    }

    try? FileManager.default.removeItem(at: outputURL)
    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
    writer.shouldOptimizeForNetworkUse = false
    let outputSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.hevcWithAlpha,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 3_000_000,
            AVVideoExpectedSourceFrameRateKey: fps,
            AVVideoMaxKeyFrameIntervalKey: fps,
            AVVideoAllowFrameReorderingKey: false,
            kVTCompressionPropertyKey_AlphaChannelMode as String:
                kVTAlphaChannelMode_PremultipliedAlpha,
            kVTCompressionPropertyKey_TargetQualityForAlpha as String: 0.95,
        ],
    ]
    guard writer.canApply(outputSettings: outputSettings, forMediaType: .video) else {
        throw EncoderError.unsupportedSettings
    }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
    input.expectsMediaDataInRealTime = false
    let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: attributes
    )
    guard writer.canAdd(input) else { throw EncoderError.cannotAddInput }
    writer.add(input)
    guard writer.startWriting() else {
        throw EncoderError.writerFailed(writerMessage(writer))
    }
    writer.startSession(atSourceTime: .zero)
    guard let pool = adaptor.pixelBufferPool else {
        throw EncoderError.cannotCreatePixelBuffer
    }

    for (index, frameURL) in frameURLs.enumerated() {
        while !input.isReadyForMoreMediaData {
            Thread.sleep(forTimeInterval: 0.001)
        }
        let image = try loadCGImage(at: frameURL)
        let buffer = try premultipliedPixelBuffer(from: image, pool: pool)
        let time = CMTime(value: CMTimeValue(index), timescale: fps)
        guard adaptor.append(buffer, withPresentationTime: time) else {
            throw EncoderError.appendFailed(index, writerMessage(writer))
        }
    }

    input.markAsFinished()
    let completion = DispatchSemaphore(value: 0)
    writer.finishWriting { completion.signal() }
    completion.wait()
    guard writer.status == .completed else {
        throw EncoderError.writerFailed(writerMessage(writer))
    }
    print("已编码：\(outputURL.path) · \(frameURLs.count) 帧 · \(fps) fps")
}

do {
    guard CommandLine.arguments.count >= 3 else { throw EncoderError.usage }
    let frameDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let fps = CommandLine.arguments.count >= 4 ? Int32(CommandLine.arguments[3]) ?? 30 : 30
    try encode(frameDirectory: frameDirectory, outputURL: outputURL, fps: fps)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
