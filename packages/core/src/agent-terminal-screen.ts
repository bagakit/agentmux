import headless, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import { AgentMuxError } from './errors.js'

const { Terminal } = headless

export type AgentTerminalScreenChunk = {
  startByte: number
  endByte: number
  dataBytes: Uint8Array
}

export class AgentTerminalScreen {
  private readonly terminal: HeadlessTerminal
  private nextByte = 0

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 0,
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

  composerText(marker: string): string | null {
    const buffer = this.terminal.buffer.active
    const cursorLine = buffer.baseY + buffer.cursorY
    const firstVisibleLine = Math.max(buffer.viewportY, cursorLine - this.terminal.rows + 1)
    for (let row = cursorLine; row >= firstVisibleLine; row -= 1) {
      const line = buffer.getLine(row)
      if (!line) continue
      const text = line.translateToString(false)
      const firstCell = text.search(/\S/u)
      if (firstCell < 0 || !text.startsWith(marker, firstCell)) continue
      if (row < cursorLine) {
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
      const parts = [line.translateToString(
        false,
        firstCell + marker.length,
        row === cursorLine ? buffer.cursorX : undefined
      ).trimStart()]
      for (let continuation = row + 1; continuation <= cursorLine; continuation += 1) {
        const wrapped = buffer.getLine(continuation)
        if (!wrapped) return null
        parts.push(wrapped.translateToString(
          false,
          0,
          continuation === cursorLine ? buffer.cursorX : undefined
        ))
      }
      return parts.join('').trimEnd()
    }
    return null
  }

  dispose(): void {
    this.terminal.dispose()
  }
}
