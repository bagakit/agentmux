import type {
  AgentMuxClientEvent,
  AgentMuxRunDataEvent,
  AgentMuxRunState
} from './types.js'
import { AgentMuxError } from './errors.js'

export type FollowOutput = {
  runId: string
  replay: boolean
  startByte: number
  endByte: number
  dataBytes: Uint8Array
}

export type FollowEnd = {
  state: AgentMuxRunState
  exitCode?: number
  exitSignal?: string
}

type FollowEvent = Extract<AgentMuxClientEvent, {
  type: 'terminal-output' | 'process-state'
}>

export class OrderedSessionOutputFollow {
  private readonly pending: FollowEvent[] = []
  private replayFinished = false
  private cursor: number
  private pendingBytes = 0
  private draining = false
  private failed = false

  constructor(
    private readonly runId: string,
    afterByte: number,
    private readonly output: (event: FollowOutput) => unknown,
    private readonly end: (event: FollowEnd) => void,
    private readonly readerFailure?: (error: AgentMuxError) => void
  ) {
    this.cursor = afterByte
  }

  accept(event: AgentMuxClientEvent): void {
    if (
      (event.type !== 'terminal-output' && event.type !== 'process-state') ||
      event.run.runId !== this.runId
    ) return
    if (this.failed) return
    if (!this.replayFinished || this.readerFailure) {
      const size = event.type === 'terminal-output' ? event.dataBytes.byteLength : 256
      if (this.readerFailure && (this.pendingBytes + size > 1024 * 1024 || this.pending.length >= 4096)) {
        this.fail(new AgentMuxError(`Output reader fell behind after byte ${this.cursor}; reconnect from that cursor.`, 'CONTROL_PROTOCOL_ERROR'))
        return
      }
      this.pendingBytes += size
      this.pending.push(event)
      if (this.replayFinished) void this.drain().catch(error => this.fail(error))
      return
    }
    this.emitLive(event)
  }

  finishReplay(replay: readonly AgentMuxRunDataEvent[]): void {
    if (this.replayFinished) return
    for (const event of replay) {
      this.emitBytes(event.dataBytes, event.startByte, event.endByte, true)
    }
    this.replayFinished = true
    for (const event of this.pending.splice(0)) this.emitLive(event)
  }

  /** Public remote readers honor Writable backpressure without a second byte cursor. */
  async finishReplayAsync(replay: readonly AgentMuxRunDataEvent[]): Promise<void> {
    if (this.replayFinished || this.failed) return
    for (const event of replay) {
      if (this.failed) return
      await this.emitBytes(event.dataBytes, event.startByte, event.endByte, true)
    }
    this.replayFinished = true
    await this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length && !this.failed) {
        const event = this.pending.shift()!
        try { await this.emitLive(event) }
        finally { this.pendingBytes = Math.max(0, this.pendingBytes - (event.type === 'terminal-output' ? event.dataBytes.byteLength : 256)) }
      }
    } finally { this.draining = false }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true; this.pending.length = 0; this.pendingBytes = 0
    this.readerFailure?.(error instanceof AgentMuxError ? error : new AgentMuxError('Output reader failed; reconnect from its last confirmed cursor.', 'CONTROL_PROTOCOL_ERROR'))
  }

  private emitLive(event: FollowEvent): unknown {
    if (event.type === 'process-state') {
      if (event.state === 'running') return
      this.end({
        state: event.state,
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        ...(event.exitSignal === undefined ? {} : { exitSignal: event.exitSignal })
      })
      return
    }
    const range = event.evidence.outputByteRange
    return this.emitBytes(event.dataBytes, range.startByte, range.endByte, false)
  }

  private emitBytes(dataBytes: Uint8Array, eventStartByte: number, endByte: number, replay: boolean): unknown {
    if (endByte <= this.cursor) return
    const startByte = Math.max(eventStartByte, this.cursor)
    const flushed = this.output({
      runId: this.runId,
      replay,
      startByte,
      endByte,
      dataBytes: dataBytes.subarray(startByte - eventStartByte)
    })
    if (flushed instanceof Promise) return flushed.then(() => { this.cursor = endByte })
    this.cursor = endByte
    return flushed
  }
}
