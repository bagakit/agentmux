import Darwin
import Foundation
import Testing
import AgentMuxNativeMacOSCore

@Suite struct NativeProcessStartTests {
    @Test func currentProcessHasAStableKnownBirth() throws {
        let now = Date().timeIntervalSince1970 * 1000
        let start = try #require(NativeProcessStart.milliseconds(pid: getpid()))

        #expect(start.isFinite)
        #expect(start > 0)
        #expect(start <= now)
        #expect(NativeProcessStart.milliseconds(pid: getpid()) == start)
    }

    @Test func childBornAfterParentAndUnknownOnceReaped() throws {
        let parent = try #require(NativeProcessStart.milliseconds(pid: getpid()))
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        let pid = child.processIdentifier
        let childStart = NativeProcessStart.milliseconds(pid: pid)
        let now = Date().timeIntervalSince1970 * 1000
        child.terminate()
        child.waitUntilExit()

        let start = try #require(childStart)
        #expect(start > parent)
        #expect(start <= now)
        #expect(NativeProcessStart.milliseconds(pid: pid) == nil)
    }

    @Test func nonProcessIdentifiersHaveNoBirth() {
        #expect(NativeProcessStart.milliseconds(pid: 0) == nil)
        #expect(NativeProcessStart.milliseconds(pid: -1) == nil)
    }
}
