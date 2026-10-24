import ApplicationServices

/// Only an explicit unsupported reply permits a different input path. An AX
/// timeout or cannot-complete reply does not prove that the first write failed.
public enum NativeAXReply {
    public enum Disposition: Equatable { case accepted, unsupported, unknown }
    public static func classify(_ status: AXError) -> Disposition {
        switch status {
        case .success: .accepted
        case .actionUnsupported, .attributeUnsupported, .notImplemented: .unsupported
        default: .unknown
        }
    }
}
