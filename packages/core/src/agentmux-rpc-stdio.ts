import { createConnection } from 'node:net'
import { PassThrough, Transform, type Readable, type Writable } from 'node:stream'
import type { AgentMuxRpcEndpoint } from './public-rpc.js'
import { AgentMuxError } from './errors.js'
import { rpcTransportError as transportError } from './rpc-transport-error.js'
import { isAgentMuxRpcDeviceMethod } from './public-rpc-device.js'
import { AgentMuxRpcLines, parseRpcRequest, rpcFailure, rpcEncode } from './public-rpc-frame.js'

/** Both directions share the existing bounded decoder and emit whole original frames. */
function frames(consume: (value: unknown, raw: Buffer) => Buffer | void | Promise<Buffer | void>): Transform {
  const lines = new AgentMuxRpcLines()
  let pieces: Buffer[] = []
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const accept = async () => {
        let offset = 0
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(10, offset)
          const end = newline < 0 ? chunk.byteLength : newline + 1
          const part = chunk.subarray(offset, end)
          pieces.push(Buffer.from(part))
          let complete = false, value: unknown
          lines.accept(part, parsed => { complete = true; value = parsed })
          if (complete) {
            const raw = Buffer.concat(pieces); pieces = []
            const outgoing = await consume(value, raw)
            if (outgoing) stream.push(outgoing)
          }
          offset = end
        }
      }
      void accept().then(() => callback(), error => callback(error))
    },
    flush(callback) { try { lines.end(); callback() } catch (error) { callback(error as Error) } },
    destroy(error, callback) { pieces = []; callback(error) }
  })
  return stream
}

/** Standard SSH stdio forwarding relays to the existing Unix business owner. It owns no Runtime. */
export async function forwardAgentMuxRpcStdio(options: { endpoint: AgentMuxRpcEndpoint; input: Readable; output: Writable; signal?: AbortSignal }): Promise<void> {
  if (options.endpoint.transport !== 'unix') throw new AgentMuxError('Stdio forwarding requires a Unix RPC endpoint.', 'INVALID_CLI_ARGUMENT')
  const outgoing = new PassThrough()
  // Validate a complete frame before forwarding any member. Ordinary bytes keep
  // their original spelling, while the maintained stream owns backpressure.
  const gate = frames(async (value, raw) => {
    if (Array.isArray(value) && !value.length) throw new AgentMuxError('An RPC batch cannot be empty.', 'CONTROL_PROTOCOL_ERROR')
    const requests = (Array.isArray(value) ? value : [value]).map(parseRpcRequest)
    if (!requests.some(request => isAgentMuxRpcDeviceMethod(request.method))) return raw
    const error = new AgentMuxError('Device management cannot be forwarded through stdio. Use the local Unix client and original Host confirmation.', 'CONTROL_PERMISSION_DENIED')
    const responses = requests.filter(request => Object.hasOwn(request, 'id')).map(request => rpcFailure(request.id!, error))
    if (responses.length) {
      const encoded = rpcEncode(Array.isArray(value) ? responses : responses[0])
      await new Promise<void>((resolve, reject) => outgoing.write(encoded, error => error ? reject(error) : resolve()))
    }
  })
  // A local denial cannot be inserted inside an upstream response/notification.
  const responses = frames((_value, raw) => raw)
  const socket = createConnection({ path: options.endpoint.path })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const stop = (error?: Error) => { if (settled) return; settled = true
      options.input.unpipe(gate); gate.unpipe(socket); gate.destroy()
      socket.unpipe(responses); responses.unpipe(outgoing); responses.destroy()
      outgoing.unpipe(options.output); outgoing.destroy(); socket.destroy(); options.signal?.removeEventListener('abort', abort)
      if (error) reject(transportError(error)); else resolve() }
    const abort = () => stop()
    options.signal?.addEventListener('abort', abort, { once: true })
    socket.once('error', error => stop(error)); gate.once('error', error => stop(error))
    responses.once('error', error => stop(error)); outgoing.once('error', error => stop(error))
    options.input.once('error', error => stop(error)); options.output.once('error', error => stop(error))
    socket.once('connect', () => {
      outgoing.pipe(options.output, { end: false })
      options.input.pipe(gate).pipe(socket); socket.pipe(responses).pipe(outgoing, { end: false })
    })
    responses.once('end', () => outgoing.end()); outgoing.once('end', () => stop())
    socket.once('close', () => { if (!socket.readableEnded) stop() })
    if (options.signal?.aborted) abort()
  })
}
