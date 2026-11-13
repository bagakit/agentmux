import Dispatch
import Foundation
@testable import AgentMuxNativeMacOSCore
import Testing

@Suite struct PermissionStatusSnapshotTests {
    @Test func capturesBothPermissionResults() {
        let snapshot = PermissionStatusSnapshotProbe.capture(
            accessibilityProbe: { true },
            screenshotsProbe: { false }
        )

        #expect(snapshot == PermissionStatusSnapshot(accessibilityGranted: true, screenshotsGranted: false))
    }

    @Test func runsPermissionProbesConcurrently() {
        let accessibilityStarted = DispatchSemaphore(value: 0)
        let screenshotsStarted = DispatchSemaphore(value: 0)
        let releaseProbes = DispatchSemaphore(value: 0)
        let finished = CallbackRecorder()

        DispatchQueue.global().async {
            _ = PermissionStatusSnapshotProbe.capture(
                accessibilityProbe: {
                    accessibilityStarted.signal()
                    releaseProbes.wait()
                    return true
                },
                screenshotsProbe: {
                    screenshotsStarted.signal()
                    releaseProbes.wait()
                    return true
                }
            )
            finished.record()
        }

        #expect(accessibilityStarted.wait(timeout: .now() + 1) == .success)
        #expect(screenshotsStarted.wait(timeout: .now() + 1) == .success)
        releaseProbes.signal()
        releaseProbes.signal()
        #expect(finished.wait(seconds: 1))
    }

    @Test func coalescesRefreshesWhileProbeIsRunning() {
        let callbackQueue = DispatchQueue(label: "permission-status-test-callback")
        let probeStarted = DispatchSemaphore(value: 0)
        let releaseProbe = DispatchSemaphore(value: 0)
        let handled = CallbackRecorder()
        let probeCount = LockedCounter()
        let coordinator = PermissionStatusRefreshCoordinator(
            callbackQueue: callbackQueue,
            probe: {
                probeCount.increment()
                probeStarted.signal()
                releaseProbe.wait()
                return PermissionStatusSnapshot(
                    accessibilityGranted: true,
                    screenshotsGranted: true
                )
            },
            handler: { _ in handled.record() }
        )

        coordinator.refresh()
        #expect(probeStarted.wait(timeout: .now() + 1) == .success)
        coordinator.refresh()
        coordinator.refresh()
        releaseProbe.signal()

        #expect(handled.wait(seconds: 1))
        #expect(probeCount.value == 1)
        #expect(handled.count == 1)
    }

    @Test func allowsRefreshAfterPreviousSnapshotWasHandled() {
        let callbackQueue = DispatchQueue(label: "permission-status-test-callback")
        let firstHandled = CallbackRecorder()
        let secondHandled = CallbackRecorder()
        let probeCount = LockedCounter()
        let coordinator = PermissionStatusRefreshCoordinator(
            callbackQueue: callbackQueue,
            probe: {
                let count = probeCount.increment()
                return PermissionStatusSnapshot(
                    accessibilityGranted: count == 2,
                    screenshotsGranted: false
                )
            },
            handler: { snapshot in
                if snapshot.accessibilityGranted {
                    secondHandled.record()
                } else {
                    firstHandled.record()
                }
            }
        )

        coordinator.refresh()
        #expect(firstHandled.wait(seconds: 1))
        coordinator.refresh()

        #expect(secondHandled.wait(seconds: 1))
        #expect(probeCount.value == 2)
        #expect(firstHandled.count == 1)
        #expect(secondHandled.count == 1)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }
}
