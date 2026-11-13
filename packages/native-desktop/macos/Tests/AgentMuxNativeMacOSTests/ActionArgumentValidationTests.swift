import AgentMuxNativeMacOSCore
import Testing

@Suite struct ActionArgumentValidationTests {
    @Test func positiveIntegerAcceptsPositiveValuesAndDefaults() throws {
        #expect(try ActionArgumentValidation.positiveInteger(nil, defaultValue: 1, name: "clickCount").get() == 1)
        #expect(try ActionArgumentValidation.positiveInteger(2, defaultValue: 1, name: "clickCount").get() == 2)
    }

    @Test func positiveIntegerRejectsZeroNegativeAndNonFiniteValues() {
        #expect(
            failureMessage(ActionArgumentValidation.positiveInteger(0, defaultValue: 1, name: "clickCount"))
                == "clickCount must be a positive integer"
        )
        #expect(
            failureMessage(ActionArgumentValidation.positiveInteger(-1, defaultValue: 1, name: "clickCount"))
                == "clickCount must be a positive integer"
        )
        #expect(
            failureMessage(ActionArgumentValidation.positiveInteger(.infinity, defaultValue: 1, name: "clickCount"))
                == "clickCount must be a positive integer"
        )
    }

    @Test func positiveNumberAcceptsPositiveValuesAndDefaults() throws {
        #expect(try ActionArgumentValidation.positiveNumber(nil, defaultValue: 1, name: "pages").get() == 1)
        #expect(try ActionArgumentValidation.positiveNumber(0.5, defaultValue: 1, name: "pages").get() == 0.5)
    }

    @Test func positiveNumberRejectsZeroNegativeAndNonFiniteValues() {
        #expect(
            failureMessage(ActionArgumentValidation.positiveNumber(0, defaultValue: 1, name: "pages"))
                == "pages must be a positive number"
        )
        #expect(
            failureMessage(ActionArgumentValidation.positiveNumber(-0.5, defaultValue: 1, name: "pages"))
                == "pages must be a positive number"
        )
        #expect(
            failureMessage(ActionArgumentValidation.positiveNumber(.nan, defaultValue: 1, name: "pages"))
                == "pages must be a positive number"
        )
    }

    @Test func mouseButtonDefaultsToLeftAndAcceptsEveryButton() throws {
        #expect(try ActionArgumentValidation.mouseButton(nil).get() == .left)
        #expect(try ActionArgumentValidation.mouseButton("left").get() == .left)
        #expect(try ActionArgumentValidation.mouseButton("right").get() == .right)
        #expect(try ActionArgumentValidation.mouseButton("middle").get() == .middle)
    }

    @Test func mouseButtonRejectsUnknownButtons() {
        #expect(failureMessage(ActionArgumentValidation.mouseButton("primary")) == "unsupported mouse button 'primary'")
        #expect(failureMessage(ActionArgumentValidation.mouseButton("")) == "unsupported mouse button ''")
    }

    @Test func scrollDirectionRejectsUnknownDirections() throws {
        #expect(try ActionArgumentValidation.scrollDirection("down").get() == "down")
        #expect(
            failureMessage(ActionArgumentValidation.scrollDirection("diagonal"))
                == "unsupported scroll direction: diagonal"
        )
    }

    private func failureMessage<T>(_ result: Result<T, ActionArgumentValidationError>) -> String? {
        if case let .failure(error) = result {
            return error.message
        }
        return nil
    }
}
