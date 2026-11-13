import Testing
@testable import AgentMuxNativeMacOSCore
@Suite struct NativeImageLimitsTests {
    @Test func commonRetinaCaptureAndPerImageBoundaries() {
        #expect(NativeImageLimits.permits(width: 3840, height: 2160))
        #expect(NativeImageLimits.permits(width: 8192, height: 4096))
        #expect(!NativeImageLimits.permits(width: 8192, height: 4097))
        #expect(!NativeImageLimits.permits(width: 16385, height: 1))
        #expect(!NativeImageLimits.permits(width: .infinity, height: 1))
        #expect(!NativeImageLimits.permits(width: 1, height: .nan))
    }
}
