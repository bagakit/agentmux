import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { CtxmuxClient, PROTOCOL_VERSION, type RuntimeIdentity } from '@ctxmux/sdk'

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: processBoundary.spawn
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
  vi.restoreAllMocks(); vi.unstubAllEnvs(); processBoundary.spawn.mockReset()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-cold-readiness-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'durable'))
  const serving = { value: false }
  vi.spyOn(CtxmuxClient.prototype, 'runtimeInfo').mockImplementation(async () => {
    if (!serving.value) throw new Error('listener is not serving yet')
    return structuredClone(runtime)
  })
  // Only process creation and the public server response are controlled. Production artifact
  // verification, activation lifetime, fd3 parsing, observation timer and receipt I/O all execute.
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const children: ChildProcess[] = []
  const signals: unknown[] = []
  processBoundary.spawn.mockImplementation(() => {
    const child = actual.spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        input += chunk; let index;
        while ((index = input.indexOf('\\n')) >= 0) {
          const command = input.slice(0, index); input = input.slice(index + 1);
          if (command === 'exit') { process.exit(17); }
          else if (command === 'closed') { fs.closeSync(3); }
          else if (command === 'malformed') { fs.writeSync(3, '{broken\\n'); }
          else {
            fs.writeSync(3, JSON.stringify({schema: 'ctxmux.daemon-ready.v1',
              daemon_instance: command === 'mismatch' ? 'other-child' : '${runtime.daemonInstanceId}'}) + '\\n');
          }
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    const kill = child.kill.bind(child)
    vi.spyOn(child, 'kill').mockImplementation(signal => { signals.push(signal); return kill(signal) })
    children.push(child)
    return child
  })
  cleanup.push(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit'); child.stdin?.end(); await exited
    }
  })
  const adapter = new CtxmuxRunAdapter()
  cleanup.push(async () => { adapter.disconnect() })
  return { directory, adapter, children, serving, signals }
}

describe('durable daemon startup outlives a connect observation', () => {
  it('shares the child across callers after the real five-second window, preserves it on disconnect and proves late ownership', async () => {
    const h = await fixture()
    const other = new CtxmuxRunAdapter()
    cleanup.push(async () => { other.disconnect() })
    const started = Date.now()
    const results = await Promise.allSettled([h.adapter.connect(), other.connect()])
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'CTXMUX_STARTUP_PENDING' })
        expect(result.reason.message).toContain('Retry the same Runtime connection')
        expect(result.reason.message).toContain(`PID ${h.children[0]!.pid}`)
      }
    }
    expect(h.children).toHaveLength(1)
    const child = h.children[0]!
    h.adapter.disconnect(); other.disconnect()
    expect(h.signals).toEqual([])
    expect(child.exitCode).toBeNull()
    expect((child.stdio[3] as Readable).destroyed).toBe(false)
    expect(child.stderr?.destroyed).toBe(false)

    // A compatible public listener can be used even while its inherited receipt is pending.
    h.serving.value = true
    await other.connect()
    expect(other.runtimeOwnership).toBe('unverified')
    expect(other.isConnected()).toBe(true)
    await expect(readFile(join(h.directory, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    child.stdin!.write('ready\n')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(join(h.directory, 'owner.json'), 'utf8'))).toMatchObject({
        schema: 'agentmux.ctxmux-owner.v1', daemonInstanceId: runtime.daemonInstanceId,
        runtimeId: runtime.runtimeId, socketPath: h.adapter.socketPath,
        stateDirectory: h.adapter.stateDirectory
      })
      expect(other.runtimeOwnership).toBe('owned')
    })
    await h.adapter.connect()
    expect(h.adapter.runtimeOwnership).toBe('owned')
    expect(h.adapter.identity().daemonInstanceId).toBe(runtime.daemonInstanceId)
    expect(h.children).toHaveLength(1)
    expect(h.signals).toEqual([])
  }, 15_000)

  it.each(['malformed', 'closed', 'mismatch'] as const)('preserves a live child after %s readiness and admits a compatible public listener without claiming it', async command => {
    const h = await fixture(), errors = vi.fn()
    h.adapter.onError(errors)
    const connecting = h.adapter.connect()
    const observed = connecting.catch(error => error)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    const child = h.children[0]!
    if (command === 'mismatch') h.serving.value = true
    child.stdin!.write(`${command}\n`)
    if (command === 'mismatch') await connecting
    else {
      expect(await observed).toMatchObject({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' })
      await expect(h.adapter.connect()).rejects.toMatchObject({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' })
    }
    expect(errors).toHaveBeenCalled()
    expect(errors.mock.calls[0]![0].message).toMatch(/invalid readiness|closed its readiness|does not match/)
    h.serving.value = true
    await h.adapter.connect()
    expect(h.adapter.isConnected()).toBe(true)
    expect(h.adapter.runtimeOwnership).toBe('unverified')
    const lateObserver = vi.fn()
    h.adapter.onError(lateObserver)
    expect(lateObserver).toHaveBeenCalledOnce()
    expect(lateObserver.mock.calls[0]![0].message).toMatch(/invalid readiness|closed its readiness|does not match/)
    await expect(readFile(join(h.directory, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.children).toHaveLength(1)
    expect(child.exitCode).toBeNull()
    expect(h.signals).toEqual([])
  })

  it('reports actual child exit, then permits a fresh activation at the same dead endpoint', async () => {
    const h = await fixture()
    const failed = h.adapter.connect().catch(error => error)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    const first = h.children[0]!, exited = once(first, 'exit')
    first.stdin!.write('exit\n')
    expect(await failed).toMatchObject({ code: expect.stringMatching(/CTXMUX_(UNAVAILABLE|OWNER_IDENTITY_UNPROVEN)/) })
    await exited
    expect(first.exitCode).toBe(17)
    const retry = h.adapter.connect()
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.serving.value = true
    h.children[1]!.stdin!.write('ready\n')
    await retry
    expect(h.adapter.runtimeOwnership).toBe('owned')
    expect(h.adapter.isConnected()).toBe(true)
    expect(h.signals).toEqual([])
  })
})
