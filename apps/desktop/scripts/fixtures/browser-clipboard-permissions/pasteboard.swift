import AppKit
import CryptoKit

var original: [[String: Data]]?
var expectedChange: Int?
var lastMarker: String?
var originalFront: NSRunningApplication?
var originalFrontStarted: Date?
var probePID: pid_t?
let pasteboard = NSPasteboard.general
func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func snapshot() throws -> [[String: Data]] {
    try (pasteboard.pasteboardItems ?? []).map { item in
        var values: [String: Data] = [:]
        for type in item.types {
            guard let data = item.data(forType: type) else { throw NSError(domain: "Unpreserved pasteboard format", code: 1) }
            values[type.rawValue] = data
        }
        return values
    }
}
func metadata(_ items: [[String: Data]]) -> [[String: Any]] {
    items.map { values in ["formats": values.keys.sorted().map { ["type": $0, "bytes": values[$0]!.count, "sha256": sha(values[$0]!)] }] }
}
func handle(_ input: [String: Any]) throws -> [String: Any] {
    switch input["command"] as? String {
    case "snapshot":
        originalFront = NSWorkspace.shared.frontmostApplication
        originalFrontStarted = originalFront?.launchDate
        probePID = (input["probePid"] as? NSNumber)?.int32Value
        let before = pasteboard.changeCount, items = try snapshot()
        guard before == pasteboard.changeCount else { throw NSError(domain: "Pasteboard changed during snapshot", code: 2) }
        original = items; expectedChange = before
        return ["state": "preserved", "changeCount": before, "items": metadata(items), "originalFrontmostPid": originalFront?.processIdentifier as Any? ?? NSNull()]
    case "restore-focus":
        guard let previous = originalFront, let started = originalFrontStarted, let probePID,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == probePID else { return ["state": "later-focus-preserved"] }
        guard !previous.isTerminated, previous.launchDate == started else { return ["state": "original-focus-target-unavailable"] }
        return ["state": previous.activate(options: []) ? "original-focus-restored" : "original-focus-unconfirmed", "pid": previous.processIdentifier]
    case "prepare":
        guard let expected = expectedChange, pasteboard.changeCount == expected else { throw NSError(domain: "External pasteboard change; no test write allowed", code: 3) }
        return ["state": "unchanged", "changeCount": expected]
    case "confirm":
        guard let expected = expectedChange, let marker = input["marker"] as? String else { throw NSError(domain: "Missing original lease", code: 4) }
        let before = pasteboard.changeCount
        guard before > expected, pasteboard.string(forType: .string) == marker, before == pasteboard.changeCount else {
            expectedChange = nil
            throw NSError(domain: "Clipboard result differs or changed externally; no restoration", code: 5)
        }
        expectedChange = before; lastMarker = marker
        return ["state": "confirmed", "changeCount": before, "markerSha256": sha(Data(marker.utf8))]
    case "restore":
        guard let original else { throw NSError(domain: "No original snapshot", code: 6) }
        guard let expected = expectedChange, pasteboard.changeCount == expected,
              lastMarker == nil || pasteboard.string(forType: .string) == lastMarker else {
            return ["state": "external-change-preserved", "restored": false]
        }
        if lastMarker == nil { return ["state": "original-unchanged", "restored": true, "items": metadata(original)] }
        let items = original.map { values -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in values { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
            return item
        }
        guard pasteboard.changeCount == expected else { return ["state": "external-change-preserved", "restored": false] }
        pasteboard.clearContents()
        guard items.isEmpty || pasteboard.writeObjects(items) else { throw NSError(domain: "Original pasteboard restoration unconfirmed", code: 7) }
        guard try snapshot() == original else { throw NSError(domain: "Restored pasteboard bytes differ", code: 8) }
        return ["state": "restored", "restored": true, "changeCount": pasteboard.changeCount, "items": metadata(original), "atomicCompareAndSwap": false]
    default: throw NSError(domain: "Unknown private pasteboard command", code: 9)
    }
}
while let line = readLine() {
    var response: [String: Any]
    do {
        let input = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        do { response = ["id": input["id"]!, "ok": true, "result": try handle(input)] }
        catch { response = ["id": input["id"]!, "ok": false, "error": String(describing: error)] }
    } catch { response = ["ok": false, "error": "Invalid private request"] }
    let data = try! JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    fflush(stdout)
}
