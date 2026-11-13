import Foundation
import CoreGraphics
import AgentMuxNativeMacOSCore

struct NativeScreenSelectionError: Error { let code: String; let message: String }

private func image(width: Int, height: Int, color: (Int, Int) -> [UInt8]) -> CGImage {
    var bytes: [UInt8] = []
    for y in 0..<height { for x in 0..<width { bytes.append(contentsOf: color(x, y) + [255]) } }
    let provider = CGDataProvider(data: Data(bytes) as CFData)!
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}

@main
private struct SelectionPixelsChecks {
    static func main() throws {
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        let left = NativeSelectionDisplay(displayID: 7, appKitFrame: CGRect(x: -100, y: 0, width: 100, height: 80),
            quartzFrame: CGRect(x: -100, y: 0, width: 100, height: 80), image: image(width: 100, height: 80) { _, _ in [240, 30, 20] }, engine: "frozen-test", issue: nil)
        let right = NativeSelectionDisplay(displayID: 9, appKitFrame: CGRect(x: 0, y: 0, width: 100, height: 80),
            quartzFrame: CGRect(x: 0, y: 0, width: 100, height: 80), image: image(width: 200, height: 160) { x, y in x < 100 ? (y < 80 ? [10, 40, 230] : [20, 200, 40]) : [230, 180, 10] }, engine: "frozen-test", issue: nil)
        let pixels = NativeSelectionPixels(displays: [left, right])
        let original = pixels.sample(at: CGPoint(x: 10, y: 70), in: right)
        check("sampling uses original display physical pixels and AppKit vertical conversion", original?.x == 20 && original?.y == 20 && original?.hex == "#0A28E6")
        check("sampling the lower source region preserves original pixel orientation", pixels.sample(at: CGPoint(x: 10, y: 10), in: right)?.hex == "#14C828")
        check("negative display origins retain the exact source pixel", pixels.sample(at: CGPoint(x: -90, y: 70), in: left)?.x == 10 && pixels.sample(at: CGPoint(x: -90, y: 70), in: left)?.hex == "#F01E14")
        check("a point on another display never borrows this image", pixels.sample(at: CGPoint(x: -10, y: 70), in: right) == nil)
        let selected = CGRect(x: -20, y: 10, width: 40, height: 30)
        let output = try pixels.compose(selected)
        check("mixed-scale selection reports its actual PNG dimensions", output.image.width == 80 && output.image.height == 60 && output.scale == 2)
        let outputDisplay = NativeSelectionDisplay(displayID: 12, appKitFrame: CGRect(x: 0, y: 0, width: 80, height: 60),
            quartzFrame: CGRect(x: 0, y: 0, width: 80, height: 60), image: output.image, engine: output.engine, issue: nil)
        let result = NativeSelectionPixels(displays: [outputDisplay])
        check("cross-display composition keeps frozen left pixels", result.sample(at: CGPoint(x: 10, y: 50), in: outputDisplay)?.hex == "#F01E14")
        check("cross-display composition keeps frozen right pixels", result.sample(at: CGPoint(x: 60, y: 50), in: outputDisplay)?.hex == "#0A28E6")
        // A later replacement producer is deliberately unrelated to the retained
        // source object. Selecting again from this request keeps the old pixels.
        let newer = NativeSelectionPixels(displays: [NativeSelectionDisplay(displayID: 9, appKitFrame: right.appKitFrame, quartzFrame: right.quartzFrame,
            image: image(width: 200, height: 160) { _, _ in [255, 255, 255] }, engine: "later-test", issue: nil)])
        _ = try newer.compose(CGRect(x: 0, y: 0, width: 20, height: 20))
        check("later live pixels cannot replace the original chooser sample", pixels.sample(at: CGPoint(x: 10, y: 70), in: right)?.hex == original?.hex)
        let unavailable = NativeSelectionDisplay(displayID: 17, appKitFrame: left.appKitFrame, quartzFrame: left.quartzFrame, image: nil, engine: "unavailable", issue: "original display capture failed")
        let partial = NativeSelectionPixels(displays: [unavailable, right])
        check("one failed display does not revoke an independent healthy selection", partial.issue(in: CGRect(x: 0, y: 0, width: 20, height: 20)) == nil)
        check("a selected unavailable source retains its exact display identity", partial.issue(in: selected)?.contains("17") == true)
        do { _ = try partial.compose(selected); check("partial output never silently fills missing source pixels", false) }
        catch let error as NativeScreenSelectionError { check("partial output never silently fills missing source pixels", error.code == "display_capture_unavailable") }
        let healthy = try partial.compose(CGRect(x: 0, y: 0, width: 20, height: 20))
        check("healthy source still exports through the real composer", healthy.image.width == 40 && healthy.image.height == 40)
        let loading = NativeSelectionLoading()
        check("pending native capture starts uncancelled", !loading.isCancelled)
        loading.cancel()
        check("cancellation is explicit and retained without cancelling another request", loading.isCancelled && !NativeSelectionLoading().isCancelled)
        let report: [String: Any] = ["tests": cases.count, "cases": cases, "failures": failures,
            "boundary": "Actual immutable production display samples and cross-display composer with controlled RGBA sources; no OS screenshot or physical display claim"]
        print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }
}
