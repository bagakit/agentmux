import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer, createConnection, type Socket } from 'node:net'
import { CtxmuxClient, createOperationKey, defineRun } from '@ctxmux/sdk'

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), artifactMissing: false, receiptDenied: false, receiptWrites: 0, holdReceipt: null as (() => Promise<void>) | null }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: boundary.spawn }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (boundary.artifactMissing && String(args[0]).includes(join('vendor', 'ctxmux') + '/') && String(args[0]).endsWith('/manifest.json')) {
        throw Object.assign(new Error('Activation artifacts disappeared after the original spawn'), { code: 'ENOENT' })
      }
      return await Reflect.apply(actual.readFile, actual, args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).includes('/owner-') && String(args[1]).endsWith('.json')) {
        boundary.receiptWrites++
        await boundary.holdReceipt?.()
        if (boundary.receiptDenied) throw Object.assign(new Error('owner receipt temporarily unavailable'), { code: 'EACCES' })
      }
      return await Reflect.apply(actual.rename, actual, args)
    }
  }
})
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { CTXMUX_MANIFEST_SHA256, ctxmuxOwnerReceiptPath } from '../src/runtime-paths.js'
import { AgentMuxClient } from '../src/client.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  boundary.artifactMissing = false; boundary.receiptDenied = false; boundary.receiptWrites = 0; boundary.holdReceipt = null
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.spawn.mockReset()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-sdk-ready-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  const wrapper = join(directory, 'launch.sh')
  // The wrapper execs the actual daemon, preserving the exact SDK-owned child PID.
  // Only launch timing and the inherited receipt channel are fault-injected.
  await writeFile(wrapper, `#!/bin/sh
IFS= read -r command
case "$command" in
  exit) exit 17 ;;
  withheld-listener) exec "$1" --socket "$3.withheld" --state-dir "$5" --readiness-fd 3 ;;
  closed) exec 3>&-; exec "$1" --socket "$3" --state-dir "$5" ;;
  malformed) printf '{broken\\n' >&3 ;;
  mismatch) printf '%s\\n' '{"schema":"ctxmux.daemon-ready.v1","daemon_instance":"00000000-0000-4000-8000-000000000000"}' >&3 ;;
esac
exec "$@"
`, { mode: 0o700 })
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const children: ChildProcess[] = [], signals: unknown[] = []
  boundary.spawn.mockImplementation((program: string, args: string[], options: SpawnOptions) => {
    const stdio = options.stdio as unknown[]
    const child = actual.spawn('/bin/sh', [wrapper, program, ...args], { ...options, stdio: ['pipe', ...stdio.slice(1)] } as SpawnOptions)
    const kill = child.kill.bind(child)
    vi.spyOn(child, 'kill').mockImplementation(signal => { signals.push(signal); return kill(signal) })
    children.push(child)
    return child
  })
  cleanup.push(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGTERM'); await done
    }
  })
  const adapter = new CtxmuxRunAdapter()
  cleanup.push(async () => adapter.disconnect())
  const native = new CtxmuxClient({ socketPath: adapter.socketPath })
  const launch = async (command = 'ready') => {
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.stdin!.write(command + '\n')
  }
  const receiptPath = (identity: { runtimeId: string; daemonInstanceId: string }) =>
    ctxmuxOwnerReceiptPath(adapter.socketPath, identity, CTXMUX_MANIFEST_SHA256)
  return { directory, adapter, native, children, signals, launch, receiptPath }
}

describe('SDK owns the original durable activation', () => {
  it('keeps one child after bounded waits and disconnect, then proves late ownership without activation artifacts', async () => {
    const h = await fixture(), other = new CtxmuxRunAdapter()
    cleanup.push(async () => other.disconnect())
    const available = vi.fn(); h.adapter.onConnectionAvailable(available)
    const started = Date.now()
    const results = await Promise.allSettled([h.adapter.connect(), other.connect()])
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'CTXMUX_STARTUP_PENDING' })
    }
    expect(h.children).toHaveLength(1)
    const child = h.children[0]!
    other.disconnect()
    expect(h.signals).toEqual([])
    expect((child.stdio[3] as Readable).destroyed).toBe(false)
    expect(child.stderr?.destroyed).toBe(false)
    boundary.artifactMissing = true
    await h.launch()
    await vi.waitFor(() => expect(available).toHaveBeenCalled(), { timeout: 3_000 })
    const original = await h.native.runtimeInfo()
    await h.adapter.connect()
    expect(h.adapter.runtimeOwnership).toBe('owned')
    expect(h.adapter.identity().daemonInstanceId).toBe(original.daemonInstanceId)
    expect(JSON.parse(await readFile(h.receiptPath(await h.native.runtimeInfo()), 'utf8'))).toMatchObject({ daemonInstanceId: original.daemonInstanceId, runtimeId: original.runtimeId })
    expect(h.children).toHaveLength(1); expect(h.signals).toEqual([])
  }, 15_000)

  it.each(['malformed', 'closed', 'mismatch'])('keeps a real compatible Runtime usable with %s receipt without claiming its child', async command => {
    const h = await fixture(), errors = vi.fn(); h.adapter.onError(errors)
    const connecting = h.adapter.connect().catch(error => error)
    await h.launch(command)
    await connecting
    await vi.waitFor(async () => expect((await h.native.runtimeInfo()).runtimeIdPersistence).toBe('state_dir'))
    await h.adapter.connect()
    expect(h.adapter.isConnected()).toBe(true)
    expect(h.adapter.runtimeOwnership).toBe('unverified')
    await expect(readFile(h.receiptPath(await h.native.runtimeInfo()))).rejects.toMatchObject({ code: 'ENOENT' })
    const run = await h.native.start(defineRun('/bin/cat', { cwd: h.directory }), createOperationKey(`ready-${command}`))
    expect((await h.adapter.status(run.id)).pid).toBe(run.pid)
    expect(h.signals).toEqual([]); expect(h.children).toHaveLength(1)
    if (command !== 'closed') {
      const late = vi.fn(); h.adapter.onError(late)
      expect(late).toHaveBeenCalled()
      expect(late.mock.calls[0]![0]).toMatchObject({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' })
    }
  }, 12_000)

  it('ends one observation and releases its subscription without ending the original activation', async () => {
    const h = await fixture(), cancelled = new AbortController(), available = vi.fn()
    h.adapter.onConnectionAvailable(available)
    const first = h.adapter.connect({ signal: cancelled.signal }).catch(error => error)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    cancelled.abort()
    expect(await first).toMatchObject({ code: 'CONTROL_CANCELLED' })
    h.adapter.disconnect()
    await h.launch()
    await vi.waitFor(async () => expect((await h.native.runtimeInfo()).runtimeIdPersistence).toBe('state_dir'))
    expect(available).not.toHaveBeenCalled()
    await h.adapter.connect()
    expect(h.adapter.isConnected()).toBe(true)
    expect(h.children).toHaveLength(1); expect(h.signals).toEqual([])
  })

  it('settles a recovered product receipt failure instead of replaying it to a late observer', async () => {
    const h = await fixture(); boundary.receiptDenied = true
    const connecting = h.adapter.connect(); await h.launch(); await connecting
    expect(h.adapter.runtimeOwnership).toBe('unverified')
    const during = vi.fn(); h.adapter.onError(during)
    await vi.waitFor(() => expect(during).toHaveBeenCalled())
    expect(during).toHaveBeenCalledWith(expect.objectContaining({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' }))
    boundary.receiptDenied = false
    await h.adapter.connect()
    await vi.waitFor(() => expect(h.adapter.runtimeOwnership).toBe('owned'))
    const late = vi.fn(); h.adapter.onError(late)
    expect(late).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(h.receiptPath(await h.native.runtimeInfo()), 'utf8')).daemonInstanceId).toBe((await h.native.runtimeInfo()).daemonInstanceId)
  })

  it('retries the original published readiness proof after a failed Hello observation while keeping the listener usable', async () => {
    const h = await fixture(), errors = vi.fn(), cancelled = new AbortController()
    h.adapter.onError(errors)
    const first = h.adapter.connect({ signal: cancelled.signal }).catch(error => error)
    await h.launch('withheld-listener')
    const original = new CtxmuxClient({ socketPath: h.adapter.socketPath + '.withheld' })
    await vi.waitFor(async () => expect((await original.runtimeInfo()).runtimeIdPersistence).toBe('state_dir'))
    cancelled.abort(); expect(await first).toMatchObject({ code: 'CONTROL_CANCELLED' })
    await vi.waitFor(() => expect(errors.mock.calls.some(([error]) => error.code === 'CTXMUX_OWNER_IDENTITY_UNPROVEN')).toBe(true), { timeout: 7_000 })
    const wires = new Set<Socket>()
    const proxy = createServer(downstream => {
      const upstream = createConnection(h.adapter.socketPath + '.withheld')
      for (const wire of [downstream, upstream]) { wires.add(wire); wire.on('error', () => {}); wire.on('close', () => wires.delete(wire)) }
      downstream.pipe(upstream).pipe(downstream)
    })
    cleanup.push(async () => { for (const wire of wires) wire.destroy(); await new Promise<void>(done => proxy.close(() => done())) })
    await new Promise<void>(done => proxy.listen(h.adapter.socketPath, done))
    await h.adapter.connect()
    expect(h.adapter.isConnected()).toBe(true)
    await vi.waitFor(() => expect(h.adapter.runtimeOwnership).toBe('owned'))
    expect(h.adapter.identity().daemonInstanceId).toBe((await original.runtimeInfo()).daemonInstanceId)
    const late = vi.fn(); h.adapter.onError(late)
    expect(late).not.toHaveBeenCalled()
    expect(h.children).toHaveLength(1); expect(h.signals).toEqual([])
  }, 12_000)

  it('shares one product receipt write while compatible consumers remain usable, then retries only that failed receipt', async () => {
    const h = await fixture(), other = new CtxmuxRunAdapter(), errors = vi.fn()
    cleanup.push(async () => other.disconnect())
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    boundary.holdReceipt = () => held; boundary.receiptDenied = true
    h.adapter.onError(errors)
    const first = h.adapter.connect(); await h.launch(); await first
    await other.connect()
    expect(h.adapter.isConnected()).toBe(true); expect(other.isConnected()).toBe(true)
    expect(h.adapter.runtimeOwnership).toBe('unverified')
    expect(boundary.receiptWrites).toBe(1)
    boundary.holdReceipt = null; release()
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
    boundary.receiptDenied = false
    await h.adapter.connect(); await other.connect()
    await vi.waitFor(() => expect(h.adapter.runtimeOwnership).toBe('owned'))
    expect(other.runtimeOwnership).toBe('owned')
    expect(boundary.receiptWrites).toBe(2)
    const late = vi.fn(); h.adapter.onError(late)
    expect(late).not.toHaveBeenCalled()
  })

  it('addresses product receipts by exact child generation while another publisher is delayed', async () => {
    const h = await fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    cleanup.push(async () => release())
    boundary.holdReceipt = () => boundary.receiptWrites === 1 ? held : Promise.resolve()
    const first = h.adapter.connect(); await h.launch(); await first
    await vi.waitFor(() => expect(boundary.receiptWrites).toBe(1))
    const original = await h.native.runtimeInfo(), child = h.children[0]!, exited = once(child, 'exit')
    child.kill('SIGTERM'); await exited
    const second = h.adapter.connect()
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.children[1]!.stdin!.write('ready\n'); await second
    const current = await h.native.runtimeInfo()
    expect(current.daemonInstanceId).not.toBe(original.daemonInstanceId)
    expect(h.adapter.isConnected()).toBe(true)
    await vi.waitFor(() => expect(h.adapter.runtimeOwnership).toBe('owned'))
    expect(boundary.receiptWrites).toBe(2)
    expect(JSON.parse(await readFile(h.receiptPath(current), 'utf8')).daemonInstanceId).toBe(current.daemonInstanceId)
    release()
    await vi.waitFor(async () => expect(JSON.parse(await readFile(h.receiptPath(original), 'utf8')).daemonInstanceId).toBe(original.daemonInstanceId))
    expect(JSON.parse(await readFile(h.receiptPath(current), 'utf8')).daemonInstanceId).toBe(current.daemonInstanceId)
    const reopened = new CtxmuxRunAdapter(); cleanup.push(async () => reopened.disconnect())
    await reopened.connect()
    expect(reopened.runtimeOwnership).toBe('owned')
  })

  it('public Core explicit connect retries a failed receipt without restarting healthy Runtime work', async () => {
    const h = await fixture(), client = new AgentMuxClient()
    cleanup.push(() => client.dispose())
    boundary.receiptDenied = true
    const connecting = client.connectRuntime(); await h.launch(); await connecting
    const original = await h.native.runtimeInfo()
    await vi.waitFor(() => expect(boundary.receiptWrites).toBeGreaterThan(0))
    expect(client.runtimeIdentity()).toMatchObject({ instanceId: original.daemonInstanceId, ownership: 'unverified' })
    // This is the stable connected public Core path, not a private adapter retry.
    await client.connect()
    boundary.receiptDenied = false
    await client.connect()
    await vi.waitFor(() => expect(client.runtimeIdentity()).toMatchObject({ instanceId: original.daemonInstanceId, ownership: 'owned' }))
    expect(h.children).toHaveLength(1); expect(h.signals).toEqual([])
  })

  it('observes real child exit before disconnecting and permits a new activation only after that exit', async () => {
    const h = await fixture(), lost = vi.fn(); h.adapter.onConnectionLost(lost)
    const connecting = h.adapter.connect(); await h.launch(); await connecting
    const original = h.adapter.identity().daemonInstanceId, child = h.children[0]!, exited = once(child, 'exit')
    child.kill('SIGTERM'); await exited
    expect(h.adapter.isConnected()).toBe(false); expect(lost).toHaveBeenCalledOnce()
    const retry = h.adapter.connect()
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.children[1]!.stdin!.write('ready\n'); await retry
    expect(h.adapter.isConnected()).toBe(true)
    await vi.waitFor(() => expect(h.adapter.runtimeOwnership).toBe('owned'))
    expect(h.adapter.identity().daemonInstanceId).not.toBe(original)
  })
})
