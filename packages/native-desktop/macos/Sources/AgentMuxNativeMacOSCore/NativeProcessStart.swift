import Darwin

/// Process birth as the kernel records it. Every process has one, including
/// executables that LaunchServices never saw, so it identifies a pid's current
/// occupant without depending on how the process was started.
public enum NativeProcessStart {
    /// Milliseconds since 1970, or nil when no live or unreaped process holds `pid`.
    public static func milliseconds(pid: pid_t) -> Double? {
        guard pid > 0 else { return nil }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
              size == MemoryLayout<kinfo_proc>.stride,
              info.kp_proc.p_pid == pid else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
    }
}
