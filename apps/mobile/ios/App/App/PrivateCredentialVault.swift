import Foundation
import Security

struct PrivateDeviceCredential: Codable {
    let origin: String
    let hostId: String
    let deviceId: String
    let credential: String
}

enum PrivateTransportFailure: Error, Equatable {
    case unavailable, invalid, cancelled, secretStoreUnconfirmed, claimUnconfirmed, deviceUnapproved
}

/** No JS export. A missing/locked/corrupt item never deletes or replaces the original item. */
final class PrivateCredentialVault {
    private let service = "dev.bagakit.agentmux.mobile.device.v1"
    private func query(_ origin: String, _ hostId: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: origin + "\n" + hostId, kSecAttrSynchronizable as String: false]
    }
    func read(origin: String, hostId: String) throws -> PrivateDeviceCredential? {
        var q = query(origin, hostId)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 4096,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              Set(object.keys) == Set(["origin", "hostId", "deviceId", "credential"]),
              let value = try? JSONDecoder().decode(PrivateDeviceCredential.self, from: data),
              value.origin == origin, value.hostId == hostId, !value.deviceId.isEmpty,
              value.credential.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw PrivateTransportFailure.secretStoreUnconfirmed
        }
        return value
    }
    func save(_ value: PrivateDeviceCredential) throws {
        // Validate the existing item before an intentional new approval can replace it.
        // A locked or corrupt original item must remain untouched.
        _ = try read(origin: value.origin, hostId: value.hostId)
        let data = try JSONEncoder().encode(value)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let q = query(value.origin, value.hostId)
        let updated = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw PrivateTransportFailure.secretStoreUnconfirmed }
        var item = q
        for (key, value) in attributes { item[key] = value }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw PrivateTransportFailure.secretStoreUnconfirmed
        }
    }
}
