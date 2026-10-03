import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import { CtxmuxClient, PROTOCOL_VERSION, type RuntimeIdentity } from '@ctxmux/sdk'

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn
}))
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

const runtime: RuntimeIdentity = {
  daemonInstanceId: '11111111-1111-4111-8111-111111111111',
  runtimeId: '22222222-2222-4222-8222-222222222222', runtimeIdPersistence: 'state_dir',
  buildId: 'ctxmuxd/0.1.0', protocolGeneration: PROTOCOL_VERSION, platform: 'macos', arch: 'aarch64',
  capabilities: { 'native.start': 1, 'native.recoverable_input': 1, 'native.recoverable_stop': 1,
    'services.persistent_state': 1, 'services.planned_exec_upgrade_continuity': 1 }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.spawn.mockReset()
})

async function coldConnect() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-diagnostic-lifetime-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.spyOn(CtxmuxClient.prototype, 'runtimeInfo')
    .mockRejectedValueOnce(new Error('absent listener')).mockResolvedValue(runtime)
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let child: ChildProcess | undefined
  fixture.spawn.mockImplementation(() => {
    child = actual.spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      fs.writeSync(3, JSON.stringify({schema:'ctxmux.daemon-ready.v1',daemon_instance:'${runtime.daemonInstanceId}'})+'\\n');
      process.stdin.on('data', data => {
        fs.writeSync(2, data);
        process.stdout.write('diagnostic-written\\n');
      });
      process.stdin.on('end', () => process.exit(0));
    `], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    return child
  })
  const adapter = new CtxmuxRunAdapter()
  await adapter.connect()
  if (!child?.stderr || !child.stdin || !child.stdout) throw new Error('cold spawn fixture did not execute')
  const started = child
  cleanup.push(async () => {
    adapter.disconnect()
    if (started.exitCode === null) {
      const ended = once(started, 'exit'); started.stdin?.end(); await ended
    }
  })
  return { adapter, child: started, stderr: child.stderr, stdin: child.stdin, stdout: child.stdout }
}

it('keeps draining the real spawned pipe after production readiness succeeds', async () => {
  const h = await coldConnect()
  expect(h.adapter.isConnected()).toBe(true)
  expect(h.stderr.destroyed).toBe(false)
  const data = once(h.stderr, 'data'), acknowledgement = once(h.stdout, 'data')
  h.stdin.write('late persistence failure\n')
  expect((await data)[0]).toContain('late persistence failure')
  expect((await acknowledgement)[0].toString()).toContain('diagnostic-written')
  expect(h.child.exitCode).toBe(null)
  expect(h.adapter.isConnected()).toBe(true)
})

it('unreferences the drained pipe so it does not keep the client alive', async () => {
  const unref = vi.spyOn(Socket.prototype, 'unref')
  const h = await coldConnect()
  expect(unref.mock.instances).toContain(h.stderr)
  expect(h.stderr.destroyed).toBe(false)
})

it('reports a diagnostic channel error without disconnecting the working Runtime', async () => {
  const h = await coldConnect(), error = vi.fn(), lost = vi.fn()
  h.adapter.onError(error); h.adapter.onConnectionLost(lost)
  h.stderr.emit('error', new Error('diagnostic receiver unavailable'))
  expect(error).toHaveBeenCalledOnce()
  expect(error.mock.calls[0]?.[0]).toMatchObject({ code: 'CTXMUX_DIAGNOSTIC_CHANNEL_UNAVAILABLE' })
  expect(h.adapter.isConnected()).toBe(true)
  expect(lost).not.toHaveBeenCalled()
  expect(h.child.exitCode).toBe(null)
})

it('continues draining after the bounded diagnostic prefix is filled', async () => {
  const h = await coldConnect()
  let received = 0
  h.stderr.on('data', chunk => { received += Buffer.byteLength(chunk) })
  const acknowledgement = once(h.stdout, 'data')
  h.stdin.write('界'.repeat(20_000))
  await acknowledgement
  await vi.waitFor(() => expect(received).toBe(60_000))
  expect(h.stderr.destroyed).toBe(false)
  expect(h.adapter.isConnected()).toBe(true)
})
