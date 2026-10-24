import Darwin
import Foundation
import XCTest
@testable import AgentMuxNativeMacOSCore

final class NativePeerAuthorizerTests: XCTestCase {
    func testMissingOrMalformedAuditFactsCannotAuthenticate() {
        XCTAssertFalse(NativePeerAuthorizer.authorizes(auditToken: nil))
        XCTAssertFalse(NativePeerAuthorizer.authorizes(auditToken: Data()))
        XCTAssertFalse(NativePeerAuthorizer.authorizes(auditToken: Data(repeating: 0, count: 1)))
    }
    func testFabricatedAuditBytesMustPassTheRealOSGuestLookup() {
        // Even DEBUG's bare test profile cannot turn a failed Security lookup
        // into an unsigned peer or accept a caller-invented token.
        let fabricated = Data(repeating: 0xff, count: MemoryLayout<audit_token_t>.size)
        XCTAssertFalse(NativePeerAuthorizer.authorizes(auditToken: fabricated))
    }
}
