import Darwin
import Foundation

// A socket-publication protocol fixture, compiled with the production
// UnixSocketPathSafety source. It does not invoke AppKit, Security peer policy,
// screen capture, signing or permission APIs, or add a production test mode.
@main
private struct SocketPublicationProducer {
    private struct Failure: Error {
        let stage: String
        let code: Int32
    }

    static func main() {
        UnixSocketPathSafety.initializePrivateCreationMask()
        do { try run() } catch {
            let failure = error as? Failure
            try? event("failed", extra: ["stage": failure?.stage ?? "fixture_protocol", "errno": failure?.code ?? 0])
            exit(1)
        }
    }

    private static func run() throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 2, !arguments[1].isEmpty else { throw Failure(stage: "arguments", code: EINVAL) }
        let socketPath = arguments[0]
        let token = arguments[1]
        let instanceId = UUID().uuidString
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw Failure(stage: "socket", code: errno) }
        defer { Darwin.close(listener) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < capacity else { throw Failure(stage: "path_length", code: ENAMETOOLONG) }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            socketPath.withCString { source in
                strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self), source, capacity)
            }
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw Failure(stage: "bind", code: errno) }
        var identity = stat()
        guard lstat(socketPath, &identity) == 0 else { throw Failure(stage: "bound_identity", code: errno) }
        var cleaned = false
        defer { if !cleaned { try? removeExactSocket(socketPath, identity: identity) } }

        // This receipt and barrier precede chmod and listen. The parent must
        // inspect the real directory entry, rather than trust a reported mode.
        try event("bound")
        guard readLine() == "continue" else { throw Failure(stage: "bind_barrier", code: EINVAL) }
        guard chmod(socketPath, 0o600) == 0 else { throw Failure(stage: "chmod", code: errno) }
        guard listen(listener, 1) == 0 else { throw Failure(stage: "listen", code: errno) }
        try event("listening")
        let peer = accept(listener, nil, nil)
        guard peer >= 0 else { throw Failure(stage: "accept", code: errno) }
        defer { Darwin.close(peer) }
        var noSignal: Int32 = 1
        guard setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw Failure(stage: "no_sigpipe", code: errno)
        }

        var buffered = Data()
        let hello = try request(peer, buffered: &buffered, token: token)
        guard hello["method"] as? String == "handshake" else { throw Failure(stage: "handshake_method", code: EINVAL) }
        try response(peer, request: hello, instanceId: instanceId, result: [
            "provider": "agentmux-native-macos", "providerVersion": "socket-publication-fixture",
            "protocolVersion": 1, "instanceId": instanceId,
        ])
        let capture = try request(peer, buffered: &buffered, token: token)
        guard capture["method"] as? String == "captureScreenshot",
              let parameters = capture["params"] as? [String: Any], parameters["mode"] as? String == "selection",
              let operationId = capture["operationId"] as? String, !operationId.isEmpty,
              capture["expectedInstanceId"] as? String == instanceId else {
            throw Failure(stage: "capture_identity", code: EINVAL)
        }
        try response(peer, request: capture, instanceId: instanceId, result: ["state": "cancelled"])
        try event("served", extra: ["requestCount": 2, "instanceId": instanceId, "operationId": operationId])
        let closing = readLine()
        guard closing == nil || closing == "close" else { throw Failure(stage: "close_barrier", code: EINVAL) }
        try removeExactSocket(socketPath, identity: identity)
        cleaned = true
        try event("closed")
    }

    private static func request(_ descriptor: Int32, buffered: inout Data, token: String) throws -> [String: Any] {
        let limit = 64 * 1024
        while !buffered.contains(10) {
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw Failure(stage: "request_read", code: count < 0 ? errno : EPIPE) }
            guard buffered.count + count <= limit else { throw Failure(stage: "request_limit", code: EMSGSIZE) }
            buffered.append(contentsOf: bytes.prefix(count))
        }
        guard let newline = buffered.firstIndex(of: 10) else { throw Failure(stage: "request_frame", code: EINVAL) }
        let line = buffered[..<newline]
        buffered.removeSubrange(...newline)
        guard let value = try JSONSerialization.jsonObject(with: line) as? [String: Any],
              let id = value["id"] as? NSNumber, CFGetTypeID(id) != CFBooleanGetTypeID(),
              id.doubleValue.isFinite, id.doubleValue.rounded() == id.doubleValue, id.doubleValue > 0,
              value["token"] as? String == token else { throw Failure(stage: "request_identity", code: EINVAL) }
        return value
    }

    private static func response(_ descriptor: Int32, request: [String: Any], instanceId: String, result: [String: Any]) throws {
        var value: [String: Any] = ["id": request["id"]!, "ok": true, "instanceId": instanceId, "result": result]
        if let operationId = request["operationId"] { value["operationId"] = operationId }
        try writeJSON(descriptor, value)
    }

    private static func event(_ name: String, extra: [String: Any] = [:]) throws {
        try writeJSON(STDOUT_FILENO, extra.merging(["event": name, "pid": Int(getpid())]) { _, identity in identity })
    }

    private static func writeJSON(_ descriptor: Int32, _ value: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        data.append(10)
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Failure(stage: "response_write", code: count < 0 ? errno : EPIPE) }
                offset += count
            }
        }
    }

    private static func removeExactSocket(_ path: String, identity: stat) throws {
        var current = stat()
        guard lstat(path, &current) == 0, current.st_dev == identity.st_dev, current.st_ino == identity.st_ino,
              current.st_uid == getuid(), UnixSocketPathSafety.isSocketMode(current.st_mode) else {
            throw Failure(stage: "cleanup_identity", code: EINVAL)
        }
        guard unlink(path) == 0 else { throw Failure(stage: "cleanup_unlink", code: errno) }
    }
}
