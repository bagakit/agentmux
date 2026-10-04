import { fixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '../src/process-runner.js'
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
})

it('preserves active-child cancellation reason while terminating only its private child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-command-cancel-')), ready = join(root, 'ready')
  const cancel = new AbortController(), reason = new AgentMuxError('Yield for the original terminal protocol reply.', 'AGENT_INPUT_OBSERVATION_CANCELLED', JSON.stringify({ source: 'terminal-protocol' }))
  try {
    const running = runProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ready], { signal: cancel.signal }).catch(error => error)
    let pid = 0
    for (let attempt = 0; attempt < 200 && !pid; attempt++) { pid = Number(await readFile(ready, 'utf8').catch(() => '')); if (!pid) await new Promise(done => setTimeout(done, 10)) }
    expect(pid).toBeGreaterThan(0); cancel.abort(reason)
    const error = await running
    expect(error).toMatchObject({ code: 'COMMAND_ABORTED', message: 'Command was cancelled.', cause: reason })
    expect(error.cause).toBe(reason); expect(JSON.parse(error.detail)).toMatchObject({ code: reason.code, detail: reason.detail })
    for (let attempt = 0; attempt < 200; attempt++) { try { process.kill(pid, 0) } catch { pid = 0; break } await new Promise(done => setTimeout(done, 10)) }
    expect(pid, 'cancelled private command must be reaped').toBe(0)
    expect(cancel.signal.reason).toBe(reason)
  } finally { cancel.abort(reason); await rm(root, { recursive: true, force: true }) }
})

it('keeps command timeout distinct from caller cancellation', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }).catch(error => error)
  expect(result).toMatchObject({ code: 'COMMAND_TIMEOUT', message: 'Command timed out.' })
  expect(result.detail).toBeUndefined(); expect(result.cause).toBeUndefined()
})

it('keeps healthy command result and stdin unchanged', async () => {
  expect(await runProcess(process.execPath, ['-e', 'process.stdin.on("data", s => process.stdout.write(s)); process.stderr.write("stderr");'], { input: 'original stdin', timeoutMs: 1000 }))
    .toEqual({ stdout: 'original stdin', stderr: 'stderr', exitCode: 0 })
})
