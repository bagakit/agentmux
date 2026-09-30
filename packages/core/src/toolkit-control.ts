import { createConnection, type Socket } from 'node:net'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from './control.js'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from './control-host.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { parseToolkitSnapshot, type AgentMuxToolkitPort, type ToolkitRequest, type ToolkitSnapshot } from './toolkit.js'

export type ToolkitStreamFrame = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string; ok: true; operation: 'toolkit.watch'
} & ({ event: 'attached'; result: Record<string, never> } |
  { event: 'snapshot'; result: { snapshot: ToolkitSnapshot } } | { event: 'end'; result: { reason: string } })

export async function serveToolkitControl(socket: Socket, request: ToolkitRequest,
  port: AgentMuxToolkitPort | undefined, streams: Set<Socket>): Promise<void> {
  socket.setTimeout(0)
  const controller = new AbortController()
  let closed = false, opened = false, blocked = false
  let subscription: { dispose(): void } | undefined
  let latest: ToolkitSnapshot | null = null, pending: string | null = null
  const dispose = () => {
    if (closed) return
    closed = true; clearTimeout(deadline); controller.abort()
    try { subscription?.dispose() } catch { /* Host reports cleanup separately. */ }
    pending = null; streams.delete(socket)
    socket.off('end', disconnect); socket.off('close', disconnect); socket.off('error', disconnect); socket.off('drain', drain)
  }
  const disconnect = () => { dispose(); socket.destroy() }
  const encode = (value: unknown) => {
    const line = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(line) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Toolkit frame exceeds the Control budget.', 'CONTROL_FAILED')
    return line
  }
  const envelope = (event: string, result: unknown) => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: request.requestId, operation: request.operation, ok: true, event, result })
  const fail = (error: unknown) => {
    if (closed) return
    const e = error instanceof AgentMuxError ? error : new AgentMuxError(String(error), 'CONTROL_FAILED')
    const line = encode({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId,
      operation: request.operation, ok: false, error: { code: e.code, message: e.message.slice(0,4096) } })
    dispose(); if (!socket.destroyed) socket.end(line, () => socket.destroy())
  }
  const send = (snapshot: ToolkitSnapshot) => {
    const line = encode(envelope('snapshot', { snapshot: parseToolkitSnapshot(snapshot) }))
    if (blocked) pending = line
    else blocked = !socket.write(line)
  }
  const drain = () => {
    blocked = false
    if (!closed && pending) { const line = pending; pending = null; blocked = !socket.write(line) }
  }
  const deadline = setTimeout(() => fail(new AgentMuxError('Toolkit establishment timed out; outcome is unconfirmed.', 'CONTROL_TIMEOUT')),
    agentMuxControlTimeoutMs(request.operation))
  socket.once('close', disconnect); socket.once('end', disconnect); socket.once('error', disconnect); socket.on('drain', drain)
  streams.add(socket)
  if (!port) { fail(new AgentMuxError('Control owner does not provide Toolkit.', 'CONTROL_UNAVAILABLE')); return }
  try {
    if (request.operation !== 'toolkit.watch') {
      const { operation, ...result } = await port.execute(request, controller.signal)
      if (closed || controller.signal.aborted) return
      if (operation !== request.operation) throw new AgentMuxError('Toolkit operation mismatch.', 'CONTROL_PROTOCOL_ERROR')
      const line = encode({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId, operation, ok: true, result })
      dispose(); socket.end(line, () => socket.destroy()); return
    }
    const established = await port.subscribe(request.toolId, value => {
      if (closed) return
      try { latest = parseToolkitSnapshot(value); if (opened) send(latest) } catch (error) { fail(error) }
    }, error => {
      if (closed) return
      if (error || !opened) { fail(error ?? new AgentMuxError('Toolkit owner ended during establishment.', 'CONTROL_UNAVAILABLE')); return }
      const line = encode(envelope('end', { reason: 'owner-ended' }))
      dispose(); socket.end(line, () => socket.destroy())
    }, controller.signal)
    if (closed || controller.signal.aborted) { established.dispose(); return }
    subscription = established
    blocked = !socket.write(encode(envelope('attached', {})))
    opened = true; clearTimeout(deadline)
    if (latest) send(latest)
  } catch (error) { fail(error) }
}

export async function subscribeAgentMuxToolkit(value: ToolkitRequest,
  handlers: { onFrame(frame: ToolkitStreamFrame): void; onEnd(error?: Error): void },
  options: { path?: string; signal?: AbortSignal } = {}): Promise<{ dispose(): void }> {
  const request = parseAgentMuxControlRequest(value)
  if (request.operation !== 'toolkit.watch') throw new AgentMuxError('Toolkit subscription requires watch.', 'INVALID_CONTROL_REQUEST')
  const socket = createConnection(options.path ?? defaultAgentMuxControlSocketPath())
  let opened = false, closed = false, buffer = Buffer.alloc(0)
  return await new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      if (closed) return
      closed = true; clearTimeout(deadline); options.signal?.removeEventListener('abort', abort); socket.destroy()
      if (!opened) reject(error ?? new AgentMuxError('Toolkit ended before opening.', 'CONTROL_PROTOCOL_ERROR'))
      else handlers.onEnd(error)
    }
    const abort = () => finish(new AgentMuxError('Toolkit consumer cancelled.', 'CONTROL_CANCELLED'))
    const deadline = setTimeout(() => finish(new AgentMuxError('Toolkit establishment timed out.', 'CONTROL_TIMEOUT')), agentMuxControlTimeoutMs(request.operation))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    socket.once('error', (error: NodeJS.ErrnoException) => finish(new AgentMuxError(error.message,
      ['ENOENT','ECONNREFUSED'].includes(error.code ?? '') ? 'CONTROL_UNAVAILABLE' : 'CONTROL_PROTOCOL_ERROR')))
    const eof = () => finish(buffer.length ? new AgentMuxError('Incomplete Toolkit NDJSON at EOF.', 'CONTROL_PROTOCOL_ERROR') : undefined)
    socket.once('end', eof); socket.once('close', eof)
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      if (closed) return
      buffer = Buffer.concat([buffer, chunk])
      try {
        let lf: number
        while (!closed && (lf = buffer.indexOf(10)) >= 0) {
          if (lf + 1 > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Toolkit frame exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
          const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0,lf)))
          buffer = buffer.subarray(lf+1)
          if (raw.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION || raw.requestId !== request.requestId || raw.operation !== request.operation) throw new AgentMuxError('Toolkit stream identity mismatch.', 'CONTROL_PROTOCOL_ERROR')
          if (raw.ok === false) { const r = parseAgentMuxControlReceipt(raw); if (!r.ok) throw new AgentMuxError(r.error.message,r.error.code) }
          if (raw.ok !== true || !raw.result || Object.keys(raw).some(k => !['schemaVersion','requestId','operation','ok','event','result'].includes(k))) throw new AgentMuxError('Toolkit stream frame is invalid.', 'CONTROL_PROTOCOL_ERROR')
          let frame: ToolkitStreamFrame
          if (!opened) {
            if (raw.event !== 'attached' || Object.keys(raw.result).length) throw new AgentMuxError('Toolkit opening is invalid.', 'CONTROL_PROTOCOL_ERROR')
            opened = true; clearTimeout(deadline); frame = raw
            resolve({ dispose: () => finish() })
          } else if (raw.event === 'snapshot' && Object.keys(raw.result).join() === 'snapshot') {
            frame = { ...raw, result: { snapshot: parseToolkitSnapshot(raw.result.snapshot) } }
          } else if (raw.event === 'end' && Object.keys(raw.result).join() === 'reason' && typeof raw.result.reason === 'string') frame = raw
          else throw new AgentMuxError('Toolkit stream boundary is invalid.', 'CONTROL_PROTOCOL_ERROR')
          handlers.onFrame(frame)
          if (closed) return
          if (frame.event === 'end') { finish(); return }
        }
        if (buffer.length > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Toolkit incomplete frame exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
      } catch (error) { finish(error instanceof AgentMuxError ? error : new AgentMuxError('Toolkit stream is invalid.', 'CONTROL_PROTOCOL_ERROR')) }
    })
  })
}
