import { describe, expect, it, vi } from 'vitest'
import {
  finishTerminalReplayRecovery,
  hydrateTerminalReplay,
  TERMINAL_REPLAY_BATCH_CHARS
} from '../src/renderer/src/lib/terminal-replay'

describe('hydrateTerminalReplay', () => {
  it('restores ordered replay bytes through one xterm write', async () => {
    const write = vi.fn(async (_data: string) => {})

    const cursor = await hydrateTerminalReplay([
      { data: '\u001b[2J', endByte: 4 },
      { data: 'ready', endByte: 9 },
      { data: '\r\n', endByte: 11 }
    ], write)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('\u001b[2Jready\r\n')
    expect(cursor).toBe(11)
  })

  it('does not schedule an empty replay write', async () => {
    const write = vi.fn(async (_data: string) => {})

    await expect(hydrateTerminalReplay([], write)).resolves.toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('splits a large replay into bounded writes and yields between parser batches', async () => {
    const writes: string[] = []
    const yields: number[] = []
    const data = 'x'.repeat(TERMINAL_REPLAY_BATCH_CHARS * 2 + 17)

    const cursor = await hydrateTerminalReplay([
      { data, endByte: data.length }
    ], async (chunk) => { writes.push(chunk) }, async () => { yields.push(writes.length) })

    expect(writes.map((chunk) => chunk.length)).toEqual([
      TERMINAL_REPLAY_BATCH_CHARS,
      TERMINAL_REPLAY_BATCH_CHARS,
      17
    ])
    expect(writes.join('')).toBe(data)
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
      redrawCurrentScreen: async () => {
        calls.push('redraw')
        return true
      }
    })).resolves.toBe(true)

    expect(calls).toEqual(['release', 'live', 'redraw'])
  })

  it('keeps historical Gap replay read-only', async () => {
    const calls: string[] = []

    await expect(finishTerminalReplayRecovery({
      gap: true,
      canControlRun: false,
      startLiveSynchronization: async () => { calls.push('live') },
      releaseLiveOutput: async () => { calls.push('release') },
      redrawCurrentScreen: async () => {
        calls.push('redraw')
        return true
      }
    })).resolves.toBe(false)

    expect(calls).toEqual(['release'])
  })

  it('keeps an optional redraw failure from turning a successful attach into an attach error', async () => {
    const onRedrawError = vi.fn()

    await expect(finishTerminalReplayRecovery({
      gap: true,
      canControlRun: true,
      startLiveSynchronization: async () => {},
      releaseLiveOutput: async () => {},
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
      redrawCurrentScreen: async () => { calls.push('redraw'); return true },
      onRecoveryError
    })).resolves.toBe(false)

    expect(calls).toEqual(['release', 'live'])
    expect(onRecoveryError).toHaveBeenCalledOnce()
  })
})
