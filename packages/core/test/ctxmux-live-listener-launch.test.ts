import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ runtimeInfo: vi.fn(), spawn: vi.fn((_command: string, _args: readonly string[]) => { throw new Error('launch was attempted') }) }))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }))
vi.mock('@ctxmux/sdk', async (original) => ({
  ...await original<typeof import('@ctxmux/sdk')>(),
  CtxmuxClient: class { runtimeInfo = fixture.runtimeInfo }
}))
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

describe('the selected live listener is preserved when Hello cannot be accepted', () => {
  it('does not launch another daemon when Hello fails before any Runtime identity is returned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-live-hello-'))
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
    fixture.spawn.mockClear()
    fixture.runtimeInfo.mockRejectedValue(new Error('incompatible public Hello'))
    const server = createServer((socket) => socket.on('error', () => {}))
    await new Promise<void>((done) => server.listen(join(root, 'ctxmux.sock'), done))
    try {
      await expect(new CtxmuxRunAdapter().connect()).rejects.toThrow('incompatible public Hello')
      expect(fixture.runtimeInfo).toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
      expect(server.listening).toBe(true)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still reaches the existing launch owner when the selected socket is proven absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-dead-hello-'))
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
    fixture.spawn.mockClear()
    fixture.runtimeInfo.mockRejectedValue(new Error('socket absent'))
    try {
      await expect(new CtxmuxRunAdapter().connect()).rejects.toThrow('launch was attempted')
      expect(fixture.spawn).toHaveBeenCalledOnce()
      expect(fixture.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--socket', join(root, 'ctxmux.sock')]))
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})
