import { createHash } from 'node:crypto'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxClientEvent, AgentMuxRunDataEvent, AgentMuxRunInputOperation } from './types.js'
import { AgentMuxError } from './errors.js'
import { EXECUTION_FRAME_LIMIT } from './agent-execution-channel.js'

type Side = 'frontend' | 'executor'
export type AgentExecutionBridgePort = Pick<AgentMuxClient,
  'attachTerminal' | 'readRunReplay' | 'writeTerminal' | 'runtimeIdentity' | 'onRunEvent' | 'releaseRunAttachment'>
export interface AgentExecutionBridgePosition {
  runId: string
  ownerInstanceId: string
  outputByte: number
  inputByte: number
}
export interface AgentExecutionBridgeState {
  bindingId: string
  frontend: AgentExecutionBridgePosition
  executor: AgentExecutionBridgePosition
  pending?: { source: Side; sourceStartByte: number; sourceEndByte: number; digest: string; operation: Omit<AgentMuxRunInputOperation, 'data'> }
}

/**
 * A reader/forwarder over two existing ctxmux Runs. It owns no processes, byte
 * log, native retries, or Session state. Closing it only releases its readers.
 */
export class AgentExecutionBridge {
  private state: AgentExecutionBridgeState
  private tail: Promise<void> = Promise.resolve()
  private releases: (() => void)[] = []
  private stopped = false
  private queuedBytes = 0
  private readonly partial: Record<Side, { parts: Buffer[]; bytes: number }> = { frontend: { parts: [], bytes: 0 }, executor: { parts: [], bytes: 0 } }
  private readonly readThrough: Record<Side, number>
  constructor(private readonly options: {
    state: AgentExecutionBridgeState
    ports: Record<Side, AgentExecutionBridgePort>
    /** Must durably acknowledge this exact state before returning. */
    persist(state: AgentExecutionBridgeState): Promise<void>
    /** Idempotent observation only: replay may repeat frames; this callback grants no new action. */
    onFrame(side: Side, frame: unknown): Promise<void>
    onError(error: Error): void
  }) {
    this.state = structuredClone(options.state)
    this.readThrough = { frontend: this.state.frontend.outputByte, executor: this.state.executor.outputByte }
    if (this.state.frontend.runId === this.state.executor.runId && options.ports.frontend === options.ports.executor)
      throw new AgentMuxError('Execution bridge requires distinct original helper Runs.', 'INVALID_EXECUTION_BINDING')
  }
  snapshot(): AgentExecutionBridgeState { return structuredClone(this.state) }
  private async save(next: AgentExecutionBridgeState): Promise<void> {
    await this.options.persist(structuredClone(next))
    this.state = next
  }
  private fail(error: unknown): void {
    if (this.stopped) return
    this.stopped = true
    for (const release of this.releases.splice(0)) release()
    this.options.onError(error instanceof Error ? error : new Error(String(error)))
  }
  private enqueue(side: Side, data: { startByte: number; endByte: number; dataBytes: Uint8Array }): void {
    if (this.stopped) return
    this.queuedBytes += data.dataBytes.byteLength
    if (this.queuedBytes > EXECUTION_FRAME_LIMIT * 2) {
      this.fail(new AgentMuxError('The execution reader is backpressured; retain its original byte cursor and reattach.', 'EXECUTION_READER_BACKPRESSURED'))
      return
    }
    const frozen = { ...data, dataBytes: Buffer.from(data.dataBytes) }
    this.tail = this.tail.then(async () => { if (!this.stopped) await this.consume(side, frozen) })
      .catch(error => this.fail(error)).finally(() => { this.queuedBytes -= frozen.dataBytes.byteLength })
  }
  async start(): Promise<void> {
    // Retry only the Runtime's ORIGINAL recoverable Input claim. No new native
    // operation or process may be synthesized from an uncertain acknowledgement.
    if (this.state.pending) await this.deliverPending()
    for (const side of ['frontend', 'executor'] as const) {
      const port = this.options.ports[side], position = this.state[side]
      const identity = await port.runtimeIdentity()
      if (identity.instanceId !== position.ownerInstanceId) throw new AgentMuxError(
        'The original helper Runtime instance is unavailable. No replacement helper was started.', 'EXECUTION_RUNTIME_CHANGED')
      let opening = true
      const waiting: { startByte: number; endByte: number; dataBytes: Uint8Array }[] = []
      let waitingBytes = 0
      const receive = (event: AgentMuxClientEvent) => {
        if (event.type !== 'terminal-output' || event.run.runId !== position.runId) return
        const range = event.evidence.outputByteRange
        if (!range) { this.fail(new Error('Execution output has no authoritative byte range')); return }
        const data = { ...range, dataBytes: event.dataBytes }
        if (!opening) { this.enqueue(side, data); return }
        waitingBytes += data.dataBytes.byteLength
        if (waitingBytes > EXECUTION_FRAME_LIMIT * 2) { this.fail(new Error('Execution attachment replay exceeded its reader budget')); return }
        waiting.push({ ...data, dataBytes: Uint8Array.from(data.dataBytes) })
      }
      this.releases.push(port.onRunEvent(position.runId, receive, { observeMessages: false, onError: error => this.fail(new Error(error.message)) }))
      const attached = await port.attachTerminal(position.runId, position.outputByte, 'raw')
      if (attached.run.state !== 'running') throw new AgentMuxError(
        'The original helper is not confirmed running. Historical output does not establish a live execution service.', 'EXECUTION_HELPER_UNAVAILABLE')
      if (attached.run.runId !== position.runId || attached.gap) throw new AgentMuxError(
        'The original execution protocol has an output Gap; its tool outcomes remain unknown.', 'EXECUTION_PROTOCOL_GAP')
      for (const data of attached.replay) this.enqueue(side, data)
      opening = false
      for (const data of waiting) this.enqueue(side, data)
    }
    await this.tail
    if (this.stopped) throw new AgentMuxError('The execution reader could not establish its original continuation.', 'EXECUTION_READER_UNAVAILABLE')
  }
  private async consume(side: Side, data: Pick<AgentMuxRunDataEvent, 'startByte' | 'endByte' | 'dataBytes'>): Promise<void> {
    if (data.endByte <= this.readThrough[side]) return // Exact attachment/live overlap only.
    if (data.startByte > this.readThrough[side] || data.endByte - data.startByte !== data.dataBytes.byteLength)
      throw new AgentMuxError('Execution output is not contiguous with its original cursor.', 'EXECUTION_PROTOCOL_GAP')
    if (data.startByte < this.readThrough[side]) data = { ...data,
      dataBytes: data.dataBytes.subarray(this.readThrough[side] - data.startByte), startByte: this.readThrough[side] }
    const partial = this.partial[side]
    const bytes = Buffer.from(data.dataBytes.buffer, data.dataBytes.byteOffset, data.dataBytes.byteLength)
    let from = 0
    while (from < bytes.length) {
      const newline = bytes.indexOf(10, from)
      const end = newline < 0 ? bytes.length : newline
      const part = bytes.subarray(from, end)
      partial.bytes += part.length
      if (partial.bytes > EXECUTION_FRAME_LIMIT) throw new Error('Execution frame exceeds its declared byte limit')
      partial.parts.push(part)
      if (newline < 0) break
      const line = Buffer.concat(partial.parts, partial.bytes)
      partial.parts = []; partial.bytes = 0
      const frame = JSON.parse(line.toString('utf8')) as { type?: unknown }
      const sourceEndByte = data.startByte + newline + 1
      const forward = side === 'frontend' ? frame.type === 'request' || frame.type === 'closed' : frame.type === 'response'
      if (forward) {
        const target = side === 'frontend' ? 'executor' : 'frontend'
        const operationId = createHash('sha256').update(JSON.stringify([this.state.bindingId, side, sourceEndByte])).digest('hex')
        const operation = { ownerInstanceId: this.state[target].ownerInstanceId, operationId,
          expectedByte: this.state[target].inputByte }
        const original = Buffer.concat([line, Buffer.from('\n')])
        const digest = createHash('sha256').update(original).digest('hex')
        await this.save({ ...this.state, pending: { source: side, sourceStartByte: this.state[side].outputByte, sourceEndByte, digest, operation } })
        await this.deliverPending(original)
      } else {
        await this.options.onFrame(side, frame)
        await this.save({ ...this.state, [side]: { ...this.state[side], outputByte: sourceEndByte } })
      }
      from = newline + 1
    }
    this.readThrough[side] = data.endByte
  }
  private async deliverPending(data?: Uint8Array): Promise<void> {
    const pending = this.state.pending!
    const target = pending.source === 'frontend' ? 'executor' : 'frontend'
    const position = this.state[target]
    const identity = await this.options.ports[target].runtimeIdentity()
    if (identity.instanceId !== pending.operation.ownerInstanceId) throw new AgentMuxError(
      'The original execution Input owner changed; its outcome remains unknown.', 'EXECUTION_RUNTIME_CHANGED')
    if (!data) {
      const source = this.state[pending.source]
      const originalSourceOwner = await this.options.ports[pending.source].runtimeIdentity()
      if (originalSourceOwner.instanceId !== source.ownerInstanceId) throw new AgentMuxError(
        'The original execution source Runtime changed; its Input was not resent.', 'EXECUTION_RUNTIME_CHANGED')
      const replay = await this.options.ports[pending.source].readRunReplay({ runId: source.runId }, pending.sourceStartByte, 'raw')
      const observedSourceOwner = await this.options.ports[pending.source].runtimeIdentity()
      if (observedSourceOwner.instanceId !== source.ownerInstanceId) throw new AgentMuxError(
        'The execution source Runtime changed during replay; its Input was not resent.', 'EXECUTION_RUNTIME_CHANGED')
      if (replay.run.runId !== source.runId || replay.gap) throw new AgentMuxError(
        'The original pending Input source has a Replay Gap; no replacement bytes were sent.', 'EXECUTION_PROTOCOL_GAP')
      const parts: Uint8Array[] = []
      let cursor = pending.sourceStartByte
      for (const chunk of replay.replay) {
        if (cursor === pending.sourceEndByte) break
        if (chunk.startByte !== cursor || chunk.endByte - chunk.startByte !== chunk.dataBytes.byteLength)
          throw new AgentMuxError('The original pending Input replay is not contiguous.', 'EXECUTION_PROTOCOL_GAP')
        const count = Math.min(chunk.endByte, pending.sourceEndByte) - cursor
        parts.push(chunk.dataBytes.subarray(0, count)); cursor += count
      }
      if (cursor !== pending.sourceEndByte) throw new AgentMuxError('The original pending Input source is incomplete.', 'EXECUTION_PROTOCOL_GAP')
      data = Buffer.concat(parts)
    }
    if (data.byteLength !== pending.sourceEndByte - pending.sourceStartByte || createHash('sha256').update(data).digest('hex') !== pending.digest)
      throw new AgentMuxError('The original pending Input bytes do not match their retained claim.', 'EXECUTION_INPUT_SOURCE_MISMATCH')
    const receipt = await this.options.ports[target].writeTerminal({ runId: position.runId }, { ...pending.operation, data })
    const bytes = data.byteLength
    const end = pending.operation.expectedByte + bytes
    if (receipt.runId !== position.runId || receipt.appliedByteRange?.startByte !== pending.operation.expectedByte ||
      receipt.appliedByteRange.endByte !== end || receipt.acceptedThroughByte === null || receipt.acceptedThroughByte < end)
      throw new AgentMuxError('Execution Input receipt does not identify the original byte range.', 'EXECUTION_INPUT_RECEIPT_MISMATCH')
    const next = { ...this.state, [target]: { ...position, inputByte: end },
      [pending.source]: { ...this.state[pending.source], outputByte: pending.sourceEndByte } }
    delete next.pending
    await this.save(next)
    this.readThrough[pending.source] = Math.max(this.readThrough[pending.source], pending.sourceEndByte)
  }
  async close(): Promise<void> {
    this.stopped = true
    for (const release of this.releases.splice(0)) release()
    await this.tail
    await Promise.allSettled((['frontend', 'executor'] as const).map(side =>
      this.options.ports[side].releaseRunAttachment({ runId: this.state[side].runId })))
  }
}
