import { parseClientIncidentReport, type AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import { isObjectId } from '@agentmux/core/object-id'

export type ClientIncidentTransport = {
  open(): Promise<unknown>
  report(token: string, report: AgentMuxClientIncidentReport): Promise<unknown>
}
export const CLIENT_INCIDENT_DISPATCH_LIMITS = Object.freeze({ reports: 32, bytes: 512 * 1024,
  progressReports: 16, progressBytes: 256 * 1024 })
export type ClientIncidentDispatchStatus = {
  pending: number; pendingBytes: number; inFlight: boolean
  dropped: number; rejected: number; unavailable: number; coalesced: number
}
export type ClientIncidentDispatcher = {
  send(report: AgentMuxClientIncidentReport): void
  dropped(): number
  inspect(): ClientIncidentDispatchStatus
}
type Pending = { report: AgentMuxClientIncidentReport; bytes: number; progressKey: string | null }
const increment = (value: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount)
const encoder = new TextEncoder()

/** The receiver is unknown IPC data. Do not execute accessors or coerce fields. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error('Invalid diagnostic receipt.')
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) throw Error('Invalid diagnostic receipt.')
  }
  return value as Record<string, unknown>
}
function opened(value: unknown): string | null {
  if (value === null) return null
  const item = fields(value, ['token'])
  if (!Object.hasOwn(item, 'token') || typeof item.token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.token)) throw Error('Invalid diagnostic token.')
  return item.token
}
function accepted(value: unknown, originalLogId?: string): boolean {
  const item = fields(value, ['accepted', 'logId'])
  if (!Object.hasOwn(item, 'accepted') || typeof item.accepted !== 'boolean' ||
    Object.hasOwn(item, 'logId') && (!item.accepted || !isObjectId(item.logId) || originalLogId !== undefined && item.logId !== originalLogId)) throw Error('Invalid diagnostic receipt.')
  return item.accepted
}
function progressKey(report: AgentMuxClientIncidentReport): string | null {
  if (report.kind !== 'conversation-reading-progress' || !report.reading) return null
  const scope = report.reading.scope
  return JSON.stringify([scope.ownerInstanceId, scope.consumerId, scope.hostId, scope.agentSessionId, scope.runId])
}

/** One finite queue for the actual transport Realm. Documents are positions, not transport owners. */
export function createClientIncidentDispatcher(readTransport: () => ClientIncidentTransport | undefined): ClientIncidentDispatcher {
  const queue: Pending[] = []
  let pendingBytes = 0, sending = false, token: string | null = null, owner: ClientIncidentTransport | undefined
  let dropped = 0, rejected = 0, unavailable = 0, coalesced = 0
  const lose = (count: number, reason: 'rejected' | 'unavailable' | 'coalesced' | 'budget') => {
    dropped = increment(dropped, count)
    if (reason === 'rejected') rejected = increment(rejected, count)
    if (reason === 'unavailable') unavailable = increment(unavailable, count)
    if (reason === 'coalesced') coalesced = increment(coalesced, count)
  }
  const discard = () => { lose(queue.length, 'unavailable'); queue.length = 0; pendingBytes = 0 }
  const drain = async () => {
    if (sending) return
    sending = true
    try {
      const transport = readTransport()
      if (!transport) { token = null; owner = undefined; discard(); return }
      if (transport !== owner) { owner = transport; token = null }
      if (!token) token = opened(await transport.open())
      if (!token) { discard(); return }
      while (queue.length) {
        const pending = queue.shift()!
        pendingBytes -= pending.bytes
        try { if (!accepted(await transport.report(token, pending.report), pending.report.reading?.logId)) lose(1, 'rejected') }
        catch {
          // The original publication may have applied. Never replay it with a new token.
          lose(1, 'unavailable'); token = null; discard(); return
        }
      }
    } catch { token = null; discard() }
    finally { sending = false }
  }
  return {
    send(input) {
      try {
        // The finite parser returns detached data without invoking caller serializers.
        const report = parseClientIncidentReport(input)
        const pending: Pending = { report, bytes: encoder.encode(JSON.stringify(report)).byteLength, progressKey: progressKey(report) }
        // Critical observations reclaim queued healthy progress before they can
        // be dropped. The real in-flight publication keeps its original slot.
        if (pending.progressKey === null) {
          while (queue.length >= CLIENT_INCIDENT_DISPATCH_LIMITS.reports || pendingBytes + pending.bytes > CLIENT_INCIDENT_DISPATCH_LIMITS.bytes) {
            const victim = queue.findIndex(item => item.progressKey !== null)
            if (victim < 0) break
            pendingBytes -= queue.splice(victim, 1)[0]!.bytes
            lose(1, 'budget')
          }
        }
        const same = pending.progressKey === null ? [] : queue.flatMap((item, index) => item.progressKey === pending.progressKey ? [index] : [])
        // Keep the first pending checkpoint. Later healthy snapshots replace only the pending tail.
        const replace = same.length >= 2 ? same.at(-1)! : -1
        const previous = replace < 0 ? undefined : queue[replace]
        const progress = queue.filter(item => item.progressKey !== null)
        const fits = queue.length + (previous ? 0 : 1) <= CLIENT_INCIDENT_DISPATCH_LIMITS.reports &&
          pendingBytes - (previous?.bytes ?? 0) + pending.bytes <= CLIENT_INCIDENT_DISPATCH_LIMITS.bytes &&
          (pending.progressKey === null || progress.length + (previous ? 0 : 1) <= CLIENT_INCIDENT_DISPATCH_LIMITS.progressReports &&
            progress.reduce((total, item) => total + item.bytes, 0) - (previous?.bytes ?? 0) + pending.bytes <= CLIENT_INCIDENT_DISPATCH_LIMITS.progressBytes)
        if (!fits) { lose(1, 'budget'); return }
        if (previous) { queue[replace] = pending; pendingBytes += pending.bytes - previous.bytes; lose(1, 'coalesced') }
        else { queue.push(pending); pendingBytes += pending.bytes }
        // The async owner retains its actual open/report slot until the Promise truly settles.
        void drain()
      } catch { lose(1, 'rejected') }
    },
    dropped: () => dropped,
    inspect: () => ({ pending: queue.length, pendingBytes, inFlight: sending, dropped, rejected, unavailable, coalesced }),
  }
}

