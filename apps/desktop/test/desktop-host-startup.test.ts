import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ spawn: vi.fn(), live: false, socketPath: '', rpc: vi.fn(), dispose: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: native.spawn
}))
vi.mock('@agentmux/core', async importOriginal => ({
  ...await importOriginal<typeof import('@agentmux/core')>(),
  defaultAgentMuxControlSocketPath: () => native.socketPath,
  probeSocketLiveness: async () => native.live ? 'alive' : 'dead',
  connectAgentMuxRpc: async () => ({ call: native.rpc,
    subscribe: async () => { throw new Error('Only the general observation transport is unavailable') }, dispose: native.dispose })
}))
import { AgentMuxError, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import { connectDesktopAgentMuxHost, callOriginalDesktopHost } from '../src/main/desktop-host.js'

class Child extends EventEmitter {
  pid: number | undefined
  exitCode: number | null = null
  signalCode: string | null = null
  unref = vi.fn()
  kill = vi.fn()
  constructor(pid: number | undefined) { super(); this.pid = pid }
}
const clients: DesktopRuntimeClient[] = [], children: Child[] = [], directories: string[] = []
let failSpawn = false
const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2,
  processId: 3101, ctxmux: null, availability: 'connected' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  native.live = false; failSpawn = false
  native.rpc.mockReset().mockImplementation(async method => {
    if (method === 'runtime.owner.identity') return { owner }
    if (method === 'runtime.invoke') return { value: [{ agentSessionId: 'retained-session', run: { runId: 'retained-run' } }] }
    throw new Error('Unexpected public method: ' + method)
  })
  native.dispose.mockReset().mockResolvedValue(undefined)
  native.spawn.mockReset().mockImplementation(() => {
    const child = new Child(failSpawn ? undefined : 3101 + children.length)
    children.push(child)
    queueMicrotask(() => child.emit(child.pid === undefined ? 'error' : 'spawn', new Error('spawn failed')))
    return child
  })
})
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose()
  for (const child of children.splice(0)) { child.exitCode = 0; child.emit('exit', 0, null) }
  await vi.advanceTimersByTimeAsync(10_050)
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-host-startup-')); directories.push(directory)
  native.socketPath = join(directory, 'control.sock')
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const connect = async () => {
    const client = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, store)
    clients.push(client); return client
  }
  const client = await connect()
  await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledOnce())
  return { client, connect, store }
}
const result = <T>(pending: Promise<T>) => pending.then(value => ({ value }), error => ({ error }))
async function originalChildResult<T>(pending: Promise<T>): Promise<T> {
  let settled: T | undefined
  void pending.then(value => { settled = value })
  await vi.waitFor(() => {
    expect(native.spawn).toHaveBeenCalledOnce()
    expect(settled).toBeDefined()
  })
  return settled!
}

it('retains one original child across sequential and concurrent reader deadlines, then confirms that public owner', async () => {
  const f = await fixture()
  const first = result(f.client.readAgentSessions())
  await vi.advanceTimersByTimeAsync(10_050)
  expect(await originalChildResult(first)).toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
  const second = result(f.client.readAgentSessions()), third = result(f.client.readAgentSessions())
  await vi.advanceTimersByTimeAsync(10_050)
  expect(await originalChildResult(second)).toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
  expect(await originalChildResult(third)).toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
  expect(native.spawn).toHaveBeenCalledOnce()
  const [executable, args, options] = native.spawn.mock.calls[0]!
  expect(executable).toBe(process.execPath)
  expect(args).toEqual([expect.stringMatching(/agentmux-host\.js$/), '--store', f.store.path])
  expect(options).toMatchObject({ detached: true, env: { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_AGENT_SESSION_STORE: f.store.path } })
  native.live = true
  expect(await f.client.readAgentSessions()).toEqual([{ agentSessionId: 'retained-session', run: { runId: 'retained-run' } }])
  expect('runtimeOwnerIdentity' in f.client && f.client.runtimeOwnerIdentity()).toEqual(owner)
  expect(native.rpc).toHaveBeenCalledWith('runtime.owner.identity', {}, expect.anything())
  expect(native.rpc).toHaveBeenCalledWith('runtime.invoke', expect.objectContaining({ fence: {
    runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } }), expect.anything())
  expect(children[0]!.kill).not.toHaveBeenCalled()
})

it('retires the record only after actual child exit and permits one subsequent launch', async () => {
  const f = await fixture(), pending = result(f.client.readAgentSessions())
  await vi.advanceTimersByTimeAsync(1)
  children[0]!.exitCode = 2; children[0]!.emit('exit', 2, null)
  await vi.advanceTimersByTimeAsync(50)
  expect(await pending).toMatchObject({ error: { code: 'CONTROL_UNAVAILABLE' } })
  const next = result(f.client.readAgentSessions())
  await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(2))
  native.live = true; await vi.advanceTimersByTimeAsync(50)
  expect(await next).toEqual({ value: [{ agentSessionId: 'retained-session', run: { runId: 'retained-run' } }] })
  expect(children.map(child => child.kill.mock.calls.length)).toEqual([0, 0])
})

it('a kill or send error with a retained PID cannot retire a live launch', async () => {
  const f = await fixture(), first = result(f.client.readAgentSessions())
  children[0]!.emit('error', new Error('send failed while child remains alive'))
  await vi.advanceTimersByTimeAsync(10_050)
  expect(await originalChildResult(first)).toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
  const next = f.client.readAgentSessions()
  await vi.advanceTimersByTimeAsync(100)
  expect(native.spawn).toHaveBeenCalledOnce()
  native.live = true; await vi.advanceTimersByTimeAsync(50)
  expect(await next).toHaveLength(1)
})

it('a confirmed spawn failure without a PID permits a later original-namespace attempt', async () => {
  failSpawn = true
  const f = await fixture()
  // The automatic consumer attempt may already be retrying; every failed launch has no PID.
  const first = result(f.client.readAgentSessions())
  await vi.advanceTimersByTimeAsync(1)
  expect(await first).toMatchObject({ error: { message: 'spawn failed' } })
  failSpawn = false
  const next = f.client.readAgentSessions()
  await vi.waitFor(() => expect(children.some(child => child.pid !== undefined)).toBe(true))
  native.live = true; await vi.advanceTimersByTimeAsync(50)
  expect(await next).toHaveLength(1)
  expect(native.spawn.mock.calls.every(([, args]) => args.at(-1) === f.store.path)).toBe(true)
})

it('cancels only the requesting reader and leaves the original launch available to another consumer', async () => {
  const f = await fixture(), abort = new AbortController()
  const cancelled = result(callOriginalDesktopHost(f.client, 'runtime.owner.identity', {}, { signal: abort.signal }))
  abort.abort(new AgentMuxError('Reader cancelled', 'CONTROL_CANCELLED'))
  expect(await cancelled).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  await f.client.dispose(); clients.splice(clients.indexOf(f.client), 1)
  const nextClient = await f.connect(), pending = nextClient.readAgentSessions()
  await vi.advanceTimersByTimeAsync(100)
  expect(native.spawn).toHaveBeenCalledOnce()
  expect(children[0]!.kill).not.toHaveBeenCalled()
  native.live = true; await vi.advanceTimersByTimeAsync(50)
  expect(await pending).toHaveLength(1)
  expect('runtimeOwnerIdentity' in nextClient && nextClient.runtimeOwnerIdentity()).toEqual(owner)
})
