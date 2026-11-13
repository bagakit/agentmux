import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct KeyboardInputSafetyTests {
    @Test func syntheticInputRequiresFocusedTargetWindow() {
        let cases: [(focused: Bool, restoreWindow: Bool, expectedFailure: KeyboardInputSafety.FocusFailure?)] = [
            (focused: true, restoreWindow: false, expectedFailure: nil),
            (focused: true, restoreWindow: true, expectedFailure: nil),
            (focused: false, restoreWindow: false, expectedFailure: .targetNotFocused),
            (focused: false, restoreWindow: true, expectedFailure: .targetNotFocusedAfterRestore),
        ]

        for testCase in cases {
            #expect(
                KeyboardInputSafety.syntheticInputFocusFailure(
                    targetWindowFocused: testCase.focused,
                    restoreWindowRequested: testCase.restoreWindow
                ) == testCase.expectedFailure
            )
        }
    }
}
