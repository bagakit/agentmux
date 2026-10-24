import CoreGraphics
import XCTest
@testable import AgentMuxNativeMacOSCore

final class NativeCaptureGeometryTests: XCTestCase {
    func testPrimaryDisplayTopLeftMapsToQuartzOrigin() {
        XCTAssertEqual(NativeCaptureGeometry.quartzRect(appKitRect: CGRect(x: 0, y: 700, width: 200, height: 100), primaryDisplayTop: 800), CGRect(x: 0, y: 0, width: 200, height: 100))
    }
    func testLeftAndAboveDisplaysKeepNegativeCoordinates() {
        XCTAssertEqual(NativeCaptureGeometry.quartzRect(appKitRect: CGRect(x: -1600, y: 900, width: 300, height: 200), primaryDisplayTop: 800), CGRect(x: -1600, y: -300, width: 300, height: 200))
    }
    func testInvalidRectanglesCannotAllocateCaptureBuffers() {
        XCTAssertFalse(NativeCaptureGeometry.isValid(CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1)))
        XCTAssertFalse(NativeCaptureGeometry.isValid(CGRect(x: 0, y: 0, width: 0, height: 1)))
        XCTAssertTrue(NativeCaptureGeometry.isValid(CGRect(x: -10, y: -20, width: 100, height: 200)))
    }
}
