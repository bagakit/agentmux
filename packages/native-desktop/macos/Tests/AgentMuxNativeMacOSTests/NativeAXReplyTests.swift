import ApplicationServices
import XCTest
@testable import AgentMuxNativeMacOSCore

final class NativeAXReplyTests: XCTestCase {
    func testUnconfirmedAXWritesNeverAuthorizeAnotherInputPath() {
        XCTAssertEqual(NativeAXReply.classify(.cannotComplete), .unknown)
        XCTAssertEqual(NativeAXReply.classify(.failure), .unknown)
        XCTAssertEqual(NativeAXReply.classify(.apiDisabled), .unknown)
    }
    func testAcceptanceAndExplicitUnsupportedRepliesStayDistinct() {
        XCTAssertEqual(NativeAXReply.classify(.success), .accepted)
        XCTAssertEqual(NativeAXReply.classify(.actionUnsupported), .unsupported)
        XCTAssertEqual(NativeAXReply.classify(.attributeUnsupported), .unsupported)
    }
}
