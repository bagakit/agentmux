import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }))
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.spawn.mockReset()
})

async function coldConnect() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-sdk-diagnostic-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let child: ChildProcess | undefined
  fixture.spawn.mockImplementation((...args: Parameters<typeof actual.spawn>) => { child = actual.spawn(...args); return child })
  const adapter = new CtxmuxRunAdapter()
  cleanup.push(async () => {
    adapter.disconnect()
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done }
  })
  await adapter.connect()
  if (!child?.stderr) throw new Error('The real SDK did not spawn the private daemon')
  return { adapter, child, stderr: child.stderr }
}

it('consumes the SDK-owned diagnostic pipe without closing or referencing it after readiness', async () => {
  const unref = vi.spyOn(Socket.prototype, 'unref'), h = await coldConnect()
  expect(h.adapter.isConnected()).toBe(true)
  expect(h.stderr.destroyed).toBe(false)
  expect(unref.mock.instances).toContain(h.stderr)
})

it('keeps a typed SDK diagnostic-channel failure visible without disconnecting the real Runtime', async () => {
  const h = await coldConnect(), error = vi.fn(), lost = vi.fn()
  h.adapter.onError(error); h.adapter.onConnectionLost(lost)
  h.stderr.emit('error', new Error('diagnostic receiver unavailable'))
  expect(error).toHaveBeenCalledOnce()
  expect(error.mock.calls[0]?.[0]).toMatchObject({ code: 'CTXMUX_DIAGNOSTIC_CHANNEL_UNAVAILABLE' })
  expect(h.adapter.isConnected()).toBe(true); expect(lost).not.toHaveBeenCalled()
  expect(h.child.exitCode).toBe(null)
  const late = vi.fn(); h.adapter.onError(late)
  expect(late).toHaveBeenCalledWith(expect.objectContaining({ code: 'CTXMUX_DIAGNOSTIC_CHANNEL_UNAVAILABLE' }))
})

it('a throwing presentation observer cannot suppress the original child exit', async () => {
  const h = await coldConnect(), lost = vi.fn()
  h.adapter.onConnectionLost(lost)
  h.adapter.onError(() => { throw new Error('presentation observer failed') })
  h.stderr.emit('error', new Error('typed diagnostic channel failure'))
  const exited = once(h.child, 'exit'); h.child.kill('SIGTERM'); await exited
  expect(h.adapter.isConnected()).toBe(false)
  expect(lost).toHaveBeenCalledOnce()
})
