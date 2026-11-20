import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { BrowserProfileNetworkCheck } from './browser-profile-control.js'

/** A probe reports protocol observations, never grants a route or certifies Browser support. */
export type BrowserProxyProbeReason = 'not-started' | 'no-proxy' | 'not-socks5' | 'connection-unavailable' |
  'protocol-unavailable' | 'credentials-unavailable' | 'credential-size' | 'authentication-rejected' |
  'unsupported-authentication' | 'route-changed' | 'exit-unavailable' | 'check-address-missing'
export type BrowserProxyProbeRoute = { mode: 'system' | 'direct' } |
  { mode: 'proxy'; scheme: 'http' | 'https' | 'socks4' | 'socks5'; host: string; port: number }
export type BrowserProxyProbeObservation<Status extends string> = { status: Status; latencyMs: number; reason?: BrowserProxyProbeReason }
export const BROWSER_WEBRTC_IP_POLICIES = [
  'default', 'default_public_interface_only', 'default_public_and_private_interfaces', 'disable_non_proxied_udp'
] as const
export type BrowserWebRtcIpPolicy = (typeof BROWSER_WEBRTC_IP_POLICIES)[number]
const WEBRTC_OBSERVATION_REASONS = ['no-live-page', 'native-unavailable', 'mixed-policies', 'route-changed'] as const
export type BrowserWebRtcObservation = { observedPages: number } & (
  | { status: 'observed'; policy: BrowserWebRtcIpPolicy }
  | { status: 'unknown'; reason: (typeof WEBRTC_OBSERVATION_REASONS)[number] }
)
export type BrowserProxyProbe = {
  id: string; profileId: string; configurationRevision: string; route: BrowserProxyProbeRoute
  /** Only the HTTPS origin is public; the configured address's path/query stay private. */
  exitOrigin: string | null
  startedAt: number; finishedAt?: number; phase: 'pending' | 'observed'
  tcp: BrowserProxyProbeObservation<'connected' | 'unknown' | 'not-applicable'>
  authentication: BrowserProxyProbeObservation<'authenticated' | 'not-required' | 'rejected' | 'unknown' | 'not-applicable'>
  /** Only a request through the original Profile session can populate this observation. */
  exit: BrowserProfileNetworkCheck
  /** Native WebContents policy readback. Older diagnostics have no WebRTC observation. */
  webrtc?: BrowserWebRtcObservation
}
export type BrowserProxyProbeReceipt = { diagnostic: BrowserProxyProbe; historySaved: boolean }
export type BrowserProxyProbeHistory = { diagnostics: BrowserProxyProbe[]; nextCursor: string | null }
const REASONS: readonly BrowserProxyProbeReason[] = ['not-started', 'no-proxy', 'not-socks5', 'connection-unavailable',
  'protocol-unavailable', 'credentials-unavailable', 'credential-size', 'authentication-rejected',
  'unsupported-authentication', 'route-changed', 'exit-unavailable', 'check-address-missing']

export function parseBrowserProxyProbe(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProxyProbe {
  const invalid = (): never => { throw new AgentMuxError('Proxy diagnostic is not a valid non-secret protocol observation.', code) }
  const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, code)
  const text = (value: unknown, max = 128): string => {
    if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0020\u007f]/u.test(value)) return invalid()
    return value
  }
  const number = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid(); return value }
  const observation = <T extends string>(value: unknown, statuses: readonly T[]): BrowserProxyProbeObservation<T> => {
    const row = object(value, ['status', 'latencyMs', 'reason'])
    if (!statuses.includes(row.status as T) || row.reason !== undefined && !REASONS.includes(row.reason as BrowserProxyProbeReason)) return invalid()
    return { status: row.status as T, latencyMs: number(row.latencyMs), ...(row.reason === undefined ? {} : { reason: row.reason as BrowserProxyProbeReason }) }
  }
  const row = object(value, ['id', 'profileId', 'configurationRevision', 'route', 'exitOrigin', 'startedAt', 'finishedAt', 'phase', 'tcp', 'authentication', 'exit', 'webrtc'])
  const rawRoute = object(row.route, ['mode', 'scheme', 'host', 'port'])
  let route: BrowserProxyProbeRoute
  if (rawRoute.mode === 'proxy') {
    if (!['http', 'https', 'socks4', 'socks5'].includes(rawRoute.scheme as string) || !Number.isSafeInteger(rawRoute.port) || (rawRoute.port as number) < 1 || (rawRoute.port as number) > 65535) return invalid()
    const host = text(rawRoute.host, 253)
    if (/[\/@?#]/u.test(host)) return invalid()
    route = { mode: 'proxy', scheme: rawRoute.scheme as 'http' | 'https' | 'socks4' | 'socks5', host, port: rawRoute.port as number }
  } else {
    if (rawRoute.mode !== 'direct' && rawRoute.mode !== 'system' || rawRoute.scheme !== undefined || rawRoute.host !== undefined || rawRoute.port !== undefined) return invalid()
    route = { mode: rawRoute.mode }
  }
  const rawExit = object(row.exit, ['status', 'httpStatus', 'ip', 'reason', 'latencyMs'])
  let exit: BrowserProfileNetworkCheck
  if (rawExit.status === 'reachable' && Number.isSafeInteger(rawExit.httpStatus) && (rawExit.httpStatus as number) >= 100 && (rawExit.httpStatus as number) <= 599 && rawExit.reason === undefined) {
    const ip = rawExit.ip === undefined ? undefined : text(rawExit.ip, 45)
    if (ip !== undefined && !/^[\da-fA-F:.]+$/u.test(ip)) return invalid()
    exit = { status: 'reachable', httpStatus: rawExit.httpStatus as number, latencyMs: number(rawExit.latencyMs), ...(ip === undefined ? {} : { ip }) }
  } else {
    if (rawExit.status !== 'unknown' || rawExit.httpStatus !== undefined || rawExit.ip !== undefined || !REASONS.includes(rawExit.reason as BrowserProxyProbeReason)) return invalid()
    exit = { status: 'unknown', reason: rawExit.reason as string, latencyMs: number(rawExit.latencyMs) }
  }
  const startedAt = number(row.startedAt), finishedAt = row.finishedAt === undefined ? undefined : number(row.finishedAt)
  let exitOrigin: string | null = null
  if (row.exitOrigin !== null) {
    try { const url = new URL(text(row.exitOrigin, 2048)); if (url.protocol !== 'https:' || url.origin !== row.exitOrigin) return invalid(); exitOrigin = url.origin }
    catch { return invalid() }
  }
  if (row.phase !== 'pending' && row.phase !== 'observed' || (row.phase === 'observed') !== (finishedAt !== undefined)) return invalid()
  let webrtc: BrowserWebRtcObservation | undefined
  if (row.webrtc !== undefined) {
    const native = object(row.webrtc, ['status', 'policy', 'reason', 'observedPages'])
    const observedPages = number(native.observedPages)
    if (!Number.isSafeInteger(observedPages)) return invalid()
    if (native.status === 'observed' && native.reason === undefined && observedPages > 0 &&
        BROWSER_WEBRTC_IP_POLICIES.includes(native.policy as BrowserWebRtcIpPolicy)) {
      webrtc = { status: 'observed', policy: native.policy as BrowserWebRtcIpPolicy, observedPages }
    } else if (native.status === 'unknown' && native.policy === undefined &&
        WEBRTC_OBSERVATION_REASONS.includes(native.reason as typeof WEBRTC_OBSERVATION_REASONS[number])) {
      webrtc = { status: 'unknown', reason: native.reason as typeof WEBRTC_OBSERVATION_REASONS[number], observedPages }
    } else return invalid()
  }
  return { id: text(row.id), profileId: text(row.profileId), configurationRevision: text(row.configurationRevision), route, exitOrigin, startedAt,
    phase: row.phase, ...(finishedAt === undefined ? {} : { finishedAt }),
    tcp: observation(row.tcp, ['connected', 'unknown', 'not-applicable']),
    authentication: observation(row.authentication, ['authenticated', 'not-required', 'rejected', 'unknown', 'not-applicable']), exit,
    ...(webrtc ? { webrtc } : {}) }
}
