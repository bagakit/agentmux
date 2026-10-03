import { createClientChannel, type EncryptedChannel, type Transport, type KeyPair } from '@agentmux/relay/e2ee'
import { buildRelayWebSocketUrl } from '@agentmux/relay/endpoint'
import { parseConnectionOffer, type ConnectionOffer } from '@agentmux/relay/offer'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode, type JSONRPCRequest } from './public-rpc-frame.js'

export type AgentMuxRpcRelayOptions = { offer: ConnectionOffer; keyPair?: KeyPair; createWebSocket?: (url: string) => WebSocket }
export type AgentMuxRpcRelayReader = { dispose(): Promise<void> }

/** Encrypted framing only; business admission, subscriptions and semantic recovery stay in the original SDK/service. */
export async function openAgentMuxRpcRelayRequest(options: AgentMuxRpcRelayOptions, request: JSONRPCRequest,
  onFrame: (frame: unknown) => void, onEnd: (error?: Error) => void, signal: AbortSignal): Promise<AgentMuxRpcRelayReader> {
  const offer = parseConnectionOffer(options.offer)
  if (signal.aborted) throw new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')
  const socket = (options.createWebSocket ?? (url => new WebSocket(url)))(buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint, useTls: offer.relay.useTls, serverId: offer.serverId, role: 'client'
  }))
  socket.binaryType = 'arraybuffer'
  let closed = false, channel: EncryptedChannel | undefined, ready = false, sent = false
  const sendRequest = () => {
    if (closed || !ready || !channel || sent) return
    sent = true
    void Promise.resolve(channel.send(rpcEncode(request))).catch(error => finish(error instanceof Error ? error : new Error(String(error))))
  }
  const finish = (error?: Error) => {
    if (closed) return
    closed = true; signal.removeEventListener('abort', abort)
    channel?.close(1000, 'Reader released'); socket.close()
    onEnd(error)
  }
  const abort = () => finish(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED'))
  const transport: Transport = { send: data => {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 8 * 1024 * 1024) {
      throw new AgentMuxError('Relay output is unavailable; the operation is not replayed.', 'CONTROL_UNAVAILABLE')
    }
    socket.send(data)
  }, close: (code, reason) => socket.close(code === 1000 || code && code >= 3000 && code <= 4999 ? code : 4001, reason),
  onmessage: null, onclose: null, onerror: null }
  signal.addEventListener('abort', abort, { once: true })
  socket.addEventListener('message', event => {
    if (closed) return
    if (typeof event.data !== 'string' && !(event.data instanceof ArrayBuffer)) { finish(new AgentMuxError('Invalid Relay frame.', 'CONTROL_PROTOCOL_ERROR')); return }
    if ((typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data.byteLength) > AGENTMUX_RPC_MAX_MESSAGE_BYTES * 2) {
      finish(new AgentMuxError('Relay frame exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')); return
    }
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== 'string' })
  })
  socket.addEventListener('close', event => {
    finish(new AgentMuxError(event.code === 4003 ? '此设备的授权已撤销；原 Agent 会话保留。' : `Relay disconnected (${event.code}); original Sessions retained.`, event.code === 4003 ? 'AGENT_CAPABILITY_INVALID' : 'CONTROL_UNAVAILABLE'))
    transport.onclose?.(event.code, event.reason)
  })
  socket.addEventListener('error', () => finish(new AgentMuxError('Relay connection is unavailable. Original Sessions retained.', 'CONTROL_UNAVAILABLE')))
  socket.addEventListener('open', () => {
    if (closed) return
    void createClientChannel(transport, offer.daemonPublicKeyB64, {
      onopen: () => { ready = true; sendRequest() },
      onmessage: data => { if (closed) return
        try { onFrame(JSON.parse(typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data))) }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      }, onclose: () => finish(new AgentMuxError('Encrypted Relay connection ended. Original Sessions retained.', 'CONTROL_UNAVAILABLE')),
      onerror: error => finish(error)
    }, options.keyPair).then(value => { channel = value; if (closed) value.close(); else sendRequest() })
      .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
  })
  if (signal.aborted) abort()
  return { dispose: async () => { if (closed) return; closed = true; signal.removeEventListener('abort', abort); channel?.close(); socket.close() } }
}
