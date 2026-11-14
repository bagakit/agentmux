import { afterEach, expect, it } from 'vitest'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { observeMountedSessions } from '../src/renderer/src/lib/space-mount-sessions'
import { ordinarySpaceMember, ordinaryMemberRouteOccurrence } from '../src/renderer/src/lib/ordinary-space-member'
import { editMountedSpaceDraftInput, memberSpaceInputTarget, mountedRegionKey, mountedSpaceTarget } from '../src/renderer/src/lib/space-mount-view'
import { mountedMemberDraft, mountedMemberRequestBuckets } from '../src/renderer/src/lib/space-member-input'
import { spaceMountKey } from '../src/shared/space-mount'
import { useAppStore } from '../src/renderer/src/store'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function originalOccurrence() {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-raw-session'
  const original = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-foreign-create')
  await f.b.spatial.settleAgentOpen(admission.requestId, original, { workspaceId: 'original-b-project', phase: 'attached',
    agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } })
  const document = await f.b.spatial.readForLayout()
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
  expect(ordinaryMemberRouteOccurrence(fact, snapshot, metadata)).toBe(occurrence)
  expect(ordinaryMemberRouteOccurrence(fact, { ...snapshot, revision: snapshot.revision + 1 }, metadata)).toBeUndefined()
  expect(ordinaryMemberRouteOccurrence({ ...fact, creationOperationId: 'another-original-CID' }, snapshot, metadata)).toBeUndefined()
  expect(ordinaryMemberRouteOccurrence({ ...fact, metadataMember: { ...fact.metadataMember, runtimeId: 'another-original-Runtime' } }, snapshot, metadata)).toBeUndefined()
  expect(ordinaryMemberRouteOccurrence(fact, { ...snapshot, reference: { ...snapshot.reference, runtimeId: 'another-source' } }, metadata)).toBeUndefined()

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

it('ordinary member input reuses the original user-document leaf without mounting navigation or adopting raw-SID drafts', async () => {
  const { document, reference } = await originalOccurrence()
  const fact = ordinarySpaceMember(document.graph, reference, 'local')
  if (fact.kind !== 'foreign') throw Error('Expected the actual original foreign admission')
  const key = spaceMountKey(fact.source.reference), before = useAppStore.getState()
  const originalInputs = { opaque: { future: ['original bytes'] } }
  useAppStore.setState({ mountedSpaceInputs: originalInputs, selectedSpaceMount: null, agentComposerDrafts: { [reference.sessionId]: 'Other local raw-SID input' } })
  try {
    expect(mountedMemberDraft(originalInputs, key, reference.tabId, fact.member, fact.source)).toBe('')
    expect(mountedMemberRequestBuckets(originalInputs, key, fact.member, fact.source)).toEqual({})
    expect(useAppStore.getState().mountedSpaceInputs).toBe(originalInputs)
    const input = editMountedSpaceDraftInput(originalInputs, key, reference.tabId, reference.regionId, 'Unsent source-qualified input', undefined, fact.source)
    useAppStore.setState({ mountedSpaceInputs: input })
    expect(mountedSpaceTarget(input, key)).toBeUndefined()
    expect(memberSpaceInputTarget(input, key)).toEqual(fact.source)
    expect(mountedMemberDraft(input, key, reference.tabId, fact.member)).toBe('Unsent source-qualified input')
    expect(input.opaque).toBe(originalInputs.opaque)
    expect(useAppStore.getState().selectedSpaceMount).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts[reference.sessionId]).toBe('Other local raw-SID input')
    useAppStore.getState().mountSpace(fact.source)
    const promoted = useAppStore.getState().mountedSpaceInputs
    expect(mountedSpaceTarget(promoted, key)).toEqual(fact.source)
    expect(mountedMemberDraft(promoted, key, reference.tabId, fact.member)).toBe('Unsent source-qualified input')
    expect((promoted as Record<string, { drafts: Record<string, string> }>)[key]!.drafts[mountedRegionKey(fact.source.reference, reference.tabId, reference.regionId)]).toBe('Unsent source-qualified input')
    const future = { [key]: { kind: 'future-owner', target: fact.source, drafts: { original: 'Keep opaque' } } }
    const bytes = JSON.stringify(future)
    expect(() => editMountedSpaceDraftInput(future, key, reference.tabId, reference.regionId, 'Must not overwrite', undefined, fact.source)).toThrow('unreadable')
    expect(JSON.stringify(future)).toBe(bytes)
    expect(() => mountedMemberDraft({}, 'wrong-key', reference.tabId, fact.member, fact.source)).toThrow('unreadable')
  } finally { useAppStore.setState(before, true) }
})
