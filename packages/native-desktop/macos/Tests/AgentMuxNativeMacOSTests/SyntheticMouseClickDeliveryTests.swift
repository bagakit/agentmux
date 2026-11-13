import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct SyntheticMouseClickDeliveryTests {
    @Test func singleClickPlanPairsDownAndUpAfterMove() {
        #expect(
            SyntheticMouseClickDelivery.steps(clickCount: 1) ==
            [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
        )
    }

    @Test func multiClickPlanNumbersEachPressForClickState() {
        #expect(
            SyntheticMouseClickDelivery.steps(clickCount: 2) ==
            [
                .move,
                .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1),
                .buttonDown(pressIndex: 2), .buttonUp(pressIndex: 2),
            ]
        )
    }

    @Test func nonPositiveClickCountStillDeliversOnePress() {
        for count in [0, -3] {
            #expect(
                SyntheticMouseClickDelivery.steps(clickCount: count) ==
                [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
            )
        }
    }

    @Test func excessiveClickCountIsCappedAtTripleClick() {
        #expect(
            SyntheticMouseClickDelivery.steps(clickCount: Int.max) ==
            [
                .move,
                .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1),
                .buttonDown(pressIndex: 2), .buttonUp(pressIndex: 2),
                .buttonDown(pressIndex: 3), .buttonUp(pressIndex: 3),
            ]
        )
    }

    @Test func clickStateMatchesPressIndexAndSkipsMove() {
        #expect(SyntheticMouseClickDelivery.clickState(for: .move) == 0)
        #expect(SyntheticMouseClickDelivery.clickState(for: .buttonDown(pressIndex: 1)) == 1)
        #expect(SyntheticMouseClickDelivery.clickState(for: .buttonUp(pressIndex: 2)) == 2)
    }

    @Test func ambiguousWindowFrameFallbackDoesNotSelectRecipient() {
        let candidates = [(windowID: 101, frame: 7), (windowID: 202, frame: 7)]

        #expect(SyntheticMouseClickDelivery.uniqueWindowCandidate(
            from: candidates,
            matching: { $0.frame == 7 }
        ) == nil)
        #expect(SyntheticMouseClickDelivery.uniqueWindowCandidate(
            from: candidates,
            matching: { $0.frame == 8 }
        ) == nil)
        #expect(
            SyntheticMouseClickDelivery.uniqueWindowCandidate(
                from: candidates,
                matching: { $0.windowID == 101 }
            )?.windowID ==
            101
        )
    }

    @Test func recipientChangeBeforeMouseDownPostsNoClickAndReportsBothWindows() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: SyntheticMouseClickDelivery.FenceFailure.recipientChanged(expected: target, actual: intruder, deliveredPresses: 0)) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: { .focused(intruder) },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [.move])
    }

    @Test func finalMouseUpMayDismissTheTargetWithoutFailingTheClick() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var observations: [SyntheticMouseClickDelivery.RecipientObservation] = [.focused(target), .dismissed]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentObservation: { observations.removeFirst() },
            makeEvent: { $0 },
            post: { posted.append($0) },
            pause: { _ in }
        )

        #expect(posted == [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    @Test func finalUnavailableObservationRemainsFailClosed() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var observations: [SyntheticMouseClickDelivery.RecipientObservation] = [.focused(target), .unavailable]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: SyntheticMouseClickDelivery.FenceFailure.recipientChanged(expected: target, actual: nil, deliveredPresses: 1)) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: { observations.removeFirst() },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    @Test func finalMouseUpRejectsADifferentFocusedRecipient() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients: [SyntheticMouseClickDelivery.Recipient?] = [target, intruder]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: SyntheticMouseClickDelivery.FenceFailure.recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: {
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    @Test func mouseUpPostsBeforeRecipientCheckForTheNextPress() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var trace: [String] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 2,
            target: target,
            currentObservation: {
                trace.append("recipient")
                return .focused(target)
            },
            makeEvent: { $0 },
            post: {
                switch $0 {
                case .move:
                    trace.append("move")
                case .buttonDown:
                    trace.append("down")
                case .buttonUp:
                    trace.append("up")
                }
            },
            pause: { interval in
                #expect(interval > 0)
                trace.append("pause")
            }
        )

        #expect(trace == [
            "move", "pause", "recipient", "down", "pause", "up", "recipient",
            "pause", "recipient", "down", "pause", "up", "recipient", "pause"
        ])
    }

    @Test func recipientChangeBeforeLaterPressReportsCompletedPresses() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients = [target, target, intruder]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: SyntheticMouseClickDelivery.FenceFailure.recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: {
                    .focused(recipients.removeFirst())
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    @Test func recipientChangeAfterIntermediateMouseUpStopsBeforeNextPress() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients: [SyntheticMouseClickDelivery.Recipient?] = [target, intruder]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: SyntheticMouseClickDelivery.FenceFailure.recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: {
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    @Test func intermediateMouseUpDismissalStopsBeforeNextPress() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var recipients: [SyntheticMouseClickDelivery.Recipient?] = [target, nil]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: SyntheticMouseClickDelivery.FenceFailure.recipientChanged(expected: target, actual: nil, deliveredPresses: 1)) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: {
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    @Test func buttonPairIsPreparedBeforeMouseDownPosts() {
        enum PreparationFailure: Error { case mouseUp }
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var posted: [SyntheticMouseClickDelivery.Step] = []

        #expect(throws: (any Error).self) {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: { .focused(target) },
                makeEvent: { step in
                    if case .buttonUp = step { throw PreparationFailure.mouseUp }
                    return step
                },
                post: { posted.append($0) },
                pause: { _ in }
            )
        }
        #expect(posted == [.move])
    }
}
