import AppKit
import CoreGraphics
import Foundation

// Read only the exact private window returned by Electron's native source ID.
let arguments = CommandLine.arguments
guard arguments.count == 3, let identifier = UInt32(arguments[1]), let process = Int(arguments[2]),
      let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, identifier) as? [[String: Any]],
      let window = windows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == identifier }),
      (window[kCGWindowOwnerPID as String] as? Int) == process else {
    fputs("The exact private native window identity was not confirmed\n", stderr)
    exit(1)
}
let session = CGSessionCopyCurrentDictionary() as? [String: Any]
let fact: [String: Any] = [
    "windowId": identifier, "pid": process,
    "onScreen": window[kCGWindowIsOnscreen as String] ?? false,
    "layer": window[kCGWindowLayer as String] ?? -1,
    "bounds": window[kCGWindowBounds as String] ?? [:],
    "screenLocked": session?["CGSSessionScreenIsLocked"] ?? "not-reported"
]
let data = try JSONSerialization.data(withJSONObject: fact, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
