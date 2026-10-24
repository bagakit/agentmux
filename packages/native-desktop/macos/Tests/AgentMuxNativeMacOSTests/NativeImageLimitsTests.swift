import XCTest
@testable import AgentMuxNativeMacOSCore
final class NativeImageLimitsTests: XCTestCase {
    func testCommonRetinaCaptureAndPerImageBoundaries() {
        XCTAssertTrue(NativeImageLimits.permits(width: 3840, height: 2160))
        XCTAssertTrue(NativeImageLimits.permits(width: 8192, height: 4096))
        XCTAssertFalse(NativeImageLimits.permits(width: 8192, height: 4097))
        XCTAssertFalse(NativeImageLimits.permits(width: 16385, height: 1))
        XCTAssertFalse(NativeImageLimits.permits(width: .infinity, height: 1))
        XCTAssertFalse(NativeImageLimits.permits(width: 1, height: .nan))
    }
}
