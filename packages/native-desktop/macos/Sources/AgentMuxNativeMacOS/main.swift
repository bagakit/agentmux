import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import ImageIO
import AgentMuxNativeMacOSCore
import ScreenCaptureKit

private let providerName = "agentmux-native-macos"
private let providerVersion = "1.0.0"
private let providerProtocolVersion = 1

struct Request: Decodable, Sendable {
    let id: Int
    let method: String
    let params: [String: JSONValue]?
    let token: String?
    let operationId: String?
    let expectedInstanceId: String?
}

enum JSONValue: Decodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    var number: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}

enum ProviderError: Error {
    case coded(String, String)

    var code: String {
        switch self {
        case let .coded(code, _):
            return code
        }
    }

    var message: String {
        switch self {
        case let .coded(_, message):
            return message
        }
    }
}

struct AppDescriptor {
    let name: String
    let bundleId: String?
    let pid: pid_t
    let app: NSRunningApplication

    var processStartedAt: Double? { app.launchDate.map { $0.timeIntervalSince1970 * 1000 } }

}

final class ElementRecord {
    let index: Int
    let element: AXUIElement
    let localFrame: CGRect?
    let actions: [String]

    init(index: Int, element: AXUIElement, localFrame: CGRect?, actions: [String]) {
        self.index = index
        self.element = element
        self.localFrame = localFrame
        self.actions = actions
    }
}

struct Snapshot {
    let id: String
    let app: AppDescriptor
    let windowTitle: String
    let windowBounds: CGRect
    let windowId: CGWindowID
    let windowLayer: Int
    let treeText: String
    let focusedElementId: Int?
    let screenshot: ScreenshotPayload?
    let screenshotStatus: ScreenshotStatus
    let screenshotScale: CGSize
    let screenshotEngine: String?
    let elements: [Int: ElementRecord]
    let truncated: Bool
    let maxDepthReached: Bool

    func withoutScreenshotPayload() -> Snapshot {
        Snapshot(
            id: id,
            app: app,
            windowTitle: windowTitle,
            windowBounds: windowBounds,
            windowId: windowId,
            windowLayer: windowLayer,
            treeText: treeText,
            focusedElementId: focusedElementId,
            screenshot: nil,
            screenshotStatus: .skipped,
            screenshotScale: CGSize(width: 1, height: 1),
            screenshotEngine: nil,
            elements: elements,
            truncated: truncated,
            maxDepthReached: maxDepthReached
        )
    }
}

struct ScreenshotPayload {
    let data: String
    let width: Int
    let height: Int
    let scale: Double
}

struct CapturedImage {
    let image: CGImage
    let engine: String
}

enum ScreenshotStatus {
    case captured
    case skipped
    case failed(String)
}

private struct CachedSnapshotEntry {
    let snapshotId: String
    let keys: [String]
    let createdAt: Date
}

final class Provider: @unchecked Sendable {
    let operationLock = NSLock()
    let instanceId = UUID().uuidString
    var completedOperations: [String: NativeOperationReceipt] = [:]
    private var snapshots: [String: Snapshot] = [:]
    private var snapshotEntries: [CachedSnapshotEntry] = []

    func handle(method: String, params: [String: JSONValue]) throws -> Any {
        switch method {
        case "handshake":
            return providerHandshake()
        case "listDisplays":
            return NativeDesktopOperations.listDisplays()
        case "captureScreenshot":
            return NativeDesktopOperations.capture(params)
        case "clipboardRead":
            return try NativeDesktopOperations.clipboardRead(params)
        case "clipboardWrite":
            return try NativeDesktopOperations.clipboardWrite(params)
        case "permissionStatus":
            return NativeDesktopOperations.permissionStatus()
        case "listApps":
            return onMain { ["apps": listApps().map(renderListedApp)] }
        case "listWindows":
            return try listWindows(params: params)
        case "getAppState":
            return try renderSnapshot(observe(params: params))
        case "click":
            return try actionResult(params: params) { try click(params: params) }
        case "performSecondaryAction":
            return try actionResult(params: params) { try performSecondaryAction(params: params) }
        case "setValue":
            return try actionResult(params: params) { try setValue(params: params) }
        case "typeText":
            return try actionResult(params: params) { try typeText(params: params) }
        case "pressKey":
            return try actionResult(params: params) { try pressKey(params: params) }
        case "hotkey":
            return try actionResult(params: params) { try hotkey(params: params) }
        case "pasteText":
            return try actionResult(params: params) { try pasteText(params: params) }
        case "scroll":
            return try actionResult(params: params) { try scroll(params: params) }
        case "drag":
            return try actionResult(params: params) { try drag(params: params) }
        default:
            throw ProviderError.coded("invalid_argument", "unknown method '\(method)'")
        }
    }

    private func actionResult(params: [String: JSONValue], action runAction: () throws -> [String: Any]) throws -> [String: Any] {
        var action = try runAction()
        action["targetWindowId"] = params["windowId"]?.number.map { Int($0) }
        do {
            return try renderActionResult(action: action, snapshot: observe(params: params))
        } catch {
            // The action receipt survives an observation failure on its original target.
            // Never silently remove the window selector and observe another window.
            let failure = nativeErrorPayload(error)
            return ["action": action, "observation": ["state": "failed", "error": failure]]
        }
    }

    private func observe(params: [String: JSONValue]) throws -> Snapshot {
        if params["restoreWindow"] != nil {
            throw ProviderError.coded("invalid_argument", "restoreWindow is not supported; target the exact native window explicitly")
        }
        if let raw = params["noScreenshot"], raw.bool == nil {
            throw ProviderError.coded("invalid_argument", "noScreenshot must be a protocol boolean")
        }
        let query = try requiredString(params, "app")
        let windowId = try requestedWindowId(params)
        guard windowId != nil, params["windowIndex"] == nil else {
            throw ProviderError.coded("invalid_argument", "getAppState and actions require an exact discovered windowId")
        }
        let app = try resolveApp(query, params: params)
        let snapshot = try buildSnapshot(
            app: app,
            includeScreenshot: params["noScreenshot"]?.bool == false,
            windowId: windowId
        )
        // Why: cached snapshots only validate element identity for follow-up
        // actions; retaining MB-scale screenshot base64 in the long-lived agent grows memory.
        rememberSnapshot(snapshot: snapshot.withoutScreenshotPayload(), params: params)
        return snapshot
    }

    private func rememberSnapshot(snapshot: Snapshot, params: [String: JSONValue]) {
        let key = snapshotCacheKey(params)
        snapshots[key] = snapshot
        snapshotEntries.append(CachedSnapshotEntry(snapshotId: snapshot.id, keys: [key], createdAt: Date()))
        pruneSnapshotCache()
    }

    private func snapshotCacheKey(_ params: [String: JSONValue]) -> String {
        let scope = params["clientScope"]?.string ?? "default"
        let process = params["app"]?.string ?? ""
        let start = params["processStartedAt"]?.number ?? -1
        let window = params["windowId"]?.number ?? -1
        return "\(scope.utf8.count):\(scope):\(process):\(start):\(window)"
    }

    private func pruneSnapshotCache() {
        let now = Date()
        while let oldest = snapshotEntries.first,
              ComputerSnapshotCachePolicy.shouldPrune(
                  entryCount: snapshotEntries.count,
                  createdAt: oldest.createdAt,
                  now: now
              ) {
            let expired = snapshotEntries.removeFirst()
            for key in expired.keys where snapshots[key]?.id == expired.snapshotId {
                snapshots.removeValue(forKey: key)
            }
        }
    }

    private func currentSnapshot(params: [String: JSONValue]) throws -> Snapshot {
        pruneSnapshotCache()
        let cached = try cachedSnapshot(params: params)
        guard let expectedSnapshot = params["snapshotId"]?.string,
              let cached, cached.id == expectedSnapshot else {
            throw ProviderError.coded("snapshot_stale", "action requires the original snapshotId for this exact process and window; observe again")
        }
        // Why: cached AX frames can be stale after a window move or resize, and
        // stale geometry can turn an intended action into a misclick.
        let snapshot = try observe(params: params.merging(["noScreenshot": .bool(true)]) { _, replacement in replacement })
        try validateRequestedElements(cached: cached, current: snapshot, params: params)
        return snapshot
    }

    private func currentKeyboardSnapshot(params: [String: JSONValue]) throws -> Snapshot {
        // Why: AX text replacement/select-all do not post global input, so only
        // synthetic fallback paths require the target window to be focused.
        try currentSnapshot(params: params.merging(["noScreenshot": .bool(true)]) { _, replacement in replacement })
    }

    private func cachedSnapshot(params: [String: JSONValue]) throws -> Snapshot? {
        snapshots[snapshotCacheKey(params)]
    }

    private func validateRequestedElements(cached: Snapshot?, current: Snapshot, params: [String: JSONValue]) throws {
        let requestedIndexes = try ["elementIndex", "fromElementIndex", "toElementIndex"].compactMap { key -> Int? in
            guard params[key]?.number != nil else { return nil }
            return try optionalInteger(params, key)
        }
        guard !requestedIndexes.isEmpty else { return }
        guard let cached else {
            throw ProviderError.coded("element_not_found", "element indexes require a fresh get-app-state snapshot for this app/window")
        }
        for index in requestedIndexes {
            guard let expected = cached.elements[index], let actual = current.elements[index] else {
                throw ProviderError.coded("element_not_found", "element \(index) is stale; run get-app-state again and use a fresh element index")
            }
            guard CFEqual(expected.element, actual.element) else {
                throw ProviderError.coded("element_not_found", "element \(index) changed since the last snapshot; run get-app-state again and use a fresh element index")
            }
        }
    }

    private func ensureWindowStillAvailable(_ snapshot: Snapshot) throws {
        guard WindowCapture.candidates(pid: snapshot.app.pid).contains(where: { $0.windowId == snapshot.windowId }) else {
            throw ProviderError.coded("window_stale", "window \(Int(snapshot.windowId)) is no longer available; run get-app-state again to refresh the target window")
        }
    }

    private func listApps() -> [AppDescriptor] {
        var seen = Set<pid_t>()
        return NSWorkspace.shared.runningApplications
            .filter { !$0.isTerminated && $0.activationPolicy == .regular }
            .compactMap { app in
                guard let name = app.localizedName, !name.isEmpty else { return nil }
                let pid = app.processIdentifier
                guard pid > 0, pidIsLive(pid) else { return nil }
                guard seen.insert(pid).inserted else { return nil }
                return AppDescriptor(name: name, bundleId: app.bundleIdentifier, pid: pid, app: app)
            }
            .sorted { lhs, rhs in
                if lhs.app.isActive != rhs.app.isActive {
                    return lhs.app.isActive && !rhs.app.isActive
                }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }

    private func renderListedApp(_ app: AppDescriptor) -> [String: Any] {
        [
            "name": app.name,
            "bundleId": jsonNullable(app.bundleId),
            "pid": Int(app.pid),
            "processStartedAt": jsonNullable(app.processStartedAt),
            "isRunning": true,
            "lastUsedAt": NSNull(),
            "useCount": NSNull(),
        ]
    }

    private func providerHandshake() -> [String: Any] {
        [
            "platform": "darwin",
            "provider": providerName,
            "providerVersion": providerVersion,
            "protocolVersion": providerProtocolVersion,
            "instanceId": instanceId,
            "supports": [
                "apps": [
                    "list": true,
                    "bundleIds": true,
                    "pids": true,
                ],
                "windows": [
                    "list": true,
                    "targetById": true,
                    "targetByIndex": false,
                    "focus": false,
                    "moveResize": false,
                ],
                "observation": [
                    "screenshot": true,
                    "screenSelection": true,
                    "displayScreenshot": true,
                    "rectScreenshot": true,
                    "annotatedScreenshot": false,
                    "elementFrames": true,
                    "ocr": false,
                ],
                "actions": [
                    "click": true,
                    "typeText": true,
                    "pressKey": true,
                    "hotkey": true,
                    "pasteText": true,
                    "scroll": true,
                    "drag": true,
                    "setValue": true,
                    "performAction": true,
                ],
                "clipboard": ["readText": true, "writeText": true, "readPNG": true, "writePNG": true],
                "permissions": ["status": true, "request": false],
                "surfaces": [
                    "menus": false,
                    "dialogs": false,
                    "dock": false,
                    "menubar": false,
                ],
            ],
        ]
    }

    private func resolveApp(_ query: String, params: [String: JSONValue]) throws -> AppDescriptor {
        guard let pid = parsePid(query), let app = appByPid(pid) else {
            throw ProviderError.coded("app_not_found", "app must identify a live discovered process as pid:<pid>")
        }
        guard let expectedStart = params["processStartedAt"]?.number,
              let actualStart = app.processStartedAt,
              abs(expectedStart - actualStart) < 0.01 else {
            throw ProviderError.coded("process_stale", "processStartedAt does not identify this running process; discover applications again")
        }
        return app
    }

    private func listWindows(params: [String: JSONValue]) throws -> [String: Any] {
        let app = try resolveApp(try requiredString(params, "app"), params: params)
        let windows = WindowCapture.candidates(pid: app.pid)
            .filter { $0.layer == 0 }
            .enumerated()
            .map { index, candidate -> [String: Any] in
                [
                    "index": index,
                    "app": [
                        "name": app.name,
                        "bundleId": jsonNullable(app.bundleId),
                        "pid": Int(app.pid),
                        "processStartedAt": jsonNullable(app.processStartedAt),
                    ],
                    "id": Int(candidate.windowId),
                    "title": candidate.title ?? "",
                    "x": Int(candidate.bounds.origin.x.rounded()),
                    "y": Int(candidate.bounds.origin.y.rounded()),
                    "width": Int(candidate.bounds.width.rounded()),
                    "height": Int(candidate.bounds.height.rounded()),
                    "isMinimized": false,
                    "isOffscreen": !candidate.isOnScreen,
                    "screenIndex": jsonNullable(screenIndex(for: candidate.bounds)),
                    "isMain": NSNull(),
                    "platform": [
                        "layer": candidate.layer,
                        "alpha": candidate.alpha,
                    ],
                ]
            }
        return [
            "app": renderListedApp(app),
            "windows": windows,
        ]
    }

    private func appByPid(_ pid: pid_t) -> AppDescriptor? {
        guard let app = NSRunningApplication(processIdentifier: pid),
              !app.isTerminated,
              let name = app.localizedName
        else {
            return nil
        }
        return AppDescriptor(name: name, bundleId: app.bundleIdentifier, pid: pid, app: app)
    }

    private func buildSnapshot(
        app: AppDescriptor,
        includeScreenshot: Bool,
        windowId: CGWindowID?
    ) throws -> Snapshot {
        let appElement = AXUIElementCreateApplication(app.pid)
        enableSupportedAccessibilityMode(appElement)
        let windowCandidates = WindowCapture.candidates(pid: app.pid)
        let canCaptureScreenshot = includeScreenshot
        guard let capture = WindowCapture.resolve(
            candidates: windowCandidates,
            windowId: windowId,
            captureImage: canCaptureScreenshot
        ) else {
            throw ProviderError.coded("window_not_found", "app '\(app.name)' has no on-screen window")
        }
        guard let window = matchingWindow(appElement: appElement, capture: capture) else {
            throw ProviderError.coded("window_not_found", "could not match accessibility window to requested window; run get-app-state again or retry without a window selector")
        }
        let title = stringAttribute(window, kAXTitleAttribute as String) ?? capture.title ?? app.name
        let renderer = TreeRenderer(
            windowBounds: capture.bounds,
            focused: focusedElement(appElement: appElement),
            compactBrowserTabs: true
        )
        renderer.render(window)
        let screenshot = includeScreenshot ? capture.screenshotPayload() : nil
        let screenshotStatus: ScreenshotStatus = if screenshot != nil {
            .captured

        } else if includeScreenshot {
            .failed(capture.captureFailure ?? "native window capture returned no image; accessibility state remains available")
        } else {
            .skipped
        }
        return Snapshot(
            id: UUID().uuidString,
            app: app,
            windowTitle: title,
            windowBounds: capture.bounds,
            windowId: capture.windowId,
            windowLayer: capture.layer,
            treeText: renderTreeText(app: app, title: title, bounds: capture.bounds, lines: renderer.lines, focused: renderer.focusedSummary),
            focusedElementId: renderer.focusedElementId,
            screenshot: screenshot,
            screenshotStatus: screenshotStatus,
            screenshotScale: screenshotScale(screenshot: screenshot, bounds: capture.bounds),
            screenshotEngine: capture.image?.engine,
            elements: renderer.records,
            truncated: renderer.truncated,
            maxDepthReached: renderer.maxDepthReached
        )
    }

    private func renderSnapshot(_ snapshot: Snapshot) -> [String: Any] {
        var screenshot: Any = NSNull()
        if let payload = snapshot.screenshot {
            screenshot = [
                "data": payload.data,
                "format": "png",
                "width": payload.width,
                "height": payload.height,
                "scale": payload.scale,
            ]
        }
        return [
            "snapshotId": snapshot.id,
            "snapshot": [
                "id": snapshot.id,
                "app": [
                    "name": snapshot.app.name,
                    "bundleId": jsonNullable(snapshot.app.bundleId),
                    "pid": Int(snapshot.app.pid),
                    "processStartedAt": jsonNullable(snapshot.app.processStartedAt),
                ],
                "window": [
                    "id": Int(snapshot.windowId),
                    "title": snapshot.windowTitle,
                    "x": Int(snapshot.windowBounds.origin.x.rounded()),
                    "y": Int(snapshot.windowBounds.origin.y.rounded()),
                    "width": Int(snapshot.windowBounds.width.rounded()),
                    "height": Int(snapshot.windowBounds.height.rounded()),
                    "isMinimized": false,
                    "isOffscreen": false,
                    "screenIndex": jsonNullable(screenIndex(for: snapshot.windowBounds)),
                    "platform": [
                        "layer": snapshot.windowLayer,
                    ],
                ],
                "coordinateSpace": "window",
                "treeText": snapshot.treeText,
                "elementCount": snapshot.elements.count,
                "elements": snapshot.elements.keys.sorted().compactMap { index -> [String: Any]? in
                    guard let element = snapshot.elements[index] else { return nil }
                    let frame: Any = element.localFrame.map { ["x": Double($0.minX), "y": Double($0.minY), "width": Double($0.width), "height": Double($0.height)] } as Any? ?? NSNull()
                    return ["index": index, "actions": element.actions, "frame": frame]
                },
                "focusedElementId": jsonNullable(snapshot.focusedElementId),
                "truncation": [
                    "truncated": snapshot.truncated,
                    "maxNodes": TreeRenderer.maxNodes,
                    "maxDepth": TreeRenderer.maxDepth,
                    "maxDepthReached": snapshot.maxDepthReached,
                ],
            ],
            "screenshot": screenshot,
            "screenshotStatus": renderScreenshotStatus(snapshot.screenshotStatus, snapshot: snapshot),
        ]
    }

    private func renderActionResult(action: [String: Any], snapshot: Snapshot) -> [String: Any] {
        var result = renderSnapshot(snapshot)
        var metadata = action
        metadata["targetWindowId"] = Int(snapshot.windowId)
        result["action"] = metadata
        return result
    }

    private func click(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let button = try mouseButton(params["mouseButton"]?.string)
        let count = try positiveInteger(params["clickCount"]?.number, defaultValue: 1, name: "clickCount")
        guard count <= SyntheticMouseClickDelivery.maxClickCount else {
            throw ProviderError.coded(
                "invalid_argument",
                "clickCount must be at most \(SyntheticMouseClickDelivery.maxClickCount)"
            )
        }
        let modifiers = try KeyMap.parseModifiers(params["modifiers"]?.string)
        // Why: agents expect a click into a target app to make the next
        // keyboard action safe, even when the click uses an AX action path.
        focusExactWindowForClick(snapshot)
        if let elementIndex = try optionalInteger(params, "elementIndex") {
            let record = try element(snapshot, elementIndex)
            if modifiers.isEmpty,
               count <= 1,
               button.hasAccessibilityAction,
               let actionName = try performClickAction(record: record, mouseButton: button) {
                return actionMetadata(path: "accessibility", actionName: actionName)
            }
            if let point = center(record.localFrame, in: snapshot.windowBounds) {
                try Input.click(
                    at: point,
                    button: button,
                    count: count,
                    modifiers: modifiers,
                    targetWindow: snapshot
                )
                return actionMetadata(
                    path: "synthetic",
                    fallbackReason: "actionUnsupported",
                    verification: unverifiedAction(reason: "synthetic_input")
                )
            }
            throw ProviderError.coded("element_not_clickable", "element \(record.index) has no clickable frame")
        }
        let point = try coordinatePoint(params: params, xKey: "x", yKey: "y", snapshot: snapshot)
        try Input.click(
            at: point,
            button: button,
            count: count,
            modifiers: modifiers,
            targetWindow: snapshot
        )
        return actionMetadata(
            path: "synthetic",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func performClickAction(record: ElementRecord, mouseButton: MouseButtonSelection) throws -> String? {
        if mouseButton == .right {
            return try performAction(record.element, "AXShowMenu") ? "AXShowMenu" : nil
        }
        for action in ["AXPress", "AXConfirm", "AXOpen"] {
            if try performAction(record.element, action) {
                return action
            }
        }
        return nil
    }

    private func performSecondaryAction(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let record = try element(snapshot, try requiredInteger(params, "elementIndex"))
        let requested = try requiredString(params, "action")
        let action = record.actions.first { $0 == requested }
        guard let action else {
            throw ProviderError.coded("action_not_supported", "'\(requested)' is not a valid secondary action for element \(record.index)")
        }
        guard try performAction(record.element, action) else {
            throw ProviderError.coded("accessibility_error", "AXUIElementPerformAction(\(action)) failed")
        }
        return actionMetadata(path: "accessibility", actionName: action)
    }

    private func setValue(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let record = try element(snapshot, try requiredInteger(params, "elementIndex"))
        let expected = try requiredStringAllowingEmpty(params, "value")
        guard isSettable(record.element, kAXValueAttribute as String) else {
            throw ProviderError.coded("value_not_settable", "element \(record.index) is not settable")
        }
        let current = rawAttributeValue(record.element, kAXValueAttribute as String)
        let coercion = AttributeValueCoercion(existingValue: current, requested: expected)
        let result: AXError
        switch coercion.writeValue {
        case .string:
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, expected as CFString)
        case let .integer(value):
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, NSNumber(value: value))
        case let .double(value):
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, NSNumber(value: value))
        case let .boolean(value):
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, value ? kCFBooleanTrue : kCFBooleanFalse)
        }
        guard result == .success else {
            throw ProviderError.coded("accessibility_error", "AXUIElementSetAttributeValue failed with \(result.rawValue)")
        }
        let verification: [String: Any]
        switch coercion.compare(readback: rawAttributeValue(record.element, kAXValueAttribute as String)) {
        case let .match(actualPreview):
            verification = verifiedAction(property: "value", expected: expected, actualPreview: actualPreview)
        case let .mismatch(actualPreview):
            verification = unverifiedAction(reason: "value_mismatch", expected: expected, actualPreview: actualPreview)
        case .unsupported:
            verification = unverifiedAction(reason: "readback_unsupported", expected: expected)
        }
        return actionMetadata(path: "accessibility", actionName: "AXSetValue", verification: verification)
    }

    private func typeText(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let text = try requiredString(params, "text")
        if let focused = focusedRecord(snapshot), let verification = try TextInput.replaceSelection(focused.element, with: text) {
            return actionMetadata(path: "accessibility", actionName: "AXReplaceSelection", verification: verification)
        }
        try requireTargetWindowFocused(snapshot)
        try Input.typeText(text, targetWindow: snapshot)
        return actionMetadata(
            path: "synthetic",
            actionName: "typeText",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func pressKey(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        try requireTargetWindowFocused(snapshot)
        try Input.pressKey(try requiredString(params, "key"), targetWindow: snapshot)
        return actionMetadata(
            path: "synthetic",
            actionName: "pressKey",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func hotkey(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let key = try requiredString(params, "key")
        if isSelectAllHotkey(key), let focused = focusedRecord(snapshot), try TextInput.selectAll(focused.element) {
            return actionMetadata(
                path: "accessibility",
                actionName: "AXSelectAll",
                verification: TextInput.selectionVerification(focused.element)
            )
        }
        try requireTargetWindowFocused(snapshot)
        try Input.pressKey(key, targetWindow: snapshot)
        return actionMetadata(
            path: "synthetic",
            actionName: "hotkey",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func pasteText(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let text = try requiredString(params, "text")
        if let focused = focusedRecord(snapshot), let verification = try TextInput.replaceSelection(focused.element, with: text) {
            return actionMetadata(path: "accessibility", actionName: "AXReplaceSelection", verification: verification)
        }
        try requireTargetWindowFocused(snapshot)
        let verification = try Input.pasteText(text, targetWindow: snapshot)
        return actionMetadata(path: "clipboard", actionName: "paste", verification: verification)
    }

    private func scroll(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let direction = try scrollDirection(try requiredString(params, "direction"))
        let pages = try positiveNumber(params["pages"]?.number, defaultValue: 1, name: "pages")
        if let elementIndex = try optionalInteger(params, "elementIndex") {
            let record = try element(snapshot, elementIndex)
            let action = "AXScroll\(direction.capitalized)ByPage"
            if pages.rounded() == pages, let pageCount = boundedInteger(pages, as: Int.self),
               record.actions.contains(action) {
                var completed = 0
                for _ in 0..<max(1, pageCount) {
                    do {
                        guard try performAction(record.element, action) else {
                            return actionMetadata(path: "accessibility", actionName: action,
                                                  verification: ["state": "failed", "reason": "action_unsupported", "completedPages": completed, "requestedPages": pageCount])
                        }
                        completed += 1
                    } catch {
                        return actionMetadata(path: "accessibility", actionName: action,
                                              verification: ["state": "unverified", "reason": "native_action_outcome_unknown", "completedPages": completed,
                                                             "requestedPages": pageCount, "error": nativeErrorPayload(error)])
                    }
                }
                return actionMetadata(path: "accessibility", actionName: action,
                                      verification: ["state": "accepted", "completedPages": completed, "requestedPages": pageCount])
            }
            guard let point = center(record.localFrame, in: snapshot.windowBounds) else {
                throw ProviderError.coded("element_not_found", "element \(record.index) has no scrollable frame")
            }
            try Input.scroll(pid: snapshot.app.pid, at: point, direction: direction, pages: pages)
            return actionMetadata(path: "synthetic", fallbackReason: "actionUnsupported")
        }
        let point = try coordinatePoint(params: params, xKey: "x", yKey: "y", snapshot: snapshot)
        try Input.scroll(pid: snapshot.app.pid, at: point, direction: direction, pages: pages)
        return actionMetadata(path: "synthetic")
    }

    private func drag(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let start: CGPoint
        let end: CGPoint
        if let fromIndex = try optionalInteger(params, "fromElementIndex"),
           let toIndex = try optionalInteger(params, "toElementIndex") {
            let from = try element(snapshot, fromIndex)
            let to = try element(snapshot, toIndex)
            guard let fromPoint = center(from.localFrame, in: snapshot.windowBounds),
                  let toPoint = center(to.localFrame, in: snapshot.windowBounds)
            else {
                throw ProviderError.coded("element_not_found", "drag element has no frame")
            }
            start = fromPoint
            end = toPoint
        } else {
            start = try coordinatePoint(params: params, xKey: "fromX", yKey: "fromY", snapshot: snapshot)
            end = try coordinatePoint(params: params, xKey: "toX", yKey: "toY", snapshot: snapshot)
        }
        try Input.drag(pid: snapshot.app.pid, from: start, to: end)
        return actionMetadata(path: "synthetic")
    }

    private func element(_ snapshot: Snapshot, _ index: Int) throws -> ElementRecord {
        guard let record = snapshot.elements[index] else {
            throw ProviderError.coded("element_not_found", "element \(index) is not in the current cached snapshot for \(snapshot.app.name); run get-app-state again and use a fresh element index")
        }
        return record
    }

    private func focusedRecord(_ snapshot: Snapshot) -> ElementRecord? {
        guard let focusedElementId = snapshot.focusedElementId else {
            return nil
        }
        return snapshot.elements[focusedElementId]
    }
}


private func requiredString(_ params: [String: JSONValue], _ key: String) throws -> String {
    guard let value = params[key]?.string, !value.isEmpty else {
        throw ProviderError.coded("invalid_argument", "missing \(key)")
    }
    return value
}

private func requiredStringAllowingEmpty(_ params: [String: JSONValue], _ key: String) throws -> String {
    guard let value = params[key]?.string else {
        throw ProviderError.coded("invalid_argument", "missing \(key)")
    }
    return value
}

private func requiredNumber(_ params: [String: JSONValue], _ key: String) throws -> Double {
    guard let value = params[key]?.number, value.isFinite else {
        throw ProviderError.coded("invalid_argument", "missing \(key)")
    }
    return value
}

private func requiredInteger(_ params: [String: JSONValue], _ key: String) throws -> Int {
    guard let value = boundedInteger(try requiredNumber(params, key), as: Int.self) else {
        throw ProviderError.coded("invalid_argument", "\(key) is out of range")
    }
    return value
}

private func optionalInteger(_ params: [String: JSONValue], _ key: String) throws -> Int? {
    guard let raw = params[key]?.number else { return nil }
    guard let value = boundedInteger(raw, as: Int.self) else {
        throw ProviderError.coded("invalid_argument", "\(key) is out of range")
    }
    return value
}

private func positiveInteger(_ value: Double?, defaultValue: Int, name: String) throws -> Int {
    switch ActionArgumentValidation.positiveInteger(value, defaultValue: defaultValue, name: name) {
    case let .success(value):
        return value
    case let .failure(error):
        throw ProviderError.coded("invalid_argument", error.message)
    }
}

private func positiveNumber(_ value: Double?, defaultValue: Double, name: String) throws -> Double {
    switch ActionArgumentValidation.positiveNumber(value, defaultValue: defaultValue, name: name) {
    case let .success(value):
        return value
    case let .failure(error):
        throw ProviderError.coded("invalid_argument", error.message)
    }
}

private func scrollDirection(_ value: String) throws -> String {
    switch ActionArgumentValidation.scrollDirection(value) {
    case let .success(value):
        return value
    case let .failure(error):
        throw ProviderError.coded("invalid_argument", error.message)
    }
}

private func parsePid(_ query: String) -> pid_t? {
    guard query.hasPrefix("pid:") else { return nil }
    guard let pid = Int32(query.dropFirst(4)), pid > 0 else { return nil }
    return pid
}


private func pidIsLive(_ pid: pid_t) -> Bool {
    kill(pid, 0) == 0
}

private func accessibilityTrusted() -> Bool {
    AXIsProcessTrusted()
}

private func accessibilityTrustedSettled() -> Bool {
    // Fresh helper processes can receive transient TCC preflight denials before the real grant settles.
    PermissionTrustSettling.settle(probe: accessibilityTrusted).settled
}

private func screenCaptureTrusted() -> Bool {
    CGPreflightScreenCaptureAccess()
}

private func screenCaptureTrustedSettled() -> Bool {
    PermissionTrustSettling.settle(timeoutMs: 2_000, probe: screenCaptureTrusted).settled
}

private func permissionStatusSnapshotSettled() -> PermissionStatusSnapshot {
    PermissionStatusSnapshotProbe.capture(
        accessibilityProbe: accessibilityTrustedSettled,
        screenshotsProbe: screenCaptureTrustedSettled
    )
}

private func requestScreenCaptureAccess() -> Bool {
    CGRequestScreenCaptureAccess()
}

private func openAccessibilitySettings() {
    openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
}

private func openScreenRecordingSettings() {
    openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
}

private func openSystemSettings(_ value: String) {
    guard let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
}

private func enableSupportedAccessibilityMode(_ appElement: AXUIElement) {
    var names: CFArray?
    guard AXUIElementCopyAttributeNames(appElement, &names) == .success,
          let supported = names as? [String] else { return }
    for attribute in ["AXManualAccessibility", "AXEnhancedUserInterface"] where supported.contains(attribute) {
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(appElement, attribute as CFString, &settable) == .success && settable.boolValue {
            _ = AXUIElementSetAttributeValue(appElement, attribute as CFString, kCFBooleanTrue)
        }
    }
}

private func focusedSystemWindow(systemWide: AXUIElement, app: AppDescriptor) -> AXUIElement? {
    guard let focusedApp = copyElement(systemWide, kAXFocusedApplicationAttribute as String),
          pidAttribute(focusedApp) == app.pid
    else {
        return nil
    }
    if let window = copyElement(systemWide, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let window = copyElement(focusedApp, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    return nil
}

private func isTargetWindowFocused(_ snapshot: Snapshot) -> Bool {
    guard let focusedWindow = focusedSystemWindow(systemWide: AXUIElementCreateSystemWide(), app: snapshot.app) else {
        return false
    }
    if windowNumber(focusedWindow) == snapshot.windowId {
        return true
    }
    guard let frame = absoluteFrame(focusedWindow) else {
        return false
    }
    let candidates = WindowCapture.candidates(pid: snapshot.app.pid).filter { windowFramesMatch($0.bounds, frame) }
    return candidates.count == 1 && candidates[0].windowId == snapshot.windowId
}

private enum AXElementProbe {
    case value(AXUIElement)
    case absent
    case unavailable
}

private func copyElementProbe(_ element: AXUIElement, _ attribute: String) -> AXElementProbe {
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(element, attribute as CFString, &value) {
    case .success:
        guard let value else { return .unavailable }
        return .value(value as! AXUIElement)
    case .noValue:
        return .absent
    default:
        return .unavailable
    }
}

private func currentSyntheticClickRecipient(
    snapshot: Snapshot,
    point: CGPoint
) -> SyntheticMouseClickDelivery.RecipientObservation {
    let target = syntheticClickRecipient(pid: snapshot.app.pid, windowId: snapshot.windowId)
    var cachedTargetCandidates: [WindowCandidate]?
    func targetCandidates() -> [WindowCandidate] {
        if let cachedTargetCandidates { return cachedTargetCandidates }
        let candidates = WindowCapture.candidates(pid: snapshot.app.pid)
        cachedTargetCandidates = candidates
        return candidates
    }
    switch focusedSyntheticClickRecipient(
        targetPID: snapshot.app.pid,
        targetCandidates: targetCandidates
    ) {
    case let .focused(focused):
        guard focused == target else { return .focused(focused) }
        switch hitTestSyntheticClickRecipient(
            at: point,
            targetPID: snapshot.app.pid,
            targetCandidates: targetCandidates
        ) {
        case let .focused(recipient):
            return .focused(recipient)
        case .dismissed, .unavailable:
            return .unavailable
        }
    case .dismissed:
        return .dismissed
    case .unavailable:
        return .unavailable
    }
}

private func focusedSyntheticClickRecipient(
    targetPID: pid_t,
    targetCandidates: () -> [WindowCandidate]
) -> SyntheticMouseClickDelivery.RecipientObservation {
    let systemWide = AXUIElementCreateSystemWide()
    let focusedApp: AXUIElement
    switch copyElementProbe(systemWide, kAXFocusedApplicationAttribute as String) {
    case let .value(value):
        focusedApp = value
    case .absent:
        return .dismissed
    case .unavailable:
        return .unavailable
    }
    guard let ownerPID = pidAttribute(focusedApp) else { return .unavailable }

    let focusedWindow: AXUIElement
    switch copyElementProbe(focusedApp, kAXFocusedWindowAttribute as String) {
    case let .value(value):
        focusedWindow = value
    case .absent:
        guard ownerPID == targetPID else { return .unavailable }
        return .dismissed
    case .unavailable:
        return .unavailable
    }

    if let windowId = windowNumber(focusedWindow) {
        return .focused(syntheticClickRecipient(pid: ownerPID, windowId: windowId))
    }
    guard ownerPID == targetPID else { return .unavailable }
    guard let frame = absoluteFrame(focusedWindow),
          let candidate = SyntheticMouseClickDelivery.uniqueWindowCandidate(
            from: targetCandidates(),
            matching: {
              windowFramesMatch($0.bounds, frame)
            }
          )
    else { return .unavailable }
    return .focused(syntheticClickRecipient(pid: ownerPID, windowId: candidate.windowId))
}

private func hitTestSyntheticClickRecipient(
    at point: CGPoint,
    targetPID: pid_t,
    targetCandidates: () -> [WindowCandidate]
) -> SyntheticMouseClickDelivery.RecipientObservation {
    let systemWide = AXUIElementCreateSystemWide()
    var hitElement: AXUIElement?
    switch AXUIElementCopyElementAtPosition(
        systemWide,
        Float(point.x),
        Float(point.y),
        &hitElement
    ) {
    case .success:
        break
    case .noValue:
        return .dismissed
    default:
        return .unavailable
    }
    guard let hitElement,
          let ownerPID = pidAttribute(hitElement),
          let window = containingWindow(hitElement)
    else { return .unavailable }
    if let windowId = windowNumber(window) {
        return .focused(syntheticClickRecipient(pid: ownerPID, windowId: windowId))
    }
    guard ownerPID == targetPID else { return .unavailable }
    guard let frame = absoluteFrame(window),
          let candidate = SyntheticMouseClickDelivery.uniqueWindowCandidate(
            from: targetCandidates(),
            matching: {
              windowFramesMatch($0.bounds, frame)
            }
          )
    else { return .unavailable }
    return .focused(syntheticClickRecipient(pid: ownerPID, windowId: candidate.windowId))
}

private func containingWindow(_ element: AXUIElement) -> AXUIElement? {
    var current = element
    for _ in 0..<64 {
        if stringAttribute(current, kAXRoleAttribute as String) == kAXWindowRole as String {
            return current
        }
        if let window = copyElement(current, kAXWindowAttribute as String) {
            return window
        }
        guard let parent = copyElement(current, kAXParentAttribute as String) else {
            return nil
        }
        current = parent
    }
    return nil
}

private func syntheticClickRecipient(
    pid: pid_t,
    windowId: CGWindowID
) -> SyntheticMouseClickDelivery.Recipient {
    SyntheticMouseClickDelivery.Recipient(ownerPID: pid, windowID: windowId)
}

private func requireTargetWindowFocused(_ snapshot: Snapshot) throws {
    guard isTargetWindowFocused(snapshot) else {
        throw ProviderError.coded("window_not_focused", "synthetic keyboard input requires the exact target window to have OS focus; focus that window or use a native AX action")
    }
}

private func matchingWindow(appElement: AXUIElement, capture: WindowCapture) -> AXUIElement? {
    let windows = copyArray(appElement, kAXWindowsAttribute as String) ?? []
    if let byNumber = windows.first(where: { windowNumber($0) == capture.windowId }) { return byNumber }
    let matches = windows.filter { element in
        guard let frame = absoluteFrame(element) else { return false }
        return windowFramesMatch(frame, capture.bounds)
    }
    return matches.count == 1 ? matches[0] : nil
}

private func focusExactWindowForClick(_ snapshot: Snapshot) {
    let appElement = AXUIElementCreateApplication(snapshot.app.pid)
    let windows = copyArray(appElement, kAXWindowsAttribute as String) ?? []
    let exact = windows.filter { windowNumber($0) == snapshot.windowId }
    let geometry = windows.filter { absoluteFrame($0).map { windowFramesMatch($0, snapshot.windowBounds) } == true }
    guard let target = exact.count == 1 ? exact.first : (geometry.count == 1 ? geometry.first : nil) else { return }
    // AX actions can remain usable when focus bookkeeping fails. Only this native window is raised.
    _ = snapshot.app.app.activate(options: [.activateIgnoringOtherApps])
    _ = AXUIElementPerformAction(target, kAXRaiseAction as CFString)
}

private func windowFramesMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    let tolerance: CGFloat = 2
    return abs(lhs.minX - rhs.minX) <= tolerance &&
        abs(lhs.minY - rhs.minY) <= tolerance &&
        abs(lhs.width - rhs.width) <= tolerance &&
        abs(lhs.height - rhs.height) <= tolerance
}

private func requestedWindowId(_ params: [String: JSONValue]) throws -> CGWindowID? {
    guard let raw = params["windowId"] else { return nil }
    guard let value = raw.number, value >= 0, let id = boundedInteger(value, as: UInt32.self) else {
        throw ProviderError.coded("invalid_argument", "windowId is out of range")
    }
    return CGWindowID(id)
}

private func usableWindow(_ element: AXUIElement) -> Bool {
    stringAttribute(element, kAXRoleAttribute as String) == kAXWindowRole as String &&
        boolAttribute(element, kAXMinimizedAttribute as String) != true
}

private func focusedElement(appElement: AXUIElement) -> AXUIElement? {
    copyElement(appElement, kAXFocusedUIElementAttribute as String)
}

private func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    return (value as! AXUIElement)
}

private func copyArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    return value as? [AXUIElement]
}

private func pidAttribute(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else {
        return nil
    }
    return pid
}

private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
        return url.absoluteString
    }
    return nil
}

private func rawStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value = rawAttributeValue(element, attribute), CFGetTypeID(value) == CFStringGetTypeID()
    else {
        return nil
    }
    return value as? String
}

private func rawAttributeValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? Bool
}

private func numberAttribute(_ element: AXUIElement, _ attribute: String) -> NSNumber? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? NSNumber
}

private func windowNumber(_ element: AXUIElement) -> CGWindowID? {
    guard let number = numberAttribute(element, "AXWindowNumber") else {
        return nil
    }
    return CGWindowID(number.uint32Value)
}

private func absoluteFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue
    else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(origin: point, size: size)
}

private extension CGRect {
    var area: CGFloat {
        max(width, 0) * max(height, 0)
    }
}

private func actions(_ element: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyActionNames(element, &value) == .success, let value else {
        return []
    }
    return value as? [String] ?? []
}

private func performAction(_ element: AXUIElement, _ action: String) throws -> Bool {
    guard actions(element).contains(action) else { return false }
    let status = AXUIElementPerformAction(element, action as CFString)
    switch NativeAXReply.classify(status) {
    case .accepted: return true
    case .unsupported: return false
    case .unknown:
        throw ProviderError.coded("action_outcome_unknown", "native AX action \(action) returned \(status.rawValue); it will not be retried by another input path")
    }
}

private func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
}

private func frame(_ element: AXUIElement, windowBounds: CGRect) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue
    else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(x: point.x - windowBounds.minX, y: point.y - windowBounds.minY, width: size.width, height: size.height)
}


private func center(_ localFrame: CGRect?, in windowBounds: CGRect) -> CGPoint? {
    guard let localFrame else { return nil }
    return CGPoint(x: windowBounds.minX + localFrame.midX, y: windowBounds.minY + localFrame.midY)
}

private func screenIndex(for bounds: CGRect) -> Int? {
    guard let index = NSScreen.screens.firstIndex(where: { $0.frame.intersects(bounds) }) else {
        return nil
    }
    return index
}

private func coordinatePoint(params: [String: JSONValue], xKey: String, yKey: String, snapshot: Snapshot) throws -> CGPoint {
    let x = try requiredNumber(params, xKey)
    let y = try requiredNumber(params, yKey)
    return CGPoint(
        x: snapshot.windowBounds.minX + x,
        y: snapshot.windowBounds.minY + y
    )
}

private func screenshotScale(screenshot: ScreenshotPayload?, bounds: CGRect) -> CGSize {
    guard let screenshot, bounds.width > 0, bounds.height > 0 else {
        return CGSize(width: 1, height: 1)
    }
    return CGSize(
        width: CGFloat(screenshot.width) / bounds.width,
        height: CGFloat(screenshot.height) / bounds.height
    )
}

extension MouseButtonSelection {
    // Why: macOS has no dedicated middle-button event family; it rides `otherMouse*`
    // with the button number carried by `mouseButton:` on the event constructor.
    var cgButton: CGMouseButton {
        switch self {
        case .left:
            return .left
        case .right:
            return .right
        case .middle:
            return .center
        }
    }

    var downEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseDown
        case .right:
            return .rightMouseDown
        case .middle:
            return .otherMouseDown
        }
    }

    var upEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseUp
        case .right:
            return .rightMouseUp
        case .middle:
            return .otherMouseUp
        }
    }
}

private func mouseButton(_ raw: String?) throws -> MouseButtonSelection {
    switch ActionArgumentValidation.mouseButton(raw) {
    case let .success(button):
        return button
    case let .failure(error):
        throw ProviderError.coded("invalid_argument", error.message)
    }
}

private func renderTreeText(app: AppDescriptor, title: String, bounds: CGRect, lines: [String], focused: String?) -> String {
    var output = [
        "App=\(app.bundleId ?? app.name.replacingOccurrences(of: " ", with: "_")) (pid \(app.pid))",
        "Window: \"\(sanitize(title))\", App: \(sanitize(app.name)).",
        "",
    ]
    output.append(contentsOf: lines)
    output.append("")
    output.append(focused.map { "The focused UI element is \($0)." } ?? "No UI element is currently focused.")
    return output.joined(separator: "\n")
}

private func renderScreenshotStatus(_ status: ScreenshotStatus, snapshot: Snapshot) -> [String: Any] {
    let metadata: [String: Any] = [
        "engine": snapshot.screenshotEngine ?? "unknown",
        "windowId": Int(snapshot.windowId),
    ]
    switch status {
    case .captured:
        return ["state": "captured", "metadata": metadata]
    case .skipped:
        return ["state": "skipped", "reason": "no_screenshot_flag"]
    case let .failed(message):
        return ["state": "failed", "code": "screenshot_failed", "message": message, "metadata": metadata]
    }
}

private final class TreeRenderer {
    let windowBounds: CGRect
    let focused: AXUIElement?
    let compactBrowserTabs: Bool
    var lines: [String] = []
    var records: [Int: ElementRecord] = [:]
    var focusedSummary: String?
    var focusedElementId: Int?
    var truncated = false
    var maxDepthReached = false
    private let reader = AXSnapshotReader()
    private var nextIndex = 0
    static let maxNodes = 1200
    static let maxDepth = 64

    init(windowBounds: CGRect, focused: AXUIElement?, compactBrowserTabs: Bool) {
        self.windowBounds = windowBounds
        self.focused = focused
        self.compactBrowserTabs = compactBrowserTabs
    }

    func render(_ element: AXUIElement, depth: Int = 0, ancestors: [AXUIElement] = []) {
        guard nextIndex < Self.maxNodes else {
            truncated = true
            return
        }
        guard depth < Self.maxDepth else {
            truncated = true
            maxDepthReached = true
            return
        }
        guard !ancestors.contains(where: { CFEqual($0, element) }) else { return }

        let role = reader.stringAttribute(element, kAXRoleAttribute as String) ?? "AXUnknown"
        let children = reader.primaryChildren(element, role: role, windowBounds: windowBounds)
        let value = reader.valueString(element, role: role)
        let placeholder = reader.placeholderString(element)
        let rawActions = reader.actions(element)
        let rowSummary = reader.rowTextSummary(element, role: role)
        let roleDescription = reader.stringAttribute(element, kAXRoleDescriptionAttribute as String)
        let title = reader.stringAttribute(element, kAXTitleAttribute as String)
        let label = reader.stringAttribute(element, kAXDescriptionAttribute as String)
        let url = reader.stringAttribute(element, kAXURLAttribute as String)
        let linkText = role == "AXLink" ? reader.descendantTextSnippets(element, limit: 2, maxDepth: 3).first : nil
        let baseNode = SnapshotRenderNode(
            role: role,
            roleDescription: roleDescription,
            title: title,
            label: label,
            linkText: linkText,
            value: value,
            placeholder: placeholder,
            url: url,
            traits: [],
            rawActions: rawActions,
            childCount: children.count,
            rowSummary: rowSummary
        )
        let name = SnapshotRenderHeuristics.displayName(baseNode)
        let meaningful = SnapshotRenderHeuristics.meaningfulActions(rawActions, role: role)
        let localFrame = reader.frame(element, windowBounds: windowBounds)
        let traits = reader.traitsFor(element, role: role)
        let webAreaDepth = reader.webAreaDepth(role: role, ancestors: ancestors)
        let summary = reader.genericTextSummary(element, role: role, name: name, actions: meaningful, traits: traits)
        let node = SnapshotRenderNode(
            role: role,
            roleDescription: roleDescription,
            title: title,
            label: label,
            linkText: linkText,
            value: value,
            placeholder: placeholder,
            url: url,
            traits: traits,
            rawActions: rawActions,
            childCount: children.count,
            summary: summary,
            rowSummary: rowSummary,
            webAreaDepth: webAreaDepth
        )
        if SnapshotRenderHeuristics.shouldElide(node) {
            for child in children {
                render(child, depth: depth, ancestors: ancestors + [element])
            }
            return
        }

        let index = nextIndex
        nextIndex += 1
        let line = SnapshotRenderHeuristics.line(index: index, node: node)
        lines.append(String(repeating: "\t", count: depth) + line)
        records[index] = ElementRecord(
            index: index,
            element: element,
            localFrame: localFrame,
            actions: rawActions
        )
        if let focused, CFEqual(focused, element) {
            focusedElementId = index
            focusedSummary = line
        }
        if summary != nil || SnapshotRenderHeuristics.shouldSuppressChildren(node) {
            return
        }
        if compactBrowserTabs, let tabStripCompaction = tabStripCompaction(parent: node, children: children) {
            for (childIndex, child) in children.enumerated() where tabStripCompaction.retainedIndexes.contains(childIndex) {
                render(child, depth: depth + 1, ancestors: ancestors + [element])
            }
            lines.append(
                String(repeating: "\t", count: depth + 1) +
                    "... \(tabStripCompaction.omittedCount) inactive browser tabs omitted"
            )
            return
        }
        let childLineStart = lines.count
        for child in children {
            render(child, depth: depth + 1, ancestors: ancestors + [element])
        }
        if compactBrowserTabs {
            compactRenderedBrowserTabs(parent: node, startLine: childLineStart, depth: depth + 1)
        }
    }

    private func tabStripCompaction(parent: SnapshotRenderNode, children: [AXUIElement]) -> SnapshotTabStripCompaction? {
        let childNodes = children.map { child in
            let role = reader.stringAttribute(child, kAXRoleAttribute as String) ?? "AXUnknown"
            return SnapshotRenderNode(
                role: role,
                roleDescription: reader.stringAttribute(child, kAXRoleDescriptionAttribute as String),
                title: reader.stringAttribute(child, kAXTitleAttribute as String),
                label: reader.stringAttribute(child, kAXDescriptionAttribute as String),
                value: reader.valueString(child, role: role),
                traits: reader.traitsFor(child, role: role)
            )
        }
        // Why: browsers expose every open tab through AX; retaining only the active
        // tab keeps snapshots focused on the current page instead of stale tab titles.
        return SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: childNodes)
    }

    private func compactRenderedBrowserTabs(parent: SnapshotRenderNode, startLine: Int, depth: Int) {
        guard SnapshotRenderHeuristics.roleText(parent) == "scroll area" else { return }
        let indent = String(repeating: "\t", count: depth)
        let tabLineIndexes = lines.indices.dropFirst(startLine).filter { lineIndex in
            isDirectRenderedBrowserTabLine(lines[lineIndex], indent: indent)
        }
        guard tabLineIndexes.count >= 10 else { return }
        let activeLineIndexes = Set(tabLineIndexes.filter { lineIndex in
            isActiveRenderedBrowserTabLine(lines[lineIndex])
        })
        guard !activeLineIndexes.isEmpty else { return }

        let insertionIndex = tabLineIndexes.first!
        var omittedCount = 0
        for lineIndex in tabLineIndexes.reversed() where !activeLineIndexes.contains(lineIndex) {
            if let recordIndex = renderedElementIndex(lines[lineIndex], indent: indent) {
                records.removeValue(forKey: recordIndex)
                if focusedElementId == recordIndex {
                    focusedElementId = nil
                    focusedSummary = nil
                }
            }
            lines.remove(at: lineIndex)
            omittedCount += 1
        }
        guard omittedCount > 0 else { return }
        lines.insert("\(indent)... \(omittedCount) inactive browser tabs omitted", at: insertionIndex)
    }
}

private final class AXSnapshotReader {
    private enum CachedAttribute {
        case missing
        case found(CFTypeRef)
    }

    private final class ElementCache {
        let element: AXUIElement
        var loadedAttributeNames = false
        var advertisedAttributes: Set<String>?
        var attributes: [String: CachedAttribute] = [:]
        var actions: [String]?
        var settable: [String: Bool] = [:]

        init(element: AXUIElement) {
            self.element = element
        }
    }

    private var elementsByHash: [CFHashCode: [ElementCache]] = [:]

    func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = copyAttribute(element, attribute) else { return nil }
        if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
            return url.absoluteString
        }
        return nil
    }

    func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        copyAttribute(element, attribute) as? Bool
    }

    func numberAttribute(_ element: AXUIElement, _ attribute: String) -> NSNumber? {
        copyAttribute(element, attribute) as? NSNumber
    }

    func copyArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
        copyAttribute(element, attribute) as? [AXUIElement]
    }

    func actions(_ element: AXUIElement) -> [String] {
        let cache = cache(for: element)
        if let actions = cache.actions {
            return actions
        }
        var value: CFArray?
        let actions = AXUIElementCopyActionNames(element, &value) == .success ? value as? [String] ?? [] : []
        cache.actions = actions
        return actions
    }

    func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        let cache = cache(for: element)
        if let cached = cache.settable[attribute] {
            return cached
        }
        var settable = DarwinBoolean(false)
        let value = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
        cache.settable[attribute] = value
        return value
    }

    func frame(_ element: AXUIElement, windowBounds: CGRect) -> CGRect? {
        guard let absolute = absoluteFrame(element) else { return nil }
        return CGRect(
            x: absolute.minX - windowBounds.minX,
            y: absolute.minY - windowBounds.minY,
            width: absolute.width,
            height: absolute.height
        )
    }

    func primaryChildren(_ element: AXUIElement, role: String, windowBounds: CGRect) -> [AXUIElement] {
        if usesRowsAsPrimaryChildren(role: role), let rows = copyArray(element, kAXRowsAttribute as String), !rows.isEmpty {
            return visibleRows(rows, parent: element, windowBounds: windowBounds)
        }
        return copyArray(element, kAXChildrenAttribute as String) ?? []
    }

    func valueString(_ element: AXUIElement, role: String) -> String? {
        if isSecureTextElement(element, role: role) {
            return "[redacted]"
        }
        if let string = stringAttribute(element, kAXValueAttribute as String) {
            return string
        }
        if let number = numberAttribute(element, kAXValueAttribute as String) {
            return number.stringValue
        }
        return nil
    }

    func placeholderString(_ element: AXUIElement) -> String? {
        stringAttribute(element, "AXPlaceholderValue") ?? stringAttribute(element, "AXPlaceholder")
    }

    func traitsFor(_ element: AXUIElement, role: String) -> [String] {
        var traits: [String] = []
        if boolAttribute(element, kAXSelectedAttribute as String) == true { traits.append("selected") }
        if boolAttribute(element, kAXExpandedAttribute as String) == true { traits.append("expanded") }
        if boolAttribute(element, kAXEnabledAttribute as String) == false { traits.append("disabled") }
        if valueSettableRoles.contains(role), isSettable(element, kAXValueAttribute as String) { traits.append("settable") }
        return traits
    }

    func genericTextSummary(
        _ element: AXUIElement,
        role: String,
        name: String?,
        actions: [String],
        traits: [String]
    ) -> String? {
        guard (role == kAXGroupRole as String || role == kAXUnknownRole as String),
              name == nil,
              actions.isEmpty,
              traits.isEmpty,
              isPlainTextSubtree(element, maxDepth: 4)
        else {
            return nil
        }
        let texts = descendantTextSnippets(element, limit: 8, maxDepth: 4)
        guard texts.count >= 2 else { return nil }
        let summary = texts.joined(separator: " ")
        guard summary.count <= 220 else { return nil }
        return summary
    }

    func rowTextSummary(_ element: AXUIElement, role: String) -> String? {
        guard ["AXRow", "AXCell", "AXOutlineRow"].contains(role) else { return nil }
        let texts = descendantTextSnippets(element, limit: 6, maxDepth: 3)
        guard !texts.isEmpty else { return nil }
        return texts.joined(separator: " ")
    }

    func descendantTextSnippets(_ element: AXUIElement, limit: Int, maxDepth: Int) -> [String] {
        var values: [String] = []
        var seen = Set<String>()

        func collect(_ node: AXUIElement, depth: Int) {
            guard values.count < limit, depth <= maxDepth else { return }
            let role = stringAttribute(node, kAXRoleAttribute as String) ?? ""
            if role == kAXStaticTextRole as String || role == "AXLink" {
                for candidate in [
                    stringAttribute(node, kAXValueAttribute as String),
                    stringAttribute(node, kAXTitleAttribute as String),
                    stringAttribute(node, kAXDescriptionAttribute as String),
                ] {
                    guard let candidate else { continue }
                    let text = preview(candidate, maxLength: 80)
                    guard !text.isEmpty, seen.insert(text).inserted else { continue }
                    values.append(text)
                    if values.count >= limit { return }
                }
            }
            for child in copyArray(node, kAXChildrenAttribute as String) ?? [] {
                collect(child, depth: depth + 1)
                if values.count >= limit { return }
            }
        }

        collect(element, depth: 0)
        return values
    }

    func webAreaDepth(role: String, ancestors: [AXUIElement]) -> Int? {
        if role == "AXWebArea" { return 0 }
        guard let index = ancestors.firstIndex(where: { stringAttribute($0, kAXRoleAttribute as String) == "AXWebArea" }) else {
            return nil
        }
        return ancestors.count - index
    }

    private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        let cache = cache(for: element)
        if let cached = cache.attributes[attribute] {
            switch cached {
            case .missing:
                return nil
            case let .found(value):
                return value
            }
        }
        if let advertisedAttributes = advertisedAttributes(cache),
           !SnapshotRenderHeuristics.supportsAttribute(attribute, advertisedAttributes: advertisedAttributes) {
            cache.attributes[attribute] = .missing
            return nil
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
            cache.attributes[attribute] = .missing
            return nil
        }
        cache.attributes[attribute] = .found(value)
        return value
    }

    private func advertisedAttributes(_ cache: ElementCache) -> Set<String>? {
        if cache.loadedAttributeNames {
            return cache.advertisedAttributes
        }
        cache.loadedAttributeNames = true
        var value: CFArray?
        guard AXUIElementCopyAttributeNames(cache.element, &value) == .success, let attributes = value as? [String] else {
            return nil
        }
        cache.advertisedAttributes = Set(attributes)
        return cache.advertisedAttributes
    }

    private func absoluteFrame(_ element: AXUIElement) -> CGRect? {
        guard let positionValue = copyAttribute(element, kAXPositionAttribute as String),
              let sizeValue = copyAttribute(element, kAXSizeAttribute as String)
        else {
            return nil
        }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        else {
            return nil
        }
        return CGRect(origin: point, size: size)
    }

    private func visibleRows(_ rows: [AXUIElement], parent: AXUIElement, windowBounds: CGRect) -> [AXUIElement] {
        guard let parentFrame = frame(parent, windowBounds: windowBounds) else {
            return Array(rows.prefix(20))
        }
        let visible = rows.filter { row in
            guard let rowFrame = frame(row, windowBounds: windowBounds) else { return false }
            return rowFrame.intersects(parentFrame)
        }
        return Array((visible.isEmpty ? rows : visible).prefix(20))
    }

    private func isSecureTextElement(_ element: AXUIElement, role: String) -> Bool {
        guard SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: role) else {
            return false
        }
        let haystack = [
            role,
            stringAttribute(element, kAXSubroleAttribute as String) ?? "",
            stringAttribute(element, kAXTitleAttribute as String) ?? "",
            stringAttribute(element, kAXDescriptionAttribute as String) ?? "",
            placeholderString(element) ?? "",
        ].joined(separator: " ").lowercased()
        return haystack.contains("secure") ||
            haystack.contains("password") ||
            haystack.contains("passcode") ||
            haystack.contains("verification code") ||
            haystack.contains("one-time code")
    }

    private func isPlainTextSubtree(_ element: AXUIElement, maxDepth: Int) -> Bool {
        var sawText = false
        let allowedContainerRoles: Set<String> = [
            kAXGroupRole as String,
            kAXUnknownRole as String,
            kAXStaticTextRole as String,
            "AXLink",
            "AXImage",
        ]

        func visit(_ node: AXUIElement, depth: Int) -> Bool {
            guard depth <= maxDepth else { return false }
            let role = stringAttribute(node, kAXRoleAttribute as String) ?? "AXUnknown"
            guard allowedContainerRoles.contains(role) else { return false }
            if role == kAXStaticTextRole as String || role == "AXLink" {
                sawText = true
            }
            guard SnapshotRenderHeuristics.meaningfulActions(actions(node), role: role).isEmpty else { return false }
            for child in copyArray(node, kAXChildrenAttribute as String) ?? [] {
                guard visit(child, depth: depth + 1) else { return false }
            }
            return true
        }

        return visit(element, depth: 0) && sawText
    }

    private func cache(for element: AXUIElement) -> ElementCache {
        let hash = CFHash(element)
        if let cache = elementsByHash[hash]?.first(where: { CFEqual($0.element, element) }) {
            return cache
        }
        let cache = ElementCache(element: element)
        elementsByHash[hash, default: []].append(cache)
        return cache
    }
}

private let valueSettableRoles: Set<String> = [
    kAXCheckBoxRole as String,
    kAXComboBoxRole as String,
    kAXRadioButtonRole as String,
    "AXSearchField",
    kAXSliderRole as String,
    kAXTextAreaRole as String,
    kAXTextFieldRole as String,
]

private func usesRowsAsPrimaryChildren(role: String) -> Bool {
    [
        kAXBrowserRole as String,
        kAXListRole as String,
        kAXOutlineRole as String,
        kAXTableRole as String,
    ].contains(role)
}

private func isDirectRenderedBrowserTabLine(_ line: String, indent: String) -> Bool {
    guard line.hasPrefix(indent), !line.dropFirst(indent.count).hasPrefix("\t") else {
        return false
    }
    let text = String(line.dropFirst(indent.count))
    return text.range(of: #"^\d+ tab($| \(|,)"#, options: .regularExpression) != nil
}

private func isActiveRenderedBrowserTabLine(_ line: String) -> Bool {
    line.contains("(selected") || line.contains("Value: 1")
}

private func renderedElementIndex(_ line: String, indent: String) -> Int? {
    let text = line.dropFirst(indent.count)
    let digits = text.prefix { character in
        character >= "0" && character <= "9"
    }
    return Int(digits)
}

private func sanitize(_ value: String) -> String {
    value.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
}

private func preview(_ value: String, maxLength: Int = 120) -> String {
    let clean = sanitize(value)
    if clean.count <= maxLength {
        return clean
    }
    return String(clean.prefix(maxLength)) + "..."
}

private func actionMetadata(
    path: String,
    actionName: String? = nil,
    fallbackReason: String? = nil,
    verification: [String: Any]? = nil
) -> [String: Any] {
    var metadata: [String: Any] = [
        "path": path,
        "actionName": jsonNullable(actionName),
        "fallbackReason": jsonNullable(fallbackReason),
    ]
    if let verification {
        metadata["verification"] = verification
    }
    return metadata
}

private func verifiedAction(property: String, expected: String? = nil, actualPreview: String? = nil) -> [String: Any] {
    [
        "state": "verified",
        "property": property,
        "expected": jsonNullable(expected),
        "actualPreview": jsonNullable(actualPreview),
    ]
}

private func unverifiedAction(reason: String, expected: String? = nil, actualPreview: String? = nil) -> [String: Any] {
    [
        "state": "unverified",
        "reason": reason,
        "expected": jsonNullable(expected),
        "actualPreview": jsonNullable(actualPreview),
    ]
}

private func jsonNullable<T>(_ value: T?) -> Any {
    value ?? NSNull()
}

private struct WindowCandidate {
    let ownerPID: pid_t
    let windowId: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let alpha: CGFloat
    let isOnScreen: Bool
    let sharingState: Int?

    var score: Double {
        var value = Double(bounds.width * bounds.height)
        if layer == 0 { value += 1_000_000_000 }
        if title != nil && title?.isEmpty == false { value += 10_000_000 }
        if isOnScreen { value += 1_000_000 }
        if alpha >= 0.99 { value += 100_000 }
        return value
    }
}

private struct WindowCapture {
    let windowId: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let image: CapturedImage?
    let captureFailure: String?

    static func resolve(candidates: [WindowCandidate], windowId: CGWindowID?, captureImage: Bool) -> WindowCapture? {
        guard let windowId, let candidate = candidates.first(where: { $0.windowId == windowId }) else { return nil }
        return WindowCapture(candidate: candidate, captureImage: captureImage)
    }

    private init(candidate: WindowCandidate, captureImage: Bool) {
        self.windowId = candidate.windowId
        self.layer = candidate.layer
        self.bounds = candidate.bounds
        self.title = candidate.title
        // A no-screenshot observation never attempts screen capture.
        if captureImage {
            do {
                self.image = try NativeDesktopOperations.windowPixels(windowID: candidate.windowId, bounds: candidate.bounds, pid: candidate.ownerPID)
                self.captureFailure = nil
            } catch {
                self.image = nil
                self.captureFailure = nativeErrorPayload(error)["message"]
            }
        } else {
            self.image = nil
            self.captureFailure = nil
        }
    }

    static func candidates(pid: pid_t) -> [WindowCandidate] {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return infos.compactMap { info in
            guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t, ownerPid == pid,
                  let number = info[kCGWindowNumber as String] as? NSNumber,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
                  bounds.width >= 48,
                  bounds.height >= 48
            else {
                return nil
            }
            let alpha = info[kCGWindowAlpha as String] as? CGFloat ?? 1
            guard alpha > 0.01 else { return nil }
            let sharing = (info[kCGWindowSharingState as String] as? NSNumber).map { $0.intValue }
            if sharing == 0 { return nil }
            let isOnScreen = (info[kCGWindowIsOnscreen as String] as? Bool) ?? true
            return WindowCandidate(
                ownerPID: ownerPid,
                windowId: CGWindowID(number.uint32Value),
                layer: layer,
                bounds: bounds,
                title: info[kCGWindowName as String] as? String,
                alpha: alpha,
                isOnScreen: isOnScreen,
                sharingState: sharing
            )
        }
        .sorted { lhs, rhs in
            lhs.score > rhs.score
        }
    }

    func screenshotPayload() -> ScreenshotPayload? {
        guard let image, let bounded = boundedPngData(image.image) else { return nil }
        return ScreenshotPayload(
            data: bounded.data.base64EncodedString(),
            width: bounded.width,
            height: bounded.height,
            scale: Double(bounded.width) / max(Double(bounds.width), 1)
        )
    }

}

private final class AsyncBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

enum BlockingAsync {
    static func run<T>(timeout: TimeInterval, operation: @escaping @Sendable () async throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AsyncBox<T>()
        let task = Task.detached {
            do {
                box.result = .success(try await operation())
            } catch {
                box.result = .failure(error)
            }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            task.cancel()
            throw ProviderError.coded("action_timeout", "screenshot capture timed out")
        }
        return try box.result!.get()
    }
}

private struct BoundedPNG {
    let data: Data
    let width: Int
    let height: Int
}

private func boundedPngData(_ image: CGImage) -> BoundedPNG? {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
    if data.count <= 900_000 {
        return BoundedPNG(data: data, width: image.width, height: image.height)
    }
    var scale = min(1, 1280 / CGFloat(max(image.width, image.height)))
    var best = BoundedPNG(data: data, width: image.width, height: image.height)
    while scale >= 0.25 {
        guard let resized = resizePng(image, scale: scale) else {
            break
        }
        best = resized
        if resized.data.count <= 900_000 {
            return resized
        }
        scale *= 0.85
    }
    return best
}

private func resizePng(_ image: CGImage, scale: CGFloat) -> BoundedPNG? {
    let width = max(1, Int(CGFloat(image.width) * scale))
    let height = max(1, Int(CGFloat(image.height) * scale))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        return nil
    }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let resized = context.makeImage() else { return nil }
    guard let data = NSBitmapImageRep(cgImage: resized).representation(using: .png, properties: [:]) else {
        return nil
    }
    return BoundedPNG(data: data, width: width, height: height)
}

private enum Input {
    static func click(
        at point: CGPoint,
        button: MouseButtonSelection,
        count: Int,
        modifiers: [KeyModifier],
        targetWindow: Snapshot
    ) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError.coded("accessibility_error", "failed to create event source")
        }
        let flags = modifiers.reduce(into: CGEventFlags()) { result, modifier in
            result.insert(modifier.flag)
        }
        let target = syntheticClickRecipient(pid: targetWindow.app.pid, windowId: targetWindow.windowId)
        do {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: count,
                target: target,
                currentObservation: {
                    currentSyntheticClickRecipient(snapshot: targetWindow, point: point)
                },
                makeEvent: { step in
                    let type: CGEventType
                    switch step {
                    case .move:
                        type = .mouseMoved
                    case .buttonDown:
                        type = button.downEvent
                    case .buttonUp:
                        type = button.upEvent
                    }
                    guard let event = CGEvent(
                        mouseEventSource: source,
                        mouseType: type,
                        mouseCursorPosition: point,
                        mouseButton: button.cgButton
                    ) else {
                        throw ProviderError.coded("accessibility_error", "failed to create mouse event")
                    }
                    event.flags = flags
                    let clickState = SyntheticMouseClickDelivery.clickState(for: step)
                    if clickState > 0 {
                        event.setIntegerValueField(.mouseEventClickState, value: clickState)
                    }
                    return event
                },
                post: { $0.post(tap: .cghidEventTap) },
                pause: { _ = usleep($0) }
            )
        } catch let failure as SyntheticMouseClickDelivery.FenceFailure {
            switch failure {
            case let .recipientChanged(expected, actual, deliveredPresses):
                let actualDescription = actual.map {
                    "pid \($0.ownerPID) window \($0.windowID)"
                } ?? "no focused window"
                let recovery = deliveredPresses == 0
                    ? "bring the target window forward, run get-app-state again, and retry"
                    : "\(deliveredPresses) press(es) may already have been delivered; run get-app-state and verify state before retrying"
                throw ProviderError.coded(
                    deliveredPresses == 0 ? "window_not_focused" : "action_outcome_unknown",
                    "coordinate click aborted because target pid \(expected.ownerPID) window \(expected.windowID) is no longer the focused topmost recipient (current: \(actualDescription)); \(recovery)"
                )
            }
        }
    }

    static func scroll(pid: pid_t, at point: CGPoint, direction: String, pages: Double) throws {
        guard let delta = boundedInteger(max(1, (12 * pages).rounded()), as: Int32.self) else {
            throw ProviderError.coded("invalid_argument", "pages is out of range")
        }
        let wheel1: Int32 = direction == "up" ? delta : direction == "down" ? -delta : 0
        let wheel2: Int32 = direction == "left" ? delta : direction == "right" ? -delta : 0
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0) else {
            throw ProviderError.coded("accessibility_error", "failed to create scroll event")
        }
        event.location = point
        event.postToPid(pid)
    }

    static func drag(pid: pid_t, from start: CGPoint, to end: CGPoint) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError.coded("accessibility_error", "failed to create event source")
        }
        try mouse(.mouseMoved, source: source, point: start, button: .left, pid: pid)
        try mouse(.leftMouseDown, source: source, point: start, button: .left, pid: pid)
        for step in 1...10 {
            let progress = CGFloat(step) / 10
            try mouse(
                .leftMouseDragged,
                source: source,
                point: CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress),
                button: .left,
                pid: pid
            )
        }
        try mouse(.leftMouseUp, source: source, point: end, button: .left, pid: pid)
    }

    private static func originalProcessIsLive(_ snapshot: Snapshot) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: snapshot.app.pid),
              let actualStart = app.launchDate?.timeIntervalSince1970,
              let expectedStart = snapshot.app.app.launchDate?.timeIntervalSince1970 else { return false }
        return !app.isTerminated && abs(actualStart - expectedStart) < 0.00001
    }

    private static func requireRecipient(_ snapshot: Snapshot, deliveredEvents: Int) throws {
        guard originalProcessIsLive(snapshot), isTargetWindowFocused(snapshot) else {
            let code = deliveredEvents == 0 ? "window_not_focused" : "action_outcome_unknown"
            throw ProviderError.coded(code, "original keyboard recipient changed after \(deliveredEvents) posted event(s); no remaining input was delivered or replayed")
        }
    }

    static func typeText(_ text: String, targetWindow: Snapshot) throws {
        var delivered = 0
        for character in text {
            let units = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                throw ProviderError.coded(delivered == 0 ? "accessibility_error" : "action_outcome_unknown", "keyboard event allocation failed after \(delivered) posted event(s)")
            }
            units.withUnsafeBufferPointer { buffer in
                if let address = buffer.baseAddress {
                    down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: address)
                    up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: address)
                }
            }
            try requireRecipient(targetWindow, deliveredEvents: delivered)
            down.postToPid(targetWindow.app.pid)
            delivered += 1
            do { try requireRecipient(targetWindow, deliveredEvents: delivered) } catch {
                if originalProcessIsLive(targetWindow) { up.postToPid(targetWindow.app.pid) }
                throw error
            }
            up.postToPid(targetWindow.app.pid)
            delivered += 1
        }
    }

    static func pressKey(_ key: String, targetWindow: Snapshot) throws {
        let parsed = try KeyMap.parse(key)
        var flags = CGEventFlags()
        var delivered = 0
        var pressedModifiers: [KeyModifier] = []
        defer {
            if originalProcessIsLive(targetWindow) {
                for modifier in pressedModifiers.reversed() {
                    flags.remove(modifier.flag)
                    try? keyEvent(modifier.keyCode, down: false, flags: flags, pid: targetWindow.app.pid)
                }
            }
        }
        func send(_ code: CGKeyCode, down: Bool) throws {
            try requireRecipient(targetWindow, deliveredEvents: delivered)
            do { try keyEvent(code, down: down, flags: flags, pid: targetWindow.app.pid) }
            catch {
                throw ProviderError.coded(delivered == 0 ? "accessibility_error" : "action_outcome_unknown", "key event allocation failed after \(delivered) posted event(s); no remainder was replayed")
            }
            delivered += 1
        }
        for modifier in parsed.modifiers {
            flags.insert(modifier.flag)
            try send(modifier.keyCode, down: true)
            pressedModifiers.append(modifier)
        }
        try send(parsed.keyCode, down: true)
        do { try send(parsed.keyCode, down: false) } catch {
            if originalProcessIsLive(targetWindow) { try? keyEvent(parsed.keyCode, down: false, flags: flags, pid: targetWindow.app.pid) }
            throw error
        }
    }

    static func pasteText(_ text: String, targetWindow: Snapshot) throws -> [String: Any] {
        try withNativeClipboard {
            try requireRecipient(targetWindow, deliveredEvents: 0)
            let write: (accepted: Bool, changeCount: Int) = try onMain {
                try requireRecipient(targetWindow, deliveredEvents: 0)
                let item = NSPasteboardItem()
                guard item.setString(text, forType: .string) else {
                    throw ProviderError.coded("clipboard_write_failed", "could not prepare paste text; previous clipboard retained and no shortcut posted")
                }
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                let accepted = pasteboard.writeObjects([item])
                return (accepted, pasteboard.changeCount)
            }
            guard write.accepted else {
                return ["state": "unverified", "reason": "clipboard_write_unconfirmed", "clipboardChangeCount": write.changeCount,
                        "error": ["code": "clipboard_write_failed", "message": "macOS did not confirm the clipboard write; no shortcut was posted"]]
            }
            do { try pressKey("cmd+v", targetWindow: targetWindow) }
            catch {
                return ["state": "unverified", "reason": "clipboard_paste_post_unconfirmed", "clipboardRestoration": "retained_for_paste",
                        "clipboardChangeCount": write.changeCount, "error": nativeErrorPayload(error)]
            }
            // CGEvent posting provides no acknowledgement that the app consumed
            // the pasteboard. Keep the requested text for that asynchronous read.
            return ["state": "unverified", "reason": "clipboard_paste", "clipboardRestoration": "retained_for_paste",
                    "clipboardChangeCount": write.changeCount]
        }
    }

    private static func mouse(
        _ type: CGEventType,
        source: CGEventSource,
        point: CGPoint,
        button: CGMouseButton,
        flags: CGEventFlags = [],
        pid: pid_t
    ) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ProviderError.coded("accessibility_error", "failed to create mouse event")
        }
        event.flags = flags
        event.postToPid(pid)
    }

    private static func keyEvent(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags, pid: pid_t) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else {
            throw ProviderError.coded("accessibility_error", "failed to create key event")
        }
        event.flags = flags
        event.postToPid(pid)
    }
}

private enum TextInput {
    static func replaceSelection(_ element: AXUIElement, with text: String) throws -> [String: Any]? {
        guard isSettable(element, kAXValueAttribute as String),
              let current = rawStringAttribute(element, kAXValueAttribute as String)
        else {
            return nil
        }
        guard let selectedRange = selectedTextRange(element) else { return nil }
        let startOffset = max(0, min(selectedRange.location, current.utf16.count))
        let endOffset = max(startOffset, min(startOffset + selectedRange.length, current.utf16.count))
        let start = String.Index(utf16Offset: startOffset, in: current)
        let end = String.Index(utf16Offset: endOffset, in: current)
        let next = String(current[..<start]) + text + String(current[end...])
        let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, next as CFString)
        if NativeAXReply.classify(status) == .unsupported { return nil }
        guard status == .success else {
            throw ProviderError.coded("action_outcome_unknown", "AX text replacement returned \(status.rawValue); no second input path was attempted")
        }
        let caretAccepted = setSelectedTextRange(element, CFRange(location: startOffset + text.utf16.count, length: 0))
        guard rawStringAttribute(element, kAXValueAttribute as String) == next, caretAccepted else {
            return unverifiedAction(reason: "native_write_accepted_readback_unconfirmed", expected: text)
        }
        return verifiedAction(
            property: "focusedText",
            expected: text,
            actualPreview: preview(next)
        )
    }

    static func selectAll(_ element: AXUIElement) throws -> Bool {
        guard let current = rawStringAttribute(element, kAXValueAttribute as String),
              isSettable(element, kAXSelectedTextRangeAttribute as String) else { return false }
        var range = CFRange(location: 0, length: current.utf16.count)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        let status = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        if NativeAXReply.classify(status) == .unsupported { return false }
        guard status == .success else {
            throw ProviderError.coded("action_outcome_unknown", "AX selection returned \(status.rawValue); the shortcut was not replayed")
        }
        return true
    }

    static func selectionVerification(_ element: AXUIElement) -> [String: Any] {
        guard let current = rawStringAttribute(element, kAXValueAttribute as String),
              let selectedRange = selectedTextRange(element),
              selectedRange.location == 0,
              selectedRange.length == current.utf16.count
        else {
            return unverifiedAction(reason: "provider_unavailable")
        }
        return verifiedAction(property: "selection", actualPreview: preview(current))
    }

    private static func selectedTextRange(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID()
        else {
            return nil
        }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else {
            return nil
        }
        return range
    }

    @discardableResult
    private static func setSelectedTextRange(_ element: AXUIElement, _ range: CFRange) -> Bool {
        var mutableRange = range
        guard let value = AXValueCreate(.cfRange, &mutableRange) else {
            return false
        }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }
}

private func isSelectAllHotkey(_ key: String) -> Bool {
    let parts = key
        .lowercased()
        .replacingOccurrences(of: " ", with: "")
        .replacingOccurrences(of: "-", with: "+")
        .split(separator: "+")
        .map(String.init)
    guard parts.last == "a" else {
        return false
    }
    let modifiers = Set(parts.dropLast())
    return modifiers.contains("cmd") ||
        modifiers.contains("command") ||
        modifiers.contains("meta") ||
        modifiers.contains("cmdorctrl") ||
        modifiers.contains("commandorcontrol")
}

private struct KeyModifier {
    let keyCode: CGKeyCode
    let flag: CGEventFlags
}

private struct ParsedKey {
    let keyCode: CGKeyCode
    let modifiers: [KeyModifier]
}

private enum KeyMap {
    static func parse(_ spec: String) throws -> ParsedKey {
        let parts = spec.split(separator: "+").map { String($0).lowercased() }
        var modifiers: [KeyModifier] = []
        var keyName: String?
        for part in parts {
            if let modifier = modifier(part) {
                modifiers.append(modifier)
            } else {
                keyName = part
            }
        }
        guard let keyName, let keyCode = codes[keyName] else {
            throw ProviderError.coded("invalid_argument", "unsupported key '\(spec)'")
        }
        return ParsedKey(keyCode: keyCode, modifiers: modifiers)
    }

    static func parseModifiers(_ spec: String?) throws -> [KeyModifier] {
        guard let spec else {
            return []
        }
        let parts = spec.split(separator: "+", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        guard !parts.isEmpty, !parts.contains(where: \.isEmpty) else {
            throw ProviderError.coded("invalid_argument", "click modifiers require modifier keys only")
        }
        return try parts.map { part in
            guard let modifier = modifier(part) else {
                throw ProviderError.coded("invalid_argument", "unsupported click modifier '\(part)'")
            }
            return modifier
        }
    }

    private static func modifier(_ part: String) -> KeyModifier? {
        switch part {
        case "cmd", "command", "meta", "super", "win", "cmdorctrl", "commandorcontrol":
            return KeyModifier(keyCode: 55, flag: .maskCommand)
        case "ctrl", "control":
            return KeyModifier(keyCode: 59, flag: .maskControl)
        case "alt", "option":
            return KeyModifier(keyCode: 58, flag: .maskAlternate)
        case "shift":
            return KeyModifier(keyCode: 56, flag: .maskShift)
        default:
            return nil
        }
    }

    private static let codes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
        "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "left": 123, "right": 124,
        "down": 125, "up": 126, "insert": 114, "home": 115, "pageup": 116, "page_up": 116,
        "forwarddelete": 117, "end": 119, "pagedown": 121, "page_down": 121,
    ]
}

private final class NativeRuntime: NSObject, NSApplicationDelegate {
    private static let unclaimedSessionDeadline: TimeInterval = 15

    private let socketPath: String
    private let token: String?
    private let parentPID: pid_t
    private var parentMonitor: DispatchSourceProcess?
    private var listener: SocketListener?
    private var unclaimedSessionTimeout: DispatchWorkItem?

    init(socketPath: String, token: String?, parentPID: pid_t) {
        self.socketPath = socketPath
        self.token = token
        self.parentPID = parentPID
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let timeout = DispatchWorkItem {
                fputs("computer-use agent received no authenticated session before its deadline\n", stderr)
                NSApp.terminate(nil)
            }
            unclaimedSessionTimeout = timeout
            let listener = try SocketListener(
                socketPath: socketPath,
                token: token,
                parentPID: parentPID,
                onSessionClaimed: {
                    timeout.cancel()
                },
                onSessionClosed: {
                    DispatchQueue.main.async {
                        NSApp.terminate(nil)
                    }
                }
            )
            self.listener = listener
            listener.start()
            let monitor = DispatchSource.makeProcessSource(identifier: parentPID, eventMask: .exit, queue: .main)
            monitor.setEventHandler { NSApp.terminate(nil) }
            monitor.resume()
            parentMonitor = monitor
            DispatchQueue.main.asyncAfter(
                deadline: .now() + Self.unclaimedSessionDeadline,
                execute: timeout
            )
        } catch {
            fputs("failed to start computer-use socket: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        unclaimedSessionTimeout?.cancel()
        unclaimedSessionTimeout = nil
        parentMonitor?.cancel()
        listener?.stop()
    }
}

private final class PermissionRuntime: NSObject, NSApplicationDelegate {
    private let initialPermission: PermissionKind?
    private var windowController: PermissionWindowController?

    init(initialPermission: PermissionKind?) {
        self.initialPermission = initialPermission
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        windowController = PermissionWindowController(
            initialPermission: initialPermission,
            terminateWhenDragAssistantCloses: initialPermission != nil
        )
        if let initialPermission {
            windowController?.openPermission(initialPermission)
        } else {
            windowController?.showWindow(nil)
            windowController?.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        windowController?.refreshPermissions()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        windowController?.refreshPermissions()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        initialPermission == nil
    }
}

private final class PermissionWindowController: NSWindowController {
    private var dragAssistant: PermissionDragAssistantController?
    private var dragAssistantPermission: PermissionKind?
    private let initialPermission: PermissionKind?
    private let terminateWhenDragAssistantCloses: Bool
    private var permissionStatusRefresh: PermissionStatusRefreshCoordinator?

    convenience init(initialPermission: PermissionKind? = nil, terminateWhenDragAssistantCloses: Bool = false) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 315),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Enable AgentMux Native"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = PermissionPalette.background
        window.center()
        window.isReleasedWhenClosed = false
        self.init(window: window, initialPermission: initialPermission, terminateWhenDragAssistantCloses: terminateWhenDragAssistantCloses)
        window.contentView = PermissionView(
            frame: window.contentView?.bounds ?? .zero,
            showDragAssistant: { [weak self] permission in
                self?.showDragAssistant(for: permission)
            },
            close: { [weak self] in
                self?.closePermissionWindow()
            }
        )
    }

    init(window: NSWindow?, initialPermission: PermissionKind?, terminateWhenDragAssistantCloses: Bool) {
        self.initialPermission = initialPermission
        self.terminateWhenDragAssistantCloses = terminateWhenDragAssistantCloses
        super.init(window: window)
        permissionStatusRefresh = PermissionStatusRefreshCoordinator(
            probe: permissionStatusSnapshotSettled,
            handler: { [weak self] snapshot in
                Task { @MainActor in
                    self?.applyPermissionStatus(snapshot)
                }
            }
        )
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func showDragAssistant(for permission: PermissionKind) {
        dragAssistant?.close()
        dragAssistantPermission = permission
        dragAssistant = PermissionDragAssistantController(
            permission: permission,
            fallbackVisibleFrame: window?.screen?.visibleFrame,
            onRefreshPermissions: { [weak self] in
                self?.refreshPermissions()
            },
            onClose: { [weak self] in
                if self?.terminateWhenDragAssistantCloses == true {
                    NSApp.terminate(nil)
                }
            }
        )
        dragAssistant?.showWhenReady()
    }

    private func closeDragAssistant() {
        dragAssistant?.close()
        dragAssistant = nil
        dragAssistantPermission = nil
    }

    private func completeDragAssistant() {
        guard let dragAssistant else {
            dragAssistantPermission = nil
            if terminateWhenDragAssistantCloses {
                NSApp.terminate(nil)
            }
            return
        }
        self.dragAssistant = nil
        dragAssistantPermission = nil
        dragAssistant.complete()
    }

    private func closePermissionWindow() {
        // Why: the floating assistant is a separate retained window controller and
        // can keep the helper app alive after the main permission window closes.
        closeDragAssistant()
        window?.close()
    }

    func openPermission(_ permission: PermissionKind) {
        permission.requestAndOpenSettings()
        showDragAssistant(for: permission)
    }

    func refreshPermissions() {
        permissionStatusRefresh?.refresh()
    }

    private func applyPermissionStatus(_ snapshot: PermissionStatusSnapshot) {
        if let initialPermission, initialPermission.isGranted(in: snapshot) {
            // Why: targeted permission helpers should finish once the requested
            // grant lands, even if other Computer Use permissions remain unset.
            completeDragAssistant()
            return
        }
        if dragAssistantPermission?.isGranted(in: snapshot) == true {
            // Why: after one grant in full setup, the remaining missing permission
            // needs fresh guidance instead of the old assistant's instructions.
            closeDragAssistant()
        }
        if PermissionKind.allCases.allSatisfy({ $0.isGranted(in: snapshot) }) {
            closeDragAssistant()
        }
        (window?.contentView as? PermissionView)?.refreshPermissions(snapshot)
    }
}

private enum PermissionKind: CaseIterable {
    case accessibility
    case screenshots

    static func parse(_ value: String?) -> PermissionKind? {
        switch value {
        case "accessibility":
            .accessibility
        case "screenshots", "screen", "screen-recording":
            .screenshots
        default:
            nil
        }
    }

    var dragInstruction: String {
        switch self {
        case .accessibility:
            "Drag AgentMux Native into the list above to allow Accessibility."
        case .screenshots:
            "Drag AgentMux Native into the list above to allow Screenshots."
        }
    }

    var title: String {
        switch self {
        case .accessibility:
            "Accessibility"
        case .screenshots:
            "Screenshots"
        }
    }

    var detail: String {
        switch self {
        case .accessibility:
            "Read and control app interfaces"
        case .screenshots:
            "Capture windows for visual state"
        }
    }

    var icon: NSImage {
        switch self {
        case .accessibility:
            NSImage(systemSymbolName: "figure", accessibilityDescription: "Accessibility") ?? NSImage()
        case .screenshots:
            NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: "Screen Recording") ?? NSImage()
        }
    }

    func isGranted(in snapshot: PermissionStatusSnapshot) -> Bool {
        switch self {
        case .accessibility:
            snapshot.accessibilityGranted
        case .screenshots:
            snapshot.screenshotsGranted
        }
    }

    func requestAndOpenSettings() {
        switch self {
        case .accessibility:
            openAccessibilitySettings()
        case .screenshots:
            _ = requestScreenCaptureAccess()
            openScreenRecordingSettings()
        }
    }
}

private final class PermissionView: NSView {
    private let appURL = Bundle.main.bundleURL
    private let showDragAssistant: (PermissionKind) -> Void
    private let close: () -> Void
    private var contentStack: NSStackView?
    private var contentConstraints: [NSLayoutConstraint] = []
    private var permissionStatus: PermissionStatusSnapshot?

    init(frame frameRect: NSRect, showDragAssistant: @escaping (PermissionKind) -> Void, close: @escaping () -> Void) {
        self.showDragAssistant = showDragAssistant
        self.close = close
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = PermissionPalette.background.cgColor
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        NSLayoutConstraint.deactivate(contentConstraints)
        contentStack?.removeFromSuperview()
        contentConstraints = []

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.distribution = .gravityAreas
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        contentStack = stack

        let icon = NSImageView(image: NSWorkspace.shared.icon(forFile: appURL.path))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 58),
            icon.heightAnchor.constraint(equalToConstant: 58)
        ])

        let missingPermissions = permissionStatus.map { snapshot in
            PermissionKind.allCases.filter { !$0.isGranted(in: snapshot) }
        } ?? []
        let checking = permissionStatus == nil
        let ready = !checking && missingPermissions.isEmpty

        let titleText = checking
            ? "Checking Computer Use"
            : (ready ? "Computer Use is Ready" : "Enable AgentMux Native")
        let title = label(titleText, size: 22, weight: .bold)
        let subtitle = label(
            checking
                ? "Checking Accessibility and Screenshots."
                : (ready
                    ? "AgentMux can use local apps when you ask."
                    : "Grant permissions so AgentMux can use apps when you ask."),
            size: 12,
            weight: .regular
        )
        subtitle.textColor = PermissionPalette.secondaryText
        subtitle.alignment = .center
        subtitle.maximumNumberOfLines = 3

        let header = NSStackView(views: [icon, title, subtitle])
        header.orientation = .vertical
        header.alignment = .centerX
        header.spacing = 6
        header.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(header)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -10).isActive = true

        if checking {
            let progress = NSProgressIndicator()
            progress.style = .spinning
            progress.controlSize = .small
            progress.translatesAutoresizingMaskIntoConstraints = false
            progress.startAnimation(nil)
            stack.addArrangedSubview(progress)
            progress.setContentHuggingPriority(.required, for: .horizontal)
            progress.centerXAnchor.constraint(equalTo: stack.centerXAnchor).isActive = true
        } else if ready {
            stack.addArrangedSubview(doneButton())
        } else {
            for permission in missingPermissions {
                stack.addArrangedSubview(permissionRow(permission: permission) { [weak self] in
                    permission.requestAndOpenSettings()
                    self?.showDragAssistant(permission)
                })
            }
        }

        contentConstraints = [
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 22),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -20)
        ]
        NSLayoutConstraint.activate(contentConstraints)
    }

    func refreshPermissions(_ snapshot: PermissionStatusSnapshot) {
        guard permissionStatus != snapshot else { return }
        permissionStatus = snapshot
        build()
    }

    private func permissionRow(permission: PermissionKind, action: @escaping () -> Void) -> NSView {
        let row = NSView()
        row.wantsLayer = true
        row.layer?.cornerRadius = 14
        row.layer?.borderWidth = 1
        row.layer?.borderColor = PermissionPalette.border.cgColor
        row.layer?.backgroundColor = PermissionPalette.card.cgColor
        row.translatesAutoresizingMaskIntoConstraints = false

        let iconView = NSImageView(image: permission.icon)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 30, weight: .regular)
        iconView.contentTintColor = .controlAccentColor
        iconView.translatesAutoresizingMaskIntoConstraints = false

        let titleLabel = label(permission.title, size: 13, weight: .bold)
        let detailLabel = label(permission.detail, size: 11, weight: .regular)
        detailLabel.textColor = PermissionPalette.secondaryText
        let textStack = NSStackView(views: [titleLabel, detailLabel])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 4
        textStack.translatesAutoresizingMaskIntoConstraints = false

        let button = NSButton(title: "Allow", target: nil, action: nil)
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        button.contentTintColor = .white
        button.bezelColor = .controlAccentColor
        let buttonTitleAttributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold)
        ]
        button.attributedTitle = NSAttributedString(string: "Allow", attributes: buttonTitleAttributes)
        button.attributedAlternateTitle = NSAttributedString(string: "Allow", attributes: buttonTitleAttributes)
        let target = ButtonTarget(action)
        button.target = target
        button.action = #selector(ButtonTarget.run)
        objc_setAssociatedObject(button, "agentmux-native-action", target, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        button.translatesAutoresizingMaskIntoConstraints = false

        row.addSubview(iconView)
        row.addSubview(textStack)
        row.addSubview(button)
        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(equalToConstant: 62),
            iconView.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            iconView.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 34),
            iconView.heightAnchor.constraint(equalToConstant: 34),
            textStack.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 10),
            textStack.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 52),
            button.heightAnchor.constraint(equalToConstant: 30),
            button.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -12),
            button.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            textStack.trailingAnchor.constraint(lessThanOrEqualTo: button.leadingAnchor, constant: -12)
        ])
        return row
    }

    private func doneButton() -> NSView {
        let button = NSButton(title: "Done", target: nil, action: nil)
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        button.contentTintColor = .white
        button.bezelColor = .controlAccentColor
        let buttonTitleAttributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold)
        ]
        button.attributedTitle = NSAttributedString(string: "Done", attributes: buttonTitleAttributes)
        button.attributedAlternateTitle = NSAttributedString(string: "Done", attributes: buttonTitleAttributes)
        let target = ButtonTarget(close)
        button.target = target
        button.action = #selector(ButtonTarget.run)
        objc_setAssociatedObject(button, "agentmux-native-action", target, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 82).isActive = true
        button.heightAnchor.constraint(equalToConstant: 32).isActive = true
        return button
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.lineBreakMode = .byWordWrapping
        label.textColor = PermissionPalette.primaryText
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }
}

private final class PermissionDragAssistantController: NSWindowController {
    private struct SettingsWindowState {
        let frame: NSRect
        let isVisible: Bool
    }

    private let fallbackVisibleFrame: NSRect?
    private let onRefreshPermissions: () -> Void
    private let onClose: () -> Void
    private var hasSeenSettingsWindow = false
    private var followTimer: Timer?
    private var isDismissed = false
    private var scheduledShowWorkItems: [DispatchWorkItem] = []

    convenience init(
        permission: PermissionKind,
        fallbackVisibleFrame: NSRect?,
        onRefreshPermissions: @escaping () -> Void,
        onClose: @escaping () -> Void
    ) {
        let window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 92),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.title = "Drag AgentMux Native"
        window.backgroundColor = .clear
        window.isOpaque = false
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        // Why: the assistant belongs to System Settings' position; user drags
        // should either start the app-file drag or do nothing, not move the panel.
        window.isMovable = false
        window.isMovableByWindowBackground = false
        window.hasShadow = true
        self.init(
            window: window,
            fallbackVisibleFrame: fallbackVisibleFrame,
            onRefreshPermissions: onRefreshPermissions,
            onClose: onClose
        )
        window.contentView = PermissionDragAssistantView(permission: permission, appURL: Bundle.main.bundleURL) { [weak self] in
            self?.dismissFromCloseButton()
        }
    }

    init(
        window: NSWindow?,
        fallbackVisibleFrame: NSRect?,
        onRefreshPermissions: @escaping () -> Void,
        onClose: @escaping () -> Void
    ) {
        self.fallbackVisibleFrame = fallbackVisibleFrame
        self.onRefreshPermissions = onRefreshPermissions
        self.onClose = onClose
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showWhenReady() {
        guard !isDismissed else { return }
        startFollowingSettingsWindow()
        schedulePositionAndShow()
    }

    override func close() {
        isDismissed = true
        scheduledShowWorkItems.forEach { $0.cancel() }
        scheduledShowWorkItems.removeAll()
        followTimer?.invalidate()
        followTimer = nil
        super.close()
    }

    private func dismissFromCloseButton() {
        // Why: closing the NSWindow directly skips this controller's timer cleanup,
        // letting the assistant reappear while System Settings remains visible.
        complete()
    }

    func complete() {
        close()
        onClose()
    }

    private func schedulePositionAndShow() {
        scheduledShowWorkItems.forEach { $0.cancel() }
        scheduledShowWorkItems.removeAll()
        let delays = [0.12, 0.25, 0.4, 0.65, 0.95, 1.35, 1.8, 2.5]
        for (index, delay) in delays.enumerated() {
            let workItem = DispatchWorkItem { [weak self] in
                guard let self, !self.isDismissed, self.window?.isVisible != true else { return }
                if let settingsWindow = self.systemSettingsWindowState(), settingsWindow.isVisible {
                    self.positionNearSettingsWindow(settingsWindow.frame)
                    guard !self.isDismissed else { return }
                    self.showWindow(nil)
                    self.window?.orderFrontRegardless()
                } else if index == delays.count - 1 && self.systemSettingsIsFrontmost() {
                    self.positionFallback()
                    guard !self.isDismissed else { return }
                    self.showWindow(nil)
                    self.window?.orderFrontRegardless()
                }
            }
            scheduledShowWorkItems.append(workItem)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
        }
    }

    private func startFollowingSettingsWindow() {
        followTimer?.invalidate()
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.isDismissed else { return }
                self.syncVisibilityWithSettingsWindow()
            }
        }
    }

    private func syncVisibilityWithSettingsWindow() {
        guard !isDismissed else {
            followTimer?.invalidate()
            followTimer = nil
            return
        }
        guard let window else {
            followTimer?.invalidate()
            followTimer = nil
            return
        }
        let settingsWindow = systemSettingsWindowState()
        if settingsWindow != nil {
            hasSeenSettingsWindow = true
        } else if hasSeenSettingsWindow {
            NSApp.terminate(nil)
            return
        }
        // Why: System Settings can stay visible on one display while the user
        // works on another; follow actual occlusion instead of app focus.
        if let settingsWindow, settingsWindow.isVisible {
            onRefreshPermissions()
            guard !isDismissed else { return }
            positionNearSettingsWindow(settingsWindow.frame)
            guard !isDismissed else { return }
            if !window.isVisible {
                showWindow(nil)
            }
            guard !isDismissed else { return }
            window.orderFrontRegardless()
        } else if window.isVisible {
            window.orderOut(nil)
        }
    }

    private func systemSettingsIsFrontmost() -> Bool {
        let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        return bundleId == "com.apple.systempreferences" || bundleId == "com.apple.SystemSettings"
    }

    private func positionNearSettingsWindow(_ settingsFrame: NSRect) {
        guard let window else { return }
        let visibleFrame = visibleFrameContaining(settingsFrame)
        let x = settingsFrame.maxX - window.frame.width - 18
        let y = settingsFrame.minY + 18
        window.setFrameOrigin(clampedOrigin(x: x, y: y, window: window, visibleFrame: visibleFrame))
    }

    private func positionFallback() {
        guard let window else { return }
        let visibleFrame = fallbackVisibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 900, height: 700)
        let origin = NSPoint(
            x: visibleFrame.midX - window.frame.width / 2,
            y: visibleFrame.minY + 24
        )
        window.setFrameOrigin(clampedOrigin(x: origin.x, y: origin.y, window: window, visibleFrame: visibleFrame))
    }

    private func clampedOrigin(x: CGFloat, y: CGFloat, window: NSWindow, visibleFrame: NSRect) -> NSPoint {
        let inset: CGFloat = 10
        let minX = visibleFrame.minX + inset
        let maxX = visibleFrame.maxX - window.frame.width - inset
        let minY = visibleFrame.minY + inset
        let maxY = visibleFrame.maxY - window.frame.height - inset
        return NSPoint(
            x: min(max(x, minX), maxX),
            y: min(max(y, minY), maxY)
        )
    }

    private func systemSettingsWindowState() -> SettingsWindowState? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        var occludingFrames: [NSRect] = []
        for windowInfo in windows {
            guard let frame = cgWindowFrame(windowInfo), isNormalWindow(windowInfo), frame.width > 0, frame.height > 0 else {
                continue
            }
            if isSystemSettingsWindow(windowInfo), frame.width > 520, frame.height > 360 {
                return SettingsWindowState(
                    frame: appKitFrameForCGWindowFrame(frame),
                    isVisible: !isWindowFullyCovered(frame, by: occludingFrames)
                )
            }
            occludingFrames.append(frame)
        }
        return nil
    }

    private func isSystemSettingsWindow(_ windowInfo: [String: Any]) -> Bool {
        guard let ownerName = windowInfo[kCGWindowOwnerName as String] as? String else {
            return false
        }
        return ownerName == "System Settings" || ownerName == "System Preferences"
    }

    private func isNormalWindow(_ windowInfo: [String: Any]) -> Bool {
        guard (windowInfo[kCGWindowLayer as String] as? Int) == 0 else {
            return false
        }
        if let alpha = windowInfo[kCGWindowAlpha as String] as? CGFloat, alpha <= 0 {
            return false
        }
        return true
    }

    private func cgWindowFrame(_ windowInfo: [String: Any]) -> NSRect? {
        guard
            let bounds = windowInfo[kCGWindowBounds as String] as? [String: CGFloat],
            let x = bounds["X"],
            let y = bounds["Y"],
            let width = bounds["Width"],
            let height = bounds["Height"]
        else {
            return nil
        }
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func isWindowFullyCovered(_ frame: NSRect, by occludingFrames: [NSRect]) -> Bool {
        var uncoveredFrames = [frame]
        for occludingFrame in occludingFrames {
            uncoveredFrames = uncoveredFrames.flatMap { subtract(occludingFrame, from: $0) }
            if uncoveredFrames.isEmpty {
                return true
            }
        }
        return false
    }

    private func subtract(_ coveringFrame: NSRect, from frame: NSRect) -> [NSRect] {
        let overlap = frame.intersection(coveringFrame)
        guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else {
            return [frame]
        }

        var remaining: [NSRect] = []
        if overlap.minY > frame.minY {
            remaining.append(NSRect(x: frame.minX, y: frame.minY, width: frame.width, height: overlap.minY - frame.minY))
        }
        if overlap.maxY < frame.maxY {
            remaining.append(NSRect(x: frame.minX, y: overlap.maxY, width: frame.width, height: frame.maxY - overlap.maxY))
        }
        if overlap.minX > frame.minX {
            remaining.append(NSRect(x: frame.minX, y: overlap.minY, width: overlap.minX - frame.minX, height: overlap.height))
        }
        if overlap.maxX < frame.maxX {
            remaining.append(NSRect(x: overlap.maxX, y: overlap.minY, width: frame.maxX - overlap.maxX, height: overlap.height))
        }
        return remaining.filter { $0.width > 0 && $0.height > 0 }
    }

    private func appKitFrameForCGWindowFrame(_ cgFrame: NSRect) -> NSRect {
        guard let screen = screenContainingCGFrame(cgFrame),
              let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else {
            return cgFrame
        }

        let displayBounds = CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value))
        return NSRect(
            x: cgFrame.minX,
            y: screen.frame.maxY - (cgFrame.minY - displayBounds.minY) - cgFrame.height,
            width: cgFrame.width,
            height: cgFrame.height
        )
    }

    private func screenContainingCGFrame(_ frame: NSRect) -> NSScreen? {
        NSScreen.screens.max { lhs, rhs in
            cgDisplayBounds(for: lhs).intersection(frame).width * cgDisplayBounds(for: lhs).intersection(frame).height <
                cgDisplayBounds(for: rhs).intersection(frame).width * cgDisplayBounds(for: rhs).intersection(frame).height
        }
    }

    private func cgDisplayBounds(for screen: NSScreen) -> NSRect {
        guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            return screen.frame
        }
        return CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value))
    }

    private func visibleFrameContaining(_ frame: NSRect) -> NSRect {
        let screen = NSScreen.screens.max { lhs, rhs in
            lhs.frame.intersection(frame).width * lhs.frame.intersection(frame).height <
                rhs.frame.intersection(frame).width * rhs.frame.intersection(frame).height
        }
        return screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 900, height: 700)
    }
}

private final class PermissionDragAssistantView: NSView {
    private let permission: PermissionKind
    private let appURL: URL
    private let close: () -> Void

    init(permission: PermissionKind, appURL: URL, close: @escaping () -> Void) {
        self.permission = permission
        self.appURL = appURL
        self.close = close
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = PermissionPalette.background.cgColor
        layer?.cornerRadius = 14
        layer?.borderWidth = 1
        layer?.borderColor = PermissionPalette.border.cgColor
        layer?.masksToBounds = true
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        let closeButton = NSButton(title: "", target: nil, action: nil)
        closeButton.bezelStyle = .shadowlessSquare
        closeButton.isBordered = false
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")
        closeButton.imagePosition = .imageOnly
        closeButton.contentTintColor = PermissionPalette.secondaryText
        closeButton.controlSize = .small
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        let target = ButtonTarget(close)
        closeButton.target = target
        closeButton.action = #selector(ButtonTarget.run)
        objc_setAssociatedObject(closeButton, "agentmux-native-action", target, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        let instruction = label(permission.dragInstruction, size: 12, weight: .semibold)
        instruction.textColor = PermissionPalette.primaryText
        instruction.maximumNumberOfLines = 2

        let dragTile = DraggableAppTile(appURL: appURL)
        dragTile.translatesAutoresizingMaskIntoConstraints = false

        addSubview(closeButton)
        addSubview(instruction)
        addSubview(dragTile)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            closeButton.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            closeButton.widthAnchor.constraint(equalToConstant: 18),
            closeButton.heightAnchor.constraint(equalToConstant: 18),
            instruction.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 36),
            instruction.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            instruction.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            dragTile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            dragTile.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            dragTile.topAnchor.constraint(equalTo: instruction.bottomAnchor, constant: 8),
            dragTile.heightAnchor.constraint(equalToConstant: 42)
        ])
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.lineBreakMode = .byWordWrapping
        label.textColor = PermissionPalette.primaryText
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }
}

private final class DraggableAppTile: NSView, NSDraggingSource {
    private let appURL: URL

    override var mouseDownCanMoveWindow: Bool { false }

    init(appURL: URL) {
        self.appURL = appURL
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        layer?.borderColor = PermissionPalette.border.cgColor
        layer?.backgroundColor = PermissionPalette.card.cgColor
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDragged(with event: NSEvent) {
        let item = NSPasteboardItem()
        item.setString(appURL.absoluteString, forType: .fileURL)
        item.setString(appURL.path, forType: .string)

        let draggingItem = NSDraggingItem(pasteboardWriter: item)
        let iconSize: CGFloat = 64
        let location = convert(event.locationInWindow, from: nil)
        let dragFrame = NSRect(
            x: location.x - iconSize / 2,
            y: location.y - iconSize / 2,
            width: iconSize,
            height: iconSize
        )
        draggingItem.setDraggingFrame(dragFrame, contents: appIcon(size: iconSize))
        beginDraggingSession(with: [draggingItem], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }

    private func build() {
        let icon = NSImageView(image: appIcon(size: 34))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "AgentMux Native")
        title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        title.textColor = PermissionPalette.primaryText
        title.translatesAutoresizingMaskIntoConstraints = false

        addSubview(icon)
        addSubview(title)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 34),
            icon.heightAnchor.constraint(equalToConstant: 34),
            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 14),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20)
        ])
    }

    private func appIcon(size: CGFloat) -> NSImage {
        let icon = NSWorkspace.shared.icon(forFile: appURL.path)
        icon.size = NSSize(width: size, height: size)
        return icon
    }
}

private enum PermissionPalette {
    static let background = adaptiveColor(
        light: NSColor(calibratedWhite: 0.94, alpha: 0.98),
        dark: NSColor(calibratedWhite: 0.20, alpha: 0.98)
    )
    static let card = adaptiveColor(
        light: NSColor(calibratedWhite: 0.99, alpha: 0.98),
        dark: NSColor(calibratedWhite: 0.25, alpha: 0.98)
    )
    static let border = adaptiveColor(
        light: NSColor(calibratedWhite: 0.0, alpha: 0.14),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.22)
    )
    static let primaryText = NSColor.labelColor
    static let secondaryText = NSColor.secondaryLabelColor

    private static func adaptiveColor(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            let bestMatch = appearance.bestMatch(from: [
                .aqua,
                .darkAqua,
                .accessibilityHighContrastAqua,
                .accessibilityHighContrastDarkAqua
            ])
            return bestMatch == .darkAqua || bestMatch == .accessibilityHighContrastDarkAqua ? dark : light
        }
    }
}

private final class ButtonTarget: NSObject {
    private let actionBlock: () -> Void

    init(_ actionBlock: @escaping () -> Void) {
        self.actionBlock = actionBlock
    }

    @objc func run() {
        actionBlock()
    }
}

private final class SocketListener: @unchecked Sendable {
    private let socketPath: String
    private let token: String?
    private let parentPID: pid_t
    private var boundSocketIdentity: (dev_t, ino_t)?
    private let onSessionClaimed: () -> Void
    private let onSessionClosed: () -> Void
    private let provider = Provider()
    private let providerLock = NSLock()
    private let sessionLock = NSLock()
    private var sessionOwnership = NativeConnectionOwnership()
    private var lastConnectionID: UInt64 = 0
    private var socketFd: Int32 = -1
    private var isStopped = false

    init(
        socketPath: String,
        token: String?,
        parentPID: pid_t,
        onSessionClaimed: @escaping () -> Void,
        onSessionClosed: @escaping () -> Void
    ) throws {
        self.socketPath = socketPath
        self.token = token
        self.parentPID = parentPID
        self.onSessionClaimed = onSessionClaimed
        self.onSessionClosed = onSessionClosed
        do { try bindSocket() } catch { stop(); throw error }
    }

    func start() {
        Thread.detachNewThread { [weak self] in
            self?.acceptLoop()
        }
    }

    func stop() {
        isStopped = true
        if socketFd >= 0 {
            _ = shutdown(socketFd, SHUT_RDWR)
            close(socketFd)
            socketFd = -1
        }
        var info = stat()
        if let identity = boundSocketIdentity, lstat(socketPath, &info) == 0,
           info.st_dev == identity.0, info.st_ino == identity.1, info.st_uid == getuid(),
           info.st_mode & S_IFMT == S_IFSOCK {
            _ = unlink(socketPath)
            // Only our exact socket is removed. rmdir succeeds only if its directory is empty.
            _ = rmdir((socketPath as NSString).deletingLastPathComponent)
        }
    }

    private func bindSocket() throws {
        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            throw ProviderError.coded("accessibility_error", "failed to create computer-use socket")
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < maxPathLength else {
            throw ProviderError.coded("invalid_argument", "computer-use socket path is too long")
        }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            socketPath.withCString { source in
                strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self), source, maxPathLength)
            }
        }

        let result = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(socketFd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let bindErrno = errno
            let message = String(cString: strerror(bindErrno))
            close(socketFd)
            socketFd = -1
            if UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: bindErrno,
                existingMode: existingPathMode(socketPath)
            ) {
                throw ProviderError.coded("invalid_argument", "refusing to replace non-socket file at computer-use socket path")
            }
            throw ProviderError.coded("accessibility_error", "failed to bind computer-use socket: \(message)")
        }
        var boundInfo = stat()
        if lstat(socketPath, &boundInfo) == 0 { boundSocketIdentity = (boundInfo.st_dev, boundInfo.st_ino) }
        guard chmod(socketPath, 0o600) == 0 else {
            throw ProviderError.coded("permission_denied", "could not secure the native socket")
        }

        guard listen(socketFd, 8) == 0 else {
            let message = String(cString: strerror(errno))
            close(socketFd)
            socketFd = -1
            throw ProviderError.coded("accessibility_error", "failed to listen on computer-use socket: \(message)")
        }
    }

    private func acceptLoop() {
        while !isStopped {
            let fd = accept(socketFd, nil, nil)
            if fd < 0 {
                if !isStopped {
                    fputs("computer-use socket accept failed: \(String(cString: strerror(errno)))\n", stderr)
                }
                continue
            }
            var noSignal: Int32 = 1
            guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                close(fd)
                continue
            }
            guard let connectionID = allocateConnectionID() else {
                fputs("computer-use socket exhausted connection identities\n", stderr)
                close(fd)
                continue
            }
            Thread.detachNewThread { [weak self] in
                self?.handleConnection(fd, connectionID: connectionID)
            }
        }
    }

    private func allocateConnectionID() -> NativeConnectionID? {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        guard lastConnectionID < UInt64.max else { return nil }
        lastConnectionID += 1
        return NativeConnectionID(rawValue: lastConnectionID)
    }

    private func handleConnection(_ fd: Int32, connectionID: NativeConnectionID) {
        var registeredSession = false
        let connection = NativeSocketConnection(fd: fd)
        defer {
            connection.close()
            if registeredSession { disconnectSession(connectionID) }
        }
        var peerUID = uid_t.max
        var peerGID = gid_t.max
        let uidKnown = getpeereid(fd, &peerUID, &peerGID) == 0
        let peerPID = peerProcessId(fd)
        let authorizedPeer = NativePeerPolicy.isAuthorized(
            expectedPID: parentPID, actualPID: peerPID,
            expectedUID: getuid(), actualUID: uidKnown ? peerUID : nil
        ) && NativePeerAuthorizer.authorizes(auditToken: peerAuditToken(fd))
        let decoder = JSONDecoder()
        let reader = NativeNDJSONReader(descriptor: fd)
        NativeConnectionRequestLoop.run(readLine: { reader.readLine() }) { line in
            guard let data = line.data(using: .utf8), let request = try? decoder.decode(Request.self, from: data) else { return true }
            if !registeredSession && isAuthenticatedNativeConnection(expectedToken: token, requestToken: request.token, authorizedPeer: authorizedPeer) {
                sessionLock.lock()
                let registration = sessionOwnership.registerConnection(connectionID, authenticated: true)
                sessionLock.unlock()
                guard registration != .rejected else { return false }
                registeredSession = true
                if registration == .claimed { onSessionClaimed() }
            }
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                let response = handleRequest(provider: provider, lock: providerLock, request: request,
                                             expectedToken: token, authorizedPeer: authorizedPeer,
                                             isConnected: { connection.isOpen })
                connection.write(response)
            }
            return true
        }
        if let failure = reader.failure { fputs("\(failure)\n", stderr) }
    }

    private func disconnectSession(_ connectionID: NativeConnectionID) {
        sessionLock.lock()
        let shouldTerminate = sessionOwnership.disconnect(connectionID)
        sessionLock.unlock()
        if shouldTerminate {
            onSessionClosed()
        }
    }
}

private final class NativeSocketConnection: @unchecked Sendable {
    private let lock = NSLock()
    private let fd: Int32
    private var open = true
    init(fd: Int32) { self.fd = fd }
    var isOpen: Bool { lock.lock(); defer { lock.unlock() }; return open }
    func write(_ response: Any) {
        lock.lock(); defer { lock.unlock() }
        guard open else { return }
        writeJSON(response, to: fd)
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        guard open else { return }
        open = false
        _ = shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }
}

private func existingPathMode(_ path: String) -> mode_t? {
    var statInfo = stat()
    guard lstat(path, &statInfo) == 0 else {
        return nil
    }
    return statInfo.st_mode
}

private func peerProcessId(_ fd: Int32) -> pid_t? {
    var pid = pid_t(0)
    var length = socklen_t(MemoryLayout<pid_t>.size)
    let result = withUnsafeMutablePointer(to: &pid) { pointer in
        getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pointer, &length)
    }
    return result == 0 && pid > 0 ? pid : nil
}

private func peerAuditToken(_ fd: Int32) -> Data? {
    var token = audit_token_t()
    var length = socklen_t(MemoryLayout<audit_token_t>.size)
    let status = withUnsafeMutablePointer(to: &token) { pointer in
        getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, pointer, &length)
    }
    guard status == 0, length == MemoryLayout<audit_token_t>.size else { return nil }
    return withUnsafeBytes(of: token) { Data($0) }
}


@MainActor
private func runNative(socketPath: String, token: String?, parentPID: pid_t) {
    let app = NSApplication.shared
    let delegate = NativeRuntime(socketPath: socketPath, token: token, parentPID: parentPID)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    // Why: SCK is reliable once this code runs as a signed app with a real TCC identity.
    app.run()
}

@MainActor
private func runPermissionCheck(initialPermission: PermissionKind? = nil) {
    let app = NSApplication.shared
    let delegate = PermissionRuntime(initialPermission: initialPermission)
    app.delegate = delegate
    // Why: setup must foreground reliably; the long-running agent path stays accessory-only.
    app.setActivationPolicy(.regular)
    app.run()
}

private func printPermissionStatus() {
    let snapshot = permissionStatusSnapshotSettled()
    let accessibility = snapshot.accessibilityGranted ? "granted" : "not-granted"
    let screenshots = snapshot.screenshotsGranted ? "granted" : "not-granted"
    print(#"{"accessibility":"\#(accessibility)","screenshots":"\#(screenshots)"}"#)
}


private func runStdio() {
    fputs("AgentMux Native provider must be launched by its owner in native mode.\n", stderr)
    exit(13)
}

struct NativeOperationReceipt {
    let fingerprint: String
    let outcome: String
}

private func operationFingerprint(_ request: Request) -> String {
    func value(_ json: JSONValue) -> Any {
        switch json {
        case let .string(v): return v
        case let .number(v): return v
        case let .bool(v): return v
        case let .object(v): return v.mapValues(value)
        case let .array(v): return v.map(value)
        case .null: return NSNull()
        }
    }
    let object: [String: Any] = ["method": request.method, "params": (request.params ?? [:]).mapValues(value)]
    // JSONValue contains only JSON values; sorted encoding avoids ordering-dependent operation identity.
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func nativeErrorPayload(_ error: Error) -> [String: String] {
    if let error = error as? ProviderError { return ["code": error.code, "message": error.message] }
    return ["code": "native_error", "message": String(describing: error)]
}

private func handleRequest(
    provider: Provider, lock: NSLock, request: Request,
    expectedToken: String?, authorizedPeer: Bool, isConnected: () -> Bool
) -> Any {
    var envelope: [String: Any] = ["id": request.id, "instanceId": provider.instanceId]
    if let operationID = request.operationId { envelope["operationId"] = operationID }
    func failed(_ code: String, _ message: String) -> [String: Any] {
        var response = envelope
        response["ok"] = false
        response["error"] = ["code": code, "message": message]
        return response
    }
    guard isAuthenticatedNativeConnection(expectedToken: expectedToken, requestToken: request.token, authorizedPeer: authorizedPeer) else {
        return failed("permission_denied", "native connection token or exact owner process does not match")
    }
    if let expected = request.expectedInstanceId, expected != provider.instanceId {
        return failed("instance_mismatch", "the original native process is unavailable")
    }
    let mutation = NativeOperationPolicy.isMutation(request.method, includesScreenshot: request.params?["noScreenshot"]?.bool == false)
    if mutation {
        guard request.expectedInstanceId == provider.instanceId else {
            return failed("instance_mismatch", "native process changed; the original operation was not replayed")
        }
        guard let operation = request.operationId, !operation.isEmpty else {
            return failed("invalid_argument", "native mutation requires its original operationId")
        }
    }
    let independent = ["handshake", "listApps", "listDisplays", "permissionStatus", "clipboardRead", "clipboardWrite", "captureScreenshot"].contains(request.method)
    if !independent { lock.lock() }
    defer { if !independent { lock.unlock() } }
    guard isConnected() else { return failed("connection_closed", "original native connection closed before this operation began") }
    if mutation, let operationID = request.operationId {
        provider.operationLock.lock()
        if let prior = provider.completedOperations[operationID] {
            provider.operationLock.unlock()
            guard prior.fingerprint == operationFingerprint(request) else {
                return failed("operation_conflict", "original operationId cannot identify different input")
            }
            return failed("duplicate_operation", "operation already received (\(prior.outcome)); inspect the original host receipt without replay")
        }
        provider.completedOperations[operationID] = NativeOperationReceipt(fingerprint: operationFingerprint(request), outcome: "pending")
        provider.operationLock.unlock()
    }

    var response = envelope
    do {
        let result = try provider.handle(method: request.method, params: request.params ?? [:])
        response["ok"] = true
        response["result"] = result
    } catch {
        response["ok"] = false
        response["error"] = nativeErrorPayload(error)
    }
    if mutation, let operationID = request.operationId {
        provider.operationLock.lock()
        provider.completedOperations[operationID] = NativeOperationReceipt(fingerprint: operationFingerprint(request), outcome: response["ok"] as? Bool == true ? "completed" : "failed")
        provider.operationLock.unlock()
    }
    return response
}


private func writeJSON(_ object: Any, to fd: Int32?) {
    func failure(_ code: String, _ message: String) -> Data? {
        guard let original = object as? [String: Any], let id = original["id"], let instanceID = original["instanceId"] else { return nil }
        var envelope: [String: Any] = ["id": id, "instanceId": instanceID, "ok": false, "error": ["code": code, "message": message]]
        if let operationID = original["operationId"] { envelope["operationId"] = operationID }
        return try? JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes])
    }
    var data: Data?
    if JSONSerialization.isValidJSONObject(object) {
        data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    }
    if data == nil {
        data = failure("response_encoding_failed", "native operation receipt could not be encoded; the original operation must not be replayed")
    } else if data!.count > NativeNDJSONReader.maxFrameBytes {
        data = failure("response_too_large", "native operation result exceeds the single response frame limit; inspect the original operation without replay")
    }
    guard let data else { fputs("native response encoding failed before a correlated envelope was available\\n", stderr); return }
    if let fd {
        if writeAll(data, to: fd) { _ = writeAll(Data([10]), to: fd) }
    } else if let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}

private func writeAll(_ data: Data, to fd: Int32) -> Bool {
    data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else {
            return true
        }
        var offset = 0
        while offset < rawBuffer.count {
            let written = write(fd, baseAddress.advanced(by: offset), rawBuffer.count - offset)
            if written < 0 {
                if errno == EINTR {
                    continue
                }
                return false
            }
            if written == 0 {
                return false
            }
            offset += written
        }
        return true
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--agent" {
    guard arguments.count >= 2 else {
        fputs("usage: agentmux-native-macos --agent <socket-path> --token-file <token-path>\n", stderr)
        exit(2)
    }
    let tokenFileIndex = arguments.firstIndex(of: "--token-file")
    let token = tokenFileIndex.flatMap { index -> String? in
        let valueIndex = index + 1
        guard valueIndex < arguments.count else { return nil }
        let tokenPath = arguments[valueIndex]
        return try? String(contentsOfFile: tokenPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard let token, !token.isEmpty else {
        fputs("agentmux-native-macos --agent requires a non-empty --token-file\n", stderr)
        exit(2)
    }
    let parentIndex = arguments.firstIndex(of: "--parent-pid")
    let parentPID = parentIndex.flatMap { index in index + 1 < arguments.count ? pid_t(arguments[index + 1]) : nil } ?? getppid()
    guard parentPID > 1, kill(parentPID, 0) == 0 else {
        fputs("native owner process is not available\n", stderr)
        exit(2)
    }
    runNative(socketPath: arguments[1], token: token, parentPID: parentPID)
} else if arguments.first == "--permissions" {
    runPermissionCheck()
} else if arguments.first == "--permission" {
    runPermissionCheck(initialPermission: PermissionKind.parse(arguments.dropFirst().first))
} else if arguments.first == "--permission-status" {
    printPermissionStatus()

} else {
    runStdio()
}
