import ApplicationServices
import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct NativeAXReplyTests {
    @Test func unconfirmedAXWritesNeverAuthorizeAnotherInputPath() {
        #expect(NativeAXReply.classify(.cannotComplete) == .unknown)
        #expect(NativeAXReply.classify(.failure) == .unknown)
        #expect(NativeAXReply.classify(.apiDisabled) == .unknown)
    }
    @Test func acceptanceAndExplicitUnsupportedRepliesStayDistinct() {
        #expect(NativeAXReply.classify(.success) == .accepted)
        #expect(NativeAXReply.classify(.actionUnsupported) == .unsupported)
        #expect(NativeAXReply.classify(.attributeUnsupported) == .unsupported)
    }
}
