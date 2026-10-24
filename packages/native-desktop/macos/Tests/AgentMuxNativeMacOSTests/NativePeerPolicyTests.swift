import XCTest
@testable import AgentMuxNativeMacOSCore

final class NativePeerPolicyTests: XCTestCase {
    func testExactOSPeerAndUIDAreBothNecessary() {
        XCTAssertTrue(NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4321, expectedUID: 501, actualUID: 501))
        XCTAssertFalse(NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4322, expectedUID: 501, actualUID: 501))
        XCTAssertFalse(NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4321, expectedUID: 501, actualUID: 502))
        XCTAssertFalse(NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: nil, expectedUID: 501, actualUID: 501))
        XCTAssertFalse(NativePeerPolicy.isAuthorized(expectedPID: 4321, actualPID: 4321, expectedUID: 501, actualUID: nil))
    }

    func testEveryGlobalSideEffectIsInstanceCorrelated() {
        for method in ["click", "performSecondaryAction", "setValue", "typeText", "pressKey", "hotkey", "pasteText", "scroll", "drag", "clipboardWrite", "captureScreenshot"] {
            XCTAssertTrue(NativeOperationPolicy.isMutation(method), method)
        }
        for method in ["handshake", "listApps", "listWindows", "getAppState", "clipboardRead", "permissionStatus"] {
            XCTAssertFalse(NativeOperationPolicy.isMutation(method), method)
        }
    }
}
