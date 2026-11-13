import CoreFoundation
import Foundation
import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct AttributeValueCoercionTests {
    @Test func stringValueRemainsAStringWithoutTrimming() {
        let coercion = AttributeValueCoercion(existingValue: "old" as CFString, requested: "  new  ")

        #expect(coercion.writeValue == .string("  new  "))
    }

    @Test func integerValuePreservesIntegerKind() {
        let coercion = AttributeValueCoercion(existingValue: NSNumber(value: Int32(2)), requested: "3.0")

        #expect(coercion.writeValue == .integer(3))
    }

    @Test func integerDecimalConversionIsExactAboveDoublePrecision() {
        let coercion = AttributeValueCoercion(
            existingValue: NSNumber(value: Int64(1)),
            requested: "9007199254740993.0"
        )

        #expect(coercion.writeValue == .integer(9_007_199_254_740_993))
        #expect(
            coercion.compare(readback: NSNumber(value: Int64(9_007_199_254_740_992))) ==
            .mismatch(actualPreview: "9007199254740992")
        )
    }

    @Test func integerScientificNotationIsParsedExactly() {
        let cases: [(String, Int64)] = [
            ("1e3", 1_000),
            ("9.007199254740993e15", 9_007_199_254_740_993),
            ("10.0e-1", 1),
            ("+0.000E999999999999999999999", 0),
            ("-.0e-999999999999999999999", 0),
        ]

        for (requested, expected) in cases {
            #expect(
                AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: requested).writeValue ==
                .integer(expected)
            )
        }
    }

    @Test func integerParsingPreservesInt64Boundaries() {
        #expect(
            AttributeValueCoercion(
                existingValue: NSNumber(value: 1),
                requested: "9223372036854775807.0"
            ).writeValue ==
            .integer(.max)
        )
        #expect(
            AttributeValueCoercion(
                existingValue: NSNumber(value: 1),
                requested: "-9.223372036854775808e18"
            ).writeValue ==
            .integer(.min)
        )
    }

    @Test func nonIntegralAndOutOfRangeIntegerFormsUseStringFallback() {
        for requested in ["1e-1", "9223372036854775808", "-9223372036854775809", "1e999999999999999999999"] {
            #expect(
                AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: requested).writeValue ==
                .string(requested)
            )
        }
    }

    @Test func doubleValuePreservesDoubleKindForIntegralInput() {
        let coercion = AttributeValueCoercion(existingValue: NSNumber(value: 2.5), requested: "3")

        #expect(coercion.writeValue == .double(3.0))
    }

    @Test func booleanValueAcceptsWordsAndNumericAliases() {
        #expect(
            AttributeValueCoercion(existingValue: kCFBooleanFalse, requested: "TRUE").writeValue ==
            .boolean(true)
        )
        #expect(
            AttributeValueCoercion(existingValue: kCFBooleanTrue, requested: "0").writeValue ==
            .boolean(false)
        )
    }

    @Test func unreadableAndUnhandledValuesUseStringFallback() {
        #expect(
            AttributeValueCoercion(existingValue: nil, requested: "7").writeValue ==
            .string("7")
        )
        #expect(
            AttributeValueCoercion(existingValue: [1, 2] as CFArray, requested: "7").writeValue ==
            .string("7")
        )
    }

    @Test func invalidHandledValuesUseStringFallback() {
        #expect(
            AttributeValueCoercion(existingValue: NSNumber(value: 2), requested: "2.5").writeValue ==
            .string("2.5")
        )
        #expect(
            AttributeValueCoercion(existingValue: NSNumber(value: 2.5), requested: "many").writeValue ==
            .string("many")
        )
        #expect(
            AttributeValueCoercion(existingValue: kCFBooleanFalse, requested: "maybe").writeValue ==
            .string("maybe")
        )
    }

    @Test func readbackMatchesEachSupportedType() {
        let cases: [(AttributeValueCoercion, CFTypeRef, String)] = [
            (AttributeValueCoercion(existingValue: "old" as CFString, requested: "new"), "new" as CFString, "new"),
            (AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: "2"), NSNumber(value: 2), "2"),
            (AttributeValueCoercion(existingValue: NSNumber(value: 1.5), requested: "2.5"), NSNumber(value: 2.5), "2.5"),
            (AttributeValueCoercion(existingValue: kCFBooleanFalse, requested: "true"), kCFBooleanTrue, "true"),
        ]

        for (coercion, readback, preview) in cases {
            #expect(coercion.compare(readback: readback) == .match(actualPreview: preview))
        }
    }

    @Test func supportedMismatchedReadbackIncludesActualPreview() {
        let coercion = AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: "2")

        #expect(
            coercion.compare(readback: NSNumber(value: 3)) ==
            .mismatch(actualPreview: "3")
        )
    }

    @Test func unreadableAndUnhandledReadbackAreUnsupported() {
        let coercion = AttributeValueCoercion(existingValue: "old" as CFString, requested: "new")

        #expect(coercion.compare(readback: nil) == .unsupported)
        #expect(coercion.compare(readback: ["new"] as CFArray) == .unsupported)
    }
}
