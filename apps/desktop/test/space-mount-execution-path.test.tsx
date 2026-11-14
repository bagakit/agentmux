// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { SpaceSessionsObservation, SpaceSessionOccurrence } from '@agentmux/core/space-sessions'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { mountedSessionFacts, observeMountedSessions } from '../src/renderer/src/lib/space-mount-sessions'
import { mountedSpaceRegions, mountedSpaceTarget } from '../src/renderer/src/lib/space-mount-view'
import { MountedExecutionRelation } from '../src/renderer/src/components/MountedExecutionRelation'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { spaceMountKey, type SpaceMountRecord } from '../src/shared/space-mount'
import { composerDOM } from './helpers/composer-dom-fixture'
import { spaceMountFixture } from './helpers/space-mount-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
function SourceWorkbench({ mountKey, visible }: { mountKey: string; visible: boolean }) {
  const workspaceId = useAppStore(state => mountedSpaceTarget(state.mountedSpaceInputs, mountKey)?.workspaceId)
  return workspaceId ? <WorkspaceWorkbench workspaceId={workspaceId} visible={visible} /> : null
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Actual source Space registration/snapshot, Main/Preload/Renderer and mounted
 * Workbench/Focus. Session metadata is a controlled public-DTO leaf here; its
 * source admission and signed transport have separate Core consumer proof. */
async function fixture() {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(f.api.call)
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(f.api.watch)
  const resources = await f.api.call('resources', { hostId: b.id }), project = resources.workspaces[0]!
  const registered = await f.api.call('register', { hostId: b.id, registration: { runtimeId: b.identity.runtimeId, workspaceId: project.workspaceId,
    expectedResource: { hostId: project.hostId, workspacePath: project.path, projectRootPath: project.path } } })
  const target: SpaceMountRecord = { hostId: b.id, reference: registered.reference, workspaceId: registered.workspaceId, zoneId: registered.zoneId }
  await f.api.call('apply', { hostId: target.hostId, reference: target.reference, edit: { reference: target.reference, expectedRevision: registered.revision, changes: {
    tabs: [{ tabId: 'original-tab', zoneId: target.zoneId, workspaceId: target.workspaceId, name: 'Source project work', regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'agent-1', runId: null, creationOperationId: 'original-creation',
      execution: { hostId: 'saved-execution', runtimeId: 'runtime-D', cwd: project.path } }]
  } } })
  const snapshot = await f.api.call('snapshot', { hostId: target.hostId, reference: target.reference })
  const route = { source: { runtimeId: target.reference.runtimeId, publicKey: 'source-key', fingerprint: 'source-fingerprint' }, hops: [
    { edgeId: 'C', target: { runtimeId: 'runtime-C', publicKey: 'intermediate-key', fingerprint: 'intermediate-fingerprint' } },
    { edgeId: 'D', target: { runtimeId: 'runtime-D', publicKey: 'destination-key', fingerprint: 'destination-fingerprint' } }
  ] }
  const occurrence: SpaceSessionOccurrence = { regionId: 'original-region', creationOperationId: 'original-creation', projectRuntimeId: target.reference.runtimeId,
    agentRuntimeId: 'runtime-D', executionRoute: { kind: 'adopted', route } }
  const event: Extract<SpaceSessionsObservation, { type: 'member' }> = { reference: snapshot.reference, source: snapshot.source, revision: snapshot.revision,
    type: 'member', member: { hostId: 'saved-execution', runtimeId: 'runtime-D', agentSessionId: 'agent-1' }, state: { status: 'pending' }, occurrences: [occurrence] }
  const metadata = observeMountedSessions(target, undefined, { observation: event })
  const member = mountedSpaceRegions(snapshot)[0]!
  return { f, target, snapshot, member, event, occurrence, metadata, key: spaceMountKey(target.reference) }
}

test('the real Workbench badge retains the source execution chain and exclude the observer access hop', async () => {
  const f = await fixture(), originalSessions = useAppStore.getState().sessions
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(async (_target, emit) => {
    queueMicrotask(() => emit({ type: 'observation', observation: f.event }))
    return { initial: { reference: f.event.reference, source: f.event.source, revision: f.event.revision }, dispose() {} }
  })
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<SourceWorkbench mountKey={f.key} visible />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-path-state="cascade"]')?.textContent).toBe('2'))
  const badge = dom.container.querySelector('.agent-work-mode-badge')!
  expect(badge.getAttribute('aria-label')).toContain(`\n${f.target.reference.runtimeId} → runtime-C → runtime-D\nAccess to source`)
  expect(badge.querySelectorAll('[data-local]')).toHaveLength(0)
  expect(useAppStore.getState().sessions).toBe(originalSessions)
})

test('an older relation cut keeps its Session metadata but cannot relabel the current Space badge', async () => {
  const f = await fixture(), newer = { ...f.snapshot, revision: f.snapshot.revision + 1 }
  const fact = mountedSessionFacts(newer, f.metadata).get(f.member.key)!
  expect(fact.current).toBe(f.metadata.members[Object.keys(f.metadata.members)[0]!])
  expect(fact.occurrence).toBeUndefined()
  await dom.render(<MountedExecutionRelation member={f.member} target={f.target} occurrence={fact.occurrence} />)
  expect(dom.container.querySelector('[data-path-state="unconfirmed"]')).not.toBeNull()
  const otherOwner = { ...f.snapshot, source: { ...f.snapshot.source, ownerInstanceId: 'another-source-instance' } }
  expect(mountedSessionFacts(otherOwner, f.metadata).get(f.member.key)?.occurrence).toBeUndefined()
})

test('the exact Region and creation identity choose the relation for a repeated Session without inventing a hop count', async () => {
  const f = await fixture()
  const direct = { ...f.occurrence, regionId: 'another-region', creationOperationId: 'another-creation', executionRoute: { kind: 'adopted' as const,
    route: { source: f.occurrence.executionRoute.kind === 'adopted' ? f.occurrence.executionRoute.route.source : { runtimeId: 'unused', publicKey: 'unused', fingerprint: 'unused' }, hops: [{ edgeId: 'D', target: { runtimeId: 'runtime-D', publicKey: 'destination-key', fingerprint: 'destination-fingerprint' } }] } } }
  const snapshot = { ...f.snapshot, scope: { ...f.snapshot.scope, tabs: f.snapshot.scope.tabs.map(tab => ({ ...tab, regionIds: [...tab.regionIds, direct.regionId] })),
    regions: [...f.snapshot.scope.regions, { ...f.member.region, regionId: direct.regionId, creationOperationId: direct.creationOperationId }] } }
  const metadata = observeMountedSessions(f.target, undefined, { observation: { ...f.event, occurrences: [direct, f.occurrence] } })
  const members = mountedSpaceRegions(snapshot), facts = mountedSessionFacts(snapshot, metadata), other = members.find(member => member.region.regionId === direct.regionId)!
  expect(facts.get(f.member.key)?.occurrence).toEqual(f.occurrence)
  await dom.render(<MountedExecutionRelation member={other} target={f.target} occurrence={facts.get(other.key)?.occurrence} />)
  expect(dom.container.querySelector('[data-path-state="direct"]')).not.toBeNull()
  expect(dom.container.querySelector('.execution-route-link text')).toBeNull()
  const wrongCreation = observeMountedSessions(f.target, undefined, { observation: { ...f.event, occurrences: [{ ...f.occurrence, creationOperationId: 'another-creation' }] } })
  expect(mountedSessionFacts(f.snapshot, wrongCreation).get(f.member.key)?.occurrence).toBeUndefined()
  const { occurrences: _occurrences, ...withoutOccurrences } = f.event
  const absent = observeMountedSessions(f.target, undefined, { observation: withoutOccurrences })
  expect(mountedSessionFacts(f.snapshot, absent).get(f.member.key)?.current?.state.status).toBe('pending')
  expect(mountedSessionFacts(f.snapshot, absent).get(f.member.key)?.occurrence).toBeUndefined()
})


test('a completed metadata-only source cut keeps the same Workbench path without another Agent observation', async () => {
  const f = await fixture(), listeners = new Set<(value: Parameters<Parameters<typeof api.spaceMounts.sessions>[1]>[0]) => void>()
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(async (_target, emit) => {
    listeners.add(emit); queueMicrotask(() => emit({ type: 'observation', observation: f.event }))
    return { initial: { reference: f.event.reference, source: f.event.source, revision: f.event.revision }, dispose() { listeners.delete(emit) } }
  })
  useAppStore.getState().mountSpace(f.target)
  await dom.render(<SourceWorkbench mountKey={f.key} visible />)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('[data-path-state="cascade"]')).toHaveLength(1))
  const metadata = useAppStore.getState().mountedSpaceSessions[f.key]!, prior = Object.values(metadata.members)[0]!
  const changed = await f.f.api.call('apply', { hostId: f.target.hostId, reference: f.target.reference, edit: { reference: f.target.reference, expectedRevision: f.snapshot.revision,
    changes: { zones: [{ ...f.snapshot.scope.zones[0]!, branch: 'updated-source-view' }] } } })
  await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[f.key]?.snapshot?.revision).toBe(changed.revision))
  expect(dom.container.querySelectorAll('[data-path-state="unconfirmed"]')).toHaveLength(1)
  await act(async () => { for (const emit of listeners) emit({ type: 'observation', observation: { type: 'membership-complete', reference: f.snapshot.reference, source: f.snapshot.source, revision: changed.revision } }) })
  await vi.waitFor(() => expect(dom.container.querySelectorAll('[data-path-state="cascade"]')).toHaveLength(1))
  const current = Object.values(useAppStore.getState().mountedSpaceSessions[f.key]!.members)[0]!
  expect(current.state).toBe(prior.state)
  expect(current.member).toBe(prior.member)
  expect(current.cut?.revision).toBe(changed.revision)
  const otherOwner = observeMountedSessions(f.target, metadata, { observation: { type: 'membership-complete', reference: f.snapshot.reference,
    source: { ...f.snapshot.source, ownerInstanceId: 'another-source-instance' }, revision: changed.revision } })
  expect(Object.values(otherOwner.members)[0]?.cut?.source).toEqual(prior.cut?.source)
})
