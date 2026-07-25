import { describe, expect, it, vi } from 'vitest'
import {
  finishTerminalReplayRecovery,
  hydrateTerminalReplay
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

    expect(calls).toEqual(['live', 'release', 'redraw'])
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
})
