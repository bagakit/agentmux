import Foundation
import Capacitor

@objc(AgentMuxPrivateTransportPlugin)
public final class AgentMuxPrivateTransportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgentMuxPrivateTransportPlugin"
    public let jsName = "AgentMuxPrivateTransport"
    public let pluginMethods: [CAPPluginMethod] = ["begin", "claim", "open", "read", "cancel"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private struct Pending {
        let origin: String; let hostId: String; let deviceId: String; let claim: String
        var approved: [String: Any]?; var credential: PrivateDeviceCredential?; var claimUnconfirmed = false
    }
    private let owner = DispatchQueue(label: "dev.bagakit.agentmux.mobile.private-transport")
    private let vault = PrivateCredentialVault()
    private var requests: [String: PrivateHttpBytes] = [:]
    private var admissions: [String: (Int, Data) -> Void] = [:]
    private var pending: [String: Pending] = [:]
    private var pairingBusy = Set<String>()
    private let devicePath = "/_agentmux/device"

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let store = (error as? PrivateTransportFailure) == .secretStoreUnconfirmed
        if (error as? PrivateTransportFailure) == .deviceUnapproved {
            call.reject("This device has no saved authorization for this Mac. Confirm a new local invitation; existing Sessions are retained.", "NATIVE_DEVICE_UNAPPROVED")
            return
        }
        if (error as? PrivateTransportFailure) == .claimUnconfirmed {
            call.reject("The one-time claim result is unknown and has not been resent. Use a new local invitation to confirm this device; existing Sessions are retained.", "NATIVE_CLAIM_UNCONFIRMED")
            return
        }
        call.reject(store ? "System credential storage is unconfirmed. Unlock this device and retry saving; the original identity is retained."
                    : "This private connection is unconfirmed. Check the Mac address, system certificate trust and device approval; existing Sessions are retained.",
                    store ? "NATIVE_SECRET_STORE_UNCONFIRMED" : "NATIVE_CONNECTION_UNCONFIRMED")
    }
    private func text(_ value: Any?, maximum: Int = 128) throws -> String {
        guard let value = value as? String, !value.isEmpty, value.utf16.count <= maximum,
              !value.contains("\n"), !value.contains("\r") else { throw PrivateTransportFailure.invalid }
        return value
    }
    private func bound(_ call: CAPPluginCall, publicInfo: Bool = false) throws -> (String, String, String) {
        let origin = try text(call.getString("origin"), maximum: 1024)
        guard let parts = URLComponents(string: origin), parts.scheme == "https", let host = parts.host,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty else { throw PrivateTransportFailure.invalid }
        let bracketed = host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host
        let canonical = "https://" + bracketed + ((parts.port == nil || parts.port == 443) ? "" : ":\(parts.port!)")
        guard canonical == origin else { throw PrivateTransportFailure.invalid }
        let id = try text(call.getString("requestId"), maximum: 160)
        guard requests[id] == nil, requests.count < 32 else { throw PrivateTransportFailure.unavailable }
        return (origin, try text(call.getString("hostId") ?? (publicInfo ? "public-info" : nil)), id)
    }
    private func validatedPath(_ url: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = components.percentEncodedPath.removingPercentEncoding, !path.contains("\\"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { throw PrivateTransportFailure.invalid }
        return path
    }
    private func request(origin: String, path: String, method: String, hostId: String?,
                         headers: [String: String] = [:], body: Data? = nil) throws -> URLRequest {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: origin + path),
              let base = URL(string: origin), url.scheme == "https", url.host == base.host, url.port == base.port,
              url.user == nil, url.password == nil, url.fragment == nil else { throw PrivateTransportFailure.invalid }
        _ = try validatedPath(url)
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body; request.httpShouldHandleCookies = false
        for (name, value) in headers {
            let name = name.lowercased()
            guard !["authorization", "proxy-authorization", "cookie", "origin", "host", "x-agentmux-transport"].contains(name),
                  !name.hasPrefix("sec-fetch-"), !value.contains("\r"), !value.contains("\n") else {
                throw PrivateTransportFailure.invalid
            }
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue("native", forHTTPHeaderField: "X-AgentMux-Transport")
        if let hostId = hostId {
            guard let credential = try vault.read(origin: origin, hostId: hostId) else { throw PrivateTransportFailure.deviceUnapproved }
            request.setValue("AgentMuxDevice " + hostId + "." + credential.credential, forHTTPHeaderField: "Authorization")
        }
        return request
    }
    private func completeAdmission(_ id: String, status: Int, data: Data) {
        guard let completed = admissions.removeValue(forKey: id) else { return }
        requests.removeValue(forKey: id)?.cancel()
        completed(status, data)
    }
    private func start(_ request: URLRequest, id: String, call: CAPPluginCall,
                       completed: ((Int, Data) -> Void)? = nil) {
        if let completed = completed { admissions[id] = completed }
        var buffer = Data()
        var status = 0
        let operation = PrivateHttpBytes(request: request, headers: { code, headers in
            self.owner.async {
                if completed != nil {
                    guard self.admissions[id] != nil else { return }
                    guard headers["content-type"]?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "application/json" else {
                        self.completeAdmission(id, status: 0, data: Data()); return
                    }
                    status = code
                    func next() {
                        guard let operation = self.requests[id] else {
                            self.completeAdmission(id, status: 0, data: Data()); return
                        }
                        operation.read { result in self.owner.async {
                            guard self.admissions[id] != nil else { return }
                            switch result {
                            case .success(let chunk):
                                if let chunk = chunk {
                                    guard buffer.count + chunk.count <= 4096 else {
                                        self.completeAdmission(id, status: 0, data: Data()); return
                                    }
                                    buffer.append(chunk); next()
                                } else { self.completeAdmission(id, status: status, data: buffer) }
                            case .failure: self.completeAdmission(id, status: 0, data: Data())
                            }
                        } }
                    }
                    next()
                } else { call.resolve(["status": code, "headers": headers]) }
            }
        }, failedOpen: { error in self.owner.async {
            self.requests.removeValue(forKey: id)?.cancel()
            if completed != nil { self.completeAdmission(id, status: 0, data: Data()) } else { self.reject(call, error) }
        } })
        requests[id] = operation; operation.start()
    }
    private func json(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw PrivateTransportFailure.invalid }
        return object
    }
    private func integer(_ value: Any?) throws -> Int64 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue >= 0, number.doubleValue <= 9007199254740991,
              number.doubleValue.rounded() == number.doubleValue else { throw PrivateTransportFailure.invalid }
        return number.int64Value
    }
    private func save(_ value: Pending, key: String, call: CAPPluginCall) {
        do {
            guard let credential = value.credential, let approved = value.approved else { throw PrivateTransportFailure.invalid }
            try vault.save(credential)
            pending.removeValue(forKey: key); call.resolve(approved)
        } catch { reject(call, PrivateTransportFailure.secretStoreUnconfirmed) }
    }
    @objc func begin(_ call: CAPPluginCall) {
        owner.async {
            do {
                let (origin, hostId, id) = try self.bound(call), key = origin + "\n" + hostId
                guard !self.pairingBusy.contains(key), self.pending[key]?.credential == nil else { throw PrivateTransportFailure.secretStoreUnconfirmed }
                let invitation = try self.text(call.getString("invitation")), name = try self.text(call.getString("name"))
                let body = try JSONSerialization.data(withJSONObject: ["hostId": hostId, "invitation": invitation, "name": name])
                let request = try self.request(origin: origin, path: self.devicePath, method: "POST", hostId: nil,
                                               headers: ["Content-Type": "application/json"], body: body)
                self.pairingBusy.insert(key)
                self.start(request, id: id, call: call) { status, data in
                    defer { self.pairingBusy.remove(key) }
                    do {
                        let state = try self.json(data)
                        guard status == 201, Set(state.keys) == Set(["state", "hostId", "deviceId", "confirmationCode", "expiresAt", "claim"]),
                              state["state"] as? String == "waiting", state["hostId"] as? String == hostId else { throw PrivateTransportFailure.invalid }
                        let deviceId = try self.text(state["deviceId"]), claim = try self.text(state["claim"])
                        let code = try self.text(state["confirmationCode"])
                        guard claim.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                              code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { throw PrivateTransportFailure.invalid }
                        let expires = try self.integer(state["expiresAt"])
                        self.pending[key] = Pending(origin: origin, hostId: hostId, deviceId: deviceId, claim: claim)
                        call.resolve(["state": "waiting", "hostId": hostId, "deviceId": deviceId, "confirmationCode": code, "expiresAt": expires])
                    } catch { self.reject(call, error) }
                }
            } catch { self.reject(call, error) }
        }
    }
    @objc func claim(_ call: CAPPluginCall) {
        owner.async {
            do {
                let (origin, hostId, id) = try self.bound(call), key = origin + "\n" + hostId
                guard !self.pairingBusy.contains(key), let pending = self.pending[key] else { throw PrivateTransportFailure.unavailable }
                if pending.credential != nil { self.save(pending, key: key, call: call); return }
                guard !pending.claimUnconfirmed else { throw PrivateTransportFailure.claimUnconfirmed }
                let body = try JSONSerialization.data(withJSONObject: ["hostId": hostId, "deviceId": pending.deviceId, "claim": pending.claim])
                let request = try self.request(origin: origin, path: self.devicePath + "/claim", method: "POST", hostId: nil,
                                               headers: ["Content-Type": "application/json"], body: body)
                self.pairingBusy.insert(key)
                var attempting = pending; attempting.claimUnconfirmed = true; self.pending[key] = attempting
                self.start(request, id: id, call: call) { status, data in
                    defer { self.pairingBusy.remove(key) }
                    do {
                        let state = try self.json(data)
                        guard state["hostId"] as? String == hostId else { throw PrivateTransportFailure.invalid }
                        if status == 202, Set(state.keys) == Set(["state", "hostId"]), state["state"] as? String == "waiting" {
                            self.pending[key]?.claimUnconfirmed = false
                            call.resolve(["state": "waiting", "hostId": hostId]); return
                        }
                        guard status == 200, Set(state.keys) == Set(["state", "hostId", "device", "credential"]),
                              state["state"] as? String == "approved", let device = state["device"] as? [String: Any],
                              Set(device.keys) == Set(["deviceId", "name", "createdAt"]), device["deviceId"] as? String == pending.deviceId else { throw PrivateTransportFailure.invalid }
                        let name = try self.text(device["name"]), createdAt = try self.integer(device["createdAt"])
                        let credential = try self.text(state["credential"])
                        guard credential.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw PrivateTransportFailure.invalid }
                        let publicState: [String: Any] = ["state": "approved", "hostId": hostId,
                            "device": ["deviceId": pending.deviceId, "name": name, "createdAt": createdAt]]
                        var approved = pending
                        approved.approved = publicState
                        approved.credential = PrivateDeviceCredential(origin: origin, hostId: hostId, deviceId: pending.deviceId, credential: credential)
                        self.pending[key] = approved
                        self.save(approved, key: key, call: call)
                    } catch {
                        let attempt = self.pending[key]
                        self.reject(call, attempt?.credential == nil && attempt?.claimUnconfirmed == true
                            ? PrivateTransportFailure.claimUnconfirmed : error)
                    }
                }
            } catch { self.reject(call, error) }
        }
    }
    @objc func open(_ call: CAPPluginCall) {
        owner.async {
            do {
                // Unauthenticated access is restricted to public Host identity GET.
                let hostId = call.getString("hostId")
                let (origin, _, id) = try self.bound(call, publicInfo: hostId == nil)
                let path = try self.text(call.getString("path"), maximum: 8192), method = try self.text(call.getString("method"))
                guard let url = URL(string: origin + path) else { throw PrivateTransportFailure.invalid }
                let target = try self.validatedPath(url)
                let devicePath = target == self.devicePath || target.hasPrefix(self.devicePath + "/")
                guard !devicePath || (method == "GET" && [self.devicePath, self.devicePath + "/status"].contains(target)),
                      hostId != nil || (method == "GET" && target == self.devicePath && url.query == nil) else { throw PrivateTransportFailure.invalid }
                let headers = call.getObject("headers") as? [String: String] ?? [:]
                let body = call.getString("body").flatMap { Data(base64Encoded: $0) }
                if call.getString("body") != nil && body == nil { throw PrivateTransportFailure.invalid }
                let request = try self.request(origin: origin, path: path, method: method, hostId: hostId, headers: headers, body: body)
                self.start(request, id: id, call: call)
            } catch { self.reject(call, error) }
        }
    }
    @objc func read(_ call: CAPPluginCall) {
        owner.async {
            guard let id = call.getString("requestId"), let request = self.requests[id] else { self.reject(call, PrivateTransportFailure.unavailable); return }
            request.read { result in self.owner.async {
                switch result {
                case .success(let data):
                    if let data = data { call.resolve(["done": false, "data": data.base64EncodedString()]) }
                    else { self.requests.removeValue(forKey: id); call.resolve(["done": true]) }
                case .failure(let error): self.requests.removeValue(forKey: id)?.cancel(); self.reject(call, error)
                }
            } }
        }
    }
    @objc func cancel(_ call: CAPPluginCall) {
        owner.async {
            if let id = call.getString("requestId") {
                self.requests.removeValue(forKey: id)?.cancel()
                self.completeAdmission(id, status: 0, data: Data())
            }
            call.resolve()
        }
    }
    func closeBridge() {
        owner.async {
            for request in self.requests.values { request.cancel() }
            self.requests.removeAll()
            for id in Array(self.admissions.keys) { self.completeAdmission(id, status: 0, data: Data()) }
            self.pending.removeAll(); self.pairingBusy.removeAll()
        }
    }
}
