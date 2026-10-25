import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ spawn: vi.fn((_command: string, _args: readonly string[]) => { throw new Error('launch was attempted') }) }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }))
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs(); fixture.spawn.mockClear()
})
async function namespace() {
  const root = await mkdtemp(join(tmpdir(), 'amx-live-hello-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'durable'))
  return root
}
async function silentListener() {
  const root = await namespace(), sockets = new Set<Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.resume() })
  await new Promise<void>(done => server.listen(join(root, 'ctxmux.sock'), done))
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())) })
  return { server, sockets }
}

describe('initial Hello is a bounded disposable SDK observation', () => {
  it('times out a silent accepted listener without replacing it or retaining the observer socket', async () => {
    const h = await silentListener(), started = Date.now()
    await expect(new CtxmuxRunAdapter().connect()).rejects.toMatchObject({ code: 'CTXMUX_STARTUP_PENDING' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
    expect(Date.now() - started).toBeLessThan(7_000)
    await vi.waitFor(() => expect(h.sockets.size).toBe(0))
    expect(fixture.spawn).not.toHaveBeenCalled(); expect(h.server.listening).toBe(true)
  }, 10_000)

  it('cancels only the reader of the same silent public listener', async () => {
    const h = await silentListener(), controller = new AbortController()
    const observing = new CtxmuxRunAdapter().connect({ signal: controller.signal })
    const failure = observing.catch(error => error)
    await vi.waitFor(() => expect(h.sockets.size).toBe(1))
    controller.abort()
    expect(await failure).toMatchObject({ code: 'CONTROL_CANCELLED' })
    await vi.waitFor(() => expect(h.sockets.size).toBe(0))
    expect(fixture.spawn).not.toHaveBeenCalled(); expect(h.server.listening).toBe(true)
  })

  it('reaches SDK activation only when the selected socket is proven absent', async () => {
    const root = await namespace()
    await expect(new CtxmuxRunAdapter().connect()).rejects.toThrow('launch was attempted')
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--socket', join(root, 'ctxmux.sock')]))
  })
})
