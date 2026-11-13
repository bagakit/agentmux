import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserPageTransport } from './browser-page-transport.js'

type Handle = { kind: 'browser-network-reader'; id: string; navigationId: string }
type Observation = { sequence: number; requestId: string; event: 'request' | 'response' | 'finished' | 'failed';
  method: string; url: string; status?: number; mimeType?: string; canceled?: boolean; truncated?: true }
type Request = { method: string; url: string; truncated?: true }
type Reader = { handle: Handle; frameId: string; loaderId: string; capacity: number; next: number; dropped: number;
  evictedRequests: number; unattributed: number; rows: Observation[]; requests: Map<string, Request>; listeners: Set<() => void> }
type Context = { session: BrowserPageTransport; pageInfo(): { navigationId: string }; signal?: AbortSignal }

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw new TypeError('Invalid network observation options.')
  }
  return value as Record<string, unknown>
}
function positive(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Network observation budget is invalid.')
  return value
}

/** Ephemeral readers of one program's original main document. Headers and bodies never enter this owner. */
export function createBrowserNetworkObservations(context: Context) {
  const { session } = context
  const readers = new Map<string, Reader>(), closed = new Map<string, { handle: Handle; reason: string }>()
  let remove: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined, disposed = false, preparing = 0, documentSerial = 0
  const unsubscribe = () => { remove?.(); remove = undefined; if (timer) clearInterval(timer); timer = undefined }
  const idle = () => { if (!readers.size && !preparing) unsubscribe() }
  const close = (reader: Reader, reason: string) => {
    if (!readers.delete(reader.handle.id)) return
    closed.set(reader.handle.id, { handle: reader.handle, reason })
    if (closed.size > 1000) closed.delete(closed.keys().next().value!)
    for (const wake of reader.listeners) wake()
    reader.listeners.clear(); reader.requests.clear(); reader.rows = []
    idle()
  }
  const invalid = () => disposed ? 'This program ended.' : context.signal?.aborted ? 'This operation stopped.' : session.endedReason
  const check = () => {
    let reason = invalid(), navigationId: string | undefined
    try { if (!reason) navigationId = context.pageInfo().navigationId }
    catch { reason = 'The original document observation is unavailable.' }
    for (const reader of readers.values()) {
      if (reason || reader.handle.navigationId !== navigationId) close(reader, reason ?? 'The original document navigated.')
    }
    if (reason) unsubscribe()
  }
  const record = (reader: Reader, value: Omit<Observation, 'sequence'>) => {
    reader.rows.push({ sequence: reader.next++, ...value })
    if (reader.rows.length > reader.capacity) { reader.rows.shift(); reader.dropped++ }
    for (const wake of reader.listeners) wake()
  }
  const event = (method: string, params: unknown, sessionId?: string) => {
    if (sessionId) return // A child target is not the original main document.
    check()
    const row = params as any
    if (!row || typeof row !== 'object') return
    if (method === 'Page.frameNavigated' && row.frame && !row.frame.parentId) {
      documentSerial++
      for (const reader of readers.values()) close(reader, 'The original main document navigated.')
      return
    }
    for (const reader of readers.values()) {
      if (typeof row.requestId !== 'string') continue
      if (row.requestId.length > 256) { reader.unattributed++; continue }
      if (method === 'Network.requestWillBeSent') {
        if (row.frameId !== reader.frameId || row.loaderId !== reader.loaderId || typeof row.request?.method !== 'string' || typeof row.request?.url !== 'string') continue
        const previous = reader.requests.get(row.requestId)
        if (previous && Number.isInteger(row.redirectResponse?.status)) record(reader, { ...previous, requestId: row.requestId, event: 'response', status: row.redirectResponse.status })
        reader.requests.delete(row.requestId)
        let nativeUrl: URL
        try { nativeUrl = new URL(row.request.url) } catch { reader.unattributed++; continue }
        if (nativeUrl.protocol !== 'http:' && nativeUrl.protocol !== 'https:') continue
        nativeUrl.username = ''; nativeUrl.password = ''; nativeUrl.hash = ''
        const request: Request = { method: row.request.method.slice(0, 64), url: nativeUrl.href.slice(0, 8192),
          ...(row.request.method.length > 64 || nativeUrl.href.length > 8192 ? { truncated: true as const } : {}) }
        reader.requests.set(row.requestId, request)
        if (reader.requests.size > reader.capacity) { reader.requests.delete(reader.requests.keys().next().value!); reader.evictedRequests++ }
        record(reader, { ...request, requestId: row.requestId, event: 'request' })
      } else if (method === 'Network.responseReceived' || method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const request = reader.requests.get(row.requestId)
        if (!request) { reader.unattributed++; continue }
        if (method === 'Network.responseReceived') {
          if (row.frameId !== reader.frameId || row.loaderId !== reader.loaderId || !Number.isInteger(row.response?.status)) continue
          record(reader, { ...request, requestId: row.requestId, event: 'response', status: row.response.status,
            ...(typeof row.response.mimeType === 'string' ? { mimeType: row.response.mimeType.slice(0, 256),
              ...(row.response.mimeType.length > 256 ? { truncated: true as const } : {}) } : {}) })
        } else {
          record(reader, { ...request, requestId: row.requestId, event: method === 'Network.loadingFailed' ? 'failed' : 'finished',
            ...(typeof row.canceled === 'boolean' ? { canceled: row.canceled } : {}) })
          reader.requests.delete(row.requestId)
        }
      }
    }
  }
  const requireReader = (value: unknown): Reader => {
    const input = fields(value, ['kind', 'id', 'navigationId'])
    check()
    const reader = typeof input.id === 'string' ? readers.get(input.id) : undefined
    if (input.kind !== 'browser-network-reader' || !reader || input.navigationId !== reader.handle.navigationId) {
      throw new Error(typeof input.id === 'string' && closed.has(input.id)
        ? `Network reader ended: ${closed.get(input.id)!.reason} Its original actions are not replayed.`
        : 'This network reader does not belong to the current program and original document.')
    }
    return reader
  }
  const abort = () => { for (const reader of readers.values()) close(reader, 'This operation stopped.'); unsubscribe() }
  context.signal?.addEventListener('abort', abort, { once: true })

  return {
    async watch(options?: unknown): Promise<Handle> {
      const input = fields(options, ['maxEntries']), capacity = positive(input.maxEntries, 100, 1000)
      if (invalid()) throw new Error('The original program or native connection is no longer available. No observation was started.')
      const navigationId = context.pageInfo().navigationId, serial = documentSerial
      if (!remove) { remove = session.observe(event); timer = setInterval(check, 25); timer.unref?.() }
      preparing++
      let reader: Reader | undefined
      try {
        const tree = await session.sendCommand('Page.getFrameTree') as { frameTree?: { frame?: { id?: string; loaderId?: string } } }
        const frame = tree.frameTree?.frame
        if (!frame?.id || !frame.loaderId || serial !== documentSerial || invalid() || context.pageInfo().navigationId !== navigationId) throw new Error('The original document could not be confirmed. No observation was started.')
        const handle: Handle = { kind: 'browser-network-reader', id: mintObjectId(), navigationId }
        reader = { handle, frameId: frame.id, loaderId: frame.loaderId, capacity, next: 1, dropped: 0, evictedRequests: 0, unattributed: 0, rows: [], requests: new Map(), listeners: new Set() }
        readers.set(handle.id, reader)
        // Register before enable: Chromium can send a response before this acknowledgement.
        await session.sendCommand('Network.enable')
        requireReader(handle)
        return { ...handle }
      } catch (error) { if (reader) close(reader, 'Native network observation could not be confirmed.'); throw error }
      finally { preparing--; idle() }
    },
    read(handle: unknown, options?: unknown) {
      const reader = requireReader(handle), input = fields(options, ['afterSequence', 'maxEntries'])
      const after = input.afterSequence === undefined || input.afterSequence === 0 ? 0 : positive(input.afterSequence, 0)
      const maximum = positive(input.maxEntries, reader.capacity, 1000)
      const observations: Observation[] = []
      let bytes = 0, scanned = 0
      for (const row of reader.rows) {
        scanned++
        if (row.sequence <= after) continue
        const size = Buffer.byteLength(JSON.stringify(row))
        if (observations.length === maximum || bytes + size > 64 * 1024) break
        observations.push({ ...row }); bytes += size
      }
      const nextAfterSequence = observations.at(-1)?.sequence ?? after
      return { scope: 'current-main-document' as const, navigationId: reader.handle.navigationId, dropped: reader.dropped,
        evictedRequests: reader.evictedRequests, unattributed: reader.unattributed, nextAfterSequence,
        observedThroughSequence: reader.next - 1, hasMore: reader.rows.some(row => row.sequence > nextAfterSequence),
        observationBytes: bytes, scannedEntries: scanned, observations }
    },
    async waitForResponse(handle: unknown, match?: unknown, options?: unknown): Promise<Observation> {
      const reader = requireReader(handle), query = fields(match, ['url', 'method', 'status']), input = fields(options, ['timeoutMs'])
      let matchesUrl = (_url: string) => true
      if (typeof query.url === 'string') { const exact = query.url; matchesUrl = url => url === exact }
      else if (query.url !== undefined) {
        const url = fields(query.url, ['contains'])
        if (typeof url.contains !== 'string' || !url.contains) throw new TypeError('Response URL must be an exact string or {contains: nonempty text}.')
        const part = url.contains; matchesUrl = url => url.includes(part)
      }
      if (query.method !== undefined && (typeof query.method !== 'string' || !/^[A-Z]+$/.test(query.method))) throw new TypeError('Response method must be an uppercase HTTP method.')
      if (query.status !== undefined && (typeof query.status !== 'number' || !Number.isInteger(query.status) || query.status < 100 || query.status > 599)) throw new TypeError('Response status must be an HTTP status.')
      const timeout = positive(input.timeoutMs, 5000), deadline = performance.now() + timeout
      const find = () => reader.rows.find(row => row.event === 'response' && !(row.truncated && (typeof query.url === 'string' || query.method !== undefined)) && matchesUrl(row.url) && (query.method === undefined || row.method === query.method) && (query.status === undefined || row.status === query.status))
      return await new Promise<Observation>((resolve, reject) => {
        let poll: ReturnType<typeof setInterval> | undefined
        const done = () => { if (poll) clearInterval(poll); reader.listeners.delete(wake) }
        const wake = () => {
          try {
            requireReader(handle)
            const found = find()
            if (found) { done(); resolve({ ...found }) }
            else if (performance.now() >= deadline) { done(); reject(new Error(`No matching response was confirmed within ${timeout}ms. Retention dropped ${reader.dropped} observations; inspect the original page before repeating an action.`)) }
          } catch (error) { done(); reject(error) }
        }
        reader.listeners.add(wake); poll = setInterval(wake, 25); poll.unref?.(); wake()
      })
    },
    stop(handle: unknown): { stopped: true } {
      const input = fields(handle, ['kind', 'id', 'navigationId']), ended = typeof input.id === 'string' ? closed.get(input.id) : undefined
      if (input.kind === 'browser-network-reader' && ended?.handle.navigationId === input.navigationId) return { stopped: true }
      close(requireReader(handle), 'This reader was explicitly stopped.'); return { stopped: true }
    },
    dispose(): void { disposed = true; context.signal?.removeEventListener('abort', abort); for (const reader of readers.values()) close(reader, 'This program ended.'); unsubscribe(); closed.clear() }
  }
}
