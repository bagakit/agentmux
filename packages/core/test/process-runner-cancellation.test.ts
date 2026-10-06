import { fixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { isConfirmedProcessCancellation, runProcess } from '../src/process-runner.js'
import { AgentMuxError } from '../src/errors.js'

it.each([
  new AgentMuxError('Terminal input changed.', 'AGENT_INPUT_OBSERVATION_CANCELLED', JSON.stringify({ source: 'terminal-user' })),
  new DOMException('Original observation timed out.', 'TimeoutError')
])('preserves the original prelaunch cancellation %s without starting a child', async reason => {
  const cancel = new AbortController(); cancel.abort(reason)
  const error = await runProcess(fixturePath("command-that-must-not-launch"), [], { signal: cancel.signal }).catch(error => error)
  expect(error).toMatchObject({ code: 'COMMAND_ABORTED', message: 'Command was cancelled before launch.', cause: reason })
  expect(error.cause).toBe(reason); expect(Object.keys(error)).not.toContain('cause')
  expect(JSON.parse(error.detail)).toMatchObject({ code: reason instanceof AgentMuxError ? reason.code : 'TimeoutError', message: reason.message })
  expect(cancel.signal.reason).toBe(reason)
  expect(isConfirmedProcessCancellation(error, cancel.signal)).toBe(true)
})

it('preserves active-child cancellation reason while terminating only its private child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-command-cancel-')), ready = join(root, 'ready')
  const cancel = new AbortController(), reason = new AgentMuxError('Yield for the original terminal protocol reply.', 'AGENT_INPUT_OBSERVATION_CANCELLED', JSON.stringify({ source: 'terminal-protocol' }))
  const originalSpawn = cp.spawn
  let originalCloseObserved = false
  cp.spawn = function (this: unknown, ...args: Parameters<typeof cp.spawn>) {
    const child = Reflect.apply(originalSpawn, this, args)
    if (args[0] === process.execPath && Array.isArray(args[1]) && args[1].includes(ready)) child.once('close', () => { originalCloseObserved = true })
    return child
  } as typeof cp.spawn
  syncBuiltinESMExports()
  try {
    const running = runProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ready], { signal: cancel.signal }).catch(error => error)
    let pid = 0
    for (let attempt = 0; attempt < 200 && !pid; attempt++) { pid = Number(await readFile(ready, 'utf8').catch(() => '')); if (!pid) await new Promise(done => setTimeout(done, 10)) }
    expect(pid).toBeGreaterThan(0); cancel.abort(reason)
    const error = await running
    expect(originalCloseObserved, 'the original child close must precede confirmed cancellation').toBe(true)
    expect(isConfirmedProcessCancellation(error, cancel.signal)).toBe(true)
    expect(error).toMatchObject({ code: 'COMMAND_ABORTED', message: 'Command was cancelled.', cause: reason })
    expect(error.cause).toBe(reason); expect(JSON.parse(error.detail)).toMatchObject({ code: reason.code, detail: reason.detail })
    for (let attempt = 0; attempt < 200; attempt++) { try { process.kill(pid, 0) } catch { pid = 0; break } await new Promise(done => setTimeout(done, 10)) }
    expect(pid, 'cancelled private command must be reaped').toBe(0)
    expect(cancel.signal.reason).toBe(reason)
  } finally { cp.spawn = originalSpawn; syncBuiltinESMExports(); cancel.abort(reason); await rm(root, { recursive: true, force: true }) }
})

it('keeps command timeout distinct from caller cancellation', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }).catch(error => error)
  expect(result).toMatchObject({ code: 'COMMAND_TIMEOUT', message: 'Command timed out.' })
  expect(result.detail).toBeUndefined(); expect(result.cause).toBeUndefined()
  const cancel = new AbortController(); cancel.abort(new Error('later caller cancellation'))
  expect(isConfirmedProcessCancellation(result, cancel.signal)).toBe(false)
  const lookalike = new AgentMuxError('opaque error', 'COMMAND_ABORTED')
  Object.defineProperty(lookalike, 'cause', { value: cancel.signal.reason })
  expect(isConfirmedProcessCancellation(lookalike, cancel.signal)).toBe(false)
})

it('an unobserved original child exit keeps cancellation unconfirmed in the top-level error and its cause', async () => {
  const cancel = new AbortController(), reason = new Error('original caller stopped'), originalSpawn = cp.spawn
  let child: ReturnType<typeof cp.spawn> | undefined, closed!: Promise<void>, closeObserved = false
  let originalEmit: typeof cp.ChildProcess.prototype.emit | undefined, heldClose: unknown[] | undefined
  cp.spawn = function (this: unknown, ...args: Parameters<typeof cp.spawn>) {
    const current = Reflect.apply(originalSpawn, this, args)
    child = current
    originalEmit = current.emit
    // Controlled loss of this original Child's close notification, keeping the
    // real spawn/object/kill and exact emitted payload. No fabricated exit ACK.
    current.emit = function (this: cp.ChildProcess, event: string | symbol, ...values: unknown[]): boolean {
      if (event === 'close') { heldClose = values; return false }
      return Reflect.apply(originalEmit!, this, [event, ...values])
    }
    closed = new Promise(resolve => current.once('close', () => { closeObserved = true; resolve() }))
    return current
  } as typeof cp.spawn
  syncBuiltinESMExports()
  try {
    const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: cancel.signal }).catch(error => error)
    cancel.abort(reason)
    const error = await pending
    expect(error.code).toBe('COMMAND_EXIT_UNCONFIRMED'); expect(closeObserved).toBe(false)
    expect(heldClose).toBeDefined()
    expect(error.cause).toMatchObject({ code: 'COMMAND_ABORTED', cause: reason })
    expect(isConfirmedProcessCancellation(error, cancel.signal)).toBe(false)
    expect(isConfirmedProcessCancellation(error.cause, cancel.signal)).toBe(false)
  } finally {
    cp.spawn = originalSpawn; syncBuiltinESMExports()
    if (child && originalEmit) {
      child.emit = originalEmit
      if (heldClose) Reflect.apply(originalEmit, child, ['close', ...heldClose])
    }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (closed) await closed
  }
})

it('keeps healthy command result and stdin unchanged', async () => {
  expect(await runProcess(process.execPath, ['-e', 'process.stdin.on("data", s => process.stdout.write(s)); process.stderr.write("stderr");'], { input: 'original stdin', timeoutMs: 1000 }))
    .toEqual({ stdout: 'original stdin', stderr: 'stderr', exitCode: 0 })
})
