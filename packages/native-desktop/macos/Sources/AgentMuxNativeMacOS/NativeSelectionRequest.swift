import AppKit
import CoreGraphics

private final class NativeSelectionResult: @unchecked Sendable {
    var result: Result<CGRect?, Error>?
}

/// Production capture and the isolated preview consume this same request. Only
/// its calling worker waits; AppKit remains on the ordinary main event loop.
enum NativeSelectionRequest {
    static func run() throws -> CGRect? {
        let result = NativeSelectionResult()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            do {
                try NativeScreenSelection.begin { value in
                    result.result = value
                    semaphore.signal()
                }
            } catch {
                result.result = .failure(error)
                semaphore.signal()
            }
        }
        semaphore.wait()
        return try result.result!.get()
    }
}
