import AgentMuxNativeMacOSCore
import Testing

@Suite struct NativeConnectionOwnershipTests {
    @Test func unclaimedDisconnectDoesNotTerminateAgent() {
        var ownership = NativeConnectionOwnership()

        #expect(ownership.disconnect(connection(12)) == false)
    }

    @Test func unauthenticatedConnectionCannotClaimOrRetainAgent() {
        var ownership = NativeConnectionOwnership()

        #expect(ownership.registerConnection(connection(12), authenticated: false) == .rejected)
        #expect(ownership.disconnect(connection(12)) == false)
    }

    @Test func lastAuthenticatedDisconnectTerminatesAgent() {
        var ownership = NativeConnectionOwnership()

        #expect(ownership.registerConnection(connection(12), authenticated: true) == .claimed)
        #expect(ownership.disconnect(connection(12)) == true)
    }

    @Test func agentWaitsForEveryAuthenticatedConnectionToClose() {
        var ownership = NativeConnectionOwnership()

        #expect(ownership.registerConnection(connection(12), authenticated: true) == .claimed)
        #expect(ownership.registerConnection(connection(13), authenticated: true) == .retained)
        #expect(ownership.disconnect(connection(12)) == false)
        #expect(ownership.disconnect(connection(13)) == true)
    }

    @Test func duplicateRegistrationDoesNotRetainAgent() {
        var ownership = NativeConnectionOwnership()

        #expect(ownership.registerConnection(connection(12), authenticated: true) == .claimed)
        #expect(ownership.registerConnection(connection(12), authenticated: true) == .rejected)
        #expect(ownership.disconnect(connection(12)) == true)
    }

    @Test func closedSessionRejectsNewConnections() {
        var ownership = NativeConnectionOwnership()

        #expect(ownership.registerConnection(connection(12), authenticated: true) == .claimed)
        #expect(ownership.disconnect(connection(12)) == true)
        #expect(ownership.registerConnection(connection(13), authenticated: true) == .rejected)
        #expect(ownership.disconnect(connection(13)) == false)
    }

    @Test func staleDisconnectCannotRemoveReusedFileDescriptorOwner() {
        var ownership = NativeConnectionOwnership()
        let staleConnection = connection(12)
        let otherConnection = connection(13)
        let reusedDescriptorConnection = connection(14)

        #expect(ownership.registerConnection(staleConnection, authenticated: true) == .claimed)
        #expect(ownership.registerConnection(otherConnection, authenticated: true) == .retained)
        #expect(ownership.disconnect(staleConnection) == false)
        #expect(
            ownership.registerConnection(reusedDescriptorConnection, authenticated: true) ==
            .retained
        )

        #expect(ownership.disconnect(staleConnection) == false)
        #expect(ownership.disconnect(otherConnection) == false)
        #expect(ownership.disconnect(reusedDescriptorConnection) == true)
    }

    @Test func tokenlessConnectionCannotAuthenticate() {
        #expect(!isAuthenticatedNativeConnection(
            expectedToken: nil,
            requestToken: nil,
            authorizedPeer: false
        ))
        #expect(!isAuthenticatedNativeConnection(
            expectedToken: nil,
            requestToken: nil,
            authorizedPeer: true
        ))
    }

    @Test func tokenSessionRequiresAuthorizedPeerAndMatchingToken() {
        #expect(!isAuthenticatedNativeConnection(
            expectedToken: "expected",
            requestToken: "expected",
            authorizedPeer: false
        ))
        #expect(!isAuthenticatedNativeConnection(
            expectedToken: "expected",
            requestToken: "wrong",
            authorizedPeer: true
        ))
        #expect(isAuthenticatedNativeConnection(
            expectedToken: "expected",
            requestToken: "expected",
            authorizedPeer: true
        ))
    }
}

private func connection(_ rawValue: UInt64) -> NativeConnectionID {
    NativeConnectionID(rawValue: rawValue)
}
