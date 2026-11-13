import Foundation
@testable import AgentMuxNativeMacOSCore
import Testing

@Suite struct NativeConnectionRequestLoopTests {
    @Test func releasesARequestsAutoreleasedObjectsBeforeTheNextRequest() {
        var lines = ["screenshot", "next"]
        weak var screenshotBuffer: NSObject?
        var releasedBeforeNextRequest: Bool?

        NativeConnectionRequestLoop.run(readLine: { lines.isEmpty ? nil : lines.removeFirst() }) { line in
            if line == "screenshot" {
                let buffer = NSObject()
                screenshotBuffer = buffer
                // Why: stands in for the objects AppKit PNG encoding leaves in the pool.
                _ = Unmanaged.passRetained(buffer).autorelease()
            } else {
                releasedBeforeNextRequest = screenshotBuffer == nil
            }
            return true
        }

        #expect(releasedBeforeNextRequest == true)
    }

    @Test func servesEveryLineUntilInputEnds() {
        var lines = ["a", "b", "c"]
        var handled: [String] = []

        NativeConnectionRequestLoop.run(readLine: { lines.isEmpty ? nil : lines.removeFirst() }) { line in
            handled.append(line)
            return true
        }

        #expect(handled == ["a", "b", "c"])
    }

    @Test func stopsReadingWhenTheHandlerClosesTheConnection() {
        var lines = ["a", "b", "c"]
        var handled: [String] = []

        NativeConnectionRequestLoop.run(readLine: { lines.isEmpty ? nil : lines.removeFirst() }) { line in
            handled.append(line)
            return line != "b"
        }

        #expect(handled == ["a", "b"])
        #expect(lines == ["c"])
    }
}
