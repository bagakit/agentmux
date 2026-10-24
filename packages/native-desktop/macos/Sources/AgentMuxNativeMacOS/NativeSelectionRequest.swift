import AppKit
import CoreGraphics

enum NativeSelectionCompletionAction: String, Sendable { case capture, edit }

struct NativeSelectionChoice: Sendable {
    let rectangle: CGRect
    let completionAction: NativeSelectionCompletionAction
}

private final class NativeSelectionResult: @unchecked Sendable {
    var result: Result<NativeSelectionChoice?, Error>?
}

/// Production capture and the isolated preview consume this same request. Only
/// its calling worker waits; AppKit remains on the ordinary main event loop.
enum NativeSelectionRequest {
    static func run(allowEditing: Bool = false) throws -> NativeSelectionChoice? {
        let result = NativeSelectionResult()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            do {
                try NativeScreenSelection.begin(allowEditing: allowEditing) { value in
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
