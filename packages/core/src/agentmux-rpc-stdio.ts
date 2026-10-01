import { createConnection } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import type { AgentMuxRpcEndpoint } from './public-rpc.js'
import { AgentMuxError } from './errors.js'
import { rpcTransportError as transportError } from './rpc-transport-error.js'

/** Standard SSH stdio forwarding relays to the existing Unix business owner. It owns no Runtime. */
export async function forwardAgentMuxRpcStdio(options: { endpoint: AgentMuxRpcEndpoint; input: Readable; output: Writable; signal?: AbortSignal }): Promise<void> {
  if (options.endpoint.transport !== 'unix') throw new AgentMuxError('Stdio forwarding requires a Unix RPC endpoint.', 'INVALID_CLI_ARGUMENT')
  const socket = createConnection({ path: options.endpoint.path })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const stop = (error?: Error) => { if (settled) return; settled = true
      options.input.unpipe(socket); socket.unpipe(options.output); socket.destroy(); options.signal?.removeEventListener('abort', abort)
      if (error) reject(transportError(error)); else resolve() }
    const abort = () => stop()
    options.signal?.addEventListener('abort', abort, { once: true })
    socket.once('error', error => stop(error)); options.input.once('error', error => stop(error)); options.output.once('error', error => stop(error))
    socket.once('connect', () => { options.input.pipe(socket); socket.pipe(options.output, { end: false }) })
    socket.once('end', () => stop()); socket.once('close', () => stop())
    if (options.signal?.aborted) abort()
  })
}
