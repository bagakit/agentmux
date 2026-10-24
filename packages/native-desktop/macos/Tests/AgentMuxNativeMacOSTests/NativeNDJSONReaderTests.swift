import Darwin
import Foundation
import XCTest
@testable import AgentMuxNativeMacOSCore

final class NativeNDJSONReaderTests: XCTestCase {
    func testMultipleBufferedFramesRetainExactBoundaries() throws {
        let descriptors = try pair()
        defer { close(descriptors.0); close(descriptors.1) }
        let bytes = Data("{\"id\":1}\n{\"id\":2}\n".utf8)
        _ = bytes.withUnsafeBytes { write(descriptors.0, $0.baseAddress, $0.count) }
        shutdown(descriptors.0, SHUT_WR)
        let reader = NativeNDJSONReader(descriptor: descriptors.1)
        XCTAssertEqual(reader.readLine(), "{\"id\":1}")
        XCTAssertEqual(reader.readLine(), "{\"id\":2}")
        XCTAssertNil(reader.readLine())
        XCTAssertNil(reader.failure)
    }
    func testTruncatedInputIsNotACompleteRequest() throws {
        let descriptors = try pair()
        defer { close(descriptors.0); close(descriptors.1) }
        let bytes = Data("{\"id\":1}".utf8)
        _ = bytes.withUnsafeBytes { write(descriptors.0, $0.baseAddress, $0.count) }
        shutdown(descriptors.0, SHUT_WR)
        let reader = NativeNDJSONReader(descriptor: descriptors.1)
        XCTAssertNil(reader.readLine())
        XCTAssertNotNil(reader.failure)
    }
    private func pair() throws -> (Int32, Int32) {
        var descriptors: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw POSIXError(.EIO) }
        return (descriptors[0], descriptors[1])
    }
}
