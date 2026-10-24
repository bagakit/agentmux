import AppKit
import Foundation

// An independent bare AppKit test process. The control channel only observes
// state or closes this process; every tested input must use production RPC.
private struct Command: Decodable, Sendable {
    let id: Int
    let method: String
}

@MainActor
private final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var text: NSTextField!
    private var button: NSButton!
    private var presses = 0
    private let previousApplication = NSWorkspace.shared.frontmostApplication

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 440, height: 200),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "AgentMux Native isolated verification"
        window.isReleasedWhenClosed = false
        text = NSTextField(string: "initial fixture value")
        text.frame = NSRect(x: 30, y: 115, width: 380, height: 28)
        button = NSButton(title: "Fixture counter", target: self, action: #selector(increment))
        button.frame = NSRect(x: 30, y: 45, width: 180, height: 32)
        window.contentView?.addSubview(text)
        window.contentView?.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [self] in
            emit(["kind": "ready", "pid": Int(ProcessInfo.processInfo.processIdentifier),
                  "windowId": window.windowNumber,
                  "textCenter": quartzCenter(text), "buttonCenter": quartzCenter(button)])
        }
        DispatchQueue.global().async { [self] in
            while let line = readLine() {
                guard line.utf8.count < 4096, let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data) else { continue }
                DispatchQueue.main.async { self.answer(command) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    @objc private func increment() { presses += 1 }

    private func quartzCenter(_ view: NSView) -> [String: Double] {
        let local = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        let global = window.convertPoint(toScreen: local)
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        return ["x": Double(global.x), "y": Double(primaryTop - global.y)]
    }

    private func answer(_ command: Command) {
        switch command.method {
        case "state":
            emit(["id": command.id, "text": text.currentEditor()?.string ?? text.stringValue, "presses": presses])
        case "close":
            emit(["id": command.id, "state": "closing"])
            NSApp.terminate(nil)
        default:
            emit(["id": command.id, "error": "unsupported_fixture_command"])
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        // Do not take focus back from a person who switched to another app.
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            previousApplication?.activate(options: [.activateIgnoringOtherApps])
        }
    }

    private func emit(_ value: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        data.append(10)
        FileHandle.standardOutput.write(data)
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
private let fixture = Fixture()
application.delegate = fixture
application.run()
