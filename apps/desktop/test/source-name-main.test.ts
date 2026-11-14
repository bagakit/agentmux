import { afterEach, expect, it, vi } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import type { AgentMuxStoredAgentSession } from '@agentmux/core'
import { spaceMountTransport } from './helpers/space-mount-fixture'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), sameLocal = await f.b.put('same-SID'), original = await f.d.put('same-SID')
  const session: AgentMuxStoredAgentSession = { ...original, creation: { createOperationId: 'original-C', initialPrompt: 'unknown' } }
  // Original Session owner seed. No Native create, full snapshot, or production data.
  await (f.d.core as unknown as { registry: { put(session: AgentMuxStoredAgentSession, expected: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(session, original.run)
  const admitted = await f.admit('D-in-B', f.d.owner.runtimeId, session.agentSessionId, 'original-C')
  const target = { reference: f.reference, regionId: admitted.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: session.agentSessionId,
    expectedAdmission: { kind: 'creation' as const, operationId: 'original-C' } }
  const transport = spaceMountTransport(cleanup, [
    { id: 'B-carrier-in-A', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } },
    { id: 'original-execution-owner', carrier: { forwardRpc: f.d.rpc.call.bind(f.d.rpc), subscribeRpc: f.d.rpc.subscribe.bind(f.d.rpc) } }
  ])
  const subject = vi.spyOn(f.d.core, 'runtimeSubject').mockRejectedValue(Error('Names must not depend on Native Run observation'))
  const native = vi.spyOn(f.d.core, 'connectRuntime').mockRejectedValue(Error('Names must not connect Native'))
  return { ...f, ...transport, session, sameLocal, admitted, target, source: { hostId: 'B-carrier-in-A', reference: f.reference }, subject, native }
}

it('the actual trusted Main/preload/renderer name ports reach Source Tab and D canonical Agent owners with separate original OPs and ACKs', async () => {
  const f = await fixture(), original = await f.d.core.readAgentSession(f.session.agentSessionId)
  const read = await f.api.call('memberNameInspect', { ...f.source, name: { target: f.target, object: 'agent' } })
  expect(read.current).toEqual({ override: null, source: null, nameRevision: 0 }); expect(read.diskAcknowledgement).toBe('not-observed')
  await expect(access(f.d.spatial.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const accepted = await f.api.call('memberNameChange', { ...f.source, name: { target: f.target, object: 'agent',
    change: { kind: 'rename', name: 'Original D Agent name', expectedNameRevision: 0, source: 'launch', operationId: 'original-Agent-name-OP' } } }).then(value => ({ value }), error => ({ error }))
  expect(accepted).toHaveProperty('value'); if (!('value' in accepted)) throw accepted.error
  const agent = accepted.value
  const tab = await f.api.call('memberNameChange', { ...f.source, name: { target: f.target, object: 'tab',
    change: { kind: 'rename', name: 'Original B Tab name', expectedNameRevision: 0, source: 'launch', operationId: 'original-Tab-name-OP' } } })
  expect(agent).toMatchObject({ target: { runtimeId: f.d.owner.runtimeId, id: f.session.agentSessionId }, current: { override: 'Original D Agent name' }, applied: true, save: { diskDurability: 'confirmed' } })
  expect(tab).toMatchObject({ target: { runtimeId: f.b.owner.runtimeId, id: f.admitted.address.tabId }, current: { override: 'Original B Tab name' }, applied: true, save: { diskDurability: 'confirmed' } })
  expect((await f.b.spatial.readDisplayLabel({ kind: 'agent-session', id: f.sameLocal.agentSessionId })).label).toBeNull()
  const queried = await f.api.call('memberNameInspect', { ...f.source, name: { target: f.target, object: 'agent', operationId: agent.record.id } })
  expect(queried.record?.status).toBe('applied'); expect(queried.diskAcknowledgement).toBe('not-observed')
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toEqual(original)
  expect(f.subject).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

it('independent original Agent labels use the exact receiving Runtime and C; reads do not acknowledge a previous write', async () => {
  const f = await fixture(), owner = { hostId: 'original-execution-owner', expectedRuntimeId: f.d.owner.runtimeId }, name = { runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C' }
  const changed = await f.api.call('agentNameChange', { ...owner, name: { ...name, change: { kind: 'rename', name: 'Independent original name', expectedNameRevision: 0, source: 'launch', operationId: 'original-A-name-OP' } } })
  const read = await f.api.call('agentNameInspect', { ...owner, name: { ...name, operationId: changed.record.id } })
  expect(read).toMatchObject({ current: { override: 'Independent original name' }, record: { id: 'original-A-name-OP' }, diskAcknowledgement: 'not-observed' })
  const confirmed = await f.api.call('agentNameChange', { ...owner, name: { ...name, change: { kind: 'confirm', operationId: changed.record.id } } })
  expect(confirmed).toMatchObject({ applied: true, changed: false, save: { diskDurability: 'confirmed' } })
  const before = await readFile(f.d.spatial.path)
  await expect(f.api.call('agentNameChange', { ...owner, name: { ...name, runtimeId: f.b.owner.runtimeId, change: { kind: 'rename', name: 'Wrong Runtime', expectedNameRevision: 1, source: 'manual', operationId: 'wrong-Runtime-OP' } } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.api.call('agentNameChange', { ...owner, name: { ...name, createOperationId: 'another-C', change: { kind: 'rename', name: 'Wrong C', expectedNameRevision: 1, source: 'manual', operationId: 'wrong-C-OP' } } })).rejects.toMatchObject({ code: 'NAME_TARGET_UNCONFIRMED' })
  expect(await readFile(f.d.spatial.path)).toEqual(before)
  expect(f.subject).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})

it('Source name pins and trusted-frame custody reject only a mismatched operation without borrowing same-SID local ownership', async () => {
  const f = await fixture(), change = { kind: 'rename' as const, name: 'Wrong name', expectedNameRevision: 0, source: 'manual' as const, operationId: 'wrong-name-OP' }
  const secondSpace = await f.b.spatial.registerFolder({ id: 'another-real-project', hostId: 'local', name: 'Another real project', path: '/b/another-real-project' })
  const ownerWrite = vi.spyOn(f.d.spatial, 'mutateDisplayLabel')
  const mismatched = await f.api.call('memberNameChange', { ...f.source, reference: { ...f.reference, spaceId: secondSpace.spaceId }, name: { target: f.target, object: 'agent', change } }).then(value => ({ value }), error => ({ error }))
  expect(ownerWrite).not.toHaveBeenCalled(); expect(mismatched).toHaveProperty('error')
  await expect(f.api.call('memberNameChange', { ...f.source, name: { target: { ...f.target, reference: { ...f.reference, spaceId: 'another-Space' } }, object: 'agent', change } })).rejects.toMatchObject({ code: 'SPACE_PARENT_MISMATCH' })
  await expect(f.api.call('memberNameChange', { ...f.source, name: { target: { ...f.target, expectedAdmission: { kind: 'creation', operationId: 'another-C' } }, object: 'agent', change } })).rejects.toThrow()
  expect(() => f.handlers.get('spaceMounts:call')!({ ...f.event, senderFrame: { ...f.sender.mainFrame } } as never, 'foreign-frame', 'memberNameChange', { ...f.source, name: { target: f.target, object: 'agent', change } })).toThrow('Untrusted application')
  await expect(access(f.d.spatial.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.b.spatial.readDisplayLabel({ kind: 'agent-session', id: f.sameLocal.agentSessionId })).label).toBeNull()
  const correct = await f.api.call('memberNameChange', { ...f.source, name: { target: f.target, object: 'agent', change: { ...change, operationId: 'correct-name-OP', name: 'Correct original name' } } })
  expect(correct.applied).toBe(true); expect(f.subject).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})
