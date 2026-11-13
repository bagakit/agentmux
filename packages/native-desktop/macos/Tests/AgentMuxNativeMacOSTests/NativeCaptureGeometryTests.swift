import CoreGraphics
import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct NativeCaptureGeometryTests {
    @Test func invalidRectanglesCannotAllocateCaptureBuffers() {
        #expect(!NativeCaptureGeometry.isValid(CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1)))
        #expect(!NativeCaptureGeometry.isValid(CGRect(x: 0, y: 0, width: 0, height: 1)))
        #expect(NativeCaptureGeometry.isValid(CGRect(x: -10, y: -20, width: 100, height: 200)))
    }
}
