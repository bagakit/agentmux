import { afterEach, expect, it } from 'vitest'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { mountedSessionFacts, observeMountedSessions } from '../src/renderer/src/lib/space-mount-sessions'
import { ordinarySpaceMember, ordinaryMemberObservation } from '../src/renderer/src/lib/ordinary-space-member'
import { mountedRegionKey } from '../src/renderer/src/lib/space-mount-view'
import { sourceInputRecoveryRows } from '../src/renderer/src/lib/source-composer-handoff'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { spaceMountKey } from '../src/shared/space-mount'
import { useAppStore } from '../src/renderer/src/store'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function originalOccurrence() {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-raw-session'
  f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  const original = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-foreign-create')
  await f.b.spatial.settleAgentOpen(admission.requestId, original, { workspaceId: 'original-b-project', phase: 'attached',
    agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } })
  const document = await f.b.spatial.readForLayout()
  if (!document) throw Error('Expected the original spatial document')
  const reference = { tabId: admission.address.tabId!, regionId: admission.address.regionId, sessionId: sid }
  return { f, original, admission, document, reference }
}

it('the original Core admission locates a foreign ordinary Region without borrowing a same-SID local Session or display Host', async () => {
  const { f, document, reference, original } = await originalOccurrence()
  const fact = ordinarySpaceMember(document.graph, reference, 'this-B-Core')
  expect(fact).toMatchObject({ kind: 'foreign', source: { hostId: 'this-B-Core', reference: f.reference },
    creationOperationId: 'original-foreign-create', member: { hostId: 'this-B-Core', target: {
      reference: f.reference, regionId: reference.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: reference.sessionId, expectedRun: original.run } } })
  expect(ordinarySpaceMember(document.graph, reference, 'this-B-Core')).toBe(fact)
  if (fact.kind !== 'foreign') throw Error('Expected the original foreign occurrence')
  const { readSpaceSnapshot } = await import('@agentmux/core')
  const snapshot = await readSpaceSnapshot(f.b.rpc, f.reference)
  const occurrence = { regionId: reference.regionId, creationOperationId: fact.creationOperationId,
    projectRuntimeId: f.reference.runtimeId, agentRuntimeId: f.d.owner.runtimeId, executionRoute: { kind: 'unconfirmed' as const } }
  // Controlled route DTO over the real source cut. Neither a foreign Host alias
  // nor access from this observer is evidence of an execution hop.
  const metadata = observeMountedSessions(fact.source, undefined, { observation: {
    type: 'member', reference: snapshot.reference, source: snapshot.source, revision: snapshot.revision,
    member: fact.metadataMember, state: { status: 'pending' }, occurrences: [occurrence] } })
  const subject = ordinaryMemberObservation(fact, snapshot, metadata)
  expect(subject.relation).toBe(occurrence)
  expect(subject.current).toBe(mountedSessionFacts(snapshot, metadata).get(fact.presentation.key)?.current)
  expect(ordinaryMemberObservation(fact, { ...snapshot, revision: snapshot.revision + 1 }, metadata).relation).toBeUndefined()
  expect(ordinaryMemberObservation({ ...fact, creationOperationId: 'another-original-CID' }, snapshot, metadata).relation).toBeUndefined()
  expect(ordinaryMemberObservation({ ...fact, metadataMember: { ...fact.metadataMember, runtimeId: 'another-original-Runtime' } }, snapshot, metadata).relation).toBeUndefined()
  expect(ordinaryMemberObservation(fact, { ...snapshot, reference: { ...snapshot.reference, runtimeId: 'another-source' } }, metadata).relation).toBeUndefined()

  // Reading one registered Region must never enlist unrelated member facts.
  const exactMembers = new Proxy(metadata.members, { ownKeys() { throw Error('A scoped read enumerated the source roster') } })
  expect(ordinaryMemberObservation(fact, snapshot, { ...metadata, members: exactMembers }).relation).toBe(occurrence)

  const local = structuredClone(document.graph), localRegion = local.regions.find(region => region.regionId === reference.regionId)!
  localRegion.execution = { ...localRegion.execution!, hostId: 'local', runtimeId: f.b.owner.runtimeId }
  expect(ordinarySpaceMember(local, reference, 'this-B-Core')).toEqual({ kind: 'existing' })
  const wrongSession = { ...reference, sessionId: 'another-SID' }
  expect(ordinarySpaceMember(document.graph, wrongSession, 'this-B-Core').kind).toBe('unconfirmed')
  const missingWitness = structuredClone(document.graph)
  delete missingWitness.regions.find(region => region.regionId === reference.regionId)!.creationOperationId
  expect(ordinarySpaceMember(missingWitness, reference, 'this-B-Core').kind).toBe('unconfirmed')
  const observed = { id: reference.sessionId, hostId: 'D-in-B', control: { kind: 'agent' as const, hostId: 'D-in-B', agentSessionId: reference.sessionId } }
  expect(ordinarySpaceMember(missingWitness, reference, 'this-B-Core', observed).kind).toBe('existing')
  expect(ordinarySpaceMember(missingWitness, reference, 'this-B-Core', { ...observed, hostId: 'local', control: { ...observed.control, hostId: 'local' } }).kind).toBe('unconfirmed')
  expect(ordinarySpaceMember(missingWitness, reference, 'this-B-Core', { ...observed, id: 'another-client-key' }).kind).toBe('unconfirmed')
  const missingAdmission = structuredClone(document.graph)
  missingAdmission.regions.find(region => region.regionId === reference.regionId)!.creationOperationId = 'legacy-CID-without-admission'
  expect(ordinarySpaceMember(missingAdmission, reference, 'this-B-Core', observed).kind).toBe('existing')
  expect(ordinarySpaceMember(document.graph, reference, 'this-B-Core', observed).kind).toBe('foreign')
  // A complete Core witness for another Runtime remains a fixed member address,
  // even when the observer has a same-SID/same-alias legacy presentation.
  const rebound = structuredClone(document.graph)
  rebound.regions.find(region => region.regionId === reference.regionId)!.execution!.runtimeId = 'another-original-D-Runtime'
  expect(ordinarySpaceMember(rebound, reference, 'this-B-Core', observed)).toMatchObject({ kind: 'foreign',
    member: { target: { runtimeId: 'another-original-D-Runtime', agentSessionId: reference.sessionId } } })
  expect(ordinarySpaceMember(document.graph, reference, undefined).kind).toBe('unconfirmed')
})

it('ordinary member drafts use canonical execution identity while old position-only bytes stay recoverable', async () => {
  const { document, reference } = await originalOccurrence(), fact = ordinarySpaceMember(document.graph, reference, 'local')
  if (fact.kind !== 'foreign') throw Error('Expected the actual original foreign admission')
  const key = spaceMountKey(fact.source.reference), before = useAppStore.getState(), oldText = 'Unsent position-only input'
  const originalInputs = { [key]: { target: fact.source, drafts: { [mountedRegionKey(fact.source.reference, reference.tabId, reference.regionId)]: oldText } },
    opaque: { future: ['original bytes'] } }
  useAppStore.setState({ mountedSpaceInputs: originalInputs, agentComposerDrafts: { [reference.sessionId]: 'Other local raw-SID input' } })
  try {
    const rows = sourceInputRecoveryRows(originalInputs, fact.member, reference.tabId)
    expect(rows).toContainEqual(expect.objectContaining({ text: oldText }))
    const owner = originalSourceInputOwnerKey(fact.member.target.runtimeId, reference.sessionId)
    expect(useAppStore.getState().agentComposerDrafts[owner]).toBeUndefined()
    useAppStore.getState().appendAgentComposerDraft(owner, oldText)
    expect(useAppStore.getState().agentComposerDrafts[owner]).toBe(oldText)
    expect(useAppStore.getState().agentComposerDrafts[reference.sessionId]).toBe('Other local raw-SID input')
    expect(useAppStore.getState().mountedSpaceInputs).toBe(originalInputs)
    expect(Object.hasOwn(useAppStore.getState(),'selectedSpaceMount')).toBe(false)
  } finally { useAppStore.setState(before, true) }
})
