import { mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, type AgentMuxControlServerOptions } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { MoteConnectionOperation, MoteConnectionPort, MoteConnectionSync } from '../src/mote-connection-contract.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { fixturePath } from './helpers/fixture-values.js'

const cleanup: Array<() => void | Promise<void>> = []
function witness(label: string, facts: unknown) {
  if (process.env.MOTE_PARENT_FENCE_FACTS) appendFileSync(process.env.MOTE_PARENT_FENCE_FACTS, JSON.stringify({ label, facts }) + '\n')
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const syncInput = (operationId: string): MoteConnectionSync => ({
  operationId,
  source: { target: { spaceId: 'original-mote', zoneId: 'original-home', expectedResource: {
    hostId: 'local', workspaceId: 'original-workspace', workspacePath: fixturePath('mote-parent-resource')
  } }, preparedFrom: null },
  desired: { name: 'Original prepared bot', description: 'Original prepared profile' },
  connection: { connectionId: 'original-connection', application: { domain: 'platform.example', appId: 'original-app' } },
  expectedConnectionRevision: 1
})
const result = (input: MoteConnectionSync): MoteConnectionOperation => ({
  operationId: input.operationId, action: 'sync', source: input.source,
  snapshot: { name: input.desired.name, description: input.desired.description, avatarSha256: null },
  connection: input.connection, enrollmentOperationId: null, profileOperationId: 'original-profile-operation',
  defaultSave: null, enrollment: null, profile: null,
  defaultLink: { state: 'not-requested', current: null }, issue: null
})

// The parent/child effects are controlled at the existing typed port. This
// proves Core routing and pre-effect authority, not real File CAS or SDK I/O.
function parent() {
  const effects: { parentOperations: string[]; childOperations: string[] } = { parentOperations: [], childOperations: [] }
  const apply = (input: MoteConnectionSync) => {
    effects.parentOperations.push(input.operationId)
    effects.childOperations.push(input.operationId + '.profile')
    return result(input)
  }
  const sync = vi.fn<MoteConnectionPort['sync']>(async (input, context) => {
    await context.assertCurrent?.()
    return apply(input)
  })
  const owner: MoteConnectionPort = {
    sync,
    create: vi.fn(async () => { throw new Error('This test does not create a bot.') }),
    advance: vi.fn(async () => { throw new Error('This test does not advance a bot.') }),
    inspect: vi.fn(async () => ({ operation: null })),
    list: vi.fn(async () => ({ operations: [], next: null }))
  }
  return { owner, sync, effects, apply }
}

async function runtime() {
  const core = await rpcOwnerFixture(['original-fence-agent'])
  cleanup.push(() => core.close())
  const identity: AgentMuxRuntimeOwnerIdentity = {
    runtimeId: 'original-mote-runtime', ownerInstanceId: 'original-mote-instance', protocolVersion: 2,
    processId: process.pid, ctxmux: core.client.runtimeIdentity(), availability: 'connected'
  }
  const hosted = new AgentMuxHostedRuntimeService(core.client, join(core.root, 'sessions.json'), () => identity)
  cleanup.push(() => hosted.dispose())
  return { core, identity, hosted, fence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId } }
}
async function endpoint(original: Awaited<ReturnType<typeof runtime>>, options: AgentMuxControlServerOptions) {
  const directory = await mkdtemp(fixturePath('tmp/amx-parent-fence-'))
  const socketPath = join(directory, 'rpc.sock')
  const server = new AgentMuxControlServer({ ...options, coreClients: original.core.coreClients,
    hostedRuntime: () => original.hosted, socketPath })
  cleanup.push(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }) })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  cleanup.push(() => client.dispose())
  return client
}

it('the real public parent route accepts both the exact Runtime fence and an omitted optional fence', async () => {
  const original = await runtime(), controlled = parent()
  const client = await endpoint(original, { moteConnections: controlled.owner })
  for (const [operationId, context] of [
    ['optional-fence-operation', undefined], ['exact-fence-operation', { runtimeFence: original.fence }]
  ] as const) {
    const input = syncInput(operationId)
    expect(await client.call('space.mote.connection.sync', input, context)).toEqual(result(input))
  }
  expect(controlled.effects).toEqual({
    parentOperations: ['optional-fence-operation', 'exact-fence-operation'],
    childOperations: ['optional-fence-operation.profile', 'exact-fence-operation.profile']
  })
  expect(controlled.sync.mock.calls[0]![1].actor).toEqual({ kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` })
  expect(original.core.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([
  { label: 'runtime', code: 'RUNTIME_OWNER_MISMATCH', changed: { runtimeId: 'foreign-mote-runtime' } },
  { label: 'instance', code: 'RUNTIME_OWNER_CHANGED', changed: { ownerInstanceId: 'replacement-mote-instance' } }
])('a stale $label fence reaches neither the local parent nor a forwarded parent or child', async ({ label, code, changed }) => {
  const original = await runtime(), local = parent(), remote = parent()
  const localClient = await endpoint(original, { moteConnections: local.owner })
  const forward = vi.fn(async (_method: string, input: unknown) => remote.apply(input as MoteConnectionSync))
  const forwardedClient = await endpoint(original, { forwardControl: forward as NonNullable<AgentMuxControlServerOptions['forwardControl']> })
  const input = syncInput('stale-' + label + '-operation'), context = { runtimeFence: { ...original.fence, ...changed } }
  const localOutcome = await localClient.call('space.mote.connection.sync', input, context).then(() => 'applied', error => error.code)
  const forwardedOutcome = await forwardedClient.call('space.mote.connection.sync', input, context).then(() => 'applied', error => error.code)
  witness('stale-' + label, { localOutcome, forwardedOutcome, local: local.effects, forwarded: remote.effects })
  // Capture effects before checking the error. A dropped initial fence really
  // dispatches the original operation into the controlled forwarding target.
  expect(remote.effects, 'stale target must not admit a parent or dispatch its child').toEqual({ parentOperations: [], childOperations: [] })
  expect(local.effects).toEqual({ parentOperations: [], childOperations: [] })
  expect(localOutcome).toBe(code)
  expect(forwardedOutcome).toBe(code)
  expect(local.sync).not.toHaveBeenCalled()
  expect(forward).not.toHaveBeenCalled()
  expect(original.core.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an owner instance replaced while the parent awaits is rechecked by the original context before either effect', async () => {
  const original = await runtime(), controlled = parent()
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  controlled.sync.mockImplementation(async (input, context) => {
    entered()
    await barrier
    await context.assertCurrent?.()
    return controlled.apply(input)
  })
  const client = await endpoint(original, { moteConnections: controlled.owner })
  const input = syncInput('awaiting-original-operation')
  const outcome = client.call('space.mote.connection.sync', input, { runtimeFence: original.fence })
    .then(() => 'applied', error => error.code)
  try {
    await waiting
    original.identity.ownerInstanceId = 'reopened-mote-instance'
    release()
    const observed = await outcome
    witness('replaced-while-awaiting', { observed, effects: controlled.effects })
    expect(controlled.effects, 'an old context must not admit a parent or dispatch its child').toEqual({ parentOperations: [], childOperations: [] })
    expect(observed).toBe('RUNTIME_OWNER_CHANGED')
    expect(controlled.sync).toHaveBeenCalledTimes(1)
    // The same healthy endpoint remains usable with its newly observed owner;
    // the refusal belongs to the old operation, not the Agent or connection.
    const next = syncInput('replacement-owner-operation')
    const fence = { runtimeId: original.identity.runtimeId, ownerInstanceId: original.identity.ownerInstanceId }
    expect(await client.call('space.mote.connection.sync', next, { runtimeFence: fence })).toEqual(result(next))
    expect(controlled.effects).toEqual({ parentOperations: [next.operationId], childOperations: [next.operationId + '.profile'] })
    expect(original.core.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release() }
})
