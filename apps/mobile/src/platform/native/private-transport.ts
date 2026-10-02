import { registerPlugin } from '@capacitor/core'

export type NativePairingWaiting = {
  state: 'waiting'; hostId: string; deviceId: string; confirmationCode: string; expiresAt: number
}
export type NativeClaimResult = { state: 'waiting'; hostId: string } | {
  state: 'approved'; hostId: string; device: { deviceId: string; name: string; createdAt: number }
}

/** Native admission owns secrets. This bridge has no credential read/write/export method. */
export interface NativePrivateTransportPlugin {
  begin(input: { requestId: string; origin: string; hostId: string; invitation: string; name: string }): Promise<NativePairingWaiting>
  claim(input: { requestId: string; origin: string; hostId: string }): Promise<NativeClaimResult>
  open(input: { requestId: string; origin: string; hostId?: string; path: string; method: string;
    headers: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string> }>
  read(input: { requestId: string }): Promise<{ done: boolean; data?: string }>
  cancel(input: { requestId: string }): Promise<void>
}

const native = registerPlugin<NativePrivateTransportPlugin>('AgentMuxPrivateTransport')
const DEVICE = '/_agentmux/device'
const MAX_CHUNK = 64 * 1024
const forbidden = (name: string) => /^(?:authorization|proxy-authorization|cookie|origin|host|x-agentmux-transport)$/iu.test(name)
  || name.toLowerCase().startsWith('sec-fetch-')

function origin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) throw new Error('原生连接需要精确的 HTTPS Mac 地址。原工作面保留。')
  return url.origin
}
function encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
function decode(value: string): Uint8Array {
  if (value.length > 4 * Math.ceil(MAX_CHUNK / 3)) throw new Error('原生响应片段超过读取范围。原会话保留。')
  const binary = atob(value)
  if (binary.length > MAX_CHUNK || binary.length === 0) throw new Error('原生响应片段尚未核实。原会话保留。')
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
function aborted(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException('This native request was cancelled.', 'AbortError')
}

export type NativePrivateAccess = {
  info(origin: string, signal?: AbortSignal): Promise<Response>
  status(origin: string, hostId: string, signal?: AbortSignal): Promise<Response>
  begin(origin: string, hostId: string, invitation: string, name: string, signal?: AbortSignal): Promise<NativePairingWaiting>
  claim(origin: string, hostId: string, signal?: AbortSignal): Promise<NativeClaimResult>
  fetchForHost(origin: string, hostId: string): typeof fetch
}

/** Only network bytes and cancellation. The public HTTP client still owns RPC/SSE parsing. */
export function createNativePrivateAccess(options: { plugin?: NativePrivateTransportPlugin } = {}): NativePrivateAccess {
  const plugin = options.plugin ?? native
  const admission = async <T>(signal: AbortSignal | undefined,
    action: (requestId: string) => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    const requestId = crypto.randomUUID()
    const cancel = () => { void plugin.cancel({ requestId }).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await action(requestId)
      if (signal?.aborted) { await plugin.cancel({ requestId }); throw aborted(signal) }
      return result
    } finally { signal?.removeEventListener('abort', cancel) }
  }
  const fetchFor = (value: string, hostId?: string): typeof fetch => {
    const boundOrigin = origin(value)
    return async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url), signal = request.signal
      if (url.origin !== boundOrigin || url.username || url.password || url.hash) {
        throw new Error('请求属于另一 Mac 地址。这次操作未提交，原会话保留。')
      }
      const path = decodeURIComponent(url.pathname)
      if (path.includes('\\') || path.split('/').some(segment => segment === '.' || segment === '..')) {
        throw new Error('请求路径尚未核实。这次操作未提交，原会话保留。')
      }
      // Device secrets can only be consumed by the native begin/claim methods.
      if ((path === DEVICE || path.startsWith(`${DEVICE}/`))
        && !(request.method === 'GET' && (path === DEVICE || path === `${DEVICE}/status`))) {
        throw new Error('设备授权只能经过系统秘密通道。这次操作未提交。')
      }
      if (!hostId && !(request.method === 'GET' && url.pathname === DEVICE && !url.search)) {
        throw new Error('这次请求尚未绑定已确认的 Mac 身份。原会话保留。')
      }
      signal.throwIfAborted()
      const headers: Record<string, string> = {}
      for (const [name, value] of request.headers) {
        if (forbidden(name)) throw new Error('认证头由系统秘密通道持有。这次操作未提交。')
        headers[name] = value
      }
      const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
      signal.throwIfAborted()
      const requestId = crypto.randomUUID()
      let finished = false, controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const finish = () => { finished = true; signal.removeEventListener('abort', onAbort) }
      const onAbort = () => {
        if (finished) return
        finish(); controller?.error(aborted(signal))
        void plugin.cancel({ requestId }).catch(() => {})
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await plugin.open({ requestId, origin: boundOrigin, ...(hostId ? { hostId } : {}),
          path: `${url.pathname}${url.search}`, method: request.method, headers,
          ...(bytes ? { body: encode(bytes) } : {}) })
        if (signal.aborted) { await plugin.cancel({ requestId }); throw aborted(signal) }
        const body = new ReadableStream<Uint8Array>({
          start(value) { controller = value },
          async pull(value) {
            if (finished) return
            try {
              const next = await plugin.read({ requestId })
              if (finished) return
              if (next.done) { finish(); value.close(); return }
              if (typeof next.data !== 'string') throw new Error('原生响应字节尚未核实。原会话保留。')
              value.enqueue(decode(next.data))
            } catch (error) {
              if (finished) return
              finish(); value.error(error); await plugin.cancel({ requestId })
            }
          },
          async cancel() { if (!finished) { finish(); await plugin.cancel({ requestId }) } }
        }, { highWaterMark: 0 })
        const result = new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : body,
          { status: response.status, headers: response.headers })
        if (!result.body) { finish(); await plugin.cancel({ requestId }) }
        return result
      } catch (error) {
        finish(); await plugin.cancel({ requestId }).catch(() => {}); throw error
      }
    }
  }
  return {
    info(value, signal) { const bound = origin(value); return fetchFor(bound)(`${bound}${DEVICE}`, signal ? { signal } : {}) },
    status(value, hostId, signal) { const bound = origin(value); return fetchFor(bound, hostId)(`${bound}${DEVICE}/status`, signal ? { signal } : {}) },
    begin(value, hostId, invitation, name, signal) {
      const bound = origin(value)
      return admission(signal, requestId => plugin.begin({ requestId, origin: bound, hostId, invitation, name }))
    },
    claim(value, hostId, signal) {
      const bound = origin(value)
      return admission(signal, requestId => plugin.claim({ requestId, origin: bound, hostId }))
    },
    fetchForHost: fetchFor
  }
}
