import AppKit
import CoreGraphics

enum NativeSelectionCompletionAction: String, Sendable { case capture, edit }

struct NativeSelectionChoice: Sendable {
    let rectangle: CGRect
    let completionAction: NativeSelectionCompletionAction
    /// The quick-mark tool the editor should start with; nil for a direct
    /// capture and for opening the full editor without a preselected tool.
    let editTool: String?
    /// Set when an inline editing selection kept its own frozen display as
    /// the editor's backdrop; the host must release it.
    let backdrop: String?
    let pixels: NativeSelectionPixels
}

private final class NativeSelectionResult: @unchecked Sendable {
    var result: Result<NativeSelectionChoice?, Error>?
}

/// Production capture and the isolated preview consume this same request. Only
/// its calling worker waits; AppKit remains on the ordinary main event loop.
enum NativeSelectionRequest {
    static func run(allowEditing: Bool = false, initialRect: CGRect? = nil, inlineEditing: Bool = false,
                    copyColor: @escaping @Sendable (String) throws -> Void,
                    load: @escaping @Sendable (NativeSelectionLoading) throws -> NativeSelectionPixels) throws -> NativeSelectionChoice? {
        let result = NativeSelectionResult()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            do {
                try NativeScreenSelection.begin(allowEditing: allowEditing, initialRect: initialRect, inlineEditing: inlineEditing,
                                                copyColor: copyColor, load: load) { value in
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
