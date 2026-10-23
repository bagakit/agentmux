import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { AgentMuxControlServer, type AgentMuxControlServerOptions } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { ConnectionEnrollmentCallContext } from '../src/connection-enrollment-contract.js'
import type { MoteConnectionPreferencesPort, MoteConnectionPreferencesReadInput,
  MoteConnectionPreferencesReadResult, MoteConnectionPreferencesSaveParams,
  MoteConnectionPreferencesSaveResult } from '../src/mote-preferences.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { fixturePath } from './helpers/fixture-values.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

// Only the preferences leaf is controlled: these are Core routing/authority
// tests, not evidence of real File CAS, directory identity or a default parent.
const target = { spaceId: 'original-mote', zoneId: 'original-home', expectedResource: {
  hostId: 'local', workspaceId: 'scratch', workspacePath: fixturePath('preference-resource')
} }
const resource = { ...target.expectedResource, zoneId: target.zoneId,
  zonePath: join(target.expectedResource.workspacePath, 'mote'), path: 'mote/MOTE.md' }
const values = { connection: { connectionId: 'chosen-connection', application: { domain: 'platform.example', appId: 'original-app' } } }
const document = (content: string) => ({ path: resource.path, content,
  revision: 'sha256:' + createHash('sha256').update(content).digest('hex') })
const baseline = { resource, document: document('Original MOTE contents.\n'), values: { connection: null } }
const readInput: MoteConnectionPreferencesReadInput = { kind: 'connection', target }
const saveInput = (operationId: string): MoteConnectionPreferencesSaveParams => ({ ...readInput, operationId, baseline, values })
const readResult = (): MoteConnectionPreferencesReadResult => ({ ...readInput, status: 'ready',
  source: { resource, result: { status: 'read', document: baseline.document } }, values: baseline.values, issue: null })
const saveResult = (input: MoteConnectionPreferencesSaveParams): MoteConnectionPreferencesSaveResult => ({ ...readInput,
  operationId: input.operationId, status: 'saved', source: { resource, document: document('Chosen connection.\n'), values: input.values }, message: null })
function preferences() {
  const read = vi.fn<MoteConnectionPreferencesPort['read']>(async () => readResult())
  const save = vi.fn<MoteConnectionPreferencesPort['save']>(async input => saveResult(input))
  return { read, save }
}
async function endpoint(options: AgentMuxControlServerOptions = {}) {
  const root = await mkdtemp(fixturePath('tmp/amx-mpref-')), socketPath = join(root, 'rpc.sock')
  const server = new AgentMuxControlServer({ coreClients: () => [], ...options, socketPath })
  cleanup.push(async () => { await server.stop(); await rm(root, { recursive: true, force: true }) })
  await server.start()
  return { root, server, endpoint: { transport: 'unix' as const, path: socketPath } }
}
async function client(options: Parameters<typeof connectAgentMuxRpc>[0]): Promise<AgentMuxRpcClient> {
  const value = await connectAgentMuxRpc(options)
  cleanup.push(() => value.dispose())
  return value
}
async function managed() {
  const value = await rpcOwnerFixture(['original-managed-caller'])
  cleanup.push(() => value.close())
  return value
}

it('the actual Unix SDK consumes the narrow owner before generic forwarding and retains its authenticated user actor', async () => {
  const owner = preferences()
  // The alternate path deliberately returns valid DTOs: dropping dispatch must
  // fail the owner-consumption assertion, not a malformed fallback fixture.
  const forward = vi.fn(async (method: string, params: unknown) => method === 'space.mote.preferences.read'
    ? readResult() : saveResult(params as MoteConnectionPreferencesSaveParams))
  const h = await endpoint({ motePreferences: owner, forwardControl: forward as NonNullable<AgentMuxControlServerOptions['forwardControl']> })
  const rpc = await client({ endpoint: h.endpoint })
  expect(await rpc.call('space.mote.preferences.read', readInput)).toEqual(readResult())
  const input = saveInput('original-user-save')
  expect(await rpc.call('space.mote.preferences.save', input)).toEqual(saveResult(input))
  expect(owner.read).toHaveBeenCalledExactlyOnceWith(readInput)
  expect(owner.save).toHaveBeenCalledTimes(1)
  const context: ConnectionEnrollmentCallContext = owner.save.mock.calls[0]![1]!
  expect(context.actor).toEqual({ kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` })
  expect(context.signal).toBeInstanceOf(AbortSignal)
  expect(context.assertCurrent).toBeTypeOf('function')
  expect(forward).not.toHaveBeenCalled()
})

it('the actual authorized HTTP SDK preserves the device principal without a display-name actor conversion', async () => {
  const owner = preferences(), assertCurrent = vi.fn()
  const h = await endpoint({ motePreferences: owner, http: { host: '127.0.0.1', port: 0,
    authorize: () => ({ principal: { kind: 'device', id: 'original-device' }, assertCurrent }) } })
  const rpc = await client({ endpoint: { transport: 'http', url: `http://127.0.0.1:${h.server.httpAddress!.port}/`, token: 'controlled-transport' } })
  const input = saveInput('original-device-save')
  expect(await rpc.call('space.mote.preferences.save', input)).toEqual(saveResult(input))
  expect(owner.save.mock.calls[0]![1]!.actor).toEqual({ kind: 'device', id: 'original-device' })
  expect(assertCurrent).toHaveBeenCalledTimes(2)
})

it('the real retained Core capability supplies the exact Agent actor without imposing the bot-parent Workspace scope', async () => {
  const core = await managed(), owner = preferences()
  expect(core.root).not.toBe(target.expectedResource.workspacePath)
  const h = await endpoint({ coreClients: core.coreClients, motePreferences: owner })
  const rpc = await client({ endpoint: h.endpoint, credentials: core.credentials })
  const input = saveInput('original-agent-save')
  expect(await rpc.call('space.mote.preferences.save', input)).toEqual(saveResult(input))
  expect(owner.save.mock.calls[0]![1]!.actor).toEqual({ kind: 'agent', id: core.credentials.agentSessionId })
  const invalid = await client({ endpoint: h.endpoint, credentials: { ...core.credentials, capability: 'invalid-original-capability' } })
  await expect(invalid.call('space.mote.preferences.save', saveInput('unauthorized-save'))).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(owner.save).toHaveBeenCalledTimes(1)
  expect(core.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original save context reauthenticates a managed capability before the controlled effect', async () => {
  const core = await managed(), owner = preferences()
  let effects = 0
  owner.save.mockImplementation(async (input, context) => {
    const original = (await core.store.load()).find(row => row.agentSessionId === core.credentials.agentSessionId)!
    await core.store.compareAndSwap(original, { ...original, capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: original.updatedAt + 1 })
    await context!.assertCurrent!()
    effects++
    return saveResult(input)
  })
  const h = await endpoint({ coreClients: core.coreClients, motePreferences: owner })
  const rpc = await client({ endpoint: h.endpoint, credentials: core.credentials })
  await expect(rpc.call('space.mote.preferences.save', saveInput('revoked-agent-save'))).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(owner.save).toHaveBeenCalledTimes(1)
  expect(effects).toBe(0)
  expect(core.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the actual Runtime fence rejects another owner instance while an omitted optional fence remains valid', async () => {
  const core = await managed(), owner = preferences()
  const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'original-preference-runtime', ownerInstanceId: 'original-preference-instance',
    protocolVersion: 2, processId: process.pid, ctxmux: core.client.runtimeIdentity(), availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(core.client, join(core.root, 'sessions.json'), () => identity)
  cleanup.push(() => hosted.dispose())
  const h = await endpoint({ coreClients: core.coreClients, motePreferences: owner, hostedRuntime: () => hosted })
  const rpc = await client({ endpoint: h.endpoint })
  expect(await rpc.call('space.mote.preferences.read', readInput)).toEqual(readResult())
  const fence = { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }
  expect(await rpc.call('space.mote.preferences.read', readInput, { runtimeFence: fence })).toEqual(readResult())
  await expect(rpc.call('space.mote.preferences.read', readInput, { runtimeFence: { ...fence, ownerInstanceId: 'replacement-instance' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(owner.read).toHaveBeenCalledTimes(2)
  expect(core.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a transport revocation while save awaits is rechecked by its original context before any controlled write', async () => {
  const owner = preferences(), forward = vi.fn()
  let revoked = false, effects = 0, arrived!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { arrived = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  owner.save.mockImplementation(async (input, context) => {
    arrived(); await barrier
    await context!.assertCurrent!()
    effects++
    return saveResult(input)
  })
  const h = await endpoint({ motePreferences: owner, forwardControl: forward,
    http: { host: '127.0.0.1', port: 0, authorize: () => ({ principal: { kind: 'device', id: 'revocable-device' },
      assertCurrent: () => { if (revoked) throw new AgentMuxError('Original device authority was revoked.', 'CONTROL_PERMISSION_DENIED') } }) } })
  const rpc = await client({ endpoint: { transport: 'http', url: `http://127.0.0.1:${h.server.httpAddress!.port}/`, token: 'controlled-transport' } })
  const outcome = rpc.call('space.mote.preferences.save', saveInput('revoked-device-save')).then(() => 'unexpected-save', error => error.code)
  try {
    await entered
    revoked = true; release()
    expect(await outcome).toBe('CONTROL_PERMISSION_DENIED')
    expect(owner.save.mock.calls[0]![1]!.actor).toEqual({ kind: 'device', id: 'revocable-device' })
    expect(effects).toBe(0)
    expect(forward).not.toHaveBeenCalled()
  } finally { release() }
})

it('Quick preferences keep their original forward route and an ordinary headless Space reads its original spatial owner', async () => {
  const owner = preferences()
  const quick = { kind: 'quick' as const, target, status: 'unconfirmed' as const, source: null, defaults: null,
    choices: { executors: [], conversations: [], destinations: [] }, main: null, issue: 'Original client presentation is unavailable.' }
  const forward = vi.fn(async () => quick)
  const h = await endpoint({ motePreferences: owner, forwardControl: forward as NonNullable<AgentMuxControlServerOptions['forwardControl']> })
  const rpc = await client({ endpoint: h.endpoint })
  expect(await rpc.call('space.mote.preferences.read', { kind: 'quick', target })).toEqual(quick)
  expect(forward).toHaveBeenCalledExactlyOnceWith('space.mote.preferences.read', { kind: 'quick', target }, expect.any(Object))
  const spatial = new AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const headless = await endpoint({ motePreferences: owner, spatialState: spatial })
  const other = await client({ endpoint: headless.endpoint })
  expect((await other.call('space.ls', { target: {} })).catalog).toMatchObject({ spaces: [], zones: [], bindings: [] })
  expect(owner.read).not.toHaveBeenCalled()
  expect(owner.save).not.toHaveBeenCalled()
})

it('another typed target or operation from the narrow owner is refused without falling back to generic control', async () => {
  const owner = preferences(), forward = vi.fn()
  owner.read.mockImplementation(async () => ({ ...readResult(), target: { ...target, spaceId: 'another-mote' } }))
  owner.save.mockImplementation(async input => ({ ...saveResult(input), operationId: 'another-operation' }))
  const h = await endpoint({ motePreferences: owner, forwardControl: forward })
  const rpc = await client({ endpoint: h.endpoint })
  await expect(rpc.call('space.mote.preferences.read', readInput)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await expect(rpc.call('space.mote.preferences.save', saveInput('original-mismatched-save'))).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(owner.read).toHaveBeenCalledTimes(1)
  expect(owner.save).toHaveBeenCalledTimes(1)
  expect(forward).not.toHaveBeenCalled()
})
