import { expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { assertTerminalCheckpointRestore } from '../src/terminal-continuation.js'
import type { AgentMuxTerminalCheckpoint } from '../src/types.js'

const checkpoint: AgentMuxTerminalCheckpoint = { runId: 'restore-run', throughByte: 100, resizeRevision: 3,
  size: { cols: 6, rows: 4 }, restoreSize: { cols: 12, rows: 6 }, restoreScrollbackRows: 0, resizeAfterRestoreBytes: 6 }

it('restores owner geometry and temporary history for the prefix, then original policy/current geometry for the suffix', async () => {
  const screen = new AgentTerminalScreen(80, 24)
  const original = (screen as unknown as { terminal: { dispose(): void } }).terminal
  original.dispose()
  const observed: unknown[] = []
  const writes: Array<() => void> = []
  const terminal = { options: { scrollback: 500 }, resize(cols: number, rows: number) { observed.push(['resize', cols, rows]) },
    write(bytes: Uint8Array, done: () => void) { observed.push(['write', new TextDecoder().decode(bytes), this.options.scrollback]); writes.push(done) }, dispose() {} }
  ;(screen as unknown as { terminal: unknown }).terminal = terminal
  const restore = screen.restore(checkpoint, new TextEncoder().encode('prefixsuffix'))
  expect(observed).toEqual([['resize', 12, 6], ['write', 'prefix', 0]])
  expect(screen.throughByte).toBe(0)
  writes.shift()!(); await Promise.resolve()
  expect(observed).toEqual([['resize', 12, 6], ['write', 'prefix', 0], ['resize', 6, 4], ['write', 'suffix', 500]])
  expect(screen.throughByte).toBe(0)
  writes.shift()!(); await restore
  expect(screen.throughByte).toBe(100)
  expect(terminal.options.scrollback).toBe(500)
  screen.dispose()
})

it.each([{ resizeAfterRestoreBytes: -1 }, { resizeAfterRestoreBytes: 13 }, { restoreSize: { cols: 0, rows: 6 } },
  { restoreScrollbackRows: -1 }])('rejects incoherent restore facts before changing a virtual screen: %j', invalid => {
  expect(() => assertTerminalCheckpointRestore({ ...checkpoint, ...invalid }, new TextEncoder().encode('prefixsuffix')))
    .toThrow(expect.objectContaining({ code: 'CTXMUX_EVENT_INVALID' }))
})
