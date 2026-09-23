import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readPs } = vi.hoisted(() => ({ readPs: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const execFile = vi.fn()
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: readPs })
  return { ...original, execFile }
})

import { listProbeProcesses, signalOwnedProbeProcess } from '../scripts/probe-process.mjs'

const root = '/tmp/agentmux-owned-identity'
const missingPs = () => Object.assign(new Error('ps did not find the selected PID'), {
  code: 1, stdout: '', stderr: ''
})

describe('private probe cleanup identity', () => {
  let kill: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    readPs.mockReset()
    kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  })
  afterEach(() => vi.restoreAllMocks())

  it('rechecks a nonempty cleanup inventory and signals only the exact private path', async () => {
    readPs.mockResolvedValueOnce({ stdout: `41001 41001 S node ${root}/worker.mjs\n` })
      .mockResolvedValueOnce({ stdout: ` S node ${root}/worker.mjs\n` })
    const owners = await listProbeProcesses(-1, root)
    expect(owners).toEqual([41001])
    for (const pid of owners) await signalOwnedProbeProcess(pid, root, 'SIGTERM')
    expect(readPs).toHaveBeenLastCalledWith('/bin/ps', ['-p', '41001', '-o', 'stat=,command='], {
      timeout: 5_000, maxBuffer: 64 * 1024
    })
    expect(kill.mock.calls).toEqual([[41001, 'SIGTERM']])
  })

  it.each(['S node /another-private-root/worker.mjs', `S node ${root}-other/worker.mjs`])(
    'rejects live wrong-root identity %s without signalling', async (stdout) => {
      readPs.mockResolvedValue({ stdout })
      await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).rejects.toThrow('Private process identity changed')
      expect(kill.mock.calls).toEqual([])
    }
  )

  it.each(['', 'S', `? node ${root}/worker.mjs`])('rejects unknown successful ps observation %j', async (stdout) => {
    readPs.mockResolvedValue({ stdout })
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).rejects.toThrow('Private process state could not be observed')
    expect(kill.mock.calls).toEqual(stdout ? [] : [[41001, 0]])
  })

  it.each(['Z', 'Z+'])('accepts terminal zombie state %s without any signal', async (state) => {
    readPs.mockResolvedValue({ stdout: `${state} <defunct>\n` })
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).resolves.toBe(false)
    expect(kill.mock.calls).toEqual([])
  })

  it('does not require a command from an already confirmed zombie', async () => {
    readPs.mockResolvedValue({ stdout: 'Z\n' })
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).resolves.toBe(false)
    expect(kill.mock.calls).toEqual([])
  })

  it('accepts absence only after the exact empty ps result and OS ESRCH', async () => {
    readPs.mockRejectedValue(missingPs())
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).resolves.toBe(false)
    expect(kill.mock.calls).toEqual([[41001, 0]])
  })

  it('also confirms OS absence when ps succeeds with an empty observation', async () => {
    readPs.mockResolvedValue({ stdout: '' })
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).resolves.toBe(false)
    expect(kill.mock.calls).toEqual([[41001, 0]])
  })

  it('rejects an empty ps result when the OS still finds that PID', async () => {
    readPs.mockRejectedValue(missingPs())
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).rejects.toThrow('ps did not find')
    expect(kill.mock.calls).toEqual([[41001, 0]])
  })

  it('keeps permission or nonempty ps errors unknown instead of guessing absence', async () => {
    readPs.mockRejectedValue(missingPs())
    kill.mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).rejects.toThrow('not permitted')
    expect(kill.mock.calls).toEqual([[41001, 0]])
    kill.mockClear()
    readPs.mockRejectedValue(Object.assign(missingPs(), { stderr: 'ps failed to read the selected PID' }))
    await expect(signalOwnedProbeProcess(41001, root, 'SIGTERM')).rejects.toThrow('ps did not find')
    expect(kill.mock.calls).toEqual([])
  })
})
