import WebSocket from 'ws'
import { JSONRPCClient } from 'json-rpc-2.0'

/** A connection to the already authenticated actor, not another native server or thread owner. */
export async function connectCodexNativeActor(endpoint: string, token: string, signal: AbortSignal,
  name: 'agentmux_native_input' | 'agentmux_managed_resume' | 'agentmux_frontend_reconnect' | 'agentmux_resumed_turn_read' | 'agentmux_managed_initialization') {
  signal.throwIfAborted()
  const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 2_000 })
  const client = new JSONRPCClient(request => new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(request), error => error ? reject(error) : resolve())
  }))
  const close = (): void => { client.rejectAllPendingRequests('Original native actor connection closed.'); ws.terminate() }
  const dispose = (): void => { signal.removeEventListener('abort', close); close() }
  ws.on('error', () => client.rejectAllPendingRequests('Original native actor transport unavailable.'))
  ws.on('close', () => client.rejectAllPendingRequests('Original native actor transport closed.'))
  ws.on('message', bytes => {
    try {
      for (const line of bytes.toString().split('\n').filter(Boolean)) {
        const value = JSON.parse(line) as Record<string, unknown>
        // Server requests remain with the original TUI; neither lifecycle nor input impersonates it.
        if (!value.method && Object.hasOwn(value, 'id')) client.receive(value as never)
      }
    } catch { dispose() }
  })
  signal.addEventListener('abort', close, { once: true })
  const request = async (method: string, params: Record<string, unknown>, options?: { retainPending?: true }): Promise<any> => {
    signal.throwIfAborted()
    // A bootstrap mutation has no native idempotency key. Its actor retains the
    // original request and late response; a caller's bounded observation never resends it.
    return await (options?.retainPending ? client.request(method, params) : client.timeout(10_000).request(method, params))
  }
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('Original native actor closed before connection.'))) })
    await request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {}, undefined)
    return { request, dispose }
  } catch (error) { dispose(); throw error }
}
