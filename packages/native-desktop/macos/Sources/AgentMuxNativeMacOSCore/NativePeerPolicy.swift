/// OS credentials identify the one host process that owns this native connection.
/// App names, executable display strings and Bundle IDs do not authorize a peer.
public enum NativePeerPolicy {
    public static func isAuthorized(expectedPID: Int32, actualPID: Int32?, expectedUID: UInt32, actualUID: UInt32?) -> Bool {
        expectedPID > 1 && actualPID == expectedPID && actualUID == expectedUID
    }
}

public enum NativeOperationPolicy {
    public static func isMutation(_ method: String) -> Bool {
        switch method {
        case "click", "performSecondaryAction", "setValue", "typeText", "pressKey", "hotkey", "pasteText", "scroll", "drag", "clipboardWrite", "captureScreenshot": true
        default: false
        }
    }
}
