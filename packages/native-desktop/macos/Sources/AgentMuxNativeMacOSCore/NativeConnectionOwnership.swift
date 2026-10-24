public struct NativeConnectionID: Hashable, Sendable {
    public let rawValue: UInt64

    public init(rawValue: UInt64) {
        self.rawValue = rawValue
    }
}

public enum NativeConnectionRegistration: Sendable {
    case rejected
    case claimed
    case retained
}

public struct NativeConnectionOwnership: Sendable {
    private var authenticatedConnections: Set<NativeConnectionID> = []
    private var wasClaimed = false
    private var sessionClosed = false

    public init() {}

    public mutating func registerConnection(
        _ connection: NativeConnectionID,
        authenticated: Bool
    ) -> NativeConnectionRegistration {
        guard authenticated, !sessionClosed else { return .rejected }
        let inserted = authenticatedConnections.insert(connection).inserted
        guard inserted else { return .rejected }
        guard !wasClaimed else { return .retained }
        wasClaimed = true
        return .claimed
    }

    public mutating func disconnect(_ connection: NativeConnectionID) -> Bool {
        guard authenticatedConnections.remove(connection) != nil else { return false }
        guard wasClaimed, authenticatedConnections.isEmpty else { return false }
        sessionClosed = true
        return true
    }
}

public func isAuthenticatedNativeConnection(
    expectedToken: String?,
    requestToken: String?,
    authorizedPeer: Bool
) -> Bool {
    guard authorizedPeer else { return false }
    guard let expectedToken, !expectedToken.isEmpty else { return false }
    return requestToken == expectedToken
}
