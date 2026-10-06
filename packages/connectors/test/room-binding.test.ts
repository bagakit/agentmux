import { appendFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRoomBindingParams, parseRoomBindingResult } from '../../core/src/connections.js'
import { RoomBindingHost } from '../src/room-binding.js'
import { config, context, roomBindingFixture } from './fixtures/room-binding.js'

const fixtures: Awaited<ReturnType<typeof roomBindingFixture>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close() })
async function fixture(native = true) { const f = await roomBindingFixture(native); fixtures.push(f); return f }
const reply = (uuid: string, text: string) => JSON.stringify({ sessionId: 'original-native', uuid, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

describe('original room binding and grants', () => {
  it('saves the exact first native cut and operation atomically, excluding old history without touching the Agent', async () => {
    const f = await fixture(), initial = await f.client.conversationCheckpoint(f.input.agentSessionId)
    const operation = await f.bindings.bind(f.input, context)
    expect(operation.state).toBe('applied'); if (operation.state !== 'applied') throw new Error('Binding not applied')
    expect(operation.binding).toMatchObject({ executionHostId: 'local', agentSessionId: f.input.agentSessionId, regionAnchor: f.input.regionAnchor, revision: 1, sourceCheckpoints: [initial], authorizedBy: context.actor })
    expect(await f.bindings.bind(f.input, context)).toEqual(operation)
    expect((await f.bindings.inspect({ operationId: f.input.operationId })).operation).toEqual(operation)
    await expect(f.bindings.bind({ ...f.input, externalConversationId: 'another-group' }, context)).rejects.toMatchObject({ code: 'ROOM_BINDING_OPERATION_CONFLICT' })
    await f.unchanged()
    await appendFile(f.transcript, reply('new-assistant', 'Future reply'))
    const changes = await f.client.readConversationChanges(f.input.agentSessionId, { checkpoint: operation.binding.sourceCheckpoints[0]! })
    expect(changes.items).toHaveLength(1); expect(changes.items[0]?.id).toBe('new-assistant')
    expect(f.connections.database.prepare('SELECT COUNT(*) AS n FROM room_binding_revision').get()?.n).toBe(1)
  })
  it('reuses another Region for the same Session, while audience and replacement occupants require explicit relink', async () => {
    const f = await fixture(), original = await f.bindings.bind(f.input, context)
    const reused = await f.bindings.bind({ ...f.input, operationId: 'reuse', bindingId: 'other-binding', regionAnchor: { regionId: 'other-region' } }, context)
    expect(reused).toEqual({ ...original, operationId: 'reuse', reused: true })
    const different = await f.bindings.bind({ ...f.input, operationId: 'different-group', bindingId: 'different-binding', externalConversationId: 'other-group' }, context)
    expect(different).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
    await f.change(graph => { graph.tabLayouts.tab!.activeRegionId = 'other-region' })
    expect(f.bindings.readCurrent(f.input.bindingId)).toEqual(original.state === 'applied' ? original.binding : null)
    await f.change(graph => { graph.regions[0]!.agentSessionId = 'replacement-agent' })
    expect(f.bindings.publicationAuthority(f.input.bindingId, 1)).toMatchObject({ authorized: true, binding: { agentSessionId: f.input.agentSessionId } })
    expect(await f.bindings.bind({ ...f.input, operationId: 'replacement' }, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_TARGET_CHANGED' })
    expect(await f.bindings.inspect({ operationId: f.input.operationId })).toMatchObject({ operation: original, current: { revision: 1 } })
  })
  it('refuses changed spatial revision across asynchronous cut without keeping a SQL transaction open', async () => {
    const f = await fixture()
    let release!: () => void
    const checkpoint = vi.fn(async (ref: Parameters<typeof f.checkpoint>[0]) => { await new Promise<void>(resolve => { release = resolve }); return await f.checkpoint(ref) })
    const bindings = new RoomBindingHost({ connections: f.connections, spatial: f.spatial, checkpoint })
    const operation = bindings.bind(f.input, context)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect((await bindings.inspect({ operationId: f.input.operationId })).operation?.state).toBe('preparing')
    // A synchronous write succeeds during the Core await: no cross-owner transaction is held.
    f.connections.database.exec('BEGIN IMMEDIATE; COMMIT')
    await f.change(graph => { graph.regions[0]!.agentSessionId = 'replacement-agent' }); release()
    expect(await operation).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_TARGET_CHANGED' })
    expect(bindings.readCurrent(f.input.bindingId)).toBeNull()
    await f.unchanged()
  })
  it('keeps immutable revisions and original cuts through pause, explicit fresh relink and a real owner process restart', async () => {
    const f = await fixture(), first = await f.bindings.bind(f.input, context)
    await appendFile(f.transcript, reply('during-pause', 'Private before fresh cut'))
    const paused = await f.bindings.pause({ operationId: 'pause', bindingId: f.input.bindingId, expectedRevision: 1 }, context)
    expect(paused).toMatchObject({ state: 'applied', binding: { revision: 2, state: 'paused' } })
    expect(f.bindings.publicationAuthority(f.input.bindingId, 1)).toMatchObject({ authorized: false, reason: 'binding-revised' })
    expect(f.bindings.publicationAuthority(f.input.bindingId, 2)).toMatchObject({ authorized: false, reason: 'paused' })
    expect(await f.bindings.bind({ ...f.input, operationId: 'implicit-resume' }, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_PAUSED' })
    const relinked = await f.bindings.relink({ ...f.input, operationId: 'explicit-relink', expectedRevision: 2, externalConversationId: 'new-group' }, context)
    expect(relinked).toMatchObject({ state: 'applied', binding: { revision: 3, externalConversationId: 'new-group' } })
    expect(f.bindings.readExact(f.input.bindingId, 1)).toEqual(first.state === 'applied' ? first.binding : null)
    expect((await f.bindings.inspect({ operationId: f.input.operationId })).operation).toEqual(first)
    if (relinked.state !== 'applied') throw new Error('Relink not applied')
    expect((await f.client.readConversationChanges(f.input.agentSessionId, { checkpoint: relinked.binding.sourceCheckpoints[0]! })).items).toEqual([])
    const script = `import {ConnectionHost,RoomBindingHost} from './packages/connectors/dist/index.js'; import {AgentMuxSpatialStateStore} from './packages/core/dist/spatial-state.js'; import {join} from 'node:path'; const root=process.argv[1];const c=new ConnectionHost({databasePath:join(root,'connections.sqlite'),secrets:{resolve:async()=>null}});const spatial=new AgentMuxSpatialStateStore(join(root,'spatial.json'));const b=new RoomBindingHost({connections:c,spatial,checkpoint:async()=>{throw new Error('Read cannot capture a fresh cut')}});console.log(JSON.stringify({original:await b.inspect({operationId:'bind-original'}),current:b.readCurrent('original-binding'),spatial:await spatial.read()}));c.close()`
    const restarted = JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.root])).stdout)
    expect(restarted.original.operation).toEqual(first); expect(restarted.current).toEqual(relinked.binding)
    expect(restarted.spatial).toEqual(await f.spatial.read())
  })
  it('scopes actor grants to issuer, ID type, exact group and binding revision, independently of publication', async () => {
    const f = await fixture(); await f.bindings.bind(f.input, context)
    const actor = { application: config.application, idType: 'open_id', userId: 'actor' }
    const input = { operationId: 'grant-input', bindingId: f.input.bindingId, expectedBindingRevision: 1, grantId: 'actor-grant', expectedRevision: null, actor, capabilities: ['input'] as ['input'], state: 'active' as const }
    const granted = await f.bindings.grant(input, context)
    expect(granted).toMatchObject({ state: 'applied', grant: { revision: 1, bindingId: f.input.bindingId, bindingRevision: 1, capabilities: ['input'] } })
    expect(f.bindings.findGrant({ connectionId: config.connectionId, externalConversationId: f.input.externalConversationId, actor })?.capabilities).toEqual(['input'])
    expect(f.bindings.findGrant({ connectionId: config.connectionId, externalConversationId: 'other-group', actor })).toBeNull()
    expect(f.bindings.findGrant({ connectionId: config.connectionId, externalConversationId: f.input.externalConversationId, actor: { ...actor, idType: 'union_id' } })).toBeNull()
    expect(f.bindings.publicationAuthority(f.input.bindingId, 1).authorized).toBe(true)
    expect(await f.bindings.grant({ ...input, operationId: 'wrong-issuer', grantId: 'wrong-grant', actor: { ...actor, application: { ...actor.application, appId: 'other-app' } } }, context)).toMatchObject({ state: 'refused', code: 'ROOM_GRANT_ACTOR_MISMATCH' })
    expect(() => parseRoomBindingParams('connection.grant', { ...input, capabilities: ['publish'] })).toThrow()
    await f.bindings.pause({ operationId: 'pause', bindingId: f.input.bindingId, expectedRevision: 1 }, context)
    expect(f.bindings.readGrant(input.grantId, 1)?.bindingRevision).toBe(1)
    expect((await f.bindings.inspect({ bindingId: f.input.bindingId })).grants).toEqual([])
    expect((await f.bindings.inspect({ operationId: input.operationId })).operation).toEqual(granted)
  })
  it('releases only stale grant routing after explicit relink while retaining original grant identity and receipt', async () => {
    const f = await fixture(); await f.bindings.bind(f.input, context)
    const actor = { application: config.application, idType: 'open_id', userId: 'original-actor' }
    const grant = { operationId: 'grant-original', bindingId: f.input.bindingId, expectedBindingRevision: 1, grantId: 'original-grant', expectedRevision: null, actor, capabilities: ['input'] as ['input'], state: 'active' as const }
    const first = await f.bindings.grant(grant, context)
    await f.connections.configure({ operationId: 'configure-other', expectedRevision: null, connection: { ...config, connectionId: 'other-connection' } })
    await f.bindings.relink({ ...f.input, operationId: 'move-audience', expectedRevision: 1, connectionId: 'other-connection', externalConversationId: 'other-group' }, context)
    const scope = { connectionId: config.connectionId, externalConversationId: f.input.externalConversationId, actor }
    expect(f.bindings.findGrant(scope)).toBeNull()
    const secondInput = { ...f.input, operationId: 'new-binding', bindingId: 'new-binding' }
    expect(await f.bindings.bind(secondInput, context)).toMatchObject({ state: 'applied' })
    const second = await f.bindings.grant({ ...grant, operationId: 'new-grant', bindingId: secondInput.bindingId, grantId: 'new-grant' }, context)
    expect(second).toMatchObject({ state: 'applied', grant: { grantId: 'new-grant', bindingId: 'new-binding' } })
    expect(f.bindings.findGrant(scope)?.grantId).toBe('new-grant')
    expect(f.bindings.readGrant('original-grant')).toEqual(first.state === 'applied' ? first.grant : null)
    expect(f.bindings.readGrant('original-grant', 1)).toEqual(first.state === 'applied' ? first.grant : null)
    expect((await f.bindings.inspect({ operationId: grant.operationId })).operation).toEqual(first)
    expect((await f.bindings.inspect({ operationId: f.input.operationId })).binding?.revision).toBe(1)
    await f.unchanged()
  })
  it('renews grants explicitly after a Binding revision and permits only one competing valid actor grant', async () => {
    const f = await fixture(); await f.bindings.bind(f.input, context)
    const actor = { application: config.application, idType: 'open_id', userId: 'actor' }
    const input = { operationId: 'original-grant', bindingId: f.input.bindingId, expectedBindingRevision: 1, grantId: 'original-grant', expectedRevision: null, actor, capabilities: ['input'] as ['input'], state: 'active' as const }
    const first = await f.bindings.grant(input, context)
    await f.bindings.relink({ ...f.input, operationId: 'new-revision', expectedRevision: 1 }, context)
    const scope = { connectionId: config.connectionId, externalConversationId: f.input.externalConversationId, actor }
    expect(f.bindings.findGrant(scope)).toBeNull()
    const attempts = await Promise.all(['grant-a', 'grant-b'].map(grantId => f.bindings.grant({ ...input, operationId: grantId, grantId, expectedBindingRevision: 2 }, context)))
    expect(attempts.filter(op => op.state === 'applied')).toHaveLength(1)
    expect(attempts.filter(op => op.state === 'refused')).toEqual([expect.objectContaining({ code: 'ROOM_GRANT_ACTOR_CONFLICT' })])
    expect(f.bindings.findGrant(scope)?.bindingRevision).toBe(2)
    expect(f.bindings.readGrant(input.grantId)).toEqual(first.state === 'applied' ? first.grant : null)
    expect((await f.bindings.inspect({ operationId: input.operationId })).operation).toEqual(first)
    await f.unchanged()
  })
  it('refuses unsupported or changed sources only at the new sharing boundary, preserving configuration and Agent', async () => {
    const f = await fixture(false)
    expect(await f.bindings.bind(f.input, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_SOURCE_UNAVAILABLE' })
    expect(f.connections.readConfiguration(config.connectionId)?.config.enabled).toBe(true)
    expect(f.bindings.readCurrent(f.input.bindingId)).toBeNull(); await f.unchanged()
    const native = await fixture()
    expect(await native.bindings.bind({ ...native.input, expectedSource: { ...native.input.expectedSource, nativeSessionId: 'private-import' } }, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_SOURCE_CHANGED' })
    await native.unchanged()
  })
  it('rolls back the binding and cut when its original operation receipt cannot commit', async () => {
    const f = await fixture()
    f.connections.database.exec("CREATE TRIGGER reject_applied_receipt BEFORE UPDATE ON room_binding_operation WHEN json_extract(NEW.result_json,'$.state')='applied' BEGIN SELECT RAISE(ABORT,'private-storage-detail'); END")
    await expect(f.bindings.bind(f.input, context)).rejects.toMatchObject({ code: 'ROOM_BINDING_OPERATION_UNCONFIRMED' })
    expect(f.bindings.readCurrent(f.input.bindingId)).toBeNull(); expect(f.bindings.readExact(f.input.bindingId, 1)).toBeNull()
    const original = await f.bindings.inspect({ operationId: f.input.operationId })
    expect(original.operation?.state).toBe('preparing'); expect(JSON.stringify(original)).not.toContain('private-storage-detail')
    f.connections.database.exec('DROP TRIGGER reject_applied_receipt')
    expect(await f.bindings.bind(f.input, context)).toMatchObject({ state: 'applied', binding: { revision: 1 } })
    expect(f.connections.readConfiguration(config.connectionId)?.revision).toBe(1)
    await f.unchanged()
  })
  it('coalesces in-flight original intent while conflicting authority cannot reuse its operation', async () => {
    const f = await fixture(); let release!: () => void
    const checkpoint = vi.fn(async (ref: Parameters<typeof f.checkpoint>[0]) => { await new Promise<void>(resolve => { release = resolve }); return await f.checkpoint(ref) })
    const bindings = new RoomBindingHost({ connections: f.connections, spatial: f.spatial, checkpoint })
    const first = bindings.bind(f.input, context)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const duplicate = bindings.bind(f.input, context)
    await expect(bindings.bind(f.input, { actor: { kind: 'device', id: 'other-authority' } })).rejects.toMatchObject({ code: 'ROOM_BINDING_OPERATION_CONFLICT' })
    release(); expect(await duplicate).toEqual(await first); expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(bindings.listActive({ executionHostId: 'local', agentSessionId: f.input.agentSessionId })).toHaveLength(1)
    await f.unchanged()
  })
  it('preserves a prepared original operation after authority observation fails and reconciles the same intent', async () => {
    const f = await fixture(); let n = 0
    await expect(f.bindings.bind(f.input, { actor: context.actor, assertCurrent: () => { if (++n === 2) throw new Error('private-path-or-credential') } })).rejects.toMatchObject({ code: 'ROOM_BINDING_OPERATION_UNCONFIRMED' })
    expect((await f.bindings.inspect({ operationId: f.input.operationId })).operation?.state).toBe('preparing')
    const restored = new RoomBindingHost({ connections: f.connections, spatial: f.spatial, checkpoint: f.checkpoint })
    const result = await restored.bind(f.input, context)
    expect(result).toMatchObject({ state: 'applied', binding: { revision: 1 } })
    expect(JSON.stringify(await restored.inspect({ operationId: f.input.operationId }))).not.toContain('private-path-or-credential')
    if (result.state !== 'applied') throw new Error('Binding not applied')
    expect(() => parseRoomBindingResult('connection.bind', { ...result, binding: { ...result.binding, agentSessionId: 'another-session' } }, f.input)).toThrow()
  })
})
