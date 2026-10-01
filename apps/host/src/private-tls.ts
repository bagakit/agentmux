import { createPrivateKey, X509Certificate } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { createSecureContext, type SecureContextOptions } from 'node:tls'
import { AgentMuxError } from '@agentmux/core'

const addresses = new BlockList()
for (const [address, prefix] of [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16]
] as const) addresses.addSubnet(address, prefix, 'ipv4')
addresses.addAddress('::1', 'ipv6')
addresses.addSubnet('fc00::', 7, 'ipv6')

export interface PrivateTlsConfiguration {
  readonly host: string
  readonly port: number
  readonly keyPath: string
  readonly certificatePath: string
}

export interface PrivateTlsIdentity {
  readonly host: string
  readonly port: number
  readonly origin: string
  readonly certificateFingerprint: string
  readonly expiresAt: number
  readonly tls: SecureContextOptions
}

function invalid(message: string): AgentMuxError {
  return new AgentMuxError(message, 'INVALID_CONTROL_REQUEST')
}

export function requirePrivateHostAddress(host: string): 4 | 6 {
  const family = isIP(host)
  if ((family !== 4 && family !== 6) || !addresses.check(host, family === 4 ? 'ipv4' : 'ipv6')) {
    throw invalid('Choose an explicit private IP address for this Host. Wildcard and public bindings are unavailable.')
  }
  return family
}

/** Supplies TLS to the existing public RPC transport; it owns no dispatcher or Runtime. */
export async function readPrivateTls(configuration: PrivateTlsConfiguration,
  now = Date.now()): Promise<PrivateTlsIdentity> {
  const { host, port, keyPath, certificatePath } = configuration
  const family = requirePrivateHostAddress(host)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('Choose a port between 1 and 65535.')
  if (!keyPath || !certificatePath) throw invalid('Private mobile access requires a TLS certificate and its private key.')
  const [keyInfo, key, cert] = await Promise.all([stat(keyPath), readFile(keyPath), readFile(certificatePath)])
  if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0) {
    throw invalid('The TLS private key must be a private regular file (mode 0600).')
  }
  const certificate = new X509Certificate(cert)
  if (certificate.ca || !certificate.checkIP(host)) throw invalid('The TLS leaf certificate must include this Host IP in its subject alternative names.')
  if (certificate.keyUsage && !certificate.keyUsage.includes('1.3.6.1.5.5.7.3.1')) {
    throw invalid('The TLS certificate must permit server authentication.')
  }
  const startsAt = Date.parse(certificate.validFrom), expiresAt = Date.parse(certificate.validTo)
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || now < startsAt || now >= expiresAt) {
    throw invalid('The TLS certificate is not currently valid. Renew it to restore mobile access.')
  }
  if (!certificate.checkPrivateKey(createPrivateKey(key))) throw invalid('The TLS certificate does not match its private key.')
  const tls: SecureContextOptions = { key, cert, minVersion: 'TLSv1.2' }
  createSecureContext(tls)
  return { host, port, origin: `https://${family === 6 ? `[${host}]` : host}:${port}`,
    certificateFingerprint: certificate.fingerprint256, expiresAt, tls }
}
