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

  constructor(cols: number, rows: number) {
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
