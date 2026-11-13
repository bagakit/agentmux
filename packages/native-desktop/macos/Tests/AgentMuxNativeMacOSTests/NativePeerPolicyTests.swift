import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct NativePeerPolicyTests {
    @Test func exactOSPeerAndUIDAreBothNecessary() {
        #expect(NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4321, expectedUID: 501, actualUID: 501))
        #expect(!NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4322, expectedUID: 501, actualUID: 501))
        #expect(!NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4321, expectedUID: 501, actualUID: 502))
        #expect(!NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: nil, expectedUID: 501, actualUID: 501))
        #expect(!NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4321, expectedUID: 501, actualUID: nil))
    }

    @Test func explicitPixelsCannotUseTheReadOnlySnapshotPath() {
        #expect(!NativeOperationPolicy.isMutation("getAppState"))
        #expect(!NativeOperationPolicy.isMutation("getAppState", includesScreenshot: false))
        #expect(NativeOperationPolicy.isMutation("getAppState", includesScreenshot: true))
    }

    @Test func everyGlobalSideEffectIsInstanceCorrelated() {
        for method in ["click", "performSecondaryAction", "setValue", "typeText", "pressKey", "hotkey", "pasteText", "scroll", "drag", "clipboardWrite", "captureScreenshot"] {
            #expect(NativeOperationPolicy.isMutation(method), "\(method)")
        }
        for method in ["handshake", "listApps", "listWindows", "getAppState", "clipboardRead", "permissionStatus"] {
            #expect(!NativeOperationPolicy.isMutation(method), "\(method)")
        }
    }
}
