import headless, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import { AgentMuxError } from './errors.js'

const { Terminal } = headless

export const MAX_AGENT_PROMPT_BYTES = 64 * 1024

export type AgentTerminalScreenChunk = {
  startByte: number
  endByte: number
  dataBytes: Uint8Array
}

type AgentTerminalLine = {
  length: number
  getCell(column: number): { getChars(): string } | undefined
  translateToString(trimRight: boolean, startColumn?: number, endColumn?: number): string
}

function lineText(line: AgentTerminalLine, end?: number): string {
  let start = 0
  const limit = end ?? line.length
  while (start < limit && line.getCell(start)?.getChars() === '') start += 1
  return line.translateToString(true, start, end)
}

export class AgentTerminalScreen {
  private readonly terminal: HeadlessTerminal
  private nextByte = 0

  constructor(cols: number, rows: number, initialByte = 0) {
    this.nextByte = initialByte
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: MAX_AGENT_PROMPT_BYTES,
      allowProposedApi: true,
      logLevel: 'off'
    })
  }

  get throughByte(): number {
    return this.nextByte
  }

  async write(chunk: AgentTerminalScreenChunk): Promise<void> {
    if (chunk.startByte !== this.nextByte || chunk.endByte - chunk.startByte !== chunk.dataBytes.byteLength) {
      throw new AgentMuxError(
        'Terminal screen replay is not one contiguous authoritative byte stream.',
        'OUTPUT_GAP'
      )
    }
    await new Promise<void>((resolve) => this.terminal.write(chunk.dataBytes, resolve))
    this.nextByte = chunk.endByte
  }

  composerText(marker: string, allowHardLineBreaks = false): string | null {
    const buffer = this.terminal.buffer.active
    const cursorLine = buffer.baseY + buffer.cursorY
    const firstTrackedLine = Math.max(0, cursorLine - MAX_AGENT_PROMPT_BYTES - 1)
    for (let row = cursorLine; row >= firstTrackedLine; row -= 1) {
      const line = buffer.getLine(row)
      if (!line) continue
      const text = line.translateToString(false)
      const firstCell = text.search(/\S/u)
      if (firstCell < 0 || !text.startsWith(marker, firstCell)) continue
      if (row < cursorLine && !allowHardLineBreaks) {
        let wrapsToCursor = true
        for (let continuation = row + 1; continuation <= cursorLine; continuation += 1) {
          if (!buffer.getLine(continuation)?.isWrapped) {
            wrapsToCursor = false
            break
          }
        }
        if (!wrapsToCursor) continue
      }
      if (row === cursorLine && buffer.cursorX < firstCell + marker.length) continue
      let result = line.translateToString(
        true,
        firstCell + marker.length,
        row === cursorLine ? buffer.cursorX : undefined
      ).trimStart()
      for (let continuation = row + 1; continuation <= cursorLine; continuation += 1) {
        const wrapped = buffer.getLine(continuation)
        if (!wrapped) return null
        const continuationText = wrapped.translateToString(
          true,
          0,
          continuation === cursorLine ? buffer.cursorX : undefined
        )
        if (wrapped.isWrapped) {
          result += continuationText
        } else {
          result = `${result}\n${lineText(wrapped, continuation === cursorLine ? buffer.cursorX : undefined)}`
        }
      }
      return result
    }
    return null
  }

  dispose(): void {
    this.terminal.dispose()
  }
}

export type AgentTerminalFrameMarkers = { start: string; end: string }

export type AgentTerminalScreenEvidenceEvent =
  | { type: 'data'; startByte: number; endByte: number; dataBytes: Uint8Array }
  | { type: 'gap' }
  | { type: 'exit' }
  | { type: 'error'; error: Error }

export type AgentTerminalScreenWait = {
  boundaryByte: number
  requireOutputAfterBoundary: boolean
  /** 只有 initial-composer readiness 需要：boundary 之后必须观察到一个完整的同步更新帧。 */
  requireFrameAfterBoundary?: boolean
  predicate: (screen: AgentTerminalScreen) => boolean
  timeoutMs?: number
  timeoutMessage: string
  terminalMessage: string
  signal?: AbortSignal
}

type AgentTerminalScreenFailure =
  | { kind: 'gap' }
  | { kind: 'exit' }
  | { kind: 'error'; error: Error }

/**
 * 一个 Run 的长命增量屏幕证据。ctxmux 仍是唯一的字节权威：这里只有一块随事件流增量推进的
 * xterm 屏幕、一个已消费字节游标和帧标记游标，**没有第二份 Run 字节史**（帧扫描的跨块进位
 * 至多保留 marker 长度减一个字节）。
 *
 * 同一 Session 的提交/readiness 观察共享这一份屏幕：已消费的前缀不再重放，验证路径的重放
 * 字节量相对会话历史长度有界。gap、Run 退出、观察错误都会让证据失效——失效是粘性的，
 * 挂起与后续的 wait 都会拿到对应错误，由持有者丢弃并重建。
 */
export class AgentTerminalScreenEvidence {
  private readonly screen: AgentTerminalScreen
  private readonly startMarker: Buffer | null
  private readonly endMarker: Buffer | null
  private readonly listeners = new Set<() => void>()
  private tail = Promise.resolve()
  private frameCarry = Buffer.alloc(0)
  private pendingFrameStartByte: number | null = null
  private completeFrame: { startByte: number; endByte: number } | null = null
  private failure: AgentTerminalScreenFailure | null = null
  private disposed = false

  constructor(cols: number, rows: number, frame: AgentTerminalFrameMarkers | null, initialByte = 0) {
    this.screen = new AgentTerminalScreen(cols, rows, initialByte)
    this.startMarker = frame ? Buffer.from(frame.start) : null
    this.endMarker = frame ? Buffer.from(frame.end) : null
  }

  get throughByte(): number {
    return this.screen.throughByte
  }

  get failed(): boolean {
    return this.failure !== null || this.disposed
  }

  get lastCompleteFrame(): { startByte: number; endByte: number } | null {
    return this.completeFrame
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  accept(event: AgentTerminalScreenEvidenceEvent): void {
    if (this.disposed || this.failure) return
    if (event.type === 'gap') return this.fail({ kind: 'gap' })
    if (event.type === 'exit') return this.fail({ kind: 'exit' })
    if (event.type === 'error') return this.fail({ kind: 'error', error: event.error })
    this.tail = this.tail.then(async () => {
      if (this.disposed || this.failure) return
      // 重放与在线事件可能在边界处重叠：完全落在已消费游标之前的块直接跳过；
      // 部分重叠仍由 AgentTerminalScreen 的连续性断言 fail-closed。
      if (event.endByte <= this.screen.throughByte) return
      this.scanFrames(event)
      await this.screen.write(event)
      this.notify()
    })
    void this.tail.catch((error) => {
      this.fail(
        error instanceof AgentMuxError && error.code === 'OUTPUT_GAP'
          ? { kind: 'gap' }
          : { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }
      )
    })
  }

  async wait(options: AgentTerminalScreenWait): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: () => void = () => {}
      const abort = (): void => fail(new AgentMuxError(
        'Terminal screen observation was cancelled.',
        'AGENT_PROMPT_READINESS_CANCELLED'
      ))
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        unsubscribe()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const inspect = (): void => {
        if (settled) return
        if (this.failure) return fail(this.failureError(this.failure, options))
        if (this.disposed) return abort()
        const crossedBoundary = options.requireOutputAfterBoundary
          ? this.screen.throughByte > options.boundaryByte
          : this.screen.throughByte >= options.boundaryByte
        const frameObserved = !options.requireFrameAfterBoundary ||
          this.startMarker === null ||
          (this.completeFrame !== null && this.completeFrame.startByte >= options.boundaryByte)
        if (crossedBoundary && frameObserved && options.predicate(this.screen)) {
          settled = true
          cleanup()
          resolve(this.screen.throughByte)
        }
      }
      unsubscribe = this.subscribe(inspect)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) return abort()
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => fail(new AgentMuxError(
          options.timeoutMessage,
          'AGENT_PROMPT_RENDER_TIMEOUT'
        )), options.timeoutMs)
      }
      inspect()
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.notify()
    this.screen.dispose()
  }

  private failureError(failure: AgentTerminalScreenFailure, options: AgentTerminalScreenWait): Error {
    if (failure.kind === 'gap') {
      return new AgentMuxError(
        'Terminal screen evidence was evicted from CtxMux replay.',
        'OUTPUT_GAP'
      )
    }
    if (failure.kind === 'exit') {
      return new AgentMuxError(options.terminalMessage, 'AGENT_PROMPT_RENDER_FAILED')
    }
    return failure.error
  }

  private fail(failure: AgentTerminalScreenFailure): void {
    if (this.disposed || this.failure) return
    this.failure = failure
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * 帧标记按字节流连续扫描（marker 是 ASCII 逃逸序列，直接在字节层 indexOf，位置字节精确）。
   * 只记录游标：最近一个未闭合帧的起点和最近一个完整帧的起止字节，不留字节内容。
   */
  private scanFrames(event: { startByte: number; dataBytes: Uint8Array }): void {
    if (!this.startMarker || !this.endMarker) return
    const chunk = Buffer.from(event.dataBytes.buffer, event.dataBytes.byteOffset, event.dataBytes.byteLength)
    const buffer = this.frameCarry.byteLength ? Buffer.concat([this.frameCarry, chunk]) : chunk
    const baseByte = event.startByte - this.frameCarry.byteLength
    let cursor = 0
    for (;;) {
      const marker = this.pendingFrameStartByte === null ? this.startMarker : this.endMarker
      const index = buffer.indexOf(marker, cursor)
      if (index < 0) break
      if (this.pendingFrameStartByte === null) {
        this.pendingFrameStartByte = baseByte + index
      } else {
        this.completeFrame = {
          startByte: this.pendingFrameStartByte,
          endByte: baseByte + index + marker.byteLength
        }
        this.pendingFrameStartByte = null
      }
      cursor = index + marker.byteLength
    }
    const keep = Math.max(this.startMarker.byteLength, this.endMarker.byteLength) - 1
    this.frameCarry = Buffer.from(buffer.subarray(Math.max(cursor, buffer.byteLength - keep)))
  }
}
