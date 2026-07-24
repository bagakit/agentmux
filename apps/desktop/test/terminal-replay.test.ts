import { describe, expect, it, vi } from 'vitest'
import { hydrateTerminalReplay } from '../src/renderer/src/lib/terminal-replay'

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
})
