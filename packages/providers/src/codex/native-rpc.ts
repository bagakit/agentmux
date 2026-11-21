import WebSocket from 'ws'
import { JSONRPCClient, JSONRPCErrorException } from 'json-rpc-2.0'

/** A connection to the already authenticated actor, not another native server or thread owner. */
export async function connectCodexNativeActor(endpoint: string, token: string, signal: AbortSignal,
  name: 'agentmux_native_input' | 'agentmux_managed_resume' | 'agentmux_frontend_reconnect' | 'agentmux_resumed_turn_read' | 'agentmux_managed_initialization',
  options?: { retainPendingInitialization?: true; onNotification?: (method: string, params: Record<string, unknown>) => void;
    onUnavailable?: (message: string) => void }) {
  signal.throwIfAborted()
  const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 2_000 })
  const client = new JSONRPCClient(request => new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(request), error => error ? reject(error) : resolve())
  }))
  let disposed = false, unavailable = false
  const close = (): void => { client.rejectAllPendingRequests('Original native actor connection closed.'); ws.terminate() }
  const dispose = (): void => { disposed = true; signal.removeEventListener('abort', close); close() }
  const lost = (message: string): void => {
    client.rejectAllPendingRequests(message)
    if (!disposed && !signal.aborted && !unavailable) { unavailable = true; options?.onUnavailable?.(message) }
  }
  ws.on('error', () => lost('Original native actor transport unavailable.'))
  ws.on('close', () => lost('Original native actor transport closed.'))
  ws.on('message', bytes => {
    try {
      for (const line of bytes.toString().split('\n').filter(Boolean)) {
        const value = JSON.parse(line) as Record<string, unknown>
        // Server requests remain with the original TUI; neither lifecycle nor input impersonates it.
        if (!value.method && Object.hasOwn(value, 'id')) client.receive(value as never)
        else if (typeof value.method === 'string' && !Object.hasOwn(value, 'id') && value.params &&
            typeof value.params === 'object' && !Array.isArray(value.params)) options?.onNotification?.(value.method, value.params as Record<string, unknown>)
      }
    } catch { lost('Original native actor observation stream unavailable.'); dispose() }
  })
  signal.addEventListener('abort', close, { once: true })
  const request = async (method: string, params: Record<string, unknown>, options?: { retainPending?: true; requestId?: string }): Promise<any> => {
    signal.throwIfAborted()
    if (options?.requestId !== undefined) {
      const requester = options.retainPending ? client : client.timeout(10_000)
      const response = await requester.requestAdvanced({ jsonrpc: '2.0', id: options.requestId, method, params }, undefined)
      if (response.error) throw new JSONRPCErrorException(response.error.message, response.error.code, response.error.data)
      return response.result
    }
    // The managed startup actor retains its original preparation and mutation
    // requests until a response or its lifetime ends. A bounded reader never resends them.
    return await (options?.retainPending ? client.request(method, params) : client.timeout(10_000).request(method, params))
  }
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('Original native actor closed before connection.'))) })
    await request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } },
      options?.retainPendingInitialization ? { retainPending: true } : undefined)
    client.notify('initialized', {}, undefined)
    return { request, dispose, isConnected: () => ws.readyState === WebSocket.OPEN }
  } catch (error) { dispose(); throw error }
}
