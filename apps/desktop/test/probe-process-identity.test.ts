const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const { readPs, spawnProbe } = vi.hoisted(() => ({ readPs: vi.fn(), spawnProbe: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const execFile = vi.fn()
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: readPs })
  return { ...original, execFile, spawn: spawnProbe }
})

import { listProbeProcesses, signalOwnedProbeProcess, stopProbeProcesses, runProbeProcess } from '../scripts/probe-process.mjs'

const root = _hygiene_fixturePath("tmp/agentmux-owned-identity")
const missingPs = () => Object.assign(new Error('ps did not find the selected PID'), {
  code: 1, stdout: '', stderr: ''
})

describe('private probe cleanup identity', () => {
  let kill: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    readPs.mockReset()
    spawnProbe.mockReset()
    kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  })
  afterEach(() => vi.restoreAllMocks())

  it('does not signal a departed group when the live owner inventory is empty', async () => {
    readPs.mockResolvedValue({ stdout: '' })
    kill.mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    await expect(stopProbeProcesses(41001, root, 0)).resolves.toBeUndefined()
    expect(kill.mock.calls).toEqual([])
    expect(readPs).toHaveBeenCalledTimes(1)
  })

  it('cleans a detached root observer without signalling its departed original group', async () => {
    readPs.mockResolvedValueOnce({ stdout: `42002 42002 S node ${root}/observer.mjs\n` })
      .mockResolvedValueOnce({ stdout: `42002 S node ${root}/observer.mjs\n` })
      .mockResolvedValueOnce({ stdout: '' })
    kill.mockImplementation(pid => {
      if (pid !== 42002) throw Object.assign(new Error('wrong process'), { code: 'EPERM' })
      return true
    })
    await expect(stopProbeProcesses(41001, root, 0)).resolves.toBeUndefined()
    expect(kill.mock.calls).toEqual([[42002, 'SIGTERM']])
    expect(readPs).toHaveBeenCalledTimes(3)
  })

  it('escalates only the still observed live group member and confirms final absence', async () => {
    const live = { stdout: '41002 41001 S node -e child\n' }
    readPs.mockResolvedValueOnce(live).mockResolvedValueOnce({ stdout: '41001 S node -e child\n' })
      .mockResolvedValueOnce(live).mockResolvedValueOnce({ stdout: '41001 S node -e child\n' })
      .mockResolvedValueOnce({ stdout: '' })
    await expect(stopProbeProcesses(41001, root, 0)).resolves.toBeUndefined()
    expect(kill.mock.calls).toEqual([[41002, 'SIGTERM'], [41002, 'SIGKILL']])
    expect(readPs).toHaveBeenCalledTimes(5)
  })

  it('keeps a real permission failure for an observed owner visible', async () => {
    readPs.mockResolvedValueOnce({ stdout: `42002 42002 S node ${root}/observer.mjs\n` })
      .mockResolvedValueOnce({ stdout: `42002 S node ${root}/observer.mjs\n` })
    kill.mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    await expect(stopProbeProcesses(41001, root, 0)).rejects.toThrow('not permitted')
    expect(kill.mock.calls).toEqual([[42002, 'SIGTERM']])
  })

  it('refuses TERM when a discovered PID has moved to another group and private root', async () => {
    readPs.mockResolvedValueOnce({ stdout: `41002 41001 S node ${root}/worker.mjs\n` })
      .mockResolvedValueOnce({ stdout: ("42000 S node " + _hygiene_fixturePath("other/private/worker.mjs") + "\n") })
    await expect(stopProbeProcesses(41001, root, 0)).rejects.toThrow('Private process identity changed')
    expect(kill.mock.calls).toEqual([])
    expect(readPs).toHaveBeenLastCalledWith('/bin/ps', ['-p', '41002', '-o', 'pgid=,stat=,command='], {
      timeout: 5_000, maxBuffer: 64 * 1024
    })
  })

  it('refuses KILL if a surviving PID changes identity after the TERM inventory', async () => {
    const live = { stdout: `41002 41001 S node ${root}/worker.mjs\n` }
    readPs.mockResolvedValueOnce(live).mockResolvedValueOnce({ stdout: `41001 S node ${root}/worker.mjs\n` })
      .mockResolvedValueOnce(live).mockResolvedValueOnce({ stdout: ("42000 S node " + _hygiene_fixturePath("other/private/worker.mjs") + "\n") })
    await expect(stopProbeProcesses(41001, root, 0)).rejects.toThrow('Private process identity changed')
    expect(kill.mock.calls).toEqual([[41002, 'SIGTERM']])
  })

  it('ends watchdog observation when cleanup fails even if the child never exits, preserving unknown ownership', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 41001, stderr: new PassThrough() })
    spawnProbe.mockReturnValue(child)
    readPs.mockRejectedValue(Object.assign(new Error('ps permission denied'), { code: 'EPERM' }))
    vi.useFakeTimers()
    let settled = false
    const outcome = runProbeProcess('private-probe', [], { temporaryRoot: root, timeoutMs: 20, graceMs: 0 })
      .then(() => { settled = true; return null }, error => { settled = true; return error })
    try {
      await vi.advanceTimersByTimeAsync(25)
      expect(settled).toBe(true)
    } finally {
      // A failed implementation must produce an AssertionError, not hang this test.
      child.emit('exit', 0, null)
      vi.useRealTimers()
    }
    const error = await outcome
    expect(error).toMatchObject({ code: 'EPERM', probe: { leaderPid: 41001, temporaryRoot: root, cleanup: 'unknown' },
      cause: { message: 'ps permission denied', code: 'EPERM' } })
    expect(error.message).toContain('remaining owners are unknown')
    expect(kill.mock.calls).toEqual([])
    expect(child.stderr.destroyed).toBe(true)
  })

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

  it.each([("S node " + _hygiene_fixturePath("another-private-root/worker.mjs")), `S node ${root}-other/worker.mjs`])(
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
