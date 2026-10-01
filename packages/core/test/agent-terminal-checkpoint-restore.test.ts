import { expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import type { AgentMuxTerminalCheckpoint } from '../src/types.js'

const checkpoint: AgentMuxTerminalCheckpoint = { runId: 'restore-run', throughByte: 100, resizeRevision: 3,
  size: { cols: 6, rows: 4 } }

it('imports the complete owner seed at its acknowledged geometry before advancing the original byte fence', async () => {
  const screen = new AgentTerminalScreen(80, 24, 0, false)
  const original = (screen as unknown as { terminal: { dispose(): void } }).terminal
  original.dispose()
  const observed: unknown[] = []
  let complete: (() => void) | undefined
  const terminal = {
    resize(cols: number, rows: number) { observed.push(['resize', cols, rows]) },
    write(bytes: Uint8Array, done: () => void) { observed.push(['write', new TextDecoder().decode(bytes)]); complete = done },
    dispose() {}
  }
  ;(screen as unknown as { terminal: unknown }).terminal = terminal
  const restore = screen.restore(checkpoint, new TextEncoder().encode('owner seed'))
  expect(observed).toEqual([['resize', 6, 4], ['write', 'owner seed']])
  expect(screen.throughByte).toBe(0)
  expect(screen.authoritative).toBe(false)
  expect(complete).toBeTypeOf('function')
  complete!(); await restore
  expect(screen.throughByte).toBe(100)
  expect(screen.authoritative).toBe(true)
  screen.resize(8, 5, 100, 4)
  expect(observed.at(-1)).toEqual(['resize', 8, 5])
  screen.dispose()
})

it('retains the Level B screen seed and continues original output without replaying the seed as PTY bytes', async () => {
  const screen = new AgentTerminalScreen(80, 24, 0, false)
  try {
    await screen.restore({ ...checkpoint, size: { cols: 80, rows: 24 } }, new TextEncoder().encode('\u001b[22;1H› draft'))
    expect(screen.composerText('›')).toBe('draft')
    expect(screen.throughByte).toBe(100)
    await screen.write({ startByte: 100, endByte: 101, dataBytes: new TextEncoder().encode('!') })
    expect(screen.composerText('›')).toBe('draft!')
    expect(screen.throughByte).toBe(101)
    expect(screen.authoritative).toBe(true)
  } finally { screen.dispose() }
})
