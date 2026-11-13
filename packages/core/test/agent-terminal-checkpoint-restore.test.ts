import { expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { assertTerminalCheckpointRestore, parseTerminalContinuation, terminalCheckpointHistoryPolicy } from '../src/terminal-continuation.js'
import type { AgentMuxTerminalCheckpoint } from '../src/types.js'

const checkpoint: AgentMuxTerminalCheckpoint = { runId: 'restore-run', throughByte: 100, resizeRevision: 3,
  size: { cols: 6, rows: 4 }, restoreSize: { cols: 12, rows: 6 }, restoreScrollbackRows: 17, resizeAfterRestoreBytes: 6, historyPolicy: { status: 'observed', scrollbackRows: 400 } }

it('imports the complete owner seed at its acknowledged geometry before advancing the original byte fence', async () => {
  const screen = new AgentTerminalScreen(80, 24, 0, false)
  const original = (screen as unknown as { terminal: { dispose(): void } }).terminal
  original.dispose()
  const observed: unknown[] = []
  const completes: Array<() => void> = []
  const terminal = {
    options: { scrollback: 500 }, rows: 4, buffer: { normal: { length: 4 } },
    resize(cols: number, rows: number) { observed.push(['resize', cols, rows]) },
    write(bytes: Uint8Array, done: () => void) { observed.push(['write', new TextDecoder().decode(bytes), this.options.scrollback]); completes.push(done) },
    dispose() {}
  }
  ;(screen as unknown as { terminal: unknown }).terminal = terminal
  const restore = screen.restore(checkpoint, new TextEncoder().encode('prefixsuffix'))
  expect(observed).toEqual([['resize', 12, 6], ['write', 'prefix', 17]])
  expect(screen.throughByte).toBe(0)
  expect(screen.authoritative).toBe(false)
  completes.shift()!(); await Promise.resolve()
  expect(observed).toEqual([['resize', 12, 6], ['write', 'prefix', 17], ['resize', 6, 4], ['write', 'suffix', 400]])
  expect(screen.throughByte).toBe(0)
  expect(screen.authoritative).toBe(false)
  completes.shift()!(); await restore
  expect(terminal.options.scrollback).toBe(400)
  expect(screen.throughByte).toBe(100)
  expect(screen.authoritative).toBe(true)
  screen.resize(8, 5, 100, 4)
  expect(observed.at(-1)).toEqual(['resize', 8, 5])
  screen.dispose()
})

it('releases unused default and prior history capacity using current owner policy and real normal rows', async () => {
  const screen = new AgentTerminalScreen(80, 24)
  const terminal = (screen as unknown as { terminal: { options: { scrollback: number }; buffer: { normal: { length: number; getLine(row: number): { translateToString(trim: boolean): string } } }; rows: number } }).terminal
  try {
    for (const scrollbackRows of [8000, 7]) {
      await screen.restore({ ...checkpoint, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 },
        restoreScrollbackRows: null, resizeAfterRestoreBytes: 0, historyPolicy: { status: 'observed', scrollbackRows } }, new TextEncoder().encode('\x1bcORIGINAL'))
      expect(terminal.options.scrollback).toBe(scrollbackRows)
      expect(terminal.buffer.normal.getLine(0).translateToString(true)).toBe('ORIGINAL')
    }
    const prefix = new TextEncoder().encode('\x1bc' + Array.from({ length: 100 }, (_, row) => `ORIGINAL-${row}\r\n`).join(''))
    await screen.restore({ ...checkpoint, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 },
      restoreScrollbackRows: 150, resizeAfterRestoreBytes: prefix.length, historyPolicy: { status: 'observed', scrollbackRows: 7 } }, prefix)
    expect(terminal.buffer.normal.getLine(0).translateToString(true)).toBe('ORIGINAL-0')
    expect(terminal.options.scrollback).toBe(terminal.buffer.normal.length - terminal.rows)
    const { historyPolicy: _absent, ...missing } = checkpoint
    await expect(screen.restore(missing, new TextEncoder().encode('POISON'))).rejects.toMatchObject({code:'TERMINAL_HISTORY_POLICY_UNAVAILABLE'})
    expect(terminal.buffer.normal.getLine(0).translateToString(true)).toBe('ORIGINAL-0')
  } finally { screen.dispose() }
})

it('retains the Level B screen seed and continues original output without replaying the seed as PTY bytes', async () => {
  const screen = new AgentTerminalScreen(80, 24, 0, false)
  try {
    await screen.restore({ ...checkpoint, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, new TextEncoder().encode('\u001b[22;1H› draft'))
    expect(screen.composerText('›')).toBe('draft')
    expect(screen.throughByte).toBe(100)
    await screen.write({ startByte: 100, endByte: 101, dataBytes: new TextEncoder().encode('!') })
    expect(screen.composerText('›')).toBe('draft!')
    expect(screen.throughByte).toBe(101)
    expect(screen.authoritative).toBe(true)
  } finally { screen.dispose() }
})

it.each([{ resizeAfterRestoreBytes: -1 }, { resizeAfterRestoreBytes: 13 },
  { restoreSize: { cols: 0, rows: 6 } }, { restoreScrollbackRows: -1 }])('rejects incoherent synthetic seed facts before an emulator changes: %j', invalid => {
  expect(() => assertTerminalCheckpointRestore({ ...checkpoint, ...invalid }, new TextEncoder().encode('prefixsuffix')))
    .toThrow(expect.objectContaining({ code: 'CTXMUX_EVENT_INVALID' }))
})

it('accepts absent auxiliary policy while strictly requiring original Run, byte and geometry facts', () => {
  const { historyPolicy: _absent, ...original } = checkpoint
  const continuation = { type: 'basic-vt', checkpoint: original, restoreBytes: new TextEncoder().encode('prefixsuffix'), resizes: [] }
  const snapshot = { run: { runId: original.runId, latestOutputBytes: original.throughByte }, resizeRevision: original.resizeRevision }
  expect(parseTerminalContinuation(continuation, snapshot)).toBe(continuation)
  expect(terminalCheckpointHistoryPolicy(original)).toMatchObject({status:'unavailable'})
  for (const field of ['runId','throughByte','resizeRevision','size','restoreSize','restoreScrollbackRows','resizeAfterRestoreBytes']) {
    const invalid = { ...original } as Record<string, unknown>; delete invalid[field]
    expect(() => parseTerminalContinuation({...continuation,checkpoint:invalid},snapshot),field).toThrow(expect.objectContaining({code:'CTXMUX_EVENT_INVALID'}))
  }
  for (const invalid of [{runId:'another-run'}, {throughByte:101}, {resizeRevision:2}, {restoreSize:{cols:0,rows:4}}, {historyPolicy:null}, {historyPolicy:undefined}, {otherKey:0}]) {
    expect(() => parseTerminalContinuation({...continuation,checkpoint:{...original,...invalid}},snapshot)).toThrow(expect.objectContaining({code:'CTXMUX_EVENT_INVALID'}))
  }
})

it('restores a nonempty synthetic suffix and counts only subsequent original bytes', async () => {
  const screen = new AgentTerminalScreen(80, 24, 0, false)
  const prefix = new TextEncoder().encode('\u001b[22;1H› draft')
  try {
    await screen.restore({ ...checkpoint, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 },
      restoreScrollbackRows: 0, resizeAfterRestoreBytes: prefix.byteLength }, Buffer.concat([prefix, Buffer.from('!')]))
    expect(screen.composerText('›')).toBe('draft!')
    expect(screen.throughByte).toBe(100)
    expect(screen.authoritative).toBe(true)
    await screen.write({ startByte: 100, endByte: 101, dataBytes: new TextEncoder().encode('?') })
    expect(screen.composerText('›')).toBe('draft!?')
    expect(screen.throughByte).toBe(101)
  } finally { screen.dispose() }
})
