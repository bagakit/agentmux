import type { Socket } from 'node:net'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from './control.js'
import { parseToolkitSnapshot, type AgentMuxToolkitPort, type ToolkitRequest, type ToolkitSnapshot } from './toolkit.js'

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
