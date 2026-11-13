import type { BrowserPageTransport, BrowserNetworkSession } from './browser-page-transport.js'
import { BrowserLocalRecoveryFailure } from './browser-recovery-failure.js'

type Match = { url: string | { contains: string }; method?: string }
type Rule = { match: Match; action: 'continue' | 'abort' | 'mock'; status: number; headers: { name: string; value: string }[]; body: string }
type Context = { session: BrowserPageTransport; signal?: AbortSignal; pageInfo(): { navigationId: string }; beforeAction?(): void;
  note(message: string): void; registerCleanup?(cleanup: () => Promise<void>): void }
type Conditions = { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }
type Hits = { matchedRequests: number; fulfilledRequests: number; abortedRequests: number; continuedRequests: number; unconfirmedRequests: number }
type Routing = { navigationId: string; frameId: string; rules: Rule[]; accepting: boolean; hits: Hits; pending: Set<Promise<void>> }
type Receipt = { status: 'active' | 'withdrawn' | 'unknown'; scope: 'native-page-network'; ruleCount?: number; offlineScope?: 'main-document-http'; hits?: Hits; warning?: string }

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new TypeError('Network rule fields are invalid.')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Network ${label} must be nonempty text without control characters.`)
  return value
}
function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value) || !value.length || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new TypeError('Request rules need a nonempty bounded JSON list.')
  return value.map(item => {
    const row = record(item, ['match', 'action', 'status', 'headers', 'body']), match = record(row.match, ['url', 'method'])
    const url = typeof match.url === 'string' ? text(match.url, 'URL') : { contains: text(record(match.url, ['contains']).contains, 'URL part') }
    if (typeof url === 'string' && !['http:', 'https:'].includes(new URL(url).protocol)) throw new TypeError('Exact request URLs must use HTTP(S).')
    if (match.method !== undefined && (typeof match.method !== 'string' || !/^[A-Z][A-Z0-9-]*$/.test(match.method))) throw new TypeError('Request method must be an uppercase HTTP method.')
    if (!['continue', 'abort', 'mock'].includes(row.action as string)) throw new TypeError('Request action must be continue, abort or mock.')
    if (row.action !== 'mock' && ['status', 'headers', 'body'].some(key => row[key] !== undefined)) throw new TypeError('Only a mock rule has a response definition.')
    const status = row.status ?? 200
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599 || row.body !== undefined && typeof row.body !== 'string') throw new TypeError('Mock response status or body is invalid.')
    const headers: { name: string; value: string }[] = []
    if (row.headers !== undefined) {
      const source = row.headers
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.getPrototypeOf(source) !== Object.prototype) throw new TypeError('Mock headers must be a JSON name/value object.')
      for (const key of Reflect.ownKeys(source)) {
        const property = Object.getOwnPropertyDescriptor(source, key)!
        if (typeof key !== 'string' || !('value' in property) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
          ['set-cookie', 'set-cookie2', 'content-length', 'transfer-encoding'].includes(key.toLowerCase()) || typeof property.value !== 'string' || /[^\x20-\x7e\t]/u.test(property.value)) throw new TypeError('Mock headers cannot change Profile cookies or transport framing, and must be printable HTTP text.')
        headers.push({ name: key, value: property.value })
      }
    }
    if (!headers.some(header => header.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: 'text/plain; charset=utf-8' })
    return { match: { url, ...(match.method === undefined ? {} : { method: match.method as string }) }, action: row.action as Rule['action'], status, headers, body: typeof row.body === 'string' ? row.body : '' }
  })
}
function parseConditions(value: unknown): Conditions {
  const row = record(value, ['offline', 'latencyMs', 'downloadBytesPerSecond', 'uploadBytesPerSecond'])
  if (!Object.keys(row).length || row.offline !== undefined && typeof row.offline !== 'boolean') throw new TypeError('Network conditions need an explicit boolean offline or numeric limit.')
  const number = (value: unknown, fallback: number, throughput = false): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < (throughput ? -1 : 0) || throughput && value !== -1 && value <= 0) throw new TypeError('Network conditions require nonnegative latency and positive bytes/sec or -1 for unlimited.')
    return value
  }
  return { offline: row.offline === true, latency: number(row.latencyMs, 0), downloadThroughput: number(row.downloadBytesPerSecond, -1, true), uploadThroughput: number(row.uploadBytesPerSecond, -1, true) }
}

/** Owns only this program's explicit page-session rules, never Profile routes or another native CDP client. */
export function createBrowserNetworkRouting(context: Context) {
  let session: BrowserNetworkSession | undefined, opening: Promise<BrowserNetworkSession> | undefined
  const sendCommand: BrowserPageTransport['sendCommand'] = (method, params) => {
    if (!session) return Promise.reject(new Error('The original native network session is unavailable.'))
    return session.sendCommand(method, params)
  }
  let routing: Routing | undefined, conditions: { navigationId: string; frameId: string; offline: boolean } | undefined, unsubscribe: (() => void) | undefined
  let fetchArmed = false
  let changing = false, cleaning = false, disposed = false, cleanup: Promise<void> | undefined
  const beginChange = () => {
    if (changing || cleaning) throw new Error('The original network-rule configuration is still changing. Inspect its original result before another change.')
    changing = true
  }
  const endChange = () => { changing = false }
  const current = (navigationId: string) => {
    context.signal?.throwIfAborted()
    if (disposed || session?.endedReason || context.pageInfo().navigationId !== navigationId) throw new Error('The original network-rule document or operation changed. No replacement page is selected.')
    context.beforeAction?.()
  }
  const warning = (message: string): Receipt => {
    try { context.note(message) } catch { console.warn('Browser network feedback could not be projected. The original page and native cleanup remain available.') }
    return { status: 'unknown', scope: 'native-page-network', warning: message }
  }
  const idle = () => { if (!routing && !conditions) { unsubscribe?.(); unsubscribe = undefined } }
  const unroute = async (): Promise<Receipt> => {
    const original = routing
    if (!original) return { status: 'withdrawn', scope: 'native-page-network' }
    original.accepting = false
    try {
      if (!conditions?.offline) { await sendCommand('Fetch.disable'); fetchArmed = false }
      await Promise.all([...original.pending])
      if (routing === original) routing = undefined
      idle(); return { status: 'withdrawn', scope: 'native-page-network', hits: { ...original.hits } }
    } catch { return warning('Original request-rule withdrawal is unconfirmed. The Browser remains available; retry unrouteRequests() before configuring another rule set. No request is replayed.') }
  }
  const clearConditions = async (): Promise<Receipt> => {
    const original = conditions
    if (!original) return { status: 'withdrawn', scope: 'native-page-network' }
    try {
      await sendCommand('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] })
      if (!routing && fetchArmed) { await sendCommand('Fetch.disable'); fetchArmed = false }
      if (conditions === original) conditions = undefined
      idle(); return { status: 'withdrawn', scope: 'native-page-network' }
    } catch { return warning('Original network-condition withdrawal is unconfirmed. The page and its operation remain; retry clearNetworkConditions() without repeating the page action.') }
  }
  const dispose = (): Promise<void> => {
    if (cleanup) return cleanup
    cleaning = true; disposed = true
    if (routing) routing.accepting = false
    // Native detach ends this independent scope even if an earlier command ACK never arrives.
    // A bounded observation is not a withdrawal claim; late completion closes only this original scope.
    return cleanup = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const close = (async () => {
        const original = session ?? await opening
        if (original) await original.close()
        unsubscribe?.(); unsubscribe = undefined; routing = undefined; conditions = undefined
      })()
      try {
        await Promise.race([close, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native network cleanup acknowledgement remains unknown.')), 1000) })])
      } catch (error) {
        if (session?.endedReason) { unsubscribe?.(); unsubscribe = undefined; routing = undefined; conditions = undefined; return }
        warning('Original native network cleanup is unconfirmed (' + (error instanceof Error ? error.message : 'native receipt unavailable') + '). The Browser remains available; no action is retried. Its exact scope is retained for late detach, while stopped-operation ownership is released.')
        void close.catch(() => {})
      } finally { if (timer) clearTimeout(timer); cleaning = false }
    })()
  }
  const observe = () => {
    if (unsubscribe) return
    unsubscribe = session!.observe((method, params, sessionId) => {
      if (sessionId) return
      const row = params as { requestId?: unknown; frameId?: unknown; frame?: { parentId?: string }; request?: { url?: unknown; method?: unknown } }
      if (method === 'Page.frameNavigated' && row?.frame && !row.frame.parentId) { void dispose(); return }
      if (method !== 'Fetch.requestPaused' || typeof row?.requestId !== 'string') return
      const original = routing, network = conditions, requestId = row.requestId
      // Events are handled synchronously up to the one native command: a revoked rule never dispatches a later replacement response.
      let matched = false
      let command = 'Fetch.continueRequest', input: Record<string, unknown> = { requestId }
      try {
        if (network?.offline && row.frameId === network.frameId && typeof row.request?.url === 'string' && ['http:', 'https:'].includes(new URL(row.request.url).protocol)) {
          current(network.navigationId); command = 'Fetch.failRequest'; input = { requestId, errorReason: 'InternetDisconnected' }
        } else if (original?.accepting && row.frameId === original.frameId && typeof row.request?.url === 'string' && typeof row.request.method === 'string') {
          current(original.navigationId)
          const url = new URL(row.request.url)
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            const rule = original.rules.find(rule => (rule.match.method === undefined || rule.match.method === row.request!.method) &&
              (typeof rule.match.url === 'string' ? rule.match.url === row.request!.url : (row.request!.url as string).includes(rule.match.url.contains)))
            matched = !!rule
            if (rule?.action === 'abort') { command = 'Fetch.failRequest'; input = { requestId, errorReason: 'BlockedByClient' } }
            if (rule?.action === 'mock') { command = 'Fetch.fulfillRequest'; input = { requestId, responseCode: rule.status, responseHeaders: rule.headers, body: Buffer.from(rule.body).toString('base64') } }
          }
        }
      } catch { /* Release only the already paused original request; no rule follows a later document or owner. */ }
      if (matched && original) original.hits.matchedRequests++
      const pending = sendCommand(command, input).then(() => {
        if (matched && original) original.hits[command === 'Fetch.fulfillRequest' ? 'fulfilledRequests' : command === 'Fetch.failRequest' ? 'abortedRequests' : 'continuedRequests']++
      }).catch(() => {
        if (matched && original) original.hits.unconfirmedRequests++
        warning('An original intercepted request has an unconfirmed native result. Inspect the page before repeating its action; no request was automatically retried.')
      }).finally(() => original?.pending.delete(pending))
      original?.pending.add(pending)
    })
  }
  const armFetch = async () => {
    if (fetchArmed) return
    fetchArmed = true // An unknown ACK retains the original possible native effect for explicit cleanup.
    await sendCommand('Fetch.enable', { patterns: [{ urlPattern: 'http://*', requestStage: 'Request' }, { urlPattern: 'https://*', requestStage: 'Request' }] })
  }
  const prepare = async (): Promise<{ navigationId: string; frameId: string }> => {
    if (!context.registerCleanup) throw new Error('This host cannot retain the original network-rule cleanup. Existing Browser work remains; no rule was sent.')
    const navigationId = context.pageInfo().navigationId; current(navigationId)
    if (!context.session.openNetworkSession) throw new Error('This host cannot isolate the original network-rule session. Existing Browser controls remain available; no rule was sent.')
    opening ??= context.session.openNetworkSession()
    session ??= await opening
    current(navigationId)
    const tree = await sendCommand('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } }
    current(navigationId)
    if (!tree.frameTree?.frame?.id) throw new Error('The original main document cannot be confirmed. No network rule was sent.')
    return { navigationId, frameId: tree.frameTree.frame.id }
  }
  const abort = () => { disposed = true; void dispose() }
  context.signal?.addEventListener('abort', abort, { once: true })
  context.registerCleanup?.(async () => { disposed = true; context.signal?.removeEventListener('abort', abort); await dispose() })

  return {
    async route(value: unknown): Promise<Receipt> {
      const rules = parseRules(value)
      beginChange()
      try {
        if ((await unroute()).status === 'unknown') throw new Error('Previous request rules are not confirmed withdrawn. Existing page work remains; retry their withdrawal.')
        const original = await prepare(); routing = { ...original, rules, accepting: true, hits: { matchedRequests: 0, fulfilledRequests: 0, abortedRequests: 0, continuedRequests: 0, unconfirmedRequests: 0 }, pending: new Set() }; cleanup = undefined; observe()
        try { await armFetch(); current(original.navigationId) }
        catch { if (routing) routing.accepting = false; throw new BrowserLocalRecoveryFailure('Original request-rule application is unconfirmed. Use unrouteRequests() to withdraw this same configuration; no request is replayed.', 'network-configuration', 'unknown') }
        return { status: 'active', scope: 'native-page-network', ruleCount: rules.length, hits: { ...routing.hits } }
      } finally { endChange() }
    },
    async unroute(): Promise<Receipt> { beginChange(); try { return await unroute() } finally { endChange() } },
    async setConditions(value: unknown): Promise<Receipt> {
      const options = parseConditions(value)
      beginChange()
      try {
        if ((await clearConditions()).status === 'unknown') throw new Error('Previous network conditions are not confirmed withdrawn. Retry their original cleanup.')
        const original = await prepare(); conditions = { ...original, offline: options.offline }; cleanup = undefined; observe()
        try {
          await sendCommand('Network.enable')
          if (options.offline) await armFetch()
          const { offline: _offline, ...limits } = options
          const receipt = await sendCommand('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: ['http://*:*/*', 'https://*:*/*'].map(urlPattern => ({ urlPattern, ...limits })) }) as { ruleIds?: unknown }
          current(original.navigationId)
          if (!Array.isArray(receipt.ruleIds) || receipt.ruleIds.length !== 2 || receipt.ruleIds.some(id => typeof id !== 'string' || !id)) throw new Error('Native rule identities unavailable')
        } catch { throw new BrowserLocalRecoveryFailure('Original network-condition application is unconfirmed. Use clearNetworkConditions() to withdraw this same configuration. The Browser remains available.', 'network-configuration', 'unknown') }
        return { status: 'active', scope: 'native-page-network', ruleCount: 2, ...(options.offline ? { offlineScope: 'main-document-http' as const } : {}) }
      } finally { endChange() }
    },
    async clearConditions(): Promise<Receipt> { beginChange(); try { return await clearConditions() } finally { endChange() } },
    dispose
  }
}
