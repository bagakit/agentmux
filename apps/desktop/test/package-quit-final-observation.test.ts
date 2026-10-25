import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { waitForProcessExit } from '../scripts/package-macos.mjs'

describe('installer final process-exit observation', () => {
  it('does not block on a process that has actually exited after the last snapshot', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(child, 'spawn')
    const pid = child.pid!
    child.kill('SIGTERM')
    await once(child, 'exit')
    expect(await waitForProcessExit(async () => [pid], 0)).toEqual([])
  })

  it('keeps a living process and an unconfirmed permission result protected', async () => {
    expect(await waitForProcessExit(async () => [process.pid], 0)).toEqual([process.pid])
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    try {
      expect(await waitForProcessExit(async () => [12345], 0)).toEqual([12345])
      expect(probe).toHaveBeenCalledWith(12345, 0)
    } finally {
      probe.mockRestore()
    }
  })
})
