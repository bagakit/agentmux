import { clientIncidentPriority, parseClientIncidentReport, type AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import { isObjectId } from '@agentmux/core/object-id'

export type ClientIncidentTransport = {
  open(): Promise<unknown>
  report(token: string, report: AgentMuxClientIncidentReport): Promise<unknown>
}
export const CLIENT_INCIDENT_DISPATCH_LIMITS = Object.freeze({ reports: 32, bytes: 512 * 1024,
  readingReports: 16, readingBytes: 256 * 1024 })
const PROGRESS_PUBLICATION_INTERVAL_MS = 1000
export type ClientIncidentDispatchStatus = {
  pending: number; pendingBytes: number; inFlight: boolean
  dropped: number; rejected: number; unavailable: number; coalesced: number
}
export type ClientIncidentDispatcher = {
  send(report: AgentMuxClientIncidentReport): void
  dropped(): number
  inspect(): ClientIncidentDispatchStatus
}
type Pending = { report: AgentMuxClientIncidentReport; bytes: number; key: string | null; priority: ReturnType<typeof clientIncidentPriority> }
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
function readingKey(report: AgentMuxClientIncidentReport): string | null {
  if (!report.reading) return null
  const scope = report.reading.scope
  return JSON.stringify([scope.owner, scope.ownerInstanceId, scope.consumerKind, scope.consumerId, scope.hostId, scope.agentSessionId, scope.runId, scope.sourceHostId, scope.producerBuildId, report.reading.trigger])
}

/** One finite queue for the actual transport Realm. Documents are positions, not transport owners. */
export function createClientIncidentDispatcher(readTransport: () => ClientIncidentTransport | undefined): ClientIncidentDispatcher {
  const queue: Pending[] = []
  let pendingBytes = 0, sending = false, token: string | null = null, owner: ClientIncidentTransport | undefined
  let nextProgressAt: number | null = null, wake: ReturnType<typeof setTimeout> | undefined
  let dropped = 0, rejected = 0, unavailable = 0, coalesced = 0
  const lose = (count: number, reason: 'rejected' | 'unavailable' | 'coalesced' | 'budget') => {
    dropped = increment(dropped, count)
    if (reason === 'rejected') rejected = increment(rejected, count)
    if (reason === 'unavailable') unavailable = increment(unavailable, count)
    if (reason === 'coalesced') coalesced = increment(coalesced, count)
  }
  const clearWake = () => { clearTimeout(wake); wake = undefined }
  const discard = () => { clearWake(); lose(queue.length, 'unavailable'); queue.length = 0; pendingBytes = 0 }
  const clock = () => {
    const now = performance.now()
    if (!Number.isFinite(now) || now < 0) throw Error('Diagnostic publication clock is unavailable.')
    return now
  }
  const delayProgress = () => {
    if (nextProgressAt === null) return 0
    const delay = Math.max(0, nextProgressAt - clock())
    if (delay > PROGRESS_PUBLICATION_INTERVAL_MS) throw Error('Diagnostic publication clock moved before its original observation.')
    return delay
  }
  const schedule = (): void => {
    if (sending) return
    try {
      if (!queue.length) { clearWake(); return }
      const delay = queue.some(item => item.priority !== 'progress') ? 0 : delayProgress()
      if (delay > 0) {
        // One wake for the transport Realm, only while a normal tail is queued.
        if (wake === undefined) wake = setTimeout(() => { wake = undefined; void drain() }, delay)
      } else { clearWake(); void drain() }
    } catch { discard() }
  }
  const drain = async (): Promise<void> => {
    if (sending) return
    sending = true
    try {
      const transport = readTransport()
      if (!transport) { token = null; owner = undefined; discard(); return }
      if (transport !== owner) { owner = transport; token = null }
      if (!token) token = opened(await transport.open())
      if (!token) { discard(); return }
      let progressBatch: Set<Pending> | null = null
      while (queue.length) {
        const critical = queue.findIndex(item => item.priority === 'critical')
        const urgent = critical >= 0 ? critical : queue.findIndex(item => item.priority === 'reading')
        let next = urgent
        if (next < 0) {
          next = progressBatch === null ? -1 : queue.findIndex(item => progressBatch!.has(item))
          if (next < 0) {
            if (delayProgress() > 0) break
            // Freeze this window's finite membership. Arrivals while an actual
            // report is pending belong to the next window, even on a fast bridge.
            progressBatch = new Set(queue.filter(item => item.priority === 'progress'))
            nextProgressAt = clock() + PROGRESS_PUBLICATION_INTERVAL_MS
            next = queue.findIndex(item => progressBatch!.has(item))
          }
        }
        const pending = queue.splice(next, 1)[0]!
        progressBatch?.delete(pending)
        pendingBytes -= pending.bytes
        try { if (!accepted(await transport.report(token, pending.report), pending.report.reading?.logId)) lose(1, 'rejected') }
        catch {
          // The original publication may have applied. Never replay it with a new token.
          lose(1, 'unavailable'); token = null; discard(); return
        }
      }
    } catch { token = null; discard() }
    finally { sending = false; schedule() }
  }
  return {
    send(input) {
      try {
        // The finite parser returns detached data without invoking caller serializers.
        const report = parseClientIncidentReport(input)
        const pending: Pending = { report, bytes: encoder.encode(JSON.stringify(report)).byteLength,
          key: readingKey(report), priority: clientIncidentPriority(report) }
        const same = pending.key === null ? [] : queue.filter(item => item.key === pending.key)
        // Keep the first original checkpoint and latest tail for each reading trigger.
        const previous = same.length >= 2 ? same.at(-1) : undefined
        const reading = () => queue.filter(item => item !== previous && item.priority !== 'critical')
        const full = () => queue.length - (previous ? 1 : 0) >= CLIENT_INCIDENT_DISPATCH_LIMITS.reports ||
          pendingBytes - (previous?.bytes ?? 0) + pending.bytes > CLIENT_INCIDENT_DISPATCH_LIMITS.bytes ||
          pending.priority !== 'critical' && (reading().length >= CLIENT_INCIDENT_DISPATCH_LIMITS.readingReports ||
            reading().reduce((total, item) => total + item.bytes, 0) + pending.bytes > CLIENT_INCIDENT_DISPATCH_LIMITS.readingBytes)
        // Reclaim lower classes only. The actual report has left this queue and keeps its IO slot.
        while (full()) {
          let victim = pending.priority === 'progress' ? -1 : queue.findIndex(item => item !== previous && item.priority === 'progress')
          if (victim < 0 && pending.priority === 'critical') victim = queue.findIndex(item => item.priority === 'reading')
          if (victim < 0) break
          pendingBytes -= queue.splice(victim, 1)[0]!.bytes
          lose(1, 'budget')
        }
        if (full()) { lose(1, 'budget'); return }
        if (previous) { queue[queue.indexOf(previous)] = pending; pendingBytes += pending.bytes - previous.bytes; lose(1, 'coalesced') }
        else { queue.push(pending); pendingBytes += pending.bytes }
        // The async owner retains its actual open/report slot until the Promise truly settles.
        schedule()
      } catch { lose(1, 'rejected') }
    },
    dropped: () => dropped,
    inspect: () => ({ pending: queue.length, pendingBytes, inFlight: sending, dropped, rejected, unavailable, coalesced }),
  }
}

