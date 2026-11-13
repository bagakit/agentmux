import Darwin
import Foundation
import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct NativeNDJSONReaderTests {
    @Test func multipleBufferedFramesRetainExactBoundaries() throws {
        let descriptors = try pair()
        defer { close(descriptors.0); close(descriptors.1) }
        let bytes = Data("{\"id\":1}\n{\"id\":2}\n".utf8)
        _ = bytes.withUnsafeBytes { write(descriptors.0, $0.baseAddress, $0.count) }
        shutdown(descriptors.0, SHUT_WR)
        let reader = NativeNDJSONReader(descriptor: descriptors.1)
        #expect(reader.readLine() == "{\"id\":1}")
        #expect(reader.readLine() == "{\"id\":2}")
        #expect(reader.readLine() == nil)
        #expect(reader.failure == nil)
    }
    @Test func truncatedInputIsNotACompleteRequest() throws {
        let descriptors = try pair()
        defer { close(descriptors.0); close(descriptors.1) }
        let bytes = Data("{\"id\":1}".utf8)
        _ = bytes.withUnsafeBytes { write(descriptors.0, $0.baseAddress, $0.count) }
        shutdown(descriptors.0, SHUT_WR)
        let reader = NativeNDJSONReader(descriptor: descriptors.1)
        #expect(reader.readLine() == nil)
        #expect(reader.failure != nil)
    }
    private func pair() throws -> (Int32, Int32) {
        var descriptors: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw POSIXError(.EIO) }
        return (descriptors[0], descriptors[1])
    }
}
