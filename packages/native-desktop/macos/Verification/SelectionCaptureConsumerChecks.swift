import Foundation
import CoreGraphics
import AgentMuxNativeMacOSCore

// The runner inserts the exact production capture methods here and executes
// them. Only selector/pixel IO is controlled; ownership, dispatch, encoding
// scope, cancellation and error handling remain the production source.
private enum NativeDesktopOperations {
    /* PRODUCTION_CAPTURE_METHODS */
    static func captureRect(_ rectangle: CGRect, ownership: NativeSelectionCaptureLease.Ownership? = nil) throws -> (image: String, scale: Double, engine: String) {
        let number = ControlledIO.shared.pixelCall()
        if number == 1 {
            ControlledIO.shared.pixelsStarted.signal()
            _ = ControlledIO.shared.releasePixels.wait(timeout: .now() + 5)
        }
        return ("controlled-pixels", 1, "controlled-pixel-IO")
    }
    static func png(_ image: String, scale: Double) throws -> [String: Any] { ["format": "png", "data": image, "scale": scale] }
    static func renderRect(_ rectangle: CGRect) -> [String: Double] { ["x": rectangle.minX, "y": rectangle.minY, "width": rectangle.width, "height": rectangle.height] }
    static func captureWindow(_ params: [String: JSONValue]) throws -> [String: Any] { throw ProviderError.coded("fixture_scope", "window IO not selected") }
    static func displayIDArgument(_ value: JSONValue?) throws -> CGDirectDisplayID { throw ProviderError.coded("fixture_scope", "display IO not selected") }
}
private enum JSONValue {
    case string(String), number(Double), bool(Bool), object([String: JSONValue])
    var string: String? { if case let .string(value) = self { return value }; return nil }
    var number: Double? { if case let .number(value) = self { return value }; return nil }
    var bool: Bool? { if case let .bool(value) = self { return value }; return nil }
}
private enum ProviderError: Error { case coded(String, String) }
private struct NativeScreenSelectionError: Error { let code: String; let message: String }
private func nativeErrorPayload(_ error: Error) -> [String: String] {
    if case let ProviderError.coded(code, message) = error { return ["code": code, "message": message] }
    return ["code": "fixture_unexpected", "message": String(describing: error)]
}
private func unleasedCapture<T>(_ operation: (NativeSelectionCaptureLease.Ownership) throws -> T) throws -> T {
    // A separate lease for each call deliberately bypasses the shared owner in
    // the production-wiring mutant without constructing or copying its token.
    try NativeSelectionCaptureLease().withCapture(operation)
}
private enum NativeSelectionRequest {
    static func run(allowEditing: Bool = false) throws -> NativeSelectionChoice? {
        ControlledIO.shared.selectorCall()
        return NativeSelectionChoice(rectangle: CGRect(x: 10, y: 20, width: 100, height: 80), completionAction: allowEditing ? .edit : .capture)
    }
}
private enum NativeSelectionCompletionAction: String { case capture, edit }
private struct NativeSelectionChoice { let rectangle: CGRect; let completionAction: NativeSelectionCompletionAction }
private final class ControlledIO: @unchecked Sendable {
    static let shared = ControlledIO()
    let pixelsStarted = DispatchSemaphore(value: 0), releasePixels = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var selectors = 0, pixels = 0
    private var firstCaptured = false
    func selectorCall() { lock.lock(); selectors += 1; lock.unlock() }
    func selectorCount() -> Int { lock.lock(); defer { lock.unlock() }; return selectors }
    func pixelCall() -> Int { lock.lock(); defer { lock.unlock() }; pixels += 1; return pixels }
    func finish(_ captured: Bool) { lock.lock(); firstCaptured = captured; lock.unlock(); finished.signal() }
    func wasCaptured() -> Bool { lock.lock(); defer { lock.unlock() }; return firstCaptured }
}
@main
private struct SelectionCaptureConsumerChecks {
    static func main() {
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        let io = ControlledIO.shared
        DispatchQueue.global().async {
            let result = NativeDesktopOperations.capture(["mode": .string("selection")])
            io.finish(result["state"] as? String == "captured")
        }
        check("production selection reaches held pixel IO", io.pixelsStarted.wait(timeout: .now() + 5) == .success)
        let second = NativeDesktopOperations.capture(["mode": .string("selection")])
        let secondError = second["error"] as? [String: String]
        check("production second selection reports capture_busy while pixels are held", second["state"] as? String == "failed" && secondError?["code"] == "capture_busy")
        check("production busy branch does not open another selector", io.selectorCount() == 1)
        io.releasePixels.signal()
        check("production original pixels finish normally", io.finished.wait(timeout: .now() + 5) == .success && io.wasCaptured())
        let next = NativeDesktopOperations.capture(["mode": .string("selection")])
        check("production next capture succeeds after image receipt", next["state"] as? String == "captured")
        check("production pure capture omits host editing intent", next["completionAction"] == nil)
        let editable = NativeDesktopOperations.capture(["mode": .string("selection"), "allowEditing": .bool(true)])
        check("production editable capture retains exact selector editing intent", editable["state"] as? String == "captured" && editable["completionAction"] as? String == "edit")
        let disabled = NativeDesktopOperations.capture(["mode": .string("selection"), "allowEditing": .bool(false)])
        check("production explicit false remains a pure capture", disabled["state"] as? String == "captured" && disabled["completionAction"] == nil)
        let invalid = NativeDesktopOperations.capture(["mode": .string("selection"), "allowEditing": .string("true")])
        check("production malformed editing flag is not inferred from text", invalid["state"] as? String == "failed" && (invalid["error"] as? [String: String])?["code"] == "invalid_argument")
        let report: [String: Any] = ["tests": cases.count, "cases": cases, "failures": failures, "boundary": "Exact production capture methods; controlled selector and pixel IO"]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }
}
