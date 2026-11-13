import Foundation

/// One display capture at a time owns the physical display grabs. This lease
/// never covers clipboard, AX observation or permission-status requests.
public final class NativeDisplayCaptureLease: @unchecked Sendable {
    public enum Failure: Error { case busy }
    /// Shared by the requesting worker and its asynchronous pixel producers.
    /// Cancellation of an observer does not establish that the producer exited.
    public final class Ownership: @unchecked Sendable {
        private let lease: NativeDisplayCaptureLease
        fileprivate init(_ lease: NativeDisplayCaptureLease) { self.lease = lease }
        deinit { lease.release() }
    }
    public static let shared = NativeDisplayCaptureLease()
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
