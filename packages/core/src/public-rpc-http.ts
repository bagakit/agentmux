import type { JSONRPCRequest } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from './public-rpc-frame.js'
import { rpcTransportError } from './rpc-transport-error.js'

export * from './public-rpc-frame.js'
export { AgentMuxError } from './errors.js'
export { encodeHostedValue, decodeHostedValue } from './hosted-value.js'

export type AgentMuxRpcHttpClientOptions = {
  url: string
  token?: string
  credentials?: RequestCredentials
  /** A native client may supply its OS transport for this request only. */
  fetch?: typeof globalThis.fetch
}
export type AgentMuxRpcHttpReader = { dispose(): Promise<void> }

/** Shared HTTP transport. Credentials remain with the client and transport authority. */
export async function openAgentMuxRpcHttpRequest(options: AgentMuxRpcHttpClientOptions,
  request: JSONRPCRequest, onFrame: (frame: unknown) => void,
  onEnd: (error?: Error) => void, signal: AbortSignal): Promise<AgentMuxRpcHttpReader> {
  if (signal.aborted) throw new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')
  const body = rpcEncode(request).trimEnd()
  let response: Response
  try {
    response = await (options.fetch ?? globalThis.fetch)(options.url, {
      method: 'POST', redirect: 'error', signal,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      headers: { 'Content-Type': 'application/json',
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }) }, body
    })
  } catch (error) {
    throw signal.aborted ? new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED') : rpcTransportError(error)
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {})
    throw new AgentMuxError('HTTP RPC authorization was rejected.', 'AGENT_CAPABILITY_INVALID')
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new AgentMuxError('HTTP RPC service is unavailable.', 'CONTROL_UNAVAILABLE')
  }
  const reader = response.body.getReader()
  let closed = false
  const dispose = async () => {
    if (closed) return
    closed = true; signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
  }
  const finish = (error?: Error) => {
    if (closed) return
    void dispose(); onEnd(error)
  }
  const abort = () => finish(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  void (async () => {
    try {
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (type === 'application/json') {
        const chunks: Uint8Array[] = []; let size = 0
        while (!closed) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('HTTP RPC response exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')
          chunks.push(value)
        }
        if (!closed) {
          const bytes = new Uint8Array(size); let position = 0
          for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength }
          onFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
        }
      } else if (type === 'text/event-stream') {
        const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
        let buffer = ''
        while (!closed) {
          const { value, done } = await reader.read()
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          let separator: RegExpExecArray | null
          while (!closed && (separator = /\r?\n\r?\n/u.exec(buffer))) {
            const event = buffer.slice(0, separator.index)
            buffer = buffer.slice(separator.index + separator[0].length)
            if (encoder.encode(event).byteLength > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('SSE RPC frame exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')
            const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart()).join('\n')
            if (!data) throw new AgentMuxError('SSE stream lacks a complete RPC frame.', 'CONTROL_PROTOCOL_ERROR')
            onFrame(JSON.parse(data))
          }
          if (encoder.encode(buffer).byteLength > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('SSE RPC frame exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')
          if (done) break
        }
        if (!closed && buffer.length) throw new AgentMuxError('SSE stream ended with an incomplete frame.', 'CONTROL_PROTOCOL_ERROR')
      } else throw new AgentMuxError('Unexpected HTTP RPC content type.', 'CONTROL_PROTOCOL_ERROR')
      finish()
    } catch (error) { finish(rpcTransportError(error)) }
  })()
  return { dispose }
}
