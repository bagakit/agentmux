import Darwin
import Dispatch
import Foundation
@testable import AgentMuxNativeMacOSCore
import Testing

@Suite struct AuthenticatedConnectionHangupMonitorTests {
    @Test func rejectsInvalidDescriptorDuringSetup() {
        #expect(throws: (any Error).self) {
            try AuthenticatedConnectionHangupMonitor(
                fileDescriptor: -1,
                onHangup: {}
            )
        }
    }

    @Test func registrationFailureClosesEventQueueOnce() {
        let closes = DescriptorCloseRecorder()

        #expect(throws: (any Error).self) {
            try AuthenticatedConnectionHangupMonitor(
                fileDescriptor: 42,
                registerEvents: { _, _, _ in .EBADF },
                closeDescriptor: { descriptor in
                    closes.recordAndClose(descriptor)
                },
                onHangup: {}
            )
        }
        #expect(closes.count == 1)
    }

    @Test func reportsPeerCloseWhileRequestHandlingIsBlocked() throws {
        let descriptors = try makeSocketPair()
        let hangups = CallbackRecorder()
        let processingStarted = CallbackRecorder()
        let releaseProcessing = DispatchSemaphore(value: 0)
        let processingFinished = DispatchSemaphore(value: 0)
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {
                hangups.record()
            }
        )
        monitor.start()

        DispatchQueue.global().async {
            processingStarted.record()
            releaseProcessing.wait()
            processingFinished.signal()
        }
        #expect(processingStarted.wait(seconds: 1))
        close(descriptors.peer)

        #expect(hangups.wait(seconds: 1))
        #expect(processingFinished.wait(timeout: .now() + 0.05) == .timedOut)

        releaseProcessing.signal()
        #expect(processingFinished.wait(timeout: .now() + 1) == .success)
        #expect(hangups.count == 1)
        monitor.cancel()
        close(descriptors.local)
    }

    @Test func readableDataDoesNotLookLikeHangup() throws {
        let descriptors = try makeSocketPair()
        let hangups = CallbackRecorder()
        let events = CallbackRecorder()
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onEvent: {
                events.record()
            },
            onHangup: {
                hangups.record()
            }
        )
        monitor.start()
        var byte: UInt8 = 7

        #expect(write(descriptors.peer, &byte, 1) == 1)
        usleep(50_000)
        #expect(hangups.count == 0)
        #expect(events.count == 0)
        close(descriptors.peer)
        #expect(hangups.wait(seconds: 1))
        #expect(events.count == 1)
        #expect(hangups.count == 1)

        monitor.cancel()
        close(descriptors.local)
    }

    @Test func cancelPreventsLaterHangupCallback() throws {
        let descriptors = try makeSocketPair()
        let hangups = CallbackRecorder()
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {
                hangups.record()
            }
        )
        monitor.start()

        monitor.cancel()
        close(descriptors.peer)

        #expect(!hangups.wait(seconds: 0.1))
        close(descriptors.local)
    }

    @Test func cancelReleasesMonitorWhileSocketStaysOpen() throws {
        let descriptors = try makeSocketPair()
        var monitor: AuthenticatedConnectionHangupMonitor? = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {}
        )
        weak var retainedMonitor = monitor

        monitor?.cancel()
        monitor = nil

        let deadline = Date().addingTimeInterval(1)
        while retainedMonitor != nil, Date() < deadline {
            usleep(10_000)
        }
        #expect(retainedMonitor == nil)
        close(descriptors.peer)
        close(descriptors.local)
    }

    @Test func startReportsHangupQueuedAfterSuccessfulSetup() throws {
        let descriptors = try makeSocketPair()
        let hangups = CallbackRecorder()
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {
                hangups.record()
            }
        )

        close(descriptors.peer)
        monitor.start()

        #expect(hangups.wait(seconds: 1))
        #expect(hangups.count == 1)
        monitor.cancel()
        close(descriptors.local)
    }
}

private final class DescriptorCloseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var closeCount = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return closeCount
    }

    func recordAndClose(_ descriptor: Int32) {
        lock.lock()
        closeCount += 1
        let shouldClose = closeCount == 1
        lock.unlock()
        if shouldClose {
            close(descriptor)
        }
    }
}

private func makeSocketPair() throws -> (local: Int32, peer: Int32) {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
        throw POSIXError(.EIO)
    }
    return (descriptors[0], descriptors[1])
}
