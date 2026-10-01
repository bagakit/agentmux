import { describe, expect, it, vi } from 'vitest'
import {
  finishTerminalReplayRecovery,
  hydrateTerminalReplay,
  restoreTerminalCheckpoint,
  TERMINAL_REPLAY_BATCH_BYTES
} from '../src/renderer/src/lib/terminal-replay'

describe('hydrateTerminalReplay', () => {
  it('restores seed prefix at its declared geometry and temporary history policy before the final grid and suffix', async () => {
    const calls: unknown[] = [], write = vi.fn(async (data: Uint8Array) => { calls.push(['write', Buffer.from(data).toString()]) })
    await restoreTerminalCheckpoint({ runId: 'exact-run', throughByte: 100, resizeRevision: 3,
      size: { cols: 90, rows: 30 }, restoreSize: { cols: 40, rows: 2 }, restoreScrollbackRows: 1, resizeAfterRestoreBytes: 6 },
    Buffer.from('prefixsuffix'), { write,
      resize: size => { calls.push(['resize', size]) }, getScrollback: () => 5000,
      setScrollback: rows => { calls.push(['scrollback', rows]) } }, async () => {})
    expect(calls).toEqual([['resize', { cols: 40, rows: 2 }], ['scrollback', 1], ['write', 'prefix'],
      ['scrollback', 5000], ['resize', { cols: 90, rows: 30 }], ['write', 'suffix']])
  })

  it('restores the user history policy on a failed prefix without writing a later seed section', async () => {
    const calls: unknown[] = []
    await expect(restoreTerminalCheckpoint({ runId: 'exact-run', throughByte: 100, resizeRevision: 3,
      size: { cols: 90, rows: 30 }, restoreSize: { cols: 40, rows: 2 }, restoreScrollbackRows: 1, resizeAfterRestoreBytes: 6 },
    Buffer.from('prefixsuffix'), { write: async () => { throw new Error('parser unavailable') },
      resize: size => { calls.push(['resize', size]) }, getScrollback: () => 5000,
      setScrollback: rows => { calls.push(['scrollback', rows]) } }, async () => {})).rejects.toThrow('parser unavailable')
    expect(calls).toEqual([['resize', { cols: 40, rows: 2 }], ['scrollback', 1], ['scrollback', 5000]])
  })

  it('restores ordered replay bytes through one xterm write', async () => {
    const write = vi.fn(async (_data: Uint8Array) => {})

    const cursor = await hydrateTerminalReplay([
      { dataBytes: new TextEncoder().encode('\u001b[2J'), endByte: 4 },
      { dataBytes: new TextEncoder().encode('ready'), endByte: 9 },
      { dataBytes: new TextEncoder().encode('\r\n'), endByte: 11 }
    ], write)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(new TextEncoder().encode('\u001b[2Jready\r\n'))
    expect(cursor).toBe(11)
  })

  it('does not schedule an empty replay write', async () => {
    const write = vi.fn(async (_data: Uint8Array) => {})

    await expect(hydrateTerminalReplay([], write)).resolves.toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('splits a large replay into bounded writes and yields between parser batches', async () => {
    const writes: Uint8Array[] = []
    const yields: number[] = []
    const data = 'x'.repeat(TERMINAL_REPLAY_BATCH_BYTES * 2 + 17)

    const cursor = await hydrateTerminalReplay([
      { dataBytes: new TextEncoder().encode(data), endByte: data.length }
    ], async (chunk) => { writes.push(chunk) }, async () => { yields.push(writes.length) })

    expect(writes.map((chunk) => chunk.length)).toEqual([
      TERMINAL_REPLAY_BATCH_BYTES,
      TERMINAL_REPLAY_BATCH_BYTES,
      17
    ])
    expect(Buffer.concat(writes)).toEqual(Buffer.from(data))
    expect(yields).toEqual([1, 2, 3])
    expect(cursor).toBe(data.length)
  })

  it('redraws a running Gap only after replay hands off to ordered live output', async () => {
    const calls: string[] = []

    await expect(finishTerminalReplayRecovery({
      gap: true,
      canControlRun: true,
      startLiveSynchronization: async () => { calls.push('live') },
      releaseLiveOutput: async () => { calls.push('release') },
      finishReplay: () => { calls.push('finish') },
      redrawCurrentScreen: async () => {
        calls.push('redraw')
        return true
      }
    })).resolves.toBe(true)

    expect(calls).toEqual(['release', 'finish', 'live', 'redraw'])
  })

  it('keeps historical Gap replay read-only', async () => {
    const calls: string[] = []

    await expect(finishTerminalReplayRecovery({
      gap: true,
      canControlRun: false,
      startLiveSynchronization: async () => { calls.push('live') },
      releaseLiveOutput: async () => { calls.push('release') },
      finishReplay: () => { calls.push('finish') },
      redrawCurrentScreen: async () => {
        calls.push('redraw')
        return true
      }
    })).resolves.toBe(false)

    expect(calls).toEqual(['release', 'finish'])
  })

  it('keeps an optional redraw failure from turning a successful attach into an attach error', async () => {
    const onRedrawError = vi.fn()

    await expect(finishTerminalReplayRecovery({
      gap: true,
      canControlRun: true,
      startLiveSynchronization: async () => {},
      releaseLiveOutput: async () => {},
      finishReplay: () => {},
      redrawCurrentScreen: async () => { throw new Error('resize unavailable') },
      onRedrawError
    })).resolves.toBe(false)

    expect(onRedrawError).toHaveBeenCalledOnce()
  })

  it('releases live output even when viewport synchronization rejects', async () => {
    const calls: string[] = []
    const onRecoveryError = vi.fn()

    await expect(finishTerminalReplayRecovery({
      gap: false,
      canControlRun: true,
      startLiveSynchronization: async () => {
        calls.push('live')
        throw new Error('resize unavailable')
      },
      releaseLiveOutput: async () => { calls.push('release') },
      finishReplay: () => { calls.push('finish') },
      redrawCurrentScreen: async () => { calls.push('redraw'); return true },
      onRecoveryError
    })).resolves.toBe(false)

    expect(calls).toEqual(['release', 'finish', 'live'])
    expect(onRecoveryError).toHaveBeenCalledOnce()
  })
})
