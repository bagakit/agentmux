import Darwin
import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct UnixSocketPathSafetyTests {
    @Test func onlyUnixSocketModesAreAccepted() {
        #expect(UnixSocketPathSafety.isSocketMode(mode_t(S_IFSOCK | 0o600)))
        #expect(!UnixSocketPathSafety.isSocketMode(mode_t(S_IFREG | 0o600)))
        #expect(!UnixSocketPathSafety.isSocketMode(mode_t(S_IFDIR | 0o700)))
        #expect(!UnixSocketPathSafety.isSocketMode(mode_t(S_IFLNK | 0o777)))
    }

    @Test func rejectsOnlyNonSocketPathsAfterAddressInUseBindFailure() {
        #expect(
            UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EADDRINUSE,
                existingMode: mode_t(S_IFREG | 0o600)
            )
        )
        #expect(
            !UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EADDRINUSE,
                existingMode: mode_t(S_IFSOCK | 0o600)
            )
        )
        #expect(
            !UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EACCES,
                existingMode: mode_t(S_IFREG | 0o600)
            )
        )
        #expect(
            !UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EADDRINUSE,
                existingMode: nil
            )
        )
    }
}
