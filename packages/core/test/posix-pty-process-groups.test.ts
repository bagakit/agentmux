import { describe, expect, it, vi } from 'vitest'
import {
  forceKillPosixPtyProcessGroups,
  getPosixPtyProcessGroups
} from '../src/posix-pty-process-groups.js'

const PROCESS_TABLE = `
  100  100 ttys001
  110  200 ttys001
  120  300 ttys001
  999  999 ttys002
`

describe('POSIX PTY process-group cleanup', () => {
  it('orders child groups before the root process group', () => {
    expect(getPosixPtyProcessGroups(PROCESS_TABLE, 100, 999)).toEqual([200, 300, 100])
  })

  it('refuses a group signal when the daemon shares the target TTY', () => {
    expect(getPosixPtyProcessGroups(PROCESS_TABLE, 100, 110)).toBeNull()
  })

  it('signals every captured group and uses the root-only fallback when capture fails', () => {
    const signalProcessGroup = vi.fn()
    const fallback = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: () => PROCESS_TABLE,
      signalProcessGroup
    })
    expect(signalProcessGroup.mock.calls.map(([pgid]) => pgid)).toEqual([200, 300, 100])
    expect(fallback).not.toHaveBeenCalled()

    forceKillPosixPtyProcessGroups(404, fallback, {
      platform: 'darwin',
      readProcessTable: () => ''
    })
    expect(fallback).toHaveBeenCalledOnce()
  })
})
