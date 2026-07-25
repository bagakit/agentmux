import { describe, expect, it, vi } from 'vitest'
import { SplitRatioCommitter } from '../src/renderer/src/lib/split-ratio-commit'
import { LatestTerminalOutputAcknowledger } from '../src/renderer/src/lib/terminal-output-ack'
import { terminalStartupPhase } from '../src/renderer/src/lib/terminal-startup'

describe('Terminal interaction latency owners', () => {
  it('coalesces an acknowledgement burst and eventually sends the latest cursor', async () => {
    let releaseFirst = () => {}
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const acknowledge = vi.fn()
      .mockImplementationOnce(async () => await firstPending)
      .mockResolvedValue(undefined)
    const acknowledger = new LatestTerminalOutputAcknowledger(acknowledge)

    acknowledger.queue(10)
    acknowledger.queue(20)
    acknowledger.queue(30)

    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenLastCalledWith(10)

    releaseFirst()
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2))
    expect(acknowledge).toHaveBeenLastCalledWith(30)

    acknowledger.queue(25)
    await Promise.resolve()
    expect(acknowledge).toHaveBeenCalledTimes(2)
  })

  it('stops draining acknowledgements after its Terminal View is disposed', async () => {
    let releaseFirst = () => {}
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const acknowledge = vi.fn(async () => await firstPending)
    const acknowledger = new LatestTerminalOutputAcknowledger(acknowledge)

    acknowledger.queue(10)
    acknowledger.queue(20)
    acknowledger.dispose()
    releaseFirst()
    await Promise.resolve()
    await Promise.resolve()

    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledWith(10)
  })

  it('commits one final split ratio after a pointer drag', () => {
    const commit = vi.fn()
    const committer = new SplitRatioCommitter(0.5, commit)

    committer.setDragging(true)
    committer.observeLayout([55, 45])
    committer.observeLayout([62, 38])
    committer.observeLayout([70, 30])

    expect(commit).not.toHaveBeenCalled()

    committer.setDragging(false)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(0.7)
  })

  it('immediately commits a non-pointer layout change', () => {
    const commit = vi.fn()
    const committer = new SplitRatioCommitter(0.5, commit)

    committer.observeLayout([60, 40])

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(0.6)
  })

  it('keeps a slow Agent visibly starting until the first output arrives', () => {
    const initial = {
      hydrating: true,
      attachFailed: false,
      agent: true,
      running: true,
      hasOutput: false
    }

    expect(terminalStartupPhase(initial)).toBe('restoring')
    expect(terminalStartupPhase({ ...initial, hydrating: false })).toBe('starting-agent')
    expect(terminalStartupPhase({ ...initial, hydrating: false, hasOutput: true })).toBeNull()
  })

  it('does not call a failed, exited, or ordinary Terminal session an Agent startup', () => {
    const waiting = {
      hydrating: false,
      attachFailed: false,
      agent: true,
      running: true,
      hasOutput: false
    }

    expect(terminalStartupPhase({ ...waiting, attachFailed: true })).toBeNull()
    expect(terminalStartupPhase({ ...waiting, running: false })).toBeNull()
    expect(terminalStartupPhase({ ...waiting, agent: false })).toBeNull()
  })
})
