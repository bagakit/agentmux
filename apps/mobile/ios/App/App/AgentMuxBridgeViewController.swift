import Capacitor

final class AgentMuxBridgeViewController: CAPBridgeViewController {
    private let privateTransport = AgentMuxPrivateTransportPlugin()
    private let workfaceFile = AgentMuxWorkfaceFilePlugin()
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(privateTransport)
        bridge?.registerPluginInstance(workfaceFile)
    }
    deinit { privateTransport.closeBridge(); workfaceFile.closeBridge() }
}
