import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  rememberTerminalViewport,
  restoreTerminalViewport
} from '../src/renderer/src/lib/terminal-viewport-memory'
import { TerminalLiveOutputQueue } from '../src/renderer/src/lib/terminal-live-output'

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
    const queue = new TerminalLiveOutputQueue()
    for (const [i,data] of ['a','b','c'].entries()) queue.admit({dataBytes:new TextEncoder().encode(data),startByte:i,endByte:i+1})
    const result = queue.take(3)
    expect(result.batch.map(chunk=>new TextDecoder().decode(chunk.dataBytes)).join('')).toBe('abc')
    expect([...queue]).toEqual([])
  })

  it('keeps the first oversized chunk intact and bounds following chunks', () => {
    const queue = new TerminalLiveOutputQueue()
    queue.admit({dataBytes:new TextEncoder().encode('large123'),startByte:0,endByte:8})
    queue.admit({dataBytes:new TextEncoder().encode('next'),startByte:8,endByte:12})
    const result = queue.take(4)
    expect(result.batch).toHaveLength(1)
    expect([...queue]).toEqual([{dataBytes:new TextEncoder().encode('next'),startByte:8,endByte:12}])
  })

  it('leaves a scheduling yield between bounded live batches', () => {
    expect(terminalView).toContain('liveOutputQueue.take()')
    expect(terminalView).toContain('if (liveOutputQueue.length > 0) await yieldTerminalWork()')
  })
})
