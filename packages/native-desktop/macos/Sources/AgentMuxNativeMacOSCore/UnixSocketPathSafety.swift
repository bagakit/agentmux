import Darwin

public enum UnixSocketPathSafety {
    /// Set once at process entry, before AppKit or worker threads start. A Unix
    /// socket becomes visible at bind, before its final chmod can run. Keeping
    /// this mask for the native process lifetime makes that first state private
    /// too; temporarily restoring a process-wide mask would race other threads.
    public static func initializePrivateCreationMask() {
        _ = Darwin.umask(mode_t(0o077))
    }

    public static func isSocketMode(_ mode: mode_t) -> Bool {
        (mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK)
    }

    public static func shouldRejectExistingPathAfterBindFailure(
        bindErrno: Int32,
        existingMode: mode_t?
    ) -> Bool {
        bindErrno == EADDRINUSE && existingMode.map { !isSocketMode($0) } == true
    }
}
