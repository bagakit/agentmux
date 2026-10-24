import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { decodeHostedValue } from '../src/hosted-value.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'
import { fixtureEpoch } from './helpers/fixture-values.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedClient } from '../src/hosted-client-contract.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { RuntimeController } from '../../../apps/desktop/src/main/runtime-controller.js'

vi.mock('electron', () => ({ app: { getPath: () => process.env.AGENTMUX_STATE_DIRECTORY } }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Hosted Stop fixture cleanup failed')
})
function barrier() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  cleanup.push(release)
  return { pending, release }
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))
const outcome = <T>(pending: Promise<T>) => pending.then(value => ({ value, error: null }), error => ({ value: null, error }))

// Production Hosted SDK, Core registry and FileStore. Only machine I/O and the
// transport event lease are controlled; Native/process proof belongs to the join.
async function fixture() {
  const root = process.env.AGENTMUX_STATE_DIRECTORY!, store = new AgentMuxFileAgentSessionStore(join(root, 'stop-sessions.json'))
  const sessions: AgentMuxStoredAgentSession[] = ['target', 'neighbor'].map((name, index) => ({ kind: 'agent',
    agentSessionId: 'private-stop-' + name, hostId: 'local', providerId: 'claude', executorId: 'claude', workspacePath: root,
    run: { runId: 'private-stop-run-' + name }, retiredRuns: [], hookBindingId: 'private-hook-' + name, hookToken: 'private-token-' + name,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'private-native-' + name },
    createdAt: fixtureEpoch(0, 0, index + 1), updatedAt: fixtureEpoch(0, 0, index + 1) }))
  for (const session of sessions) await store.compareAndSwap(null, session)
  const core = new AgentMuxClient({ store }), inner = core as any
  cleanup.push(() => core.dispose())
  let connected = true
  const stopped = new Set<string>()
  const run = (runId: string) => ({ runId, lifecycleOperationId: null, program: 'private-agent', args: [], workspacePath: root,
    pid: stopped.has(runId) ? null : 42, state: stopped.has(runId) ? { type: 'exited', code: 0, signal: null } : { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
  inner.connected = true
  inner.kernel.isConnected = () => connected
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-stop-daemon', protocolVersion: 1, buildIdentity: 'private' })
  inner.kernel.disconnect = async () => { connected = false }
  inner.kernel.status = vi.fn(async (runId: string) => run(runId))
  inner.kernel.detach = vi.fn(async () => {})
  inner.kernel.prepareStop = vi.fn(async (runId: string, operationKey: string) => ({ daemonInstance: 'private-stop-daemon', operationKey, runId }))
  const stopEntered = barrier(), globalEntered = barrier()
  inner.kernel.stop = vi.fn(async (operation: { runId: string }) => { stopped.add(operation.runId); stopEntered.release() })
  const global = barrier(), connect = vi.spyOn(core, 'connect').mockImplementation(async () => { globalEntered.release(); await global.pending })
  const native = vi.spyOn(core, 'connectRuntime')
  const load = vi.spyOn(inner.registry, 'load')
  const owner = hostedTestOwner(core), service = new AgentMuxHostedRuntimeService(core, store.path, () => owner)
  cleanup.push(() => service.dispose())
  const port = {
    call: async (method: string, params: unknown, context: unknown) => await service.call(method, structuredClone(params), context as never),
    subscribe: async () => { throw new Error('Only the private general event lease is unavailable') }
  } as unknown as AgentMuxHostedRpcPort
  const sdk = await connectHostedAgentMux({ rpc: port, waitForReady: false })
  cleanup.push(() => sdk.dispose())
  const target = sessions[0]!, neighbor = sessions[1]!
  return { root, store, core, inner, sdk, service, target, neighbor, stopped, run, connect, native, load, global, stopEntered, globalEntered,
    unavailable: () => { connected = false; inner.connected = false; native.mockRejectedValue(new AgentMuxError('Private Native unavailable', 'CTXMUX_DISCONNECTED')) } }
}

it('the Hosted SDK stops a cold exact target before unrelated Session observation settles', async () => {
  const f = await fixture()
  expect(f.inner.registry.list()).toEqual([])
  const pending = outcome(f.sdk.stopAgent(f.target.agentSessionId, f.target.run))
  await Promise.race([f.stopEntered.pending, f.globalEntered.pending, pending])
  const before = { stopped: [...f.stopped], global: f.connect.mock.calls.length, loaded: f.load.mock.calls.length }
  f.global.release()
  expect(await pending).toEqual({ value: undefined, error: null })
  expect(before).toEqual({ stopped: [f.target.run.runId], global: 0, loaded: 0 })
  expect(f.native).toHaveBeenCalledOnce()
  expect(await f.store.readMetadata(f.neighbor.agentSessionId)).toEqual(f.neighbor)
  expect((await f.store.loadRetiredAgentSessions()).map(row => row.agentSessionId)).toEqual([f.target.agentSessionId])
  expect(f.inner.kernel.stop).toHaveBeenCalledOnce()
})

it('Desktop Stop uses the Runtime scope while the general event lease is pending', async () => {
  const f = await fixture(), controller = new RuntimeController(f.store, async () => f.sdk)
  cleanup.push(() => controller.dispose())
  // Host selection is the collaborator; preparation, Hosted Stop and durable
  // retirement are actual product owners, without constructing an Electron App.
  vi.spyOn(controller as unknown as { configuredClient(id: string): AgentMuxHostedClient }, 'configuredClient').mockReturnValue(f.sdk)
  const observation = barrier(), observationEntered = barrier()
  vi.spyOn(f.sdk, 'connect').mockImplementation(async () => { observationEntered.release(); await observation.pending })
  const pending = outcome(controller.stopSession({ kind: 'agent', hostId: 'local', agentSessionId: f.target.agentSessionId, run: f.target.run }))
  await Promise.race([f.stopEntered.pending, observationEntered.pending, f.globalEntered.pending, pending])
  const before = { stopped: [...f.stopped], observed: vi.mocked(f.sdk.connect).mock.calls.length }
  observation.release(); f.global.release()
  expect(await pending).toEqual({ value: undefined, error: null })
  expect(before).toEqual({ stopped: [f.target.run.runId], observed: 0 })
  expect(await f.store.readMetadata(f.neighbor.agentSessionId)).toEqual(f.neighbor)
})

it('an exact Stop rejects a stale Run before preparing any Native operation', async () => {
  const f = await fixture()
  await expect(f.sdk.stopAgent(f.target.agentSessionId, { runId: 'another-private-run' })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(f.inner.kernel.prepareStop).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(await f.store.loadMetadata()).toEqual([f.target, f.neighbor])
})

it('a stale semantic owner fence cannot prepare an exact Stop', async () => {
  const f = await fixture()
  await expect(f.service.call('runtime.invoke', { consumerId: 'private-stale-owner',
    fence: { ...hostedTestFence, ownerInstanceId: 'another-owner' },
    invocation: { method: 'stopAgent', args: [f.target.agentSessionId, f.target.run] }
  })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(f.native).not.toHaveBeenCalled(); expect(f.inner.kernel.prepareStop).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('cold Stop rejects durable metadata belonging to another Host', async () => {
  const f = await fixture(), foreign = { ...f.target, hostId: 'another-private-host' }
  await f.store.compareAndSwap(f.target, foreign)
  await expect(f.sdk.stopAgent(f.target.agentSessionId, f.target.run)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(f.inner.kernel.prepareStop).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(await f.store.readMetadata(f.target.agentSessionId)).toEqual(foreign)
  expect(await f.store.readMetadata(f.neighbor.agentSessionId)).toEqual(f.neighbor)
})

it('Native unavailability refuses only that Stop and retains original durable identities', async () => {
  const f = await fixture(); f.unavailable()
  await expect(f.sdk.stopAgent(f.target.agentSessionId, f.target.run)).rejects.toMatchObject({ code: 'CTXMUX_DISCONNECTED' })
  expect(f.inner.kernel.prepareStop).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(await f.store.loadMetadata()).toEqual([f.target, f.neighbor])
})

it.each(['reserve', 'commit'] as const)('Stop retains its required durable %s and does not retire the neighboring Session', async phase => {
  const f = await fixture()
  const method = phase === 'reserve' ? 'reserveLifecycle' : 'commitLifecycle'
  vi.spyOn(f.store, method).mockRejectedValueOnce(new Error('Private exact Stop ' + phase + ' unavailable'))
  await expect(f.sdk.stopAgent(f.target.agentSessionId, f.target.run)).rejects.toThrow(phase === 'reserve'
    ? 'Private exact Stop reserve unavailable' : 'Agent stopped but Agent Session cleanup failed')
  expect(f.inner.kernel.stop).toHaveBeenCalledTimes(phase === 'reserve' ? 0 : 1)
  expect(await f.store.readMetadata(f.target.agentSessionId)).toEqual(f.target)
  expect(await f.store.readMetadata(f.neighbor.agentSessionId)).toEqual(f.neighbor)
})

it('Hosted explicit retry reconciles the original uncertain Stop without minting another operation', async () => {
  const f = await fixture(), stop = f.inner.kernel.stop.getMockImplementation()!
  f.inner.kernel.stop.mockImplementationOnce(async () => { throw new Error('Original private Stop receipt unavailable') })
  await expect(f.sdk.stopAgent(f.target.agentSessionId, f.target.run)).rejects.toThrow('Original private Stop receipt unavailable')
  const original = f.inner.kernel.stop.mock.calls[0][0]
  f.inner.kernel.stop.mockImplementation(stop)
  await f.sdk.stopAgent(f.target.agentSessionId, f.target.run)
  expect(f.inner.kernel.prepareStop).toHaveBeenCalledOnce()
  expect(f.inner.kernel.stop.mock.calls.map(([operation]: [unknown]) => operation)).toEqual([original, original])
  expect((await f.store.loadRetiredAgentSessions()).map(row => row.agentSessionId)).toEqual([f.target.agentSessionId])
})

describe('the explicit preparation declaration preserves existing operation requirements', () => {
  async function invocationFixture() {
    const f = await fixture()
    const invoke = async (method: string, args: unknown[]) => decodeHostedValue((await f.service.call('runtime.invoke', {
      consumerId: 'private-preparation', fence: hostedTestFence, invocation: { method, args }
    }, { principal: { kind: 'user', id: 'private-user' } }) as { value: unknown }).value)
    return { ...f, invoke }
  }

  it('reads the exact durable Session without Native readiness or general observation', async () => {
    const f = await invocationFixture(); f.unavailable()
    await expect(f.invoke('readAgentSession', [f.target.agentSessionId])).resolves.toMatchObject({ agentSessionId: f.target.agentSessionId, run: f.target.run })
    expect(f.native).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled()
  })

  it('keeps ordinary Session-observation methods waiting for their declared requirement', async () => {
    const f = await invocationFixture(), probe = vi.spyOn(f.core, 'probeAgent').mockResolvedValue({ observed: 'private-provider' } as never)
    const pending = f.invoke('probeAgent', ['claude'])
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce())
    expect(probe).not.toHaveBeenCalled()
    f.global.release(); expect(await pending).toEqual({ observed: 'private-provider' })
  })

  it.each(['manual-actor', 'native-conversation'] as const)('preserves %s input admission without unrelated general observation', async kind => {
    const f = await invocationFixture(), submit = vi.spyOn(f.core, 'submitAgentPrompt').mockResolvedValue({ status: 'private-admitted' } as never)
    const pending = f.invoke('submitAgentPrompt', [{ agentSessionId: f.target.agentSessionId, admissionIntent: { kind } }])
    for (let n = 0; n < 8; n++) await checkpoint()
    const before = submit.mock.calls.length
    f.global.release(); expect(await pending).toEqual({ status: 'private-admitted' })
    expect(before).toBe(1); expect(f.connect).not.toHaveBeenCalled()
  })

  it.each([null, { deliveryMode: 'reference' }] as const)('preserves an original reference message intake without general observation', async retained => {
    const f = await invocationFixture()
    vi.spyOn(f.core, 'readMessage').mockResolvedValue(retained as never)
    const submit = vi.spyOn(f.core, 'submitAgentMessage').mockResolvedValue({ status: 'private-intake' } as never)
    const pending = f.invoke('submitAgentMessage', [{ envelope: { messageId: 'private-original-message', sender: { kind: 'agent-session' } } }])
    for (let n = 0; n < 8; n++) await checkpoint()
    const before = submit.mock.calls.length
    f.global.release(); expect(await pending).toEqual({ status: 'private-intake' })
    expect(before).toBe(1); expect(f.connect).not.toHaveBeenCalled()
  })

  it('keeps exact-condition prompt admission dependent on its declared Session observation', async () => {
    const f = await invocationFixture(), submit = vi.spyOn(f.core, 'submitAgentPrompt').mockResolvedValue({ status: 'private-admitted' } as never)
    const pending = f.invoke('submitAgentPrompt', [{ agentSessionId: f.target.agentSessionId }])
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce())
    expect(submit).not.toHaveBeenCalled()
    f.global.release(); expect(await pending).toEqual({ status: 'private-admitted' })
  })

  it('keeps trusted message notification independent of Native readiness', async () => {
    const f = await invocationFixture(); f.unavailable()
    const notify = vi.spyOn(f.core, 'notifyMessages').mockResolvedValue({ status: 'private-notice' } as never)
    await expect(f.invoke('notifyMessages', [{ operationId: 'private-notice' }])).resolves.toEqual({ status: 'private-notice' })
    expect(notify).toHaveBeenCalledOnce(); expect(f.native).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled()
  })
})
