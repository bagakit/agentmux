import Darwin
import Foundation
import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct NativePeerAuthorizerTests {
    @Test func missingOrMalformedAuditFactsCannotAuthenticate() {
        #expect(!NativePeerAuthorizer.authorizes(auditToken: nil))
        #expect(!NativePeerAuthorizer.authorizes(auditToken: Data()))
        #expect(!NativePeerAuthorizer.authorizes(auditToken: Data(repeating: 0, count: 1)))
    }
    @Test func fabricatedAuditBytesMustPassTheRealOSGuestLookup() {
        // Even DEBUG's bare test profile cannot turn a failed Security lookup
        // into an unsigned peer or accept a caller-invented token.
        let fabricated = Data(repeating: 0xff, count: MemoryLayout<audit_token_t>.size)
        #expect(!NativePeerAuthorizer.authorizes(auditToken: fabricated))
    }
}
