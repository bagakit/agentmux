import type { Protocol } from 'puppeteer-core'
import type { BrowserNetworkSession } from './browser-page-transport.js'
import { safeBrowserUrl } from './browser-operation-step.js'

const MAX_ENTRIES = 512
const MAX_URL_LENGTH = 2048

type Transfer = {
  start: number
  startedDateTime: string
  method: string
  url: string
  response?: { status: number; mimeType: string; protocol: string; at: number; redirectURL: string }
  end?: number
  decodedBytes: number
  state: 'pending' | 'finished' | 'failed' | 'redirect'
}

function elapsed(from: number, to?: number): number {
  return to === undefined ? -1 : Math.max(0, (to - from) * 1000)
}

function harEntry(transfer: Transfer) {
  const response = transfer.response
  const wait = elapsed(transfer.start, response?.at ?? transfer.end)
  const receive = response ? elapsed(response.at, transfer.end) : -1
  const httpVersion = response?.protocol || 'unknown'
  return {
    startedDateTime: transfer.startedDateTime,
    time: Math.max(0, wait) + Math.max(0, receive),
    request: { method: transfer.method, url: transfer.url, httpVersion, cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: -1 },
    response: { status: response?.status ?? 0, statusText: '', httpVersion, cookies: [], headers: [],
      content: { size: transfer.decodedBytes, mimeType: response?.mimeType ?? 'application/octet-stream' },
      redirectURL: response?.redirectURL ?? '', headersSize: -1, bodySize: -1 },
    cache: {},
    timings: { send: -1, wait, receive },
    _state: transfer.state
  }
}

function observedResponse(response: Protocol.Network.Response, at: number): NonNullable<Transfer['response']> {
  return {
    status: response.status,
    mimeType: response.mimeType.slice(0, 128),
    protocol: response.protocol?.slice(0, 32) ?? '',
    at,
    redirectURL: ''
  }
}

/** Preserve native request identity for the original page target across document changes. */
export function collectBrowserHar(now: () => number = Date.now) {
  const startedAt = now()
  const transfers: Transfer[] = []
  const inflight = new Map<string, Transfer>()
  let dropped = 0, unmatched = 0
  const observe = (method: string, params: unknown) => {
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request, timestamp, wallTime, redirectResponse } = params as Protocol.Network.RequestWillBeSentEvent
      const previous = inflight.get(requestId)
      inflight.delete(requestId)
      const url = safeBrowserUrl(request.url)
      const acceptedUrl = url.length <= MAX_URL_LENGTH && (url.startsWith('http://') || url.startsWith('https://'))
      if (previous && redirectResponse) {
        previous.response = { ...observedResponse(redirectResponse, timestamp), redirectURL: acceptedUrl ? url : '' }
        previous.end = timestamp
        previous.state = 'redirect'
      }
      if (!acceptedUrl || transfers.length === MAX_ENTRIES) {
        if (url.length > MAX_URL_LENGTH || acceptedUrl) dropped++
        return
      }
      const unixMillis = wallTime * 1000
      if (!Number.isFinite(unixMillis) || Math.abs(unixMillis) > 8.64e15) { dropped++; return }
      const transfer: Transfer = { start: timestamp, startedDateTime: new Date(unixMillis).toISOString(),
        method: request.method.slice(0, 64), url, decodedBytes: 0, state: 'pending' }
      transfers.push(transfer)
      inflight.set(requestId, transfer)
    } else if (method === 'Network.responseReceived' || method === 'Network.loadingFinished' ||
               method === 'Network.loadingFailed' || method === 'Network.dataReceived') {
      const event = params as Protocol.Network.ResponseReceivedEvent | Protocol.Network.LoadingFinishedEvent |
        Protocol.Network.LoadingFailedEvent | Protocol.Network.DataReceivedEvent
      const transfer = inflight.get(event.requestId)
      if (!transfer) {
        if (method !== 'Network.dataReceived') unmatched++
        return
      }
      if ('response' in event) transfer.response = observedResponse(event.response, event.timestamp)
      else if ('dataLength' in event) transfer.decodedBytes += event.dataLength
      else {
        transfer.end = event.timestamp
        transfer.state = method === 'Network.loadingFailed' ? 'failed' : 'finished'
        inflight.delete(event.requestId)
      }
    }
  }
  function snapshot(gap: string | null, maximumBytes?: number, previewEntries?: number) {
    const retained = previewEntries === undefined ? transfers : transfers.slice(-previewEntries)
    const entries: ReturnType<typeof harEntry>[] = []
    let outputBytes = 0
    for (const transfer of retained) {
      const entry = harEntry(transfer)
      if (maximumBytes !== undefined) {
        outputBytes += Buffer.byteLength(JSON.stringify(entry)) + 1
        if (outputBytes > maximumBytes) break
      }
      entries.push(entry)
    }
    return {
      log: {
        version: '1.2', creator: { name: 'AgentMux', version: '1' },
        entries,
        _capture: { scope: 'page-target-http', startedAt, observedAt: now(), dropped: dropped + retained.length - entries.length, retained: transfers.length, unmatched,
          pending: inflight.size, gap, content: 'metadata-only' }
      }
    }
  }
  return { startedAt, observe, snapshot }
}

/** An independent lease isolates recording from the normal page program and request rules. */
export async function openBrowserHarCapture(open: () => Promise<BrowserNetworkSession>, signal?: AbortSignal, maximumBytes?: number) {
  signal?.throwIfAborted()
  const session = await open()
  const collector = collectBrowserHar()
  const unsubscribe = session.observe((method, params, child) => {
    if (!child && !signal?.aborted) collector.observe(method, params)
  })
  let finishing: Promise<ReturnType<typeof collector.snapshot>> | undefined
  const finish = () => finishing ??= (async () => {
    unsubscribe()
    signal?.removeEventListener('abort', cancel)
    const originalGap = session.endedReason
    let timer: ReturnType<typeof setTimeout> | undefined
    const closeGap = await Promise.race([
      session.close().then(() => null, () => 'Native recording release is unconfirmed.'),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('Native recording release is still unconfirmed.'), 1000)
      })
    ]).finally(() => clearTimeout(timer))
    return collector.snapshot(originalGap ?? closeGap, maximumBytes)
  })()
  const cancel = () => { void finish() }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    signal?.throwIfAborted()
    await session.sendCommand('Network.enable')
    signal?.throwIfAborted()
    if (session.endedReason) throw new Error('The original Browser recording connection ended before acknowledgement.')
    return { startedAt: collector.startedAt, finish, snapshot: (previewEntries?: number) => collector.snapshot(session.endedReason, maximumBytes, previewEntries) }
  } catch (error) {
    await finish()
    throw error
  }
}
