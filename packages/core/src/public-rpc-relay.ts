import { createClientChannel, type EncryptedChannel, type Transport, type KeyPair } from '@agentmux/relay/e2ee'
import { buildRelayWebSocketUrl } from '@agentmux/relay/endpoint'
import { parseConnectionOffer, type ConnectionOffer } from '@agentmux/relay/offer'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, parseRpcResponse, rpcEncode, type JSONRPCRequest } from './public-rpc-frame.js'

export type AgentMuxRpcRelayOptions = { offer: ConnectionOffer; keyPair?: KeyPair; createWebSocket?: (url: string) => WebSocket }
export type AgentMuxRpcRelayReader = { dispose(): Promise<void> }
export type AgentMuxRpcRelayClient = {
  open(request: JSONRPCRequest, onFrame: (frame: unknown) => void, onEnd: (error?: Error) => void,
    signal: AbortSignal, stream: boolean): Promise<AgentMuxRpcRelayReader>
  dispose(): void
}
type Lease = {
  request: JSONRPCRequest; encoded: string; onFrame(frame: unknown): void; onEnd(error?: Error): void
  signal: AbortSignal; abort(): void; stream: boolean; responseSeen: boolean; complete: boolean; sent: boolean; released: boolean
}
type Carrier = {
  socket: WebSocket; channel?: EncryptedChannel; ready: boolean; closed: boolean; lease?: Lease
  sendRequest(): void
}
const cancelled = () => new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')
const failure = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** Each reader owns its connection. Only a released finite reply may leave one idle connection for this client. */
export function createAgentMuxRpcRelayClient(options: AgentMuxRpcRelayOptions): AgentMuxRpcRelayClient {
  const offer = parseConnectionOffer(options.offer)
  const carriers = new Set<Carrier>()
  let idle: Carrier | undefined, disposed = false
  const close = (carrier: Carrier, error?: Error) => {
    if (carrier.closed) return
    carrier.closed = true
    carriers.delete(carrier)
    if (idle === carrier) idle = undefined
    const lease = carrier.lease
    delete carrier.lease
    lease?.signal.removeEventListener('abort', lease.abort)
    carrier.channel?.close(1000, 'Reader released')
    carrier.socket.close()
    if (lease && !lease.released) lease.onEnd(error)
  }
  const createCarrier = (): Carrier => {
    const socket = (options.createWebSocket ?? (url => new WebSocket(url)))(buildRelayWebSocketUrl({
      endpoint: offer.relay.endpoint, useTls: offer.relay.useTls, serverId: offer.serverId, role: 'client'
    }))
    socket.binaryType = 'arraybuffer'
    const carrier: Carrier = { socket, ready: false, closed: false, sendRequest: () => {
      const lease = carrier.lease
      if (carrier.closed || !carrier.ready || !carrier.channel || !lease || lease.sent) return
      if (lease.signal.aborted) { close(carrier, cancelled()); return }
      lease.sent = true
      void carrier.channel.send(lease.encoded).catch(error => close(carrier, failure(error)))
    } }
    carriers.add(carrier)
    const transport: Transport = {
      send: data => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 8 * 1024 * 1024) {
          throw new AgentMuxError('Relay output is unavailable; the operation is not replayed.', 'CONTROL_UNAVAILABLE')
        }
        socket.send(data)
      },
      close: (code, reason) => socket.close(code === 1000 || code && code >= 3000 && code <= 4999 ? code : 4001, reason),
      onmessage: null, onclose: null, onerror: null
    }
    socket.addEventListener('message', event => {
      if (carrier.closed) return
      if (typeof event.data !== 'string' && !(event.data instanceof ArrayBuffer)) {
        close(carrier, new AgentMuxError('Invalid Relay frame.', 'CONTROL_PROTOCOL_ERROR')); return
      }
      if ((typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data.byteLength) > AGENTMUX_RPC_MAX_MESSAGE_BYTES * 2) {
        close(carrier, new AgentMuxError('Relay frame exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')); return
      }
      transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== 'string' })
    })
    socket.addEventListener('close', event => {
      // A lost connection says nothing about the Host's durable capability state.
      close(carrier, new AgentMuxError(`Relay disconnected (${event.code}); original Sessions retained.`, 'CONTROL_UNAVAILABLE'))
      transport.onclose?.(event.code, event.reason)
    })
    socket.addEventListener('error', () => close(carrier,
      new AgentMuxError('Relay connection is unavailable. Original Sessions retained.', 'CONTROL_UNAVAILABLE')))
    socket.addEventListener('open', () => {
      if (carrier.closed) return
      void createClientChannel(transport, offer.daemonPublicKeyB64, {
        onopen: () => { carrier.ready = true; carrier.sendRequest() },
        onmessage: data => {
          if (carrier.closed) return
          try {
            const lease = carrier.lease
            if (!lease || lease.complete) throw new AgentMuxError('Relay reply has no active reader.', 'CONTROL_PROTOCOL_ERROR')
            const frame: unknown = JSON.parse(typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data))
            // The original client still validates business values and stream events.
            // Finite reuse additionally needs a complete, strict reply for this ID.
            if (!lease.sent) throw new AgentMuxError('Relay reply preceded its request.', 'CONTROL_PROTOCOL_ERROR')
            if (!lease.responseSeen) {
              if (parseRpcResponse(frame).id !== lease.request.id) throw new AgentMuxError('RPC response ID does not match the request.', 'CONTROL_PROTOCOL_ERROR')
              lease.responseSeen = true
              lease.complete = !lease.stream
            }
            lease.onFrame(frame)
          } catch (error) { close(carrier, failure(error)) }
        },
        onclose: () => close(carrier, new AgentMuxError('Encrypted Relay connection ended. Original Sessions retained.', 'CONTROL_UNAVAILABLE')),
        onerror: error => close(carrier, error)
      }, options.keyPair).then(channel => {
        carrier.channel = channel
        if (carrier.closed) channel.close()
        else carrier.sendRequest()
      }).catch(error => close(carrier, failure(error)))
    })
    return carrier
  }
  return {
    async open(request, onFrame, onEnd, signal, stream) {
      if (disposed || signal.aborted) throw cancelled()
      const encoded = rpcEncode(request)
      const carrier = !stream && idle ? idle : createCarrier()
      if (idle === carrier) idle = undefined
      const lease: Lease = { request, encoded, onFrame, onEnd, signal, stream, responseSeen: false, complete: false, sent: false, released: false,
        abort: () => { if (!lease.complete) close(carrier, cancelled()) } }
      carrier.lease = lease
      signal.addEventListener('abort', lease.abort, { once: true })
      carrier.sendRequest()
      if (signal.aborted) lease.abort()
      return { dispose: async () => {
        if (lease.released) return
        lease.released = true
        signal.removeEventListener('abort', lease.abort)
        if (carrier.lease !== lease) return
        delete carrier.lease
        if (!disposed && !stream && lease.complete && !carrier.closed && carrier.ready && carrier.socket.readyState === WebSocket.OPEN && !idle) idle = carrier
        else close(carrier)
      } }
    },
    dispose() {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      for (const carrier of carriers) {
        try { close(carrier, cancelled()) } catch (error) { errors.push(error) }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'Relay readers reported errors during release.')
    }
  }
}
