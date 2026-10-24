import Foundation
import AgentMuxNativeMacOSCore

@main
private struct SelectionStateChecks {
    static func main() {
        var names: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) {
            names.append(name)
            if !value() { failures.append(name) }
        }
        let bounds = CGRect(x: -100, y: -80, width: 600, height: 500)
        func drawn(_ from: CGPoint, _ to: CGPoint) -> NativeSelectionState {
            var state = NativeSelectionState(bounds: bounds)
            state.pointerDown(from); state.pointerUp(to)
            return state
        }
        var state = drawn(CGPoint(x: 200, y: 200), CGPoint(x: 40, y: 50))
        check("reverse drawing normalizes", state.rectangle == CGRect(x: 40, y: 50, width: 160, height: 150))
        check("release stays ready for explicit confirmation", state.canConfirm && !state.isInteracting)
        state.pointerDown(CGPoint(x: 100, y: 100)); state.pointerUp(CGPoint(x: 130, y: 120))
        check("interior moves preserve dimensions", state.rectangle == CGRect(x: 70, y: 70, width: 160, height: 150))
        state.nudge(dx: 1, dy: 10)
        check("arrow nudge uses logical points", state.rectangle == CGRect(x: 71, y: 80, width: 160, height: 150))
        state.nudge(dx: -1000, dy: -1000)
        check("moving clamps to negative bounds", state.rectangle == CGRect(x: -100, y: -80, width: 160, height: 150))
        for handle in NativeSelectionState.Handle.allCases {
            var resized = drawn(CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100))
            let point = resized.point(for: handle)!
            resized.pointerDown(point); resized.pointerUp(CGPoint(x: point.x + 20, y: point.y + 25))
            check("resize \(handle) changes geometry", resized.rectangle != CGRect(x: 0, y: 0, width: 100, height: 100))
            check("resize \(handle) stays bounded", resized.rectangle.map { bounds.contains($0) && $0.width > 0 && $0.height > 0 } == true)
        }
        var tiny = drawn(CGPoint(x: -100, y: -80), CGPoint(x: -99.75, y: -79.75))
        tiny.pointerDown(CGPoint(x: -100, y: -80)); tiny.pointerUp(CGPoint(x: 50, y: 50))
        check("fractional edge resize cannot leave bounds", tiny.rectangle.map(bounds.contains) == true)
        var empty = drawn(CGPoint(x: 10, y: 10), CGPoint(x: 10, y: 10))
        check("zero area cannot confirm", empty.rectangle == nil && !empty.canConfirm)
        empty.pointerDown(CGPoint(x: 10, y: 10)); empty.pointerDragged(CGPoint(x: 50, y: 40))
        check("held gesture cannot confirm", !empty.canConfirm)
        for screen in [bounds, CGRect(x: -200, y: 30, width: 160, height: 110), CGRect(x: 0, y: 0, width: 48, height: 38)] {
            let panel = NativeSelectionState.panelFrame(size: CGSize(width: 480, height: 76), preferredOrigin: CGPoint(x: 10000, y: -10000), screen: screen)
            check("panel stays within \(screen.width)pt display", screen.contains(panel))
        }
        let report: [String: Any] = ["tests": names.count, "failures": failures, "cases": names]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
        if names.isEmpty || !failures.isEmpty { exit(1) }
    }
}
