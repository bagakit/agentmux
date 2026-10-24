import Foundation

/// The selector and the pixels produced from it are one capture resource. This
/// lease never covers clipboard, AX observation or permission-status requests.
public final class NativeSelectionCaptureLease: @unchecked Sendable {
    public enum Failure: Error { case busy }
    /// Shared by the requesting worker and its asynchronous pixel producer.
    /// Cancellation of an observer does not establish that the producer exited.
    public final class Ownership: @unchecked Sendable {
        private let lease: NativeSelectionCaptureLease
        fileprivate init(_ lease: NativeSelectionCaptureLease) { self.lease = lease }
        deinit { lease.release() }
    }
    public static let shared = NativeSelectionCaptureLease()
    private let lock = NSLock()
    private var occupied = false
    public init() {}
    public func withCapture<T>(_ operation: (Ownership) throws -> T) throws -> T {
        lock.lock()
        guard !occupied else { lock.unlock(); throw Failure.busy }
        occupied = true
        lock.unlock()
        let ownership = Ownership(self)
        return try withExtendedLifetime(ownership) { try operation(ownership) }
    }
    private func release() {
        lock.lock()
        occupied = false
        lock.unlock()
    }
}
