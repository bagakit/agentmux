import AgentMuxNativeMacOSCore
import XCTest

final class NativeConnectionOwnershipTests: XCTestCase {
    func testUnclaimedDisconnectDoesNotTerminateAgent() {
        var ownership = NativeConnectionOwnership()

        XCTAssertFalse(ownership.disconnect(connection(12)))
    }

    func testUnauthenticatedConnectionCannotClaimOrRetainAgent() {
        var ownership = NativeConnectionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: false), .rejected)
        XCTAssertFalse(ownership.disconnect(connection(12)))
    }

    func testLastAuthenticatedDisconnectTerminatesAgent() {
        var ownership = NativeConnectionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertTrue(ownership.disconnect(connection(12)))
    }

    func testAgentWaitsForEveryAuthenticatedConnectionToClose() {
        var ownership = NativeConnectionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(connection(13), authenticated: true), .retained)
        XCTAssertFalse(ownership.disconnect(connection(12)))
        XCTAssertTrue(ownership.disconnect(connection(13)))
    }

    func testDuplicateRegistrationDoesNotRetainAgent() {
        var ownership = NativeConnectionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .rejected)
        XCTAssertTrue(ownership.disconnect(connection(12)))
    }

    func testClosedSessionRejectsNewConnections() {
        var ownership = NativeConnectionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertTrue(ownership.disconnect(connection(12)))
        XCTAssertEqual(ownership.registerConnection(connection(13), authenticated: true), .rejected)
        XCTAssertFalse(ownership.disconnect(connection(13)))
    }

    func testStaleDisconnectCannotRemoveReusedFileDescriptorOwner() {
        var ownership = NativeConnectionOwnership()
        let staleConnection = connection(12)
        let otherConnection = connection(13)
        let reusedDescriptorConnection = connection(14)

        XCTAssertEqual(ownership.registerConnection(staleConnection, authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(otherConnection, authenticated: true), .retained)
        XCTAssertFalse(ownership.disconnect(staleConnection))
        XCTAssertEqual(
            ownership.registerConnection(reusedDescriptorConnection, authenticated: true),
            .retained
        )

        XCTAssertFalse(ownership.disconnect(staleConnection))
        XCTAssertFalse(ownership.disconnect(otherConnection))
        XCTAssertTrue(ownership.disconnect(reusedDescriptorConnection))
    }

    func testTokenlessConnectionCannotAuthenticate() {
        XCTAssertFalse(isAuthenticatedNativeConnection(
            expectedToken: nil,
            requestToken: nil,
            authorizedPeer: false
        ))
        XCTAssertFalse(isAuthenticatedNativeConnection(
            expectedToken: nil,
            requestToken: nil,
            authorizedPeer: true
        ))
    }

    func testTokenSessionRequiresAuthorizedPeerAndMatchingToken() {
        XCTAssertFalse(isAuthenticatedNativeConnection(
            expectedToken: "expected",
            requestToken: "expected",
            authorizedPeer: false
        ))
        XCTAssertFalse(isAuthenticatedNativeConnection(
            expectedToken: "expected",
            requestToken: "wrong",
            authorizedPeer: true
        ))
        XCTAssertTrue(isAuthenticatedNativeConnection(
            expectedToken: "expected",
            requestToken: "expected",
            authorizedPeer: true
        ))
    }
}

private func connection(_ rawValue: UInt64) -> NativeConnectionID {
    NativeConnectionID(rawValue: rawValue)
}
