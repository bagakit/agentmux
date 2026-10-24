import CryptoKit
import Darwin
import Foundation
import Security

/// Production authority comes from the running peer's validated code, not an
/// app display name, caller-selected token or caller-supplied PID alone.
public enum NativePeerAuthorizer {
    private enum Mode: @unchecked Sendable {
        case signed(SecRequirement)
        case bareDebug
        case unavailable
    }
    private static let mode: Mode = resolveMode()

    public static func authorizes(auditToken: Data?) -> Bool {
        guard let auditToken, auditToken.count == MemoryLayout<audit_token_t>.size else { return false }
        var peer: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: auditToken as CFData] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &peer) == errSecSuccess, let peer else { return false }
        switch mode {
        case .unavailable: return false
        case .bareDebug: return true // Exact OS PID, UID and token are checked by the connection owner.
        case let .signed(requirement):
            return SecCodeCheckValidity(peer, [], requirement) == errSecSuccess
        }
    }

    private static func resolveMode() -> Mode {
        var ownCode: SecCode?
        guard SecCodeCopySelf([], &ownCode) == errSecSuccess, let ownCode else { return .unavailable }
        var ownStatic: SecStaticCode?
        guard SecCodeCopyStaticCode(ownCode, [], &ownStatic) == errSecSuccess, let ownStatic else { return .unavailable }
        var raw: CFDictionary?
        let status = SecCodeCopySigningInformation(ownStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &raw)
        #if DEBUG
        // SwiftPM's arm64 debug linker may ad-hoc sign a bare executable. This
        // build profile never relaxes a signed app's certificate requirement.
        let bare = Bundle.main.bundleURL.pathExtension.lowercased() != "app"
        if bare && status == errSecCSUnsigned { return .bareDebug }
        #endif
        guard status == errSecSuccess, let information = raw as? [String: Any] else { return .unavailable }
        let certificates = information[kSecCodeInfoCertificates as String] as? [SecCertificate] ?? []
        #if DEBUG
        let flags = (information[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value
        if bare, certificates.isEmpty, let flags, flags & SecCodeSignatureFlags.adhoc.rawValue != 0 { return .bareDebug }
        #endif
        guard let certificate = certificates.first,
              SecCodeCheckValidity(ownCode, [], nil) == errSecSuccess else { return .unavailable }
        let certificateHash = Insecure.SHA1.hash(data: SecCertificateCopyData(certificate) as Data)
            .map { String(format: "%02x", $0) }.joined()
        let source = "identifier \"dev.agentmux.desktop\" and certificate leaf = H\"\(certificateHash)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(source as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return .unavailable }
        return .signed(requirement)
    }
}
