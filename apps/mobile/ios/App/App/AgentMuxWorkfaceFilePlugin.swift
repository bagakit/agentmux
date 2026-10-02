import UIKit
import Capacitor

/** Explicit public-file export. This plugin has no reference to credential storage or transport. */
@objc(AgentMuxWorkfaceFilePlugin)
public final class AgentMuxWorkfaceFilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "AgentMuxWorkfaceFilePlugin"
    public let jsName = "AgentMuxWorkfaceFile"
    public let pluginMethods = [CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)]
    private var active: CAPPluginCall?
    private var directory: URL?

    @objc func save(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.active == nil else {
                call.reject("A workface file picker is already open. This second request was not saved.", "NATIVE_WORKFACE_NOT_SAVED")
                return
            }
            do {
                guard call.getString("filename") == "agentmux-workface.json",
                      let text = call.getString("bytes"), let bytes = text.data(using: .utf8), bytes.count <= 2 * 1024 * 1024,
                      let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      Set(value.keys) == Set(["schema", "workface"]), value["schema"] as? String == "agentmux.mobile-workface.v1",
                      value["workface"] is [String: Any], let view = self.bridge?.viewController,
                      view.presentedViewController == nil else { throw PrivateFileFailure.unsaved }
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("agentmux-workface-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700])
                self.directory = directory
                let file = directory.appendingPathComponent("agentmux-workface.json")
                try bytes.write(to: file, options: [.atomic, .completeFileProtection])
                self.active = call
                let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                picker.delegate = self
                view.present(picker, animated: true)
            } catch { self.finish(saved: false, call: call) }
        }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(saved: !urls.isEmpty, call: active)
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(saved: false, call: active)
    }
    func closeBridge() {
        DispatchQueue.main.async { self.finish(saved: false, call: self.active) }
    }
    private func finish(saved: Bool, call: CAPPluginCall?) {
        active = nil
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
        if saved { call?.resolve() }
        else { call?.reject("The workface file was not saved. Choose a file destination and retry; the original record is retained.", "NATIVE_WORKFACE_NOT_SAVED") }
    }
}
private enum PrivateFileFailure: Error { case unsaved }
