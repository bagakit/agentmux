import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct NumericArgumentParsingTests {
    @Test func convertsIntegralValues() {
        #expect(boundedInteger(5.0, as: Int.self) == 5)
        #expect(boundedInteger(0.0, as: Int.self) == 0)
        #expect(boundedInteger(-3.0, as: Int.self) == -3)
    }

    @Test func truncatesTowardZeroLikeIntInit() {
        #expect(boundedInteger(5.9, as: Int.self) == 5)
        #expect(boundedInteger(-5.9, as: Int.self) == -5)
    }

    // Int(1e300) traps despite being finite; malformed requests must not crash the agent.
    @Test func returnsNilForOutOfRangeValues() {
        #expect(boundedInteger(1e300, as: Int.self) == nil)
        #expect(boundedInteger(-1e300, as: Int.self) == nil)
    }

    @Test func returnsNilForNonFiniteValues() {
        #expect(boundedInteger(.nan, as: Int.self) == nil)
        #expect(boundedInteger(.infinity, as: Int.self) == nil)
        #expect(boundedInteger(-.infinity, as: Int.self) == nil)
    }

    @Test func honorsUnsignedDestinationBounds() {
        #expect(boundedInteger(4.0, as: UInt32.self) == 4)
        #expect(boundedInteger(-1.0, as: UInt32.self) == nil)
        #expect(boundedInteger(1e300, as: UInt32.self) == nil)
    }

    @Test func honorsSignedFixedWidthDestinationBounds() {
        #expect(boundedInteger(Double(Int32.max), as: Int32.self) == Int32.max)
        #expect(boundedInteger(Double(Int32.max) + 1, as: Int32.self) == nil)
        #expect(boundedInteger(Double(Int32.min) - 1, as: Int32.self) == nil)
    }
}
