import type {
  AgentMuxClientEvent,
  AgentMuxRunDataEvent,
  AgentMuxRunState
} from './types.js'

export type FollowOutput = {
  runId: string
  replay: boolean
  startByte: number | null
  endByte: number | null
  data: string
}

export type FollowEnd = {
  state: AgentMuxRunState
  exitCode?: number
  exitSignal?: string
}

type FollowEvent = Extract<AgentMuxClientEvent, {
  type: 'terminal-output' | 'process-state'
}>

function dataAfterByte(data: string, eventStartByte: number, afterByte: number): string {
  if (afterByte <= eventStartByte) return data
  return Buffer.from(data).subarray(afterByte - eventStartByte).toString('utf8')
}

export class OrderedSessionOutputFollow {
  private readonly pending: FollowEvent[] = []
  private replayFinished = false
  private cursor: number

  constructor(
    private readonly runId: string,
    afterByte: number,
    private readonly output: (event: FollowOutput) => void,
    private readonly end: (event: FollowEnd) => void
  ) {
    this.cursor = afterByte
  }

  accept(event: AgentMuxClientEvent): void {
    if (
      (event.type !== 'terminal-output' && event.type !== 'process-state') ||
      event.run.runId !== this.runId
    ) return
    if (!this.replayFinished) {
      this.pending.push(event)
      return
    }
    this.emitLive(event)
  }

  finishReplay(replay: readonly AgentMuxRunDataEvent[]): void {
    if (this.replayFinished) return
    for (const event of replay) {
      this.output({
        runId: event.runId,
        replay: true,
        startByte: event.startByte,
        endByte: event.endByte,
        data: event.data
      })
      this.cursor = Math.max(this.cursor, event.endByte)
    }
    this.replayFinished = true
    for (const event of this.pending.splice(0)) this.emitLive(event)
  }

  private emitLive(event: FollowEvent): void {
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
    if (!range) {
      this.output({
        runId: this.runId,
        replay: false,
        startByte: null,
        endByte: null,
        data: event.data
      })
      return
    }
    if (range.endByte <= this.cursor) return
    const startByte = Math.max(range.startByte, this.cursor)
    this.output({
      runId: this.runId,
      replay: false,
      startByte,
      endByte: range.endByte,
      data: dataAfterByte(event.data, range.startByte, startByte)
    })
    this.cursor = range.endByte
  }
}
