import Foundation
import AgentMuxNativeMacOSCore

@main
private struct SelectionLeaseChecks {
    private final class Outcome: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        func set() { lock.lock(); value = true; lock.unlock() }
        func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
    }
    static func main() {
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        let lease = NativeSelectionCaptureLease.shared
        let pixelsStarted = DispatchSemaphore(value: 0), releasePixels = DispatchSemaphore(value: 0), done = DispatchSemaphore(value: 0)
        let started = Outcome(), finished = Outcome()
        DispatchQueue.global().async {
            defer { done.signal() }
            do {
                try lease.withCapture { _ in
                    // The selector has already returned here. Pixel production
                    // remains held until the independent test observer releases it.
                    started.set(); pixelsStarted.signal()
                    _ = releasePixels.wait(timeout: .now() + 5)
                    finished.set()
                }
            } catch { pixelsStarted.signal() }
        }
        _ = pixelsStarted.wait(timeout: .now() + 5)
        check("first capture reaches delayed pixels", started.get())
        var rejected = false
        do { try lease.withCapture { _ in } } catch NativeSelectionCaptureLease.Failure.busy { rejected = true } catch {}
        check("second selector is busy while original pixels remain held", rejected)
        let queryDone = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { queryDone.signal() }
        check("independent work is not held by capture lease", queryDone.wait(timeout: .now() + 1) == .success)
        releasePixels.signal()
        check("original capture completes after pixel release", done.wait(timeout: .now() + 5) == .success && finished.get())
        check("next capture can acquire after original receipt", (try? lease.withCapture { _ in true }) == true)
        enum Expected: Error { case test }
        do { try lease.withCapture { _ in throw Expected.test } } catch {}
        check("failure releases only its capture lease", (try? lease.withCapture { _ in true }) == true)
        let report: [String: Any] = ["tests": cases.count, "cases": cases, "failures": failures]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }
}
