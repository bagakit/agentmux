import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { shallow } from 'zustand/shallow'
import type { SpaceSnapshot } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import { nativeSubagentRefreshDelay } from './agent-observation'
import type { AgentNameTarget, NameObservation } from '@agentmux/core/name-control'
import type { ConversationObservation, projectConversationWindow } from '@agentmux/core/conversation'
import type { ConversationReadApi } from '../../../shared/conversation-read'
import type { AppConfig, HostConfig, SessionSnapshot } from '../../../shared/contracts'
import type { SourceWorkbenchCloseDestination, SourceWorkbenchCloseMember } from '../../../shared/source-workbench-close'
import { sourcePositionKey, spaceMountKey, type SourceAgentLocation, type SourceAgentLocations, type SpaceMountMemberSurface, type SpaceMountMemberTarget, type SpaceMountRecord } from '../../../shared/space-mount'
import { api } from './api'
import { agentDisplayName, sourceRegionProjectionReference } from './workbench-tabs'
import { requestWorkbenchReferenceClose } from './workbench-close-request'
import { requestDesktopFocusWorkfaceReveal } from './desktop-presentation'
import { agentRegionLocationBindings, confirmedOriginalRawLocations, ordinaryAgentSpaceMember, useAppStore, type AppState } from '../store'
import { workbenchSelectionCatalog } from './desktop-focus-navigation'
import { workbenchNavigationTabs } from './workbench-navigation-catalog'
import { acceptsMountedSnapshot, mountedRegionKey, mountedSpaceInputs, mountedSpaceRegions, mountedSpaceTarget, type MountedSpaceObservation, type MountedSpaceRegion } from './space-mount-view'
import { mountedSessionFacts, type MountedSessionObservation } from './space-mount-sessions'
import { useSpaceSourceReader } from '../components/SpaceSourceReaders'
import { agentContextForSession, agentContextForConversation, focusRecordFacts, type FocusContext } from './focus-context'
import type { FocusContextAccess } from './focus-context-access'
import type { FocusNameEditor } from './focus-name-edit'
import { focusContextIdentityKey, type FocusContextIdentity, type FocusContextOccurrence, type FocusSourceObject } from './focus-context-identity'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { focusSourceContextId, focusSourceHistoryNames, focusSourceHostId, focusSourceKey, focusSourceWorkspace, matchingFocusContext, unobservedFocusContext } from './focus-source-model'
import { readSourceConversationRecap, sourceConversationPort } from './focus-source-conversation'
import { originalSpaceResource, originalSourceDisplayGroup, originalSourceGroupProjectionId, originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from './original-space-navigation'
import { originalLocationReaderKey, useFocusSourceLocations, type FocusSourceLocationObservation } from './focus-source-locations'

type Location = FocusContextAccess['locations'][number] & { member: MountedSpaceRegion; snapshot?: SpaceSnapshot; original?: SourceAgentLocation; sourceIssue?: string }
type Candidate = { key: string; runtimeId?: string; sid: string; locations: Location[]; target?: SpaceMountMemberTarget; authorityKey?: string; readingTarget?: import('../../../shared/space-mount').SpaceMountReadingTarget; directName?: { hostId: string; target: Pick<AgentNameTarget, 'runtimeId' | 'agentSessionId'>; changeTarget?: AgentNameTarget }; issue?: string }
function matchesLocation(location: Location, requested: FocusContextAccess['locations'][number]) {
  return JSON.stringify([location.source, location.tabId, location.regionId]) === JSON.stringify([requested.source, requested.tabId, requested.regionId]) &&
    (!requested.reference || JSON.stringify(location.reference) === JSON.stringify(requested.reference)) &&
    (!requested.originalPosition || Boolean(location.originalPosition && sourcePositionKey(location.originalPosition) === sourcePositionKey(requested.originalPosition)))
}
const sourceFactKey = (target: NonNullable<Candidate['readingTarget']>) => JSON.stringify([target.target.runtimeId, target.target.agentSessionId, target.target.reference.runtimeId, target.target.expectedAdmission])
const candidateFactKey = (candidate: Candidate) => candidate.readingTarget ? sourceFactKey(candidate.readingTarget) : candidate.directName ? JSON.stringify([candidate.runtimeId, candidate.sid, candidate.directName.target.runtimeId]) : candidate.target ? JSON.stringify([candidate.runtimeId, candidate.sid, candidate.target.target.reference, candidate.target.target.regionId]) : undefined
type SourceChoice = { locations: FocusContextAccess['locations']; choose(location: FocusContextAccess['locations'][number]): void }
export type FocusSourceIssue = { key: string; label: string; host: string; hostId: string; reference?: SpaceMountRecord['reference']; message: string; upgradeRuntimeId?: string; reading: boolean; refresh(): void }
type ReadFact = { key: string; session?: SessionSnapshot; name?: NameObservation;
  conversationPort?: ConversationReadApi; readConversation?: () => Promise<void>; reading?: ReturnType<typeof projectConversationWindow>;
  rename?: FocusNameEditor | undefined; nameSaveIssue?: string | undefined; sessionIssue?: string | undefined; nameIssue?: string | undefined; readingIssue?: string | undefined; readingCurrent?: () => boolean }

const NO_SOURCE_CONTEXTS: FocusContext[] = []
const NO_SOURCE_IDENTITIES = new Map<string, FocusContextIdentity>()

const OriginalLocationsReader = memo(function OriginalLocationsReader({ host, sessions, visible, revision, observation, mountedSourceKeys, publish }: {
  host: HostConfig; sessions: string[]; visible: boolean; revision: number; observation: SourceAgentLocations | undefined;
  mountedSourceKeys: ReadonlySet<string>; publish(observation: FocusSourceLocationObservation): void
}) {
  useFocusSourceLocations(host, sessions, visible, revision, observation, mountedSourceKeys, publish)
  return null
})

const SourceReader = memo(function SourceReader({ target, visible, revision }: { target: SpaceMountRecord; visible: boolean; revision: number }) {
  const refresh = useSpaceSourceReader(target, visible), previous = useRef(revision)
  useEffect(() => {
    if (previous.current === revision) return
    previous.current = revision
    refresh()
  }, [revision, refresh])
  return null
})

/** Native facts have their own Run generation; they never own durable labels or history. */
const SessionReader = memo(function SessionReader({ candidate, visible, publish, refresh }: { candidate: Candidate; visible: boolean; publish(key: string, fact: ReadFact, sameIdentityOnly?: boolean): void; refresh: number }) {
  const target = candidate.target, address = target && JSON.stringify([target, candidate.authorityKey]), key = candidateFactKey(candidate)
  useEffect(() => {
    if (!target || !key || !visible || !candidate.readingTarget) return
    const controller = new AbortController(); let surface: SpaceMountMemberSurface | undefined
    const emit = (fact: Partial<ReadFact>) => { if (!controller.signal.aborted) publish(candidate.key, { key, ...fact }) }
    void api.spaceMounts.member(target, event => {
      if (event.type === 'session') emit({ session: event.session, sessionIssue: undefined })
      else if (event.type === 'error' || event.type === 'observation-error') emit({ sessionIssue: event.error.message })
    }, controller.signal).then(async value => {
      if (controller.signal.aborted) { await value.dispose(); return }; surface = value
      try { emit({ session: await value.call('read', {}, controller.signal), sessionIssue: undefined }) }
      catch (cause) { emit({ sessionIssue: String(cause instanceof Error ? cause.message : cause) }) }
    }).catch(cause => emit({ sessionIssue: String(cause instanceof Error ? cause.message : cause) }))
    return () => { controller.abort(); void Promise.resolve(surface?.dispose()).catch(() => {}) }
  }, [address, key, visible, refresh, publish])
  return null
})

/** Names survive Run observation gaps; admitted members also retain bounded records. */
const MemberReader = memo(function MemberReader({ candidate, visible, publish, refresh }: { candidate: Candidate; visible: boolean; publish(key: string, fact: ReadFact, sameIdentityOnly?: boolean): void; refresh: number }) {
  const target = candidate.readingTarget ?? candidate.target
  const direct = candidate.readingTarget ? undefined : candidate.directName
  const address = JSON.stringify([target, direct]), key = candidateFactKey(candidate)
  useEffect(() => {
    if ((!target && !direct) || !key || !visible) return
    const controller = new AbortController(); let surface: import('../../../shared/space-mount').SpaceMountReadingSurface | undefined
    const emit = (fact: Partial<ReadFact>) => { if (!controller.signal.aborted) publish(candidate.key, { key: key!, ...fact }) }
    const member = candidate.readingTarget?.target
    const name = member && { object: 'agent' as const, target: { reference: member.reference, regionId: member.regionId, runtimeId: member.runtimeId, agentSessionId: member.agentSessionId, expectedAdmission: member.expectedAdmission } }
    // Name authority is independent of Native Session reads and the conversation reader.
    const readName = direct && !member ? (signal?: AbortSignal) => api.spaceMounts.call('agentNameInspect', { hostId: direct.hostId, expectedRuntimeId: direct.target.runtimeId, name: direct.target }, signal)
      : name ? (signal?: AbortSignal) => api.spaceMounts.call('memberNameInspect', { hostId: target!.hostId, reference: target!.target.reference, name }, signal) : undefined
    void readName?.(controller.signal).then(observed => {
      const rename: FocusNameEditor | undefined = (member ? member.expectedAdmission.kind === 'creation' : direct?.changeTarget) ? {
        inspect: async () => {
          const current = await readName!()
          publish(candidate.key, { key: key!, name: current, nameIssue: undefined }, true)
          return current.current
        },
        save: (value, expectedNameRevision) => changeName({ kind: 'rename', operationId: mintObjectId(), name: value, expectedNameRevision, source: 'manual' }),
        confirm: operationId => changeName({ kind: 'confirm', operationId }),
      } : undefined
      async function changeName(change: import('@agentmux/core/name-control').NameChange) {
        const result = direct?.changeTarget && !member ? await api.spaceMounts.call('agentNameChange', { hostId: direct.hostId, expectedRuntimeId: direct.target.runtimeId, name: { ...direct.changeTarget, change } })
          : await api.spaceMounts.call('memberNameChange', { hostId: target!.hostId, reference: target!.target.reference, name: { ...name!, change } })
        const { applied, current, record, save } = result
        const issue = save.issue ?? record.reason ?? null
        publish(candidate.key, {
          key: key!, name: { ...result, diskAcknowledgement: 'not-observed' }, nameIssue: undefined,
          ...(applied ? { nameSaveIssue: save.diskDurability !== 'confirmed' ? `The original name was applied; its save is unconfirmed (${change.operationId}). ${issue ?? ''}` : undefined } : {})
        }, true)
        return { operationId: change.operationId, applied, nameRevision: current.nameRevision, diskDurability: save.diskDurability, issue }
      }
      emit({ name: observed, rename, nameIssue: undefined })
    }).catch(cause => emit({ nameIssue: String(cause instanceof Error ? cause.message : cause) }))
    if (!target) return () => controller.abort()
    const observations = new Map<string, (event: ConversationObservation) => void>()
    const receive = (event: import('../../../shared/space-mount').SpaceMountMemberEvent) => {
      if (event.type === 'conversation') observations.get(event.readerId)?.(event.observation)
      else if (event.type === 'session' && !member) emit({ session: event.session, sessionIssue: undefined })
      else if (event.type === 'error' || event.type === 'observation-error') emit(member ? { readingIssue: event.error.message } : { sessionIssue: event.error.message })
    }
    const opening = candidate.readingTarget ? api.spaceMounts.reading(candidate.readingTarget, receive, controller.signal) : api.spaceMounts.member(candidate.target!, receive, controller.signal)
    void opening.then(async value => {
      if (controller.signal.aborted) { await value.dispose(); return }; surface = value
      const port = sourceConversationPort(value, candidate.sid, observations, controller.signal)
      let pending: Promise<void> | undefined, watched = false, epoch = 0, attemptedEpoch = -1
      const readConversation = (): Promise<void> => {
        if (!watched) {
          watched = true
          void port.observeConversation({ hostId: 'local', agentSessionId: candidate.sid }, event => {
            if (event.kind === 'unavailable') emit({ readingIssue: event.message ?? 'Conversation updates are unavailable.' })
            else { epoch++; void readConversation() }
          }, { signal: controller.signal }).then(() => { if (!controller.signal.aborted) { epoch++; void readConversation() } })
            .catch(cause => emit({ readingIssue: String(cause instanceof Error ? cause.message : cause) }))
        }
        if (pending) return pending
        if (attemptedEpoch === epoch) return Promise.resolve()
        const requested = epoch; attemptedEpoch = requested
        pending = readSourceConversationRecap(port, candidate.sid, controller.signal).then(reading => emit({ reading, readingIssue: undefined }))
          .catch(cause => emit({ readingIssue: String(cause instanceof Error ? cause.message : cause) }))
          .finally(() => { pending = undefined; if (!controller.signal.aborted && requested !== epoch) void readConversation() })
        return pending
      }
      emit({ conversationPort: port, readConversation, readingCurrent: () => !controller.signal.aborted })
      if (!member) {
        try { emit({ session: await (value as SpaceMountMemberSurface).call('read', {}, controller.signal), sessionIssue: undefined }) }
        catch (cause) { emit({ sessionIssue: String(cause instanceof Error ? cause.message : cause) }) }
      }
    }).catch(cause => emit({ readingIssue: String(cause instanceof Error ? cause.message : cause) }))
    return () => { controller.abort(); void Promise.resolve(surface?.dispose()).catch(() => {}) }
  }, [address, key, visible, refresh, publish])
  return null
})

function openSourceLocation(location: Location, surface: 'agents' | 'workbench', onSelectLocation?: (reference: WorkbenchProjectionSelection) => boolean | void) {
  if (location.reference) {
    const selected = onSelectLocation ? onSelectLocation(location.reference) : useAppStore.getState().selectMainRegion(location.reference)
    if (selected === false) return false
    if (surface === 'workbench') useAppStore.setState({ mainSurface: surface })
    else if (!onSelectLocation) {
      const choice = useAppStore.getState().workbenchSpaceSelection
      if (choice) requestDesktopFocusWorkfaceReveal(choice)
    }
    return true
  }
  const state = useAppStore.getState(), key = spaceMountKey(location.source.reference)
  const original = state.mountedSpaceObservations[key]?.snapshot ?? location.snapshot
  if (original?.scope.space) {
    const member = original.scope.regions.find(region => region.regionId === location.regionId && region.tabId === location.tabId)
    if (!member || member.agentSessionId !== location.member.region.agentSessionId) {
      state.reportError(Error('This original task position changed. Its task and other workfaces are retained; choose a current position.')); return false
    }
  }
  const displayWorkspaceId = location.originalPosition ? originalSourceWorkspaceId(location.source) : location.source.workspaceId
  const groupId = location.originalPosition ? originalSourceDisplayGroup(location.originalPosition) : undefined
  if (groupId && !state.layouts[displayWorkspaceId]?.groups.some(group => group.id === originalSourceGroupProjectionId(location.source, groupId))) {
    state.reportError(Error('The confirmed Source Group cannot yet be displayed. Its original workface is retained.'))
    return false
  }
  state.openOriginalSpaceLocation({ target: location.source, resource: originalSpaceResource(state, location.source),
    occurrence: { tabId: location.tabId, regionId: location.regionId, displayWorkspaceId, ...(groupId ? { groupId } : {}) } }, surface === 'workbench')
  useAppStore.setState({ mainSurface: surface })
  if (surface === 'agents') {
    const choice = useAppStore.getState().workbenchSpaceSelection
    if (choice) requestDesktopFocusWorkfaceReveal(choice)
  }
  return true
}

async function readDiscoveredWorkface(location: Location, runtimeId: string | undefined, sid: string): Promise<SpaceSnapshot> {
  const { source } = location
  const position = location.originalPosition
  if (!position || !runtimeId) throw Error('The original Agent display position is unconfirmed. Its Session is retained.')
  const witness = await api.spaceMounts.call('agentLocations', { hostId: source.hostId, agentSessionIds: [sid], expectedRuntimeId: runtimeId, position })
  if (witness.runtimeId !== runtimeId || !witness.locations.some(entry => entry.position && sourcePositionKey(entry.position) === sourcePositionKey(position)))
    throw Error('The original Agent display position changed. Its Session and current workface are retained.')
  const snapshot = await api.spaceMounts.call('snapshot', { hostId: source.hostId, reference: source.reference })
  const member = snapshot.scope.regions.find(region => region.tabId === location.tabId && region.regionId === location.regionId)
  const tab = snapshot.scope.tabs.find(tab => tab.tabId === location.tabId)
  if (!acceptsMountedSnapshot(source, snapshot) || !snapshot.scope.space || member?.kind !== 'agent' || member.agentSessionId !== sid ||
      member.execution?.hostId !== 'local' || member.execution.runtimeId !== undefined && member.execution.runtimeId !== runtimeId ||
      tab?.zoneId !== source.zoneId || tab.workspaceId !== source.workspaceId || !tab.regionIds.includes(location.regionId) ||
      !snapshot.scope.bindings.some(binding => binding.spaceId === source.reference.spaceId && binding.zoneId === source.zoneId)) {
    throw Error('The original Agent position changed. Its Session and current workface are retained.')
  }
  return snapshot
}

type OrdinaryLocation = { source: SpaceMountRecord; presentation: MountedSpaceRegion; reference: WorkbenchProjectionSelection }
const NO_ORDINARY_LOCATIONS: OrdinaryLocation[] = []

function appendCandidate(candidate: Candidate, contribution: Candidate) {
  for (const location of contribution.locations) candidate.locations.push(location)
  if (!candidate.target && contribution.target) candidate.target = contribution.target
  if (!candidate.readingTarget && contribution.readingTarget) candidate.readingTarget = contribution.readingTarget
  if (!candidate.directName && contribution.directName) candidate.directName = contribution.directName
  if (contribution.authorityKey !== undefined) candidate.authorityKey = contribution.authorityKey
  if (contribution.issue !== undefined) candidate.issue = contribution.issue
}

function snapshotCandidates(target: SpaceMountRecord, observation: MountedSpaceObservation | undefined,
  metadata: MountedSessionObservation | undefined, ordinary: readonly OrdinaryLocation[]) {
  const result = new Map<string, Candidate>()
  const snapshot = observation?.snapshot?.scope.space === null
    ? observation.lastPresentSnapshot ?? observation.snapshot : observation?.snapshot
  if (!snapshot) return result
  const referenceKey = (tabId: string, regionId: string) => JSON.stringify([tabId, regionId])
  const references = new Map<string, WorkbenchProjectionSelection[]>()
  for (const location of ordinary) {
    const key = referenceKey(location.reference.tabId, location.reference.regionId), previous = references.get(key) ?? []
    previous.push(location.reference); references.set(key, previous)
  }
  const sessionFacts = mountedSessionFacts(snapshot, metadata)
  for (const member of mountedSpaceRegions(snapshot)) {
    const sid = member.region.agentSessionId
    // A Source can retain Region facts for execution recovery after the Tab's current member changed.
    if (!sid || !member.tab.regionIds.includes(member.region.regionId)) continue
    const fact = sessionFacts.get(member.key), current = fact?.current?.state
    const observed = current?.status === 'observed' ? current : fact?.last?.state.status === 'observed' ? fact.last.state : undefined
    // Source-local is explicitly defined by the original Core member contract.
    const runtimeId = member.region.execution?.runtimeId ?? fact?.current?.member.runtimeId ??
      (member.region.execution?.hostId === 'local' ? snapshot.reference.runtimeId : undefined)
    const identity = runtimeId ? focusSourceKey(runtimeId, sid) : JSON.stringify(['unconfirmed-region', snapshot.reference, member.region.regionId])
    const located = references.get(referenceKey(member.tab.tabId, member.region.regionId)) ?? []
    const locations: Location[] = (located.length ? located : [undefined]).map(reference => ({ source: target,
      tabId: member.tab.tabId, regionId: member.region.regionId, member, snapshot, ...(reference ? { reference } : {}) }))
    const contribution: Candidate = { key: identity, ...(runtimeId ? { runtimeId } : {}), sid, locations }
    const admission = member.region.association ? { kind: 'association' as const, operationId: member.region.association.operationId }
      : member.region.creationOperationId ? { kind: 'creation' as const, operationId: member.region.creationOperationId } : undefined
    if (runtimeId && admission) contribution.readingTarget = { hostId: target.hostId, target: {
      kind: 'conversation', reference: target.reference, regionId: member.region.regionId, runtimeId, agentSessionId: sid, expectedAdmission: admission } }

    if (runtimeId && observed?.authority.runtimeId === runtimeId && observed.session.agentSessionId === sid)
      contribution.target = { hostId: target.hostId, target: { reference: target.reference, regionId: member.region.regionId,
        runtimeId, agentSessionId: sid, expectedRun: observed.session.run,
        ...(member.region.creationOperationId ? { expectedAdmission: { kind: 'creation', operationId: member.region.creationOperationId } } : {}) } }
    if (runtimeId === target.reference.runtimeId) {
      const createOperationId = observed?.authority.runtimeId === runtimeId && observed.session.agentSessionId === sid ? observed.session.creation?.createOperationId : undefined
      contribution.directName = { hostId: target.hostId, target: { runtimeId, agentSessionId: sid },
        ...(createOperationId ? { changeTarget: { runtimeId, agentSessionId: sid, createOperationId } } : {}) }
    }
    if (observed) contribution.authorityKey = observed.authority.ownerInstanceId
    const issue = observation?.error ?? metadata?.error ?? (current?.status === 'unavailable' || current?.status === 'unknown' ? current.issue.message : undefined)
    if (issue) contribution.issue = issue
    const original = result.get(identity)
    if (original) appendCandidate(original, contribution)
    else result.set(identity, contribution)
  }
  return result
}

function ordinaryCandidate(location: OrdinaryLocation, observation: MountedSpaceObservation | undefined): Candidate | undefined {
  const member = location.presentation, sid = member.region.agentSessionId, runtimeId = member.region.execution?.runtimeId
  if (observation?.snapshot || !sid || !runtimeId) return undefined
  return {
    key: focusSourceKey(runtimeId, sid), runtimeId, sid,
    locations: [{ source: location.source, tabId: location.reference.tabId, regionId: location.reference.regionId, member, reference: location.reference }],
    ...(runtimeId === location.source.reference.runtimeId ? { directName: { hostId: location.source.hostId, target: { runtimeId, agentSessionId: sid } } } : {}),
    ...(observation?.error ? { issue: observation.error } : {})
  }
}

function discoveredLocations(base: ReadonlyMap<string, Candidate>, sources: ReadonlyMap<string, FocusSourceLocationObservation>, demands: ReadonlyMap<string, string[]>) {
  const result = new Map(base)
  for (const [hostId, observed] of sources) {
    if (!observed.value) continue
    const { runtimeId, locations } = observed.value, wanted = new Set(demands.get(hostId))
    for (const original of locations) {
      const { space, zone, tab, region } = original, sid = region.agentSessionId
      if (!sid || !wanted.has(sid)) continue
      const key = focusSourceKey(runtimeId, sid), before = result.get(key)
      const reference = { runtimeId, spaceId: space.spaceId }
      const source = { hostId, reference, zoneId: zone.zoneId, workspaceId: zone.workspaceId }
      const sameMember = (location: Location) => location.source.reference.spaceId === space.spaceId && location.source.reference.runtimeId === runtimeId &&
        location.tabId === tab.tabId && location.regionId === region.regionId
      const position = original.position
      if (before?.locations.some(location => sameMember(location) && location.original &&
        (position && location.originalPosition ? sourcePositionKey(location.originalPosition) === sourcePositionKey(position) : !position && !location.originalPosition))) continue
      const mounted = before?.locations.find(sameMember)
      const kept = before?.locations.filter(location => !sameMember(location) || location.reference || location.original) ?? []
      const location: Location = { source, tabId: tab.tabId, regionId: region.regionId, original,
        ...(position ? { originalPosition: position } : {}), ...(mounted?.snapshot ? { snapshot: mounted.snapshot } : {}),
        ...(observed.issue ? { sourceIssue: observed.issue.message } : {}), member: { key: mountedRegionKey(reference, tab.tabId, region.regionId), reference, tab, zone, region } }
      result.set(key, { ...(before ?? { key, runtimeId, sid }), locations: [...kept, location] })
    }
  }
  return result
}

type SourceCandidates = {
  target: SpaceMountRecord; observation: MountedSpaceObservation | undefined; metadata: MountedSessionObservation | undefined;
  ordinary: readonly OrdinaryLocation[]; snapshots: Map<string, Candidate>; fallbacks: Map<OrdinaryLocation, Candidate>
}

/** Source-local candidates are reusable contributions to the existing global ordering. */
function useSourceCandidates(sources: ReadonlyMap<string, SpaceMountRecord>, observations: AppState['mountedSpaceObservations'],
  metadata: AppState['mountedSpaceSessions'], ordinaryLocations: readonly OrdinaryLocation[]) {
  const previousSources = useRef(new Map<string, SourceCandidates>())
  const previousShared = useRef(new Map<string, { contributions: Candidate[]; candidate: Candidate }>())
  const ordinaryBySource = useMemo(() => {
    const grouped = new Map<string, OrdinaryLocation[]>()
    for (const location of ordinaryLocations) {
      const key = spaceMountKey(location.source.reference), locations = grouped.get(key) ?? []
      locations.push(location); grouped.set(key, locations)
    }
    return grouped
  }, [ordinaryLocations])
  return useMemo(() => {
    const sourceCandidates = new Map<string, SourceCandidates>(), result = new Map<string, Candidate>()
    const shared = new Map<string, Candidate[]>()
    const add = (candidate: Candidate) => {
      const existing = result.get(candidate.key)
      if (!existing) result.set(candidate.key, candidate)
      else {
        const contributions = shared.get(candidate.key) ?? [existing]
        contributions.push(candidate); shared.set(candidate.key, contributions)
      }
    }
    for (const [key, target] of sources) {
      const observation = observations[key], sessions = metadata[key], ordinary = ordinaryBySource.get(key) ?? NO_ORDINARY_LOCATIONS
      let entry = previousSources.current.get(key)
      if (!(entry && entry.target.hostId === target.hostId && entry.target.workspaceId === target.workspaceId && entry.target.zoneId === target.zoneId &&
        entry.observation === observation && entry.metadata === sessions && shallow(entry.ordinary, ordinary))) {
        const snapshots = snapshotCandidates(target, observation, sessions, ordinary)
        const fallbacks = new Map<OrdinaryLocation, Candidate>()
        for (const location of ordinary) {
          const candidate = ordinaryCandidate(location, observation)
          if (candidate) fallbacks.set(location, candidate)
        }
        entry = { target, observation, metadata: sessions, ordinary, snapshots, fallbacks }
      }
      sourceCandidates.set(key, entry)
      for (const candidate of entry.snapshots.values()) add(candidate)
    }
    // Ordinary fallbacks come after snapshots in original display order, including interleaved Sources.
    for (const location of ordinaryLocations) {
      const candidate = sourceCandidates.get(spaceMountKey(location.source.reference))?.fallbacks.get(location)
      if (candidate) add(candidate)
    }
    const nextShared = new Map<string, { contributions: Candidate[]; candidate: Candidate }>()
    for (const [key, contributions] of shared) {
      const previous = previousShared.current.get(key)
      if (previous && shallow(previous.contributions, contributions)) {
        nextShared.set(key, previous)
        result.set(key, previous.candidate)
      } else {
        const merged = { ...contributions[0]!, locations: [] }
        for (const contribution of contributions) appendCandidate(merged, contribution)
        nextShared.set(key, { contributions, candidate: merged })
        result.set(key, merged)
      }
    }
    previousSources.current = sourceCandidates
    previousShared.current = nextShared
    return result
  }, [sources, observations, metadata, ordinaryBySource, ordinaryLocations])
}

type SourceActions = {
  onSelectLocation?: ((reference: WorkbenchProjectionSelection) => boolean | void) | undefined
  onChooseLocation?: ((choice: SourceChoice) => void) | undefined
  onFocusContext?: ((context: FocusContext) => void) | undefined
  onCloseOriginal(input: { destination: SourceWorkbenchCloseDestination; member: SourceWorkbenchCloseMember; onlyMember: true }, subject: string): void
}
type CandidateActions = SourceActions & { navigation: { current: number } }
type CandidateRow = { key: string; identity: FocusContextIdentity; context?: FocusContext; alias?: FocusContextAccess }
type CandidatePresentation = {
  candidate: Candidate; fact: ReadFact | undefined; current: ReadFact | undefined; readingCurrent: boolean | undefined; historyName: string | undefined
  matchingRows: readonly FocusContext[] | undefined; ordinary: FocusContext | undefined
  validUntil: number; row: CandidateRow
}
type SourcePresentations = {
  rows: Map<string, CandidatePresentation>; config: AppConfig | null; runtimes: ReadonlyMap<string, string>
  layouts: AppState['layouts']; actions: CandidateActions
}

function sameCandidateLayouts(candidate: Candidate, previous: AppState['layouts'], current: AppState['layouts']) {
  return previous === current || candidate.locations.every(location => {
    if (location.reference) return true
    const workspace = originalSourceWorkspaceId(location.source)
    return previous[workspace] === current[workspace]
  })
}

function sourceSessionRefreshDelay(session: SessionSnapshot | undefined, now: number) {
  if (session?.kind !== 'agent') return Infinity
  const semantic = session.semanticStatus ? msUntilSemanticStatusStale(session.semanticStatus, now) : 0
  return Math.min(semantic || Infinity, nativeSubagentRefreshDelay(session, now) || Infinity)
}

function projectSourceCandidate(candidate: Candidate, ordinary: FocusContext | undefined, current: ReadFact | undefined,
  readingCurrent: boolean | undefined, historyName: string | undefined, config: AppConfig | null, runtimes: ReadonlyMap<string, string>, layouts: AppState['layouts'],
  { onSelectLocation, onChooseLocation, onFocusContext, onCloseOriginal, navigation }: CandidateActions, refresh: (key: string) => void): CandidateRow {
  const first = candidate.locations[0]!
  let focusedContext: FocusContext | undefined
  const navigate = (surface: 'agents' | 'workbench' | 'close', requested?: FocusContextAccess['locations'][number]) => {
    const attempt = ++navigation.current
    const rawLocations = (location: Location) => {
      const state = useAppStore.getState(), target = mountedSpaceTarget(state.mountedSpaceInputs, spaceMountKey(location.source.reference))
      if (!target || target.hostId !== location.source.hostId || target.zoneId !== location.source.zoneId || target.workspaceId !== location.source.workspaceId) return []
      return confirmedOriginalRawLocations(state, target).filter(reference => {
        const region = state.tabs[reference.tabId]?.regions[reference.regionId]
        return reference.tabId === location.tabId && reference.regionId === location.regionId && region?.kind === 'agent' && region.sessionId === candidate.sid
      })
    }
    // Resolve a local display occurrence when available, otherwise ask the original owner.
    const availableLocations = candidate.locations.filter(location => !location.original || location.originalPosition)
    const locations = surface !== 'close' ? availableLocations : availableLocations.flatMap(location => {
      if (location.reference) return [location]
      const state = useAppStore.getState()
      const positions = [...rawLocations(location), ...workbenchSelectionCatalog(state).locations.filter(reference => {
        const source = sourceRegionProjectionReference(state.tabs[reference.tabId]?.regions[reference.regionId])
        return source && spaceMountKey(source.reference) === spaceMountKey(location.source.reference) &&
          source.tabId === location.tabId && source.regionId === location.regionId && source.agentSessionId === candidate.sid
      })]
      return positions.length ? positions.map(reference => ({ ...location, reference: { displayWorkspaceId: reference.displayWorkspaceId,
        groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId } })) : [location]
    })
    const choose = (request: FocusContextAccess['locations'][number]) => {
      const matches = locations.filter(location => matchesLocation(location, request))
      const location = matches.length === 1 ? matches[0] : undefined
      if (location) {
        if (surface === 'close') {
          const state = useAppStore.getState(), reference = location.reference
          if (!reference) {
            onCloseOriginal({ destination: { hostId: location.source.hostId, reference: location.source.reference }, onlyMember: true,
              member: { tabId: location.tabId, regionId: location.regionId, kind: 'agent', agentSessionId: candidate.sid,
                scope: location.member.tab.regionIds.length === 1 ? 'tab' : 'region' } }, focusedContext?.name ?? 'Agent workface')
            return
          }
          const current = state.tabs[reference.tabId]?.regions[reference.regionId], source = sourceRegionProjectionReference(current)
          const member = !source && reference && current?.kind === 'agent' ? ordinaryAgentSpaceMember({ tabId: reference.tabId, regionId: reference.regionId, sessionId: current.sessionId }) : undefined
          const original = source ? spaceMountKey(source.reference) === spaceMountKey(location.source.reference) &&
            source.tabId === location.tabId && source.regionId === location.regionId && source.agentSessionId === candidate.sid
            : (member?.kind === 'foreign' && member.source.hostId === location.source.hostId &&
              member.source.zoneId === location.source.zoneId && member.source.workspaceId === location.source.workspaceId &&
              spaceMountKey(member.source.reference) === spaceMountKey(location.source.reference) &&
              member.presentation.tab.tabId === location.tabId && member.presentation.region.regionId === location.regionId &&
              member.metadataMember.runtimeId === candidate.runtimeId && member.metadataMember.agentSessionId === candidate.sid ||
              reference && rawLocations(location).some(position => position.displayWorkspaceId === reference.displayWorkspaceId &&
              position.groupId === reference.groupId && position.tabId === reference.tabId && position.regionId === reference.regionId))
          if (!original) {
            state.reportError(Error('This original workface position is unconfirmed or changed. Its Agent and inputs are retained; choose its current exact position before closing.'))
            return
          }
          requestWorkbenchReferenceClose(reference, { keepAgentSessions: true })
          return
        }
        const open = () => {
          const selected = openSourceLocation(location, surface, onSelectLocation)
          if (selected && surface === 'agents' && !location.reference && focusedContext) onFocusContext?.(focusedContext)
        }
        if (!location.original) { open(); return }
        const before = useAppStore.getState()
        const isCurrent = () => {
          const state = useAppStore.getState()
          return navigation.current === attempt && state.mainSurface === before.mainSurface && state.focusView === before.focusView && state.agentFocus === before.agentFocus &&
            state.activeWorkspaceId === before.activeWorkspaceId && state.workbenchSpaceSelection === before.workbenchSpaceSelection &&
            state.config?.hosts.find(host => host.id === location.source.hostId) === before.config?.hosts.find(host => host.id === location.source.hostId)
        }
        void readDiscoveredWorkface(location, candidate.runtimeId, candidate.sid).then(snapshot => {
          if (!isCurrent()) return
          useAppStore.getState().observeSpaceMount(location.source, { snapshot, reading: false, error: undefined }, location.originalPosition)
          open()
        }).catch(cause => { if (isCurrent()) {
          useAppStore.getState().reportError(cause instanceof Error ? cause : Error(String(cause)))
          refresh(originalLocationReaderKey(location.source.hostId))
        } })
      }
      else useAppStore.getState().reportError(Error('This position belongs to another original task. The current task and workface are retained.'))
    }
    const choices = requested ? locations.filter(location => matchesLocation(location, requested)) : locations
    if (choices.length === 1) choose(choices[0]!)
    else if (choices.length && onChooseLocation) onChooseLocation({ locations: choices, choose })
    else useAppStore.getState().reportError(Error(choices.length ? 'This task has several original positions. Choose an exact position before opening it.' : 'The requested original position is unconfirmed. Its Agent and workface are retained.'))
  }
  const refreshCandidate = () => {
    refresh(candidate.key)
    for (const sourceKey of new Set(candidate.locations.map(location => spaceMountKey(location.source.reference)))) refresh(sourceKey)
    for (const hostId of new Set(candidate.locations.filter(location => location.original).map(location => location.source.hostId))) refresh(originalLocationReaderKey(hostId))
  }
  const locations = candidate.locations.map(location => ({
    location, resource: focusSourceWorkspace(location.source, location.member, location.snapshot, config, runtimes, location.original?.space)
  }))
  const workspace = locations[0]?.resource
  const resources = [...new Map(locations.flatMap(({ resource }) =>
    resource ? [[JSON.stringify([resource.hostId, resource.id, resource.path]), resource] as const] : [])).values()]
  const occurrences: FocusContextOccurrence[] = locations.flatMap(({ location, resource }) => {
    const member = location.member
    const displayWorkspaceId = location.reference?.displayWorkspaceId ?? originalSourceWorkspaceId(location.source)
    const displayTabId = location.reference?.tabId ?? originalSourceTabProjectionId(location.source, location.tabId)
    const displayRegionId = location.reference?.regionId ?? originalSourceRegionProjectionId(location.source, location.regionId)
    const group = location.reference?.groupId ?? layouts[displayWorkspaceId]?.groups.find(group => group.tabOrder.includes(displayTabId))?.id
    if (!group) return []
    return [{ source: { spaceId: location.source.reference.spaceId, zoneId: member.tab.zoneId, workspaceId: member.tab.workspaceId,
      hostId: resource?.hostId ?? null, ...(resource ? { resource } : {}) },
      display: { workspaceId: displayWorkspaceId, hostId: resource?.hostId ?? null,
        groupId: group, tabId: displayTabId, regionId: displayRegionId } }]
  })
  const objects = new Map<string, FocusSourceObject>()
  for (const { location } of locations) {
    const source = location.source, space = location.snapshot?.scope.space ?? location.original?.space
    if (!space || (space.kind !== 'mote' && space.kind !== 'topic')) continue
    const id = JSON.stringify([source.reference.runtimeId, space.spaceId])
    objects.set(id, { id, kind: space.kind, name: space.name, hostId: source.hostId, workspaceId: source.workspaceId,
      path: space.directoryPath, topicId: space.topicId ?? space.spaceId })
  }
  const sourceIssue = candidate.locations.find(location => location.sourceIssue)?.sourceIssue
  const identity: FocusContextIdentity = { tabs: [], occurrenceCount: candidate.locations.length,
    ...(resources.length ? { resources } : {}),
    ...(objects.size ? { objects: [...objects.values()] } : {}),
    ...(sourceIssue ? { sourceIssue } : {}),
    locations: { status: occurrences.length === candidate.locations.length ? 'confirmed' : 'unconfirmed', occurrences } }
  const actions = { open: (location?: FocusContextAccess['locations'][number]) => navigate('workbench', location),
    select: (location?: FocusContextAccess['locations'][number]) => navigate('agents', location), refresh: refreshCandidate,
    close: (location?: FocusContextAccess['locations'][number]) => navigate('close', location) }
  if (ordinary) {
    focusedContext = ordinary
    const positions = candidate.locations.filter(location => !location.original || location.originalPosition)
    return { key: focusContextIdentityKey(ordinary.hostId, ordinary.id), identity,
      ...(positions.length ? { alias: { identity: { runtimeId: candidate.runtimeId ?? null, agentSessionId: candidate.sid }, locations: positions, ...actions } } : {}) }
  }
  const issue = [current?.sessionIssue, current?.nameIssue, current?.nameSaveIssue, current?.readingIssue, candidate.issue].filter(Boolean).join(' · ') || undefined
  const session = !current?.sessionIssue && candidate.target && current?.session?.kind === 'agent' && current.session.control.run.runId === candidate.target.target.expectedRun.runId ? current.session : undefined
  // The observed Session branch already derives the conversation facts once.
  const reading = !session && current?.reading ? focusRecordFacts(current.reading.records) : undefined
  // A current name reply, including an explicit clear, supersedes visit-time display facts.
  const userName = current?.name ? current.name.current.override ?? undefined : historyName
  const originalHosts = candidate.locations.map(location => location.member.region.execution?.hostId
    ? JSON.stringify([location.source.reference.runtimeId, location.member.region.execution.hostId]) : null)
  const executionHostId = originalHosts.every(Boolean) && new Set(originalHosts).size === 1 ? first.member.region.execution?.hostId : undefined
  const confirmedRoutes = new Set<string>()
  if (candidate.runtimeId) {
    for (const location of candidate.locations) {
      if (location.source.reference.runtimeId === candidate.runtimeId && location.member.region.execution?.hostId === 'local') {
        confirmedRoutes.add(location.source.hostId)
      }
    }
    for (const [hostId, runtimeId] of runtimes) if (runtimeId === candidate.runtimeId) confirmedRoutes.add(hostId)
    // A retained Source snapshot cannot report the connection of a replacement Runtime.
    for (const hostId of confirmedRoutes) {
      const host = config?.hosts.find(item => item.id === hostId)
      const observedRuntime = runtimes.get(hostId)
      const boundRuntime = host?.kind === 'ssh' ? host.runtimeId : undefined
      if (!host || (observedRuntime && observedRuntime !== candidate.runtimeId) || (boundRuntime && boundRuntime !== candidate.runtimeId)) {
        confirmedRoutes.delete(hostId)
      }
    }
  }
  const executionRouteHostId = confirmedRoutes.size === 1 ? confirmedRoutes.values().next().value : undefined
  const access: FocusContextAccess = { identity: { runtimeId: candidate.runtimeId ?? null, agentSessionId: candidate.sid },
    locations: candidate.locations, ...(session ? { session } : {}),
    ...(current?.session ? { retainedSession: current.session } : {}),
    observation: session ? 'current' : current?.session?.kind === 'agent' && candidate.target &&
      current.session.control.run.runId !== candidate.target.target.expectedRun.runId ? 'changed' : candidate.target ? 'unavailable' : 'unconfirmed',
    ...(executionHostId ? { executionHostId } : {}),
    ...(executionRouteHostId ? { executionRouteHostId } : {}),
    ...(current?.name ? { nameRevision: current.name.current.nameRevision } : {}),
    ...(current?.rename ? { rename: current.rename } : {}),
    isCurrent: () => Boolean(session && candidate.target && session.control.run.runId === candidate.target.target.expectedRun.runId),
    ...(readingCurrent && current?.conversationPort ? { conversationPort: current.conversationPort, conversationReference: { hostId: 'local', agentSessionId: candidate.sid }, ...(current.readConversation ? { readConversation: current.readConversation } : {}) } : {}),
    ...(issue ? { issue } : {}), ...actions }
  let context = session ? current?.reading
    ? agentContextForConversation(session, current.reading.records, userName, workspace, null)
    : agentContextForSession(session, undefined, userName, workspace, null)
    : { ...unobservedFocusContext(candidate.runtimeId ?? '', candidate.sid, workspace,
      agentDisplayName({ userName, firstPrompt: reading?.firstPrompt,
        fallbackLabel: current?.session?.label ?? `Agent · ${candidate.sid}`, providerLabel: current?.session?.kind === 'agent' ? current.session.providerId : 'Agent' }), access.issue, access),
      ...(current?.session?.kind === 'agent' ? { providerId: current.session.providerId, executorId: current.session.executorId } : {}), recap: reading?.recap ?? null }
  const { control: _control, ...readOnly } = context
  context = { ...readOnly, id: candidate.runtimeId ? focusSourceContextId(candidate.runtimeId, candidate.sid) : candidate.key,
    hostId: focusSourceHostId(candidate.runtimeId ?? candidate.key), access, recap: context.recap ?? null }
  if (access.issue) context = { ...context,
    detail: current?.session && context.detail !== access.issue ? `${context.detail} · Observation: ${access.issue}` : context.detail,
    detailKind: context.bucket === 'attention' ? 'service' : 'observation', detailIsRecap: false }
  focusedContext = context
  return { key: focusContextIdentityKey(context.hostId, context.id), context, identity }
}

/** Joins source-qualified facts to the common Context pipeline; it owns no task UI. */
export function useFocusSources({ visible, contexts, onSelectLocation, onChooseLocation, onFocusContext, onCloseOriginal }: { visible: boolean; contexts: readonly FocusContext[] } & SourceActions) {
  const navigation = useRef(0)
  useEffect(() => () => { ++navigation.current }, [visible])
  const actions = useMemo(() => ({ onSelectLocation, onChooseLocation, onFocusContext, onCloseOriginal, navigation }),
    [onSelectLocation, onChooseLocation, onFocusContext, onCloseOriginal])
  const inputs = useAppStore(state => state.mountedSpaceInputs), observations = useAppStore(state => state.mountedSpaceObservations)
  const metadata = useAppStore(state => state.mountedSpaceSessions), config = useAppStore(state => state.config)
  const history = useAppStore(state => state.agentFocus.execution.history)
  const historyNames = useMemo(() => focusSourceHistoryNames(history), [history])
  const catalog = useAppStore(workbenchSelectionCatalog), navigationTabs = useAppStore(state => workbenchNavigationTabs(state.tabs)), layouts = useAppStore(state => state.layouts), bindings = useAppStore(agentRegionLocationBindings)
  // Source consumers need original Agent/projected positions, not an unrelated
  // file's name/path or Browser page state. Keep the current relevant projection.
  const previousTabs = useRef<Readonly<typeof navigationTabs>>({})
  const tabs = useMemo(() => {
    const next = Object.fromEntries(Object.entries(navigationTabs).filter(([, tab]) => tab.source ||
      Object.values(tab.regions).some(region => region.kind === 'agent' || sourceRegionProjectionReference(region))))
    if (!shallow(previousTabs.current, next)) previousTabs.current = next
    return previousTabs.current
  }, [navigationTabs])
  const previousLocations = useRef<typeof catalog.locations>([])
  const sourceLocations = useMemo(() => {
    const next = catalog.locations.filter(location => tabs[location.tabId])
    if (previousLocations.current.length !== next.length || next.some((location, index) => !shallow(location, previousLocations.current[index]))) previousLocations.current = next
    return previousLocations.current
  }, [catalog, tabs])
  const [facts, setFacts] = useState(new Map<string, ReadFact>())
  const [witnesses, setWitnesses] = useState(new Map<string, { runtimeId: string; host: HostConfig | undefined }>())
  const [locationReads, setLocationReads] = useState(new Map<string, FocusSourceLocationObservation>())
  const publishLocations = useCallback((next: FocusSourceLocationObservation) => setLocationReads(previous => {
    const before = previous.get(next.host.id)
    const value = next.value ?? (before?.host === next.host ? before.value : undefined)
    const issue = next.issue ?? (next.reading && before?.host === next.host ? before.issue : undefined)
    return new Map(previous).set(next.host.id, { ...next, ...(value ? { value } : {}), ...(issue ? { issue } : {}) })
  }), [])
  const originalLocations = useMemo(() => new Map([...locationReads].filter(([hostId, observed]) =>
    config?.hosts.find(host => host.id === hostId) === observed.host)), [locationReads, config?.hosts])
  const runtimes = useMemo(() => {
    const result = new Map([...witnesses].flatMap(([hostId, witness]) =>
      config?.hosts.find(host => host.id === hostId) === witness.host ? [[hostId, witness.runtimeId] as const] : []))
    for (const [hostId, observed] of originalLocations) if (observed.value) result.set(hostId, observed.value.runtimeId)
    return result
  }, [witnesses, config?.hosts, originalLocations])
  const [refreshes, setRefreshes] = useState(new Map<string, number>()), [clock, setClock] = useState(Date.now)
  const ordinaryContexts = useMemo(() => {
    const result = new Map<string, FocusContext[]>()
    for (const context of contexts) {
      const sid = context.control?.agentSessionId ?? context.id, members = result.get(sid) ?? []
      members.push(context); result.set(sid, members)
    }
    return result
  }, [contexts])
  const requestedLocations = useMemo(() => {
    const ssh = new Set(config?.hosts.filter(host => host.kind === 'ssh').map(host => host.id))
    const wanted = new Map<string, Set<string>>()
    for (const context of contexts) {
      const control = context.control
      if (!control || !ssh.has(control.hostId)) continue
      const members = wanted.get(control.hostId) ?? new Set<string>()
      members.add(control.agentSessionId)
      wanted.set(control.hostId, members)
    }
    return JSON.stringify([...wanted].map(([host, ids]) => [host, [...ids].sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))))
  }, [config?.hosts, contexts])
  const locationDemands = useMemo(() => new Map<string, string[]>(JSON.parse(requestedLocations)), [requestedLocations])
  const resourceHosts = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const resource of config?.workspaces ?? []) {
      const key = JSON.stringify([resource.id, resource.path]), hosts = result.get(key) ?? []
      hosts.push(resource.hostId); result.set(key, hosts)
    }
    return result
  }, [config?.workspaces])
  const publish = useCallback((key: string, fact: ReadFact, sameIdentityOnly = false) => setFacts(previous => {
    const prior = previous.get(key), same = prior?.key === fact.key
    if (sameIdentityOnly && !same) return previous
    const next = same ? { ...prior, ...fact } : fact
    if (same && prior.name && fact.name && prior.name.current.nameRevision > fact.name.current.nameRevision) next.name = prior.name
    return new Map(previous).set(key, next)
  }), [])
  const refresh = useCallback((key: string) => setRefreshes(previous => new Map(previous).set(key, (previous.get(key) ?? 0) + 1)), [])
  const previousOrdinaryLocations = useRef(new Map<string, OrdinaryLocation>())
  const ordinaryLocations = useMemo(() => {
    const result: OrdinaryLocation[] = []
    const current = new Map<string, OrdinaryLocation>()
    for (const location of sourceLocations) {
      const surface = tabs[location.tabId]?.regions[location.regionId]
      if (surface?.kind !== 'agent') continue
      const member = ordinaryAgentSpaceMember({ tabId: location.tabId, regionId: location.regionId, sessionId: surface.sessionId })
      if (member.kind !== 'foreign') continue
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      const key = JSON.stringify(reference), previous = previousOrdinaryLocations.current.get(key)
      const position = previous?.source === member.source && previous.presentation === member.presentation ? previous
        : { source: member.source, presentation: member.presentation, reference }
      result.push(position)
      current.set(key, position)
    }
    previousOrdinaryLocations.current = current
    return result
  }, [sourceLocations, tabs, bindings])
  const sources = useMemo(() => {
    const result = new Map<string, SpaceMountRecord>()
    try { for (const key of Object.keys(mountedSpaceInputs(inputs))) {
      try { const target = mountedSpaceTarget(inputs, key); if (target) result.set(spaceMountKey(target.reference), target) } catch { /* Original input owner retains/reports unreadable fragments. */ }
    } } catch { /* Other readable Sources and ordinary Contexts remain available. */ }
    for (const location of ordinaryLocations) result.set(spaceMountKey(location.source.reference), location.source)
    return result
  }, [inputs, ordinaryLocations])
  const mountedCandidates = useSourceCandidates(sources, observations, metadata, ordinaryLocations)
  const mountedSourceKeys = useMemo(() => new Set(sources.keys()), [sources])
  const candidates = useMemo(() => discoveredLocations(mountedCandidates, originalLocations, locationDemands), [mountedCandidates, originalLocations, locationDemands])
  const runtimeHosts = [...new Set([...candidates.values()].flatMap(candidate => [
    ...(ordinaryContexts.get(candidate.sid) ?? []).map(context => context.control?.hostId ?? context.hostId),
    ...candidate.locations.flatMap(location => location.member.zone?.hostId === 'local'
      ? resourceHosts.get(JSON.stringify([location.member.zone.workspaceId, location.member.zone.directoryPath])) ?? [] : [])
  ]))].filter(hostId => !originalLocations.get(hostId)?.value).sort().join('\n')
  const candidateKeys = [...candidates.keys()].sort().join('\n')
  useEffect(() => {
    const retained = new Set(candidates.keys())
    setFacts(previous => [...previous.keys()].some(key => !retained.has(key))
      ? new Map([...previous].filter(([key]) => retained.has(key))) : previous)
    const sourceKeys = new Set(sources.keys())
    for (const hostId of locationDemands.keys()) sourceKeys.add(originalLocationReaderKey(hostId))
    setRefreshes(previous => [...previous.keys()].some(key => !retained.has(key) && !sourceKeys.has(key))
      ? new Map([...previous].filter(([key]) => retained.has(key) || sourceKeys.has(key))) : previous)
  }, [candidateKeys, sources, locationDemands])
  useEffect(() => {
    if (!visible || !runtimeHosts) return
    const controller = new AbortController()
    for (const hostId of runtimeHosts.split('\n')) {
      const expectedHost = config?.hosts.find(host => host.id === hostId)
      void api.spaceMounts.call('resources', { hostId }, controller.signal).then(result => {
        if (!controller.signal.aborted) setWitnesses(previous => new Map(previous).set(hostId, { host: expectedHost, runtimeId: result.runtimeId }))
      }).catch(() => { /* No identity witness means no alias; it never removes an ordinary Context. */ })
    }
    return () => controller.abort()
  }, [runtimeHosts, visible, config?.hosts])
  useEffect(() => {
    if (!visible) return
    const now = Date.now()
    let delay = Infinity
    for (const fact of facts.values()) delay = Math.min(delay, sourceSessionRefreshDelay(fact.session, now))
    if (Number.isFinite(delay)) { const timer = setTimeout(() => setClock(Date.now()), delay); return () => clearTimeout(timer) }
  }, [facts, visible, clock])
  const presentations = useRef<SourcePresentations | undefined>(undefined)
  const result = useMemo(() => {
    const rows: FocusContext[] = [], identities = new Map<string, FocusContextIdentity>()
    const aliases = new Map<string, FocusContextAccess>()
    const issues: FocusSourceIssue[] = [], readers: ReactNode[] = []
    for (const host of config?.hosts ?? []) {
      const sessions = locationDemands.get(host.id)
      if (!sessions?.length) continue
      const key = originalLocationReaderKey(host.id), observed = originalLocations.get(host.id)
      readers.push(<OriginalLocationsReader key={key} host={host} sessions={sessions} visible={visible} revision={refreshes.get(key) ?? 0}
        observation={originalLocations.get(host.id)?.value} mountedSourceKeys={mountedSourceKeys} publish={publishLocations} />)
      if (observed?.issue) issues.push({ key, label: 'Agent locations', host: host.label, hostId: host.id, ...observed.issue,
        reading: Boolean(observed.reading), refresh: () => refresh(key) })
    }
    for (const [key, source] of sources) {
      readers.push(<SourceReader key={'source:' + key} target={source} visible={visible} revision={refreshes.get(key) ?? 0} />)
      const issue = observations[key]?.error ?? metadata[key]?.error
      if (issue) issues.push({ key, label: observations[key]?.snapshot?.scope.space?.name ?? observations[key]?.lastPresentSnapshot?.scope.space?.name ?? 'Project source',
        host: config?.hosts.find(host => host.id === source.hostId)?.label ?? source.hostId, hostId: source.hostId, reference: source.reference,
        message: issue, reading: Boolean(observations[key]?.reading || metadata[key]?.reading), refresh: () => refresh(key) })
    }
    const previous = presentations.current, next = new Map<string, CandidatePresentation>()
    const sameRoutes = previous?.runtimes === runtimes
    const samePresentation = sameRoutes && previous.config === config && previous.actions === actions
    const now = Date.now()
    for (const candidate of candidates.values()) {
      const matchingRows = ordinaryContexts.get(candidate.sid)
      const fact = facts.get(candidate.key)
      const prior = previous?.rows.get(candidate.key), sameCandidate = prior?.candidate === candidate
      const current = sameCandidate && prior.fact === fact ? prior.current : fact && fact.key === candidateFactKey(candidate) ? fact : undefined
      const readingCurrent = current?.readingCurrent?.(), historyName = current?.name ? undefined : historyNames.get(candidate.key)
      const ordinary = sameCandidate && sameRoutes && shallow(prior.matchingRows, matchingRows) ? prior.ordinary
        : candidate.runtimeId ? matchingFocusContext(matchingRows ?? [], runtimes, candidate.runtimeId, candidate.sid) : undefined
      if (!ordinary && !mountedCandidates.has(candidate.key)) continue
      let row: CandidateRow, validUntil: number
      if (sameCandidate && samePresentation && prior.current === current && prior.readingCurrent === readingCurrent &&
        prior.historyName === historyName && prior.ordinary === ordinary && now < prior.validUntil &&
        sameCandidateLayouts(candidate, previous.layouts, layouts)) {
        row = prior.row
        validUntil = prior.validUntil
      } else {
        row = projectSourceCandidate(candidate, ordinary, current, readingCurrent, historyName, config, runtimes, layouts, actions, refresh)
        validUntil = now + sourceSessionRefreshDelay(current?.session, now)
      }
      next.set(candidate.key, { candidate, fact, current, readingCurrent, historyName, matchingRows, ordinary, validUntil, row })
      identities.set(row.key, row.identity)
      if (row.alias) aliases.set(row.key, row.alias)
      if (row.context) {
        rows.push(row.context)
        readers.push(<SessionReader key={'session:' + candidate.key} candidate={candidate} visible={visible} publish={publish} refresh={refreshes.get(candidate.key) ?? 0} />)
        readers.push(<MemberReader key={'member:' + candidate.key} candidate={candidate} visible={visible} publish={publish} refresh={refreshes.get(candidate.key) ?? 0} />)
      }
    }
    presentations.current = { rows: next, config, runtimes, layouts, actions }
    return { contexts: rows.length ? rows : NO_SOURCE_CONTEXTS, identities: identities.size ? identities : NO_SOURCE_IDENTITIES, aliases, issues, readers: <Fragment>{readers}</Fragment> }
  }, [sources, observations, metadata, candidates, mountedCandidates, mountedSourceKeys, ordinaryContexts, runtimes, facts, historyNames, refreshes, layouts, config, visible, clock, publish, refresh, actions, locationDemands, originalLocations, publishLocations])
  return result
}
