import { spawn, execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)

it('public Runtime-first factory preserves controls during observation and the original Run across process reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-runtime-first-'))
  const core = resolve(import.meta.dirname, '..')
  const native = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin')
  const socket = join(root, 'ctxmux.sock')
  const state = join(root, 'state')
  await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
  const daemon = spawn(join(native, 'ctxmuxd'), ['--socket', socket, '--state-dir', join(state, 'ctxmux')], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = '', spawnError: Error | undefined
  daemon.stderr.on('data', data => { stderr += data.toString() })
  daemon.on('error', error => { spawnError = error })
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  const fixture = join(core, 'test/fixtures/runtime-first-consumer.mjs')
  try {
    const startupDeadline = Date.now() + 30_000
    for (;;) {
      if (spawnError) throw spawnError
      if (daemon.exitCode !== null) throw new Error(`Private daemon exited: ${stderr}`)
      try { if (!(await stat(socket)).isSocket()) throw new Error('Private daemon is still starting'); await exec(join(native, 'ctxmux'), ['--socket', socket, 'ping'], { timeout: 1000 }); break }
      catch (error) { if (Date.now() >= startupDeadline) throw new Error(`Private daemon did not become ready: ${stderr}`, { cause: error }); await new Promise(resolve => setTimeout(resolve, 20)) }
    }
    const identity = join(root, 'identity.json')
    const first = await exec(process.execPath, [fixture, 'first', identity], { cwd: core, env, timeout: 30000, maxBuffer: 128 * 1024 })
    const second = await exec(process.execPath, [fixture, 'second', identity], { cwd: core, env, timeout: 30000, maxBuffer: 128 * 1024 })
    const before = JSON.parse(first.stdout.trim()), after = JSON.parse(second.stdout.trim())
    expect(before).toMatchObject({ pendingInput: true, failureInput: true, sameClientRefresh: true })
    expect(after).toMatchObject({ runId: before.runId, pid: before.pid, originalProcess: true, fullFactoryRejects: true })
  } finally {
    // This PID was spawned by this test, with a private endpoint and state root.
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      await new Promise<void>(resolve => { if (daemon.exitCode !== null) resolve(); else daemon.once('exit', () => resolve()) })
    }
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
