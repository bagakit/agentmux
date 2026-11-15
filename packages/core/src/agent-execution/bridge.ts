import { createHash } from 'node:crypto'
import { inputChunkBytes, retainedInputFits } from '../recoverable-input-frame.js'
import type { AgentMuxClient } from '../client.js'
import type { AgentMuxClientEvent, AgentMuxRunDataEvent, AgentMuxRunInputOperation, AgentMuxNativeService, AgentMuxRunState } from '../types.js'
import { AgentMuxError } from '../errors.js'
import { observeRead } from '../observation-read.js'
import { EXECUTION_FRAME_LIMIT } from './channel.js'

export type AgentExecutionBridgeSide = 'frontend' | 'executor'
type Side = AgentExecutionBridgeSide
export interface AgentExecutionBridgeConnection {
  runId: string
  process: AgentMuxRunState | 'removed' | 'unobserved'
  reader: 'attached' | 'unavailable' | 'unobserved'
  readerDiagnostic?: { code: string; message: string }
  nativeService?: AgentMuxNativeService | null
}
export type AgentExecutionBridgePort = Pick<AgentMuxClient,
  'attachTerminal' | 'readRunReplay' | 'writeTerminal' | 'runtimeIdentity' | 'onRunEvent' | 'releaseRunAttachment'>
export interface AgentExecutionBridgePosition {
  runId: string
  ownerInstanceId: string
  outputByte: number
  inputByte: number
}
type PendingInput = { source: Side; sourceStartByte: number; sourceEndByte: number; digest: string; operation: Omit<AgentMuxRunInputOperation, 'data'>; chunk?: { offset: number; bytes: number } }
export interface AgentExecutionBridgeState {
  bindingId: string
  frontend: AgentExecutionBridgePosition
  executor: AgentExecutionBridgePosition
  pending?: PendingInput
  /** An independently outstanding Input from the opposite helper. */
  concurrentPending?: PendingInput
}

const sides = ['frontend', 'executor'] as const
const opposite = (side: Side): Side => side === 'frontend' ? 'executor' : 'frontend'
const pendingFor = (state: AgentExecutionBridgeState, side: Side): PendingInput | undefined =>
  state.pending?.source === side ? state.pending : state.concurrentPending?.source === side ? state.concurrentPending : undefined

function setPending(state: AgentExecutionBridgeState, side: Side, value?: PendingInput): AgentExecutionBridgeState {
  const other = pendingFor(state, opposite(side))
  const { pending: _pending, concurrentPending: _concurrentPending, ...positions } = state
  const primary = other ?? value
  return { ...positions, ...(primary ? { pending: primary } : {}), ...(other && value ? { concurrentPending: value } : {}) }
}

const chunkOperationId = (binding: string, side: Side, endByte: number, offset: number): string =>
  createHash('sha256').update(JSON.stringify([binding, side, endByte, offset])).digest('hex')

export type ExecutionFrameFact = { startByte: number; endByte: number; bytes: number; sha256: string; syntax: 'invalid-json' }

/** The machine channel retains safe frame provenance, never raw exception text. */
export class ExecutionProtocolFrameError extends AgentMuxError {
  constructor(readonly side: AgentExecutionBridgeSide, readonly frame: ExecutionFrameFact, cause: unknown) {
    super('The original helper emitted an invalid JSON protocol frame. Its Run and operations are retained.', 'EXECUTION_PROTOCOL_INVALID_FRAME')
    Object.defineProperty(this, 'cause', { value: cause })
  }
}

/**
 * A reader/forwarder over two existing ctxmux Runs. It owns no processes, byte
 * log, native retries, or Session state. Closing it only releases its readers.
 */
export class AgentExecutionBridge {
  private state: AgentExecutionBridgeState
  private readonly tails: Record<Side, Promise<void>> = { frontend: Promise.resolve(), executor: Promise.resolve() }
  private persistence = Promise.resolve()
  private readonly reader = new AbortController()
  private releases: (() => void)[] = []
  private stopped = false
  private firstFailure: Error | undefined
  private firstFailureSide: Side | undefined
  private readonly connections: Record<Side, AgentExecutionBridgeConnection>
  private readonly queuedBytes: Record<Side, number> = { frontend: 0, executor: 0 }
  private readonly partial: Record<Side, { parts: Buffer[]; bytes: number }> = { frontend: { parts: [], bytes: 0 }, executor: { parts: [], bytes: 0 } }
  private readonly readThrough: Record<Side, number>
  constructor(private readonly options: {
    state: AgentExecutionBridgeState
    ports: Record<Side, AgentExecutionBridgePort>
    /** Must durably acknowledge this exact state before returning. */
    persist(state: AgentExecutionBridgeState): Promise<void>
    /** Idempotent observation only: replay may repeat frames; this callback grants no new action. */
    onFrame(side: Side, frame: unknown): Promise<void>
    onObservationError?(side: Side, error: unknown): void
    onError(error: Error): void
    /** Exact helper facts; no Session lifecycle or native operation inference. */
    onConnection?(side: Side, connection: AgentExecutionBridgeConnection): void
  }) {
    this.state = structuredClone(options.state)
    this.connections = Object.fromEntries(sides.map(side => [side, { runId: this.state[side].runId, process: 'unobserved', reader: 'unobserved' }])) as Record<Side, AgentExecutionBridgeConnection>
    this.readThrough = { frontend: this.state.frontend.outputByte, executor: this.state.executor.outputByte }
    if (this.state.frontend.runId === this.state.executor.runId && options.ports.frontend === options.ports.executor)
      throw new AgentMuxError('Execution bridge requires distinct original helper Runs.', 'INVALID_EXECUTION_BINDING')
  }
  private publishConnection(side: Side): void { this.options.onConnection?.(side, structuredClone(this.connections[side])) }
  snapshot(): AgentExecutionBridgeState { return structuredClone(this.state) }
  private save(update: (state: AgentExecutionBridgeState) => AgentExecutionBridgeState): Promise<void> {
    // Only the journal writer is shared. Each commit merges into the latest
    // acknowledged state without holding this writer across either runtime I/O.
    const commit = this.persistence.then(async () => {
      this.assertOpen()
      const next = update(this.state)
      try { await this.options.persist(structuredClone(next)) }
      catch (error) { throw this.fail(error) }
      this.state = next
    })
    this.persistence = commit.catch(() => {})
    return commit
  }
  get failureSide(): Side | undefined { return this.firstFailureSide }
  private fail(error: unknown, side?: Side): Error {
    if (this.stopped) return this.firstFailure ?? (error instanceof Error ? error : new Error(String(error)))
    this.firstFailure = error instanceof Error ? error : new Error(String(error))
    this.firstFailureSide = side
    this.stopped = true
    this.reader.abort(this.firstFailure)
    for (const release of this.releases.splice(0)) { try { release() } catch { /* Cleanup cannot replace the original reader failure. */ } }
    this.options.onError(this.firstFailure)
    return this.firstFailure
  }
  private async endpoint<T>(side: Side, operation: () => T | Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) { throw this.fail(error, side) }
  }
  private assertOpen(): void {
    if (this.firstFailure) throw this.firstFailure
    if (this.stopped) throw new AgentMuxError('The original execution reader was closed. Its helpers and admitted operations remain retained.', 'EXECUTION_READER_UNAVAILABLE')
  }
  private enqueue(side: Side, data: { startByte: number; endByte: number; dataBytes: Uint8Array }): void {
    if (this.stopped) return
    this.queuedBytes[side] += data.dataBytes.byteLength
    if (this.queuedBytes[side] > EXECUTION_FRAME_LIMIT * 2) {
      this.fail(new AgentMuxError('The execution reader is backpressured; retain its original byte cursor and reattach.', 'EXECUTION_READER_BACKPRESSURED'), side)
      return
    }
    const frozen = { ...data, dataBytes: Buffer.from(data.dataBytes) }
    this.tails[side] = this.tails[side].then(async () => { if (!this.stopped) await this.consume(side, frozen) })
      .catch(error => { this.fail(error) }).finally(() => { this.queuedBytes[side] -= frozen.dataBytes.byteLength })
  }
  async start(): Promise<void> {
    try { await this.open() }
    catch (error) {
      try { this.fail(error) } catch { /* A failing observer cannot replace this original cause. */ }
      try { await this.close() } catch { /* Retain the first failure even if its exact reader cleanup fails. */ }
      throw this.firstFailure ?? error
    }
  }
  private async open(): Promise<void> {
    this.assertOpen()
    // Retry only the Runtime's ORIGINAL recoverable Input claim. No new native
    // operation or process may be synthesized from an uncertain acknowledgement.
    for (const side of sides) if (pendingFor(this.state, side)) {
      this.tails[side] = this.deliverPending(side).catch(error => { this.fail(error) })
    }
    for (const side of sides) {
      this.assertOpen()
      const port = this.options.ports[side], position = this.state[side]
      const identity = await this.endpoint(side, () => port.runtimeIdentity())
      this.assertOpen()
      if (identity.instanceId !== position.ownerInstanceId) throw this.fail(new AgentMuxError(
        'The original helper Runtime instance is unavailable. No replacement helper was started.', 'EXECUTION_RUNTIME_CHANGED'), side)
      let opening = true, processObserved = false, attachmentObserved = false
      const connection = this.connections[side]
      const service = (value: AgentMuxNativeService | null | undefined) => {
        if (value !== undefined && (value === null ? connection.nativeService === undefined : !connection.nativeService || value.revision > connection.nativeService.revision)) connection.nativeService = structuredClone(value)
      }
      const waiting: { startByte: number; endByte: number; dataBytes: Uint8Array }[] = []
      let waitingBytes = 0
      const receiveBytes = (data: { startByte: number; endByte: number; dataBytes: Uint8Array }) => {
        if (!opening) { this.enqueue(side, data); return }
        waitingBytes += data.dataBytes.byteLength
        if (waitingBytes > EXECUTION_FRAME_LIMIT * 2) { this.fail(new AgentMuxError('Execution attachment replay exceeded its reader budget', 'EXECUTION_READER_BACKPRESSURED'), side); return }
        waiting.push({ ...data, dataBytes: Uint8Array.from(data.dataBytes) })
      }
      const receive = (event: AgentMuxClientEvent) => {
        if (this.stopped || !('run' in event) || event.run?.runId !== position.runId) return
        if (event.type === 'process-state' || event.type === 'run-removed') {
          processObserved = true
          // A restored reader cannot revive a Run with a confirmed terminal fact.
          if (connection.process === 'unobserved' || connection.process === 'running') connection.process = event.type === 'run-removed' ? 'removed' : event.state
          this.publishConnection(side); return
        }
        if (event.type === 'attachment-state') {
          attachmentObserved = true; connection.reader = event.state === 'restored' ? 'attached' : 'unavailable'
          if (event.state === 'unavailable') connection.readerDiagnostic = structuredClone(event.diagnostic)
          else delete connection.readerDiagnostic
          this.publishConnection(side); return
        }
        if (event.type === 'run-service') { service(event.nativeService); this.publishConnection(side); return }
        if (event.type === 'terminal-snapshot') {
          if (connection.process === 'unobserved' || connection.process === 'running') connection.process = event.run.state
          processObserved = true; service(event.run.nativeService)
          this.publishConnection(side)
          if (event.gap) { this.fail(new AgentMuxError('The original helper snapshot contains an output Gap.', 'EXECUTION_PROTOCOL_GAP'), side); return }
          for (const data of event.replay) receiveBytes(data)
          return
        }
        if (event.type !== 'terminal-output') return
        const range = event.evidence.outputByteRange
        if (!range) { this.fail(new Error('Execution output has no authoritative byte range'), side); return }
        receiveBytes({ ...range, dataBytes: event.dataBytes })
      }
      const release = await this.endpoint(side, () => port.onRunEvent(position.runId, receive, { observeMessages: false, onError: error => {
        const failure = error instanceof AgentMuxError ? error : new AgentMuxError(error.message, error.code)
        if (failure !== error) Object.defineProperty(failure, 'cause', { value: error })
        this.fail(failure, side)
      } }))
      if (this.stopped) {
        try { release() } catch { /* The registration callback already retained its original failure. */ }
        this.assertOpen()
      }
      this.releases.push(release)
      const attached = await this.endpoint(side, () => port.attachTerminal(position.runId, position.outputByte, 'raw'))
      this.assertOpen()
      if (attached.run.state !== 'running') throw this.fail(new AgentMuxError(
        'The original helper is not confirmed running. Historical output does not establish a live execution service.', 'EXECUTION_HELPER_UNAVAILABLE'), side)
      if (attached.run.runId !== position.runId || attached.gap) throw this.fail(new AgentMuxError(
        'The original execution protocol has an output Gap; its tool outcomes remain unknown.', 'EXECUTION_PROTOCOL_GAP'), side)
      if (!processObserved) connection.process = attached.run.state
      if (!attachmentObserved) { connection.reader = 'attached'; delete connection.readerDiagnostic }
      service(attached.run.nativeService); this.publishConnection(side)
      for (const data of attached.replay) this.enqueue(side, data)
      opening = false
      for (const data of waiting) this.enqueue(side, data)
    }
    await Promise.all(Object.values(this.tails))
    this.assertOpen()
  }
  private async consume(side: Side, data: Pick<AgentMuxRunDataEvent, 'startByte' | 'endByte' | 'dataBytes'>): Promise<void> {
    if (data.endByte <= this.readThrough[side]) return // Exact attachment/live overlap only.
    if (data.startByte > this.readThrough[side] || data.endByte - data.startByte !== data.dataBytes.byteLength)
      throw this.fail(new AgentMuxError('Execution output is not contiguous with its original cursor.', 'EXECUTION_PROTOCOL_GAP'), side)
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
      if (partial.bytes > EXECUTION_FRAME_LIMIT) throw this.fail(new Error('Execution frame exceeds its declared byte limit'), side)
      partial.parts.push(part)
      if (newline < 0) break
      const line = Buffer.concat(partial.parts, partial.bytes)
      partial.parts = []; partial.bytes = 0
      let frame: { type?: unknown }
      try { frame = JSON.parse(line.toString('utf8')) as { type?: unknown } }
      catch (error) { throw this.fail(new ExecutionProtocolFrameError(side, { startByte: this.state[side].outputByte, endByte: data.startByte + newline + 1, bytes: line.length, sha256: createHash('sha256').update(line).digest('hex'), syntax: 'invalid-json' }, error), side) }
      const sourceEndByte = data.startByte + newline + 1
      const forward = side === 'frontend' ? ['request', 'closed', 'agent-rpc-context', 'agent-rpc-response', 'agent-rpc-closed'].includes(String(frame.type)) : ['response', 'agent-rpc-request', 'agent-rpc-close'].includes(String(frame.type))
      if (forward) {
        const target = opposite(side)
        const operationId = chunkOperationId(this.state.bindingId, side, sourceEndByte, 0)
        const operation = { ownerInstanceId: this.state[target].ownerInstanceId, operationId,
          expectedByte: this.state[target].inputByte }
        const original = Buffer.concat([line, Buffer.from('\n')])
        const digest = createHash('sha256').update(original).digest('hex')
        await this.save(state => setPending(state, side, { source: side, sourceStartByte: state[side].outputByte, sourceEndByte, digest, operation, chunk: { offset: 0, bytes: inputChunkBytes(state[target].runId, operation) } }))
        await this.deliverPending(side, original)
      } else {
        try { await observeRead(this.options.onFrame(side, frame), this.reader.signal) }
        catch (error) {
          if (this.stopped) return
          try { this.options.onObservationError?.(side, error) } catch { /* Diagnostic publication is independent of the transport. */ }
        }
        await this.save(state => ({ ...state, [side]: { ...state[side], outputByte: sourceEndByte } }))
      }
      from = newline + 1
    }
    this.readThrough[side] = data.endByte
  }
  private async deliverPending(side: Side, data?: Uint8Array): Promise<void> {
    const pending = pendingFor(this.state, side)!
    const target = opposite(side)
    const position = this.state[target]
    const identity = await this.endpoint(target, () => this.options.ports[target].runtimeIdentity())
    if (identity.instanceId !== pending.operation.ownerInstanceId) throw this.fail(new AgentMuxError(
      'The original execution Input owner changed; its outcome remains unknown.', 'EXECUTION_RUNTIME_CHANGED'), target)
    if (!data) {
      const source = this.state[pending.source]
      const originalSourceOwner = await this.endpoint(pending.source, () => this.options.ports[pending.source].runtimeIdentity())
      if (originalSourceOwner.instanceId !== source.ownerInstanceId) throw this.fail(new AgentMuxError(
        'The original execution source Runtime changed; its Input was not resent.', 'EXECUTION_RUNTIME_CHANGED'), pending.source)
      const replay = await this.endpoint(side, () => observeRead(this.options.ports[side].readRunReplay({ runId: source.runId }, pending.sourceStartByte, 'raw'), this.reader.signal))
      const observedSourceOwner = await this.endpoint(pending.source, () => this.options.ports[pending.source].runtimeIdentity())
      if (observedSourceOwner.instanceId !== source.ownerInstanceId) throw this.fail(new AgentMuxError(
        'The execution source Runtime changed during replay; its Input was not resent.', 'EXECUTION_RUNTIME_CHANGED'), pending.source)
      if (replay.run.runId !== source.runId || replay.gap) throw this.fail(new AgentMuxError(
        'The original pending Input source has a Replay Gap; no replacement bytes were sent.', 'EXECUTION_PROTOCOL_GAP'), pending.source)
      const parts: Uint8Array[] = []
      let cursor = pending.sourceStartByte
      for (const chunk of replay.replay) {
        if (cursor === pending.sourceEndByte) break
        if (chunk.startByte !== cursor || chunk.endByte - chunk.startByte !== chunk.dataBytes.byteLength)
          throw this.fail(new AgentMuxError('The original pending Input replay is not contiguous.', 'EXECUTION_PROTOCOL_GAP'), pending.source)
        const count = Math.min(chunk.endByte, pending.sourceEndByte) - cursor
        parts.push(chunk.dataBytes.subarray(0, count)); cursor += count
      }
      if (cursor !== pending.sourceEndByte) throw this.fail(new AgentMuxError('The original pending Input source is incomplete.', 'EXECUTION_PROTOCOL_GAP'), pending.source)
      data = Buffer.concat(parts)
    }
    if (data.byteLength !== pending.sourceEndByte - pending.sourceStartByte || createHash('sha256').update(data).digest('hex') !== pending.digest)
      throw new AgentMuxError('The original pending Input bytes do not match their retained claim.', 'EXECUTION_INPUT_SOURCE_MISMATCH')
    for (let current = pendingFor(this.state, side); current; current = pendingFor(this.state, side)) {
      this.assertOpen()
      const offset = current.chunk?.offset ?? 0
      const limit = current.chunk?.bytes ?? data.byteLength
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.byteLength || !Number.isSafeInteger(limit) || limit < 1 ||
          (current.chunk ? Math.min(limit, data.byteLength - offset) > inputChunkBytes(position.runId, current.operation) : !retainedInputFits(position.runId, current.operation, data)))
        throw new AgentMuxError('The retained Input layout exceeds its original Runtime transport budget; its outcome remains unknown.', 'EXECUTION_INPUT_SIZE_UNCONFIRMED')
      // A previously persisted whole-frame operation has no chunk layout. Its ID
      // and bytes remain exact: an oversized unknown claim is never repartitioned.
      const part = data.subarray(offset, Math.min(data.byteLength, offset + limit))
      const operation = current.operation
      const receipt = await this.endpoint(target, () => observeRead(this.options.ports[target].writeTerminal({ runId: position.runId }, { ...operation, data: part }), this.reader.signal))
      const end = operation.expectedByte + part.byteLength
      if (receipt.runId !== position.runId || receipt.appliedByteRange?.startByte !== operation.expectedByte ||
        receipt.appliedByteRange.endByte !== end || receipt.acceptedThroughByte === null || receipt.acceptedThroughByte < end)
        throw this.fail(new AgentMuxError('Execution Input receipt does not identify the original byte range.', 'EXECUTION_INPUT_RECEIPT_MISMATCH'), target)
      const through = offset + part.byteLength
      if (through < data.byteLength) {
        const nextOperation = { ...operation, expectedByte: end,
          operationId: chunkOperationId(this.state.bindingId, current.source, current.sourceEndByte, through) }
        // Keep the source cursor at the start of the entire JSON frame. A new
        // reader must reassemble and verify that frame before resuming this chunk.
        const next = { ...current, operation: nextOperation, chunk: { offset: through, bytes: limit } }
        await this.save(state => setPending({ ...state, [target]: { ...state[target], inputByte: end } }, side, next))
      } else {
        const sourceEndByte = current.sourceEndByte
        await this.save(state => setPending({ ...state, [target]: { ...state[target], inputByte: end },
          [side]: { ...state[side], outputByte: sourceEndByte } }, side))
        this.readThrough[side] = Math.max(this.readThrough[side], sourceEndByte)
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true
    this.reader.abort(new AgentMuxError('The original execution reader was closed. Its helpers and admitted operations remain retained.', 'EXECUTION_READER_UNAVAILABLE'))
    for (const release of this.releases.splice(0)) release()
    await Promise.all(Object.values(this.tails))
    await Promise.allSettled(sides.map(side =>
      this.options.ports[side].releaseRunAttachment({ runId: this.state[side].runId })))
  }
}
