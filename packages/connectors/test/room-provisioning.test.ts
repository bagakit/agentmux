import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomProvisioningHost } from '../src/room-provisioning.js'
import { RoomProvisioningStore } from '../src/room-provisioning-store.js'
import { roomProvisioningFixture, context } from './fixtures/room-provisioning.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(options: Parameters<typeof roomProvisioningFixture>[0] = {}) { const f = await roomProvisioningFixture(options); cleanup.push(() => f.close()); return f }

it('persists exact detached intent and claimed attempts before either effect, preserving separate creation and member receipts', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ resolve: async () => { await held; return 'private-fixture-credential' } }), original = structuredClone(f.createInput)
  f.create.mockImplementation(async request => {
    const row = f.connections.database.prepare('SELECT receipt_json FROM room_provisioning_attempt WHERE attempt_id=?').get(request.attemptId)!
    expect(JSON.parse(String(row.receipt_json))).toEqual({ state: 'dispatching', attemptId: request.attemptId })
    expect((await f.provisioning.inspect({ operationId: original.operationId })).operation!.input).toEqual(original)
    expect(request).not.toHaveProperty('members'); expect(request.name).toBe(original.name)
    return { kind: 'created', externalConversationId: 'created-room' }
  })
  f.addMembers.mockImplementation(async request => {
    const saved = (await f.provisioning.inspect({ operationId: original.operationId })).operation!
    expect(saved.creation).toMatchObject({ state: 'created', externalConversationId: 'created-room' })
    expect(saved.membership).toEqual({ state: 'dispatching', attemptId: request.attemptId })
    expect(request.members).toEqual(original.members)
    return { results: request.members.map(member => ({ member, state: 'joined' })) }
  })
  const work = f.provisioning.create(f.createInput, context)
  await vi.waitFor(() => expect(f.resolve).toHaveBeenCalled())
  f.createInput.name = 'Changed after admission'; f.createInput.members[0]!.userId = 'different'; f.createInput.regionAnchor.regionId = 'different-region'
  release()
  const result = await work
  expect(result.input).toEqual(original); expect(result.membership).toMatchObject({ state: 'settled' })
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addMembers).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(result)).not.toContain('private-fixture-credential'); expect(JSON.stringify(result)).not.toContain('credentialRef')
  await f.unchanged()
})

it('keeps known rooms through partial invitations and an independent original Binding failure without deleting or recreating', async () => {
  const f = await fixture({ addMembers: async request => ({ results: request.members.map((member, index) => ({ member, state: index ? 'not-applied' : 'joined' })) }) })
  const result = await f.provisioning.create(f.createInput, context)
  expect(result.creation).toMatchObject({ state: 'created', externalConversationId: 'created-room' })
  expect(result.membership).toMatchObject({ state: 'settled', results: [{ state: 'joined' }, { state: 'not-applied' }] })
  const binding = await f.bindings.bind({ ...f.input, externalConversationId: 'created-room', expectedSource: { ...f.input.expectedSource, nativeSessionId: 'different-source' } }, context)
  expect(binding).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_SOURCE_CHANGED' })
  expect(await f.provisioning.create(f.createInput, context)).toEqual(result)
  expect((await new RoomProvisioningHost({ connections: f.connections, spatial: f.spatial }).inspect({ operationId: result.operationId })).operation).toEqual(result)
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addMembers).toHaveBeenCalledTimes(1)
  await f.unchanged()
})

it('retains unknown creation across owner replacement and blocks another operation key or Region from recreating that exact Agent room', async () => {
  const f = await fixture({ create: async () => { throw new Error('private-fixture-credential adapter detail') } })
  const unknown = await f.provisioning.create(f.createInput, context)
  expect(unknown.creation.state).toBe('unknown'); expect(f.addMembers).not.toHaveBeenCalled()
  const later = new RoomProvisioningHost({ connections: f.connections, spatial: f.spatial }), resolutions = f.resolve.mock.calls.length
  expect(await later.inspect({ operationId: unknown.operationId })).toEqual({ operation: unknown })
  expect(await later.create(f.createInput, context)).toEqual(unknown)
  const conflict = await later.create({ ...f.createInput, operationId: 'different-key', regionAnchor: { regionId: 'other-region' } }, context)
  expect(conflict.creation).toEqual({ state: 'not-applied', reason: 'existing-operation', originalOperationId: unknown.operationId })
  expect(f.resolve).toHaveBeenCalledTimes(resolutions); expect(f.create).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(unknown)).not.toContain('private-fixture-credential')
  await f.unchanged()
})

it.each(['host', 'session'] as const)('rejects an exact %s target change during credential resolution before any effect', async field => {
  let change!: () => Promise<unknown>
  const f = await fixture({ resolve: async () => { await change(); return 'private-fixture-credential' } })
  change = () => f.change(graph => { const region = graph.regions.find(region => region.regionId === f.createInput.regionAnchor.regionId)!; if (field === 'host') region.execution!.hostId = 'other-host'; else region.agentSessionId = 'other-agent' })
  const result = await f.provisioning.create(f.createInput, context)
  expect(result.creation).toMatchObject({ state: 'not-applied', reason: 'target-changed' })
  expect(f.create).not.toHaveBeenCalled(); expect(f.addMembers).not.toHaveBeenCalled(); await f.unchanged()
})

it('allows unrelated spatial changes while keeping the original exact target, and preserves empty-member room facts', async () => {
  let change!: () => Promise<unknown>
  const f = await fixture({ resolve: async () => { await change(); return 'private-fixture-credential' } })
  change = () => f.change(graph => { graph.regions.find(region => region.regionId === 'other-region')!.agentSessionId = 'other-agent' })
  const result = await f.provisioning.create({ ...f.createInput, members: [] }, context)
  expect(result.creation).toMatchObject({ state: 'created', externalConversationId: 'created-room' })
  expect(result.membership).toEqual({ state: 'not-requested' }); expect(f.addMembers).not.toHaveBeenCalled(); await f.unchanged()
})

it('rechecks the original current authority after asynchronous preparation without exposing its private error', async () => {
  let revoked = false
  const f = await fixture({ resolve: async () => { revoked = true; return 'private-fixture-credential' } })
  const result = await f.provisioning.create(f.createInput, { ...context, assertCurrent: () => { if (revoked) throw new Error('private authority detail') } })
  expect(result.creation).toMatchObject({ state: 'not-applied', reason: 'authority-unavailable' })
  expect(JSON.stringify(result)).not.toContain('private authority detail'); expect(f.create).not.toHaveBeenCalled(); await f.unchanged()
})

it('preserves frozen member identities when an adapter mutates its detached request or returns another member receipt', async () => {
  const f = await fixture({ addMembers: async request => { request.members[0]!.userId = 'foreign-member'; return { results: request.members.map(member => ({ member, state: 'joined' })) } } })
  const original = structuredClone(f.createInput), result = await f.provisioning.create(f.createInput, context)
  expect(result.input).toEqual(original)
  expect(result.creation.state).toBe('created')
  expect(result.membership).toEqual({ state: 'settled', attemptId: expect.any(String), results: original.members.map(member => ({ member, state: 'unknown' })) })
  expect(await f.provisioning.create(f.createInput, context)).toEqual(result); expect(f.addMembers).toHaveBeenCalledTimes(1); await f.unchanged()
})

it('admits each original effect once across concurrent Host instances sharing the durable claim', async () => {
  const releases: Array<() => void> = []
  const f = await fixture({ resolve: async () => { await new Promise<void>(resolve => { releases.push(resolve) }); return 'private-fixture-credential' } })
  const other = new RoomProvisioningHost({ connections: f.connections, spatial: f.spatial })
  const first = f.provisioning.create({ ...f.createInput, members: [] }, context), second = other.create({ ...f.createInput, members: [] }, context)
  await vi.waitFor(() => expect(releases).toHaveLength(2)); releases.forEach(release => release())
  await Promise.all([first, second])
  expect(f.create).toHaveBeenCalledTimes(1)
  expect((await f.provisioning.inspect({ operationId: f.createInput.operationId })).operation!.creation.state).toBe('created'); await f.unchanged()
})

it('inspect leaves admitted pre-effect intent unchanged; only its exact original call may continue the first attempt', async () => {
  const f = await fixture(), store = new RoomProvisioningStore(f.connections)
  const original = store.admit(f.createInput, context.actor)
  expect(original.creation.state).toBe('pending')
  expect(await f.provisioning.inspect({ operationId: original.operationId })).toEqual({ operation: original })
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
  await expect(f.provisioning.create({ ...f.createInput, name: 'Changed original intent' }, context)).rejects.toMatchObject({ code: 'ROOM_PROVISIONING_OPERATION_CONFLICT' })
  await expect(f.provisioning.create(f.createInput, { actor: { kind: 'device', id: 'other-authority' } })).rejects.toMatchObject({ code: 'ROOM_PROVISIONING_OPERATION_CONFLICT' })
  expect((await f.provisioning.create(f.createInput, context)).creation.state).toBe('created')
  expect(f.create).toHaveBeenCalledTimes(1); await f.unchanged()
})

it('a confirmed creation not-applied releases the target only for a new explicit operation, while the original receipt never retries', async () => {
  const f = await fixture({ create: async () => ({ kind: 'not-applied' }) })
  const original = await f.provisioning.create(f.createInput, context)
  expect(original.creation).toMatchObject({ state: 'not-applied', reason: 'platform-not-applied', attemptId: expect.any(String) })
  expect(await f.provisioning.create(f.createInput, context)).toEqual(original)
  f.create.mockResolvedValueOnce({ kind: 'created', externalConversationId: 'confirmed-room' })
  expect((await f.provisioning.create({ ...f.createInput, operationId: 'explicit-after-known-not-applied' }, context)).creation).toMatchObject({ state: 'created', externalConversationId: 'confirmed-room' })
  expect(await f.provisioning.inspect({ operationId: original.operationId })).toEqual({ operation: original })
  expect(f.create).toHaveBeenCalledTimes(2); expect(f.addMembers).toHaveBeenCalledTimes(1); await f.unchanged()
})

it('a real interrupted owner process leaves its dispatched operation inspect-only after restart', async () => {
  const f = await fixture(), file = fileURLToPath(new URL('./fixtures/room-provisioning-owner.mjs', import.meta.url))
  const child = spawn(process.execPath, [file, f.root, JSON.stringify(f.createInput)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
  let diagnostics = ''; child.stderr!.on('data', data => { diagnostics += String(data) })
  const event = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(diagnostics || 'Controlled owner exited before its effect witness.') })])
  expect(event[0]).toMatchObject({ kind: 'effect-applied' })
  child.kill('SIGKILL'); await once(child, 'exit')
  const attempt = await readFile(join(f.root, 'room-effect'), 'utf8'), later = new RoomProvisioningHost({ connections: f.connections, spatial: f.spatial })
  expect((await later.inspect({ operationId: f.createInput.operationId })).operation!.creation).toEqual({ state: 'dispatching', attemptId: attempt })
  expect((await later.create(f.createInput, context)).creation).toEqual({ state: 'dispatching', attemptId: attempt })
  expect(f.create).not.toHaveBeenCalled(); expect(f.addMembers).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled(); await f.unchanged()
}, 20_000)
