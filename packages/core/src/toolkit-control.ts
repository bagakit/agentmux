import { createConnection } from 'node:net'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from './control.js'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from './control-host.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { parseToolkitSnapshot, type ToolkitRequest, type ToolkitSnapshot } from './toolkit.js'

export type ToolkitStreamFrame = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string; ok: true; operation: 'toolkit.watch'
} & ({ event: 'attached'; result: Record<string, never> } |
  { event: 'snapshot'; result: { snapshot: ToolkitSnapshot } } | { event: 'end'; result: { reason: string } })

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
