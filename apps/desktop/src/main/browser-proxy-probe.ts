import { Socket } from 'node:net'
import type { BrowserProxyProbe, BrowserProxyProbeRoute } from '@agentmux/core/control'
import type { BrowserProfileProxyCredential } from './browser-profile-proxy-auth.js'

/** The budget covers a fixed TCP connect and the four response octets of RFC1928/1929. */
const PROTOCOL_WAIT_MS = 5_000
class ProtocolUnavailable extends Error {}

/** A small binary reader for the stable SOCKS wire protocol, never human page strings. */
function readSocket(socket: Socket) {
  let bytes = Buffer.alloc(0), failure: Error | undefined
  let pending: { size: number; accept(value: Buffer): void; reject(error: Error): void } | undefined
  const flush = () => {
    if (!pending) return
    if (failure) { const row = pending; pending = undefined; row.reject(failure) }
    else if (bytes.length >= pending.size) { const row = pending; pending = undefined; const result = bytes.subarray(0, row.size); bytes = bytes.subarray(row.size); row.accept(result) }
  }
  const fail = () => { failure ??= new ProtocolUnavailable(); flush() }
  socket.on('data', part => { bytes = Buffer.concat([bytes, part]); if (bytes.length > 4096) { fail(); socket.destroy() } else flush() })
  socket.on('error', fail); socket.on('end', fail); socket.on('close', fail)
  socket.setTimeout(PROTOCOL_WAIT_MS, () => { fail(); socket.destroy() })
  return { read(size: number): Promise<Buffer> { return new Promise((accept, reject) => { pending = { size, accept, reject }; flush() }) } }
}

/** TCP and SOCKS are direct diagnostic sockets to the exact configured proxy, not Browser traffic. */
export async function probeBrowserProxyProtocol(route: BrowserProxyProbeRoute, ports: {
  credentials<T>(use: (credential: BrowserProfileProxyCredential) => Promise<T>): Promise<T>
  current(): boolean
  observed(tcp: BrowserProxyProbe['tcp']): Promise<void>
}): Promise<Pick<BrowserProxyProbe, 'tcp' | 'authentication'>> {
  if (route.mode !== 'proxy') return { tcp: { status: 'not-applicable', reason: 'no-proxy', latencyMs: 0 }, authentication: { status: 'not-applicable', reason: 'no-proxy', latencyMs: 0 } }
  let tcp: BrowserProxyProbe['tcp'] = { status: 'unknown', reason: 'connection-unavailable', latencyMs: 0 }
  let authentication: BrowserProxyProbe['authentication'] = { status: 'unknown', reason: 'protocol-unavailable', latencyMs: 0 }
  const socket = new Socket(), reader = readSocket(socket), started = performance.now()
  try {
    await new Promise<void>((accept, reject) => {
      socket.once('connect', accept); socket.once('error', reject); socket.once('close', () => reject(new ProtocolUnavailable()))
      socket.connect(route.port, route.host.replace(/^\[|\]$/gu, ''))
    })
    tcp = { status: 'connected', latencyMs: performance.now() - started }; await ports.observed(tcp)
    if (route.scheme !== 'socks5') return { tcp, authentication: { status: 'not-applicable', reason: 'not-socks5', latencyMs: 0 } }
    const authenticationStarted = performance.now()
    try {
      if (!ports.current()) return { tcp, authentication: { status: 'unknown', reason: 'route-changed', latencyMs: 0 } }
      // RFC1928 method negotiation: NO AUTHENTICATION or USERNAME/PASSWORD.
      socket.write(Buffer.from([5, 2, 0, 2]))
      const method = await reader.read(2)
      if (method[0] !== 5) throw new ProtocolUnavailable()
      if (method[1] === 0) authentication = { status: 'not-required', latencyMs: performance.now() - authenticationStarted }
      else if (method[1] === 255) authentication = { status: 'rejected', reason: 'unsupported-authentication', latencyMs: performance.now() - authenticationStarted }
      else if (method[1] !== 2) throw new ProtocolUnavailable()
      else {
        authentication = await ports.credentials(async credential => {
          // The original credential owner rechecks endpoint + configuration token immediately
          // before this callback. Waiting for the server never authorizes a replacement route.
          if (!ports.current()) return { status: 'unknown', reason: 'route-changed', latencyMs: performance.now() - authenticationStarted }
          const username = Buffer.from(credential.username), password = Buffer.from(credential.password)
          if (!username.length || username.length > 255 || !password.length || password.length > 255) return { status: 'unknown', reason: 'credential-size', latencyMs: performance.now() - authenticationStarted }
          socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]))
          const result = await reader.read(2)
          if (result[0] !== 1) throw new ProtocolUnavailable()
          return result[1] === 0 ? { status: 'authenticated', latencyMs: performance.now() - authenticationStarted }
            : { status: 'rejected', reason: 'authentication-rejected', latencyMs: performance.now() - authenticationStarted }
        })
      }
    } catch (cause) {
      authentication = { status: 'unknown', reason: cause instanceof ProtocolUnavailable ? 'protocol-unavailable' : ports.current() ? 'credentials-unavailable' : 'route-changed', latencyMs: performance.now() - authenticationStarted }
    }
    return { tcp, authentication }
  } catch {
    tcp = tcp.status === 'connected' ? tcp : { status: 'unknown', reason: 'connection-unavailable', latencyMs: performance.now() - started }
    return { tcp, authentication }
  } finally { socket.destroy() }
}
