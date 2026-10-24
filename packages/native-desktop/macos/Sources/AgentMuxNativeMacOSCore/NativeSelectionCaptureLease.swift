import Foundation

/// The selector and the pixels produced from it are one capture resource. This
/// lease never covers clipboard, AX observation or permission-status requests.
public final class NativeSelectionCaptureLease: @unchecked Sendable {
    public enum Failure: Error { case busy }
    public static let shared = NativeSelectionCaptureLease()
    private let lock = NSLock()
    public init() {}
    public func withCapture<T>(_ operation: () throws -> T) throws -> T {
        guard lock.try() else { throw Failure.busy }
        defer { lock.unlock() }
        return try operation()
    }
}
