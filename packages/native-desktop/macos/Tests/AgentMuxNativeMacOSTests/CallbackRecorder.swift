import Dispatch
import Foundation

/// Counts callbacks delivered from other threads and lets a test wait for one
/// with a deadline. Each successful wait consumes one recorded callback.
final class CallbackRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private let delivered = DispatchSemaphore(value: 0)
    private var recordedCount = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return recordedCount
    }

    func record() {
        lock.lock()
        recordedCount += 1
        lock.unlock()
        delivered.signal()
    }

    /// Returns true when a callback arrives before `seconds` elapse.
    func wait(seconds: Double) -> Bool {
        delivered.wait(timeout: .now() + seconds) == .success
    }
}
