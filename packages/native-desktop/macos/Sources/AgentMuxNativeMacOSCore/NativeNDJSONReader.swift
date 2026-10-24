import Darwin
import Foundation

/// The memory boundary is one protocol frame. Reads are buffered independently
/// of image size, and scanning resumes at the previous buffer end.
public final class NativeNDJSONReader {
    public static let maxFrameBytes = 26 * 1024 * 1024
    private let descriptor: Int32
    private var buffer = Data()
    private var scanned = 0
    private var ended = false
    public private(set) var failure: String?
    public init(descriptor: Int32) { self.descriptor = descriptor }

    public func readLine() -> String? {
        guard !ended else { return nil }
        while true {
            if let newline = buffer[scanned...].firstIndex(of: 10) {
                guard newline <= Self.maxFrameBytes else { return fail("native request exceeds the NDJSON frame limit") }
                let line = Data(buffer[..<newline])
                buffer.removeSubrange(...newline)
                scanned = 0
                guard let text = String(data: line, encoding: .utf8) else { return fail("native request is not UTF-8") }
                return text
            }
            scanned = buffer.count
            guard buffer.count <= Self.maxFrameBytes else { return fail("native request exceeds the NDJSON frame limit") }
            var incoming = [UInt8](repeating: 0, count: 64 * 1024)
            let count = read(descriptor, &incoming, incoming.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else {
                ended = true
                if !buffer.isEmpty { failure = "native request ended before its NDJSON delimiter" }
                return nil
            }
            buffer.append(contentsOf: incoming.prefix(count))
        }
    }
    private func fail(_ message: String) -> String? { failure = message; ended = true; return nil }
}
