import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  rememberTerminalViewport,
  restoreTerminalViewport
} from '../src/renderer/src/lib/terminal-viewport-memory'
import { takeTerminalLiveOutputBatch } from '../src/renderer/src/lib/terminal-live-output'

const terminalView = readFileSync(
  new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
  'utf8'
)

describe('terminal viewport continuity', () => {
  it('restores latest output when the user left at the bottom', () => {
    const memory = rememberTerminalViewport(42, 42)
    expect(memory).toEqual({ kind: 'latest' })
    expect(restoreTerminalViewport(memory, 77)).toEqual({ kind: 'latest' })
  })

  it('restores the previous reading line when the user scrolled up', () => {
    const memory = rememberTerminalViewport(12, 42)
    expect(memory).toEqual({ kind: 'line', line: 12 })
    expect(restoreTerminalViewport(memory, 77)).toEqual({ kind: 'line', line: 12 })
  })

  it('clamps a remembered line when scrollback became shorter', () => {
    expect(restoreTerminalViewport({ kind: 'line', line: 120 }, 30)).toEqual({ kind: 'line', line: 30 })
  })

  it('defaults non-finite viewport readings to a usable latest/line target', () => {
    expect(rememberTerminalViewport(Number.NaN, Number.NaN)).toEqual({ kind: 'latest' })
    expect(restoreTerminalViewport({ kind: 'line', line: Number.NaN }, Number.NaN)).toEqual({ kind: 'line', line: 0 })
  })

  it('wires the memory to the TerminalView visibility boundary', () => {
    expect(terminalView).toContain('rememberTerminalViewport(buffer.viewportY, buffer.baseY)')
    expect(terminalView).toContain('restoreTerminalViewport(')
    expect(terminalView).toContain('terminal.scrollToBottom()')
    expect(terminalView).toContain('terminal.scrollToLine(target.line)')
  })
})

describe('terminal live output batching', () => {
  it('coalesces consecutive small RuntimeEvents into one ordered visual batch', () => {
    const result = takeTerminalLiveOutputBatch([
      { data: 'a', startByte: 0, endByte: 1 },
      { data: 'b', startByte: 1, endByte: 2 },
      { data: 'c', startByte: 2, endByte: 3 }
    ], 3)
    expect(result.batch.map((chunk) => chunk.data).join('')).toBe('abc')
    expect(result.rest).toEqual([])
  })

  it('keeps the first oversized chunk intact and bounds following chunks', () => {
    const result = takeTerminalLiveOutputBatch([
      { data: 'large', startByte: 0, endByte: 8 },
      { data: 'next', startByte: 8, endByte: 12 }
    ], 4)
    expect(result.batch).toHaveLength(1)
    expect(result.rest.map((chunk) => chunk.data)).toEqual(['next'])
  })

  it('leaves a scheduling yield between bounded live batches', () => {
    expect(terminalView).toContain('takeTerminalLiveOutputBatch(liveOutputQueue)')
    expect(terminalView).toContain('if (liveOutputQueue.length > 0) await yieldTerminalWork()')
  })
})
