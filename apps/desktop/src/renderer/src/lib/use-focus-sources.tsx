import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SpaceSnapshot } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import type { AgentNameTarget, NameObservation } from '@agentmux/core/name-control'
import type { ConversationObservation, projectConversationWindow } from '@agentmux/core/conversation'
import type { ConversationReadApi } from '../../../shared/conversation-read'
import type { HostConfig, SessionSnapshot } from '../../../shared/contracts'
import { spaceMountKey, type SpaceMountMemberSurface, type SpaceMountMemberTarget, type SpaceMountRecord } from '../../../shared/space-mount'
import { api } from './api'
import { agentDisplayName, sourceRegionProjectionReference } from './workbench-tabs'
import { requestWorkbenchReferenceClose } from './workbench-close-request'
import { requestDesktopFocusWorkfaceReveal } from './desktop-presentation'
import { agentRegionLocationBindings, confirmedOriginalRawLocations, ordinaryAgentSpaceMember, useAppStore } from '../store'
import { workbenchSelectionCatalog } from './desktop-focus-navigation'
import { mountedSpaceInputs, mountedSpaceRegions, mountedSpaceTarget, type MountedSpaceRegion } from './space-mount-view'
import { mountedSessionFacts } from './space-mount-sessions'
import { useSpaceSourceReader } from '../components/SpaceSourceReaders'
import { agentContextForSession, agentContextForConversation, focusRecordFacts, type FocusContext } from './focus-context'
import type { FocusContextAccess } from './focus-context-access'
import { focusContextIdentityKey, type FocusContextIdentity, type FocusContextOccurrence } from './focus-context-identity'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { focusSourceContextId, focusSourceHistoryNames, focusSourceHostId, focusSourceKey, focusSourceWorkspace, matchingFocusContext, unobservedFocusContext } from './focus-source-model'
import { readSourceConversationRecap, sourceConversationPort } from './focus-source-conversation'
import { originalSpaceResource, originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from './original-space-navigation'

type Location = FocusContextAccess['locations'][number] & { member: MountedSpaceRegion; snapshot?: SpaceSnapshot }
type Candidate = { key: string; runtimeId?: string; sid: string; locations: Location[]; target?: SpaceMountMemberTarget; authorityKey?: string; readingTarget?: import('../../../shared/space-mount').SpaceMountReadingTarget; directName?: { hostId: string; target: Pick<AgentNameTarget, 'runtimeId' | 'agentSessionId'>; changeTarget?: AgentNameTarget }; issue?: string }
const sourceFactKey = (target: NonNullable<Candidate['readingTarget']>) => JSON.stringify([target.target.runtimeId, target.target.agentSessionId, target.target.reference.runtimeId, target.target.expectedAdmission])
const candidateFactKey = (candidate: Candidate) => candidate.readingTarget ? sourceFactKey(candidate.readingTarget) : candidate.directName ? JSON.stringify([candidate.runtimeId, candidate.sid, candidate.directName.target.runtimeId]) : candidate.target ? JSON.stringify([candidate.runtimeId, candidate.sid, candidate.target.target.reference, candidate.target.target.regionId]) : undefined
type SourceChoice = { locations: FocusContextAccess['locations']; choose(location: FocusContextAccess['locations'][number]): void }
type ReadFact = { key: string; session?: SessionSnapshot; name?: NameObservation;
  conversationPort?: ConversationReadApi; readConversation?: () => Promise<void>; reading?: ReturnType<typeof projectConversationWindow>;
  rename?: ((name: string | null, expectedRevision: number) => Promise<boolean>) | undefined; nameSaveIssue?: string | undefined; sessionIssue?: string | undefined; nameIssue?: string | undefined; readingIssue?: string | undefined; readingCurrent?: () => boolean }

function SourceReader({ target, visible, revision }: { target: SpaceMountRecord; visible: boolean; revision: number }) {
  const refresh = useSpaceSourceReader(target, visible), previous = useRef(revision)
  useEffect(() => {
    if (previous.current === revision) return
    previous.current = revision
    refresh()
  }, [revision, refresh])
  return null
}

/** Native facts have their own Run generation; they never own durable labels or history. */
function SessionReader({ candidate, visible, publish, refresh }: { candidate: Candidate; visible: boolean; publish(key: string, fact: ReadFact, sameIdentityOnly?: boolean): void; refresh: number }) {
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
}

/** Names survive Run observation gaps; admitted members also retain bounded records. */
function MemberReader({ candidate, visible, publish, refresh }: { candidate: Candidate; visible: boolean; publish(key: string, fact: ReadFact, sameIdentityOnly?: boolean): void; refresh: number }) {
  const target = candidate.readingTarget ?? candidate.target, direct = candidate.directName, address = JSON.stringify([target, direct]), key = candidateFactKey(candidate)
  useEffect(() => {
    if ((!target && !direct) || !key || !visible) return
    const controller = new AbortController(); let surface: import('../../../shared/space-mount').SpaceMountReadingSurface | undefined
    const emit = (fact: Partial<ReadFact>) => { if (!controller.signal.aborted) publish(candidate.key, { key: key!, ...fact }) }
    const member = candidate.readingTarget?.target
    const name = member && { object: 'agent' as const, target: { reference: member.reference, regionId: member.regionId, runtimeId: member.runtimeId, agentSessionId: member.agentSessionId, expectedAdmission: member.expectedAdmission } }
    // Name authority is independent of Native Session reads and the conversation reader.
    const nameRead = direct && !member ? api.spaceMounts.call('agentNameInspect', { hostId: direct.hostId, expectedRuntimeId: direct.target.runtimeId, name: direct.target }, controller.signal)
      : name ? api.spaceMounts.call('memberNameInspect', { hostId: target!.hostId, reference: target!.target.reference, name }, controller.signal) : undefined
    void nameRead?.then(observed => {
      const rename = (member ? member.expectedAdmission.kind === 'creation' : direct?.changeTarget) ? async (value: string | null, expectedNameRevision: number) => {
        const change = { kind: 'rename' as const, operationId: mintObjectId(), name: value, expectedNameRevision, source: 'manual' as const }
        const result = direct?.changeTarget && !member ? await api.spaceMounts.call('agentNameChange', { hostId: direct.hostId, expectedRuntimeId: direct.target.runtimeId, name: { ...direct.changeTarget, change } })
          : await api.spaceMounts.call('memberNameChange', { hostId: target!.hostId, reference: target!.target.reference, name: { ...name!, change } })
        if (result.applied) publish(candidate.key, { key: key!, name: { ...result, diskAcknowledgement: 'not-observed' }, nameIssue: undefined, nameSaveIssue: result.save.diskDurability === 'confirmed' ? undefined : `The original name was applied; its save is unconfirmed (${change.operationId}). ${result.save.issue ?? ''}` }, true)
        return result.applied
      } : undefined
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
}

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
  state.openOriginalSpaceLocation({ target: location.source, resource: originalSpaceResource(state, location.source),
    occurrence: { tabId: location.tabId, regionId: location.regionId, displayWorkspaceId: location.source.workspaceId } }, surface === 'workbench')
  useAppStore.setState({ mainSurface: surface })
  if (surface === 'agents') {
    const choice = useAppStore.getState().workbenchSpaceSelection
    if (choice) requestDesktopFocusWorkfaceReveal(choice)
  }
  return true
}

/** Joins source-qualified facts to the common Context pipeline; it owns no task UI. */
export function useFocusSources({ visible, contexts, onSelectLocation, onChooseLocation, onFocusContext }: { visible: boolean; contexts: readonly FocusContext[];
  onSelectLocation?: (reference: WorkbenchProjectionSelection) => boolean | void; onChooseLocation?: (choice: SourceChoice) => void;
  onFocusContext?: (context: FocusContext) => void }) {
  const inputs = useAppStore(state => state.mountedSpaceInputs), observations = useAppStore(state => state.mountedSpaceObservations)
  const metadata = useAppStore(state => state.mountedSpaceSessions), config = useAppStore(state => state.config)
  const history = useAppStore(state => state.agentFocus.execution.history)
  const historyNames = useMemo(() => focusSourceHistoryNames(history), [history])
  const catalog = useAppStore(workbenchSelectionCatalog), tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts), bindings = useAppStore(agentRegionLocationBindings)
  const [facts, setFacts] = useState(new Map<string, ReadFact>())
  const [witnesses, setWitnesses] = useState(new Map<string, { runtimeId: string; host: HostConfig | undefined }>())
  const runtimes = useMemo(() => new Map([...witnesses].flatMap(([hostId, witness]) =>
    config?.hosts.find(host => host.id === hostId) === witness.host ? [[hostId, witness.runtimeId] as const] : [])), [witnesses, config?.hosts])
  const [refreshes, setRefreshes] = useState(new Map<string, number>()), [clock, setClock] = useState(Date.now)
  const ordinaryContexts = useMemo(() => {
    const result = new Map<string, FocusContext[]>()
    for (const context of contexts) {
      const sid = context.control?.agentSessionId ?? context.id, members = result.get(sid) ?? []
      members.push(context); result.set(sid, members)
    }
    return result
  }, [contexts])
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
  const ordinaryLocations = useMemo(() => {
    const result: Array<{ source: SpaceMountRecord; presentation: MountedSpaceRegion; reference: WorkbenchProjectionSelection }> = []
    for (const location of catalog.locations) {
      const surface = tabs[location.tabId]?.regions[location.regionId]
      if (surface?.kind !== 'agent') continue
      const member = ordinaryAgentSpaceMember({ tabId: location.tabId, regionId: location.regionId, sessionId: surface.sessionId })
      if (member.kind === 'foreign') result.push({ source: member.source, presentation: member.presentation,
        reference: { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId } })
    }
    return result
  }, [catalog, tabs, bindings])
  const sources = useMemo(() => {
    const result = new Map<string, SpaceMountRecord>()
    try { for (const key of Object.keys(mountedSpaceInputs(inputs))) {
      try { const target = mountedSpaceTarget(inputs, key); if (target) result.set(spaceMountKey(target.reference), target) } catch { /* Original input owner retains/reports unreadable fragments. */ }
    } } catch { /* Other readable Sources and ordinary Contexts remain available. */ }
    for (const location of ordinaryLocations) result.set(spaceMountKey(location.source.reference), location.source)
    return result
  }, [inputs, ordinaryLocations])
  const candidates = useMemo(() => {
    const result = new Map<string, Candidate>()
    const referenceKey = (source: SpaceMountRecord, tabId: string, regionId: string) => JSON.stringify([source.reference, tabId, regionId])
    const references = new Map<string, WorkbenchProjectionSelection[]>()
    for (const location of ordinaryLocations) {
      const key = referenceKey(location.source, location.reference.tabId, location.reference.regionId), previous = references.get(key) ?? []
      previous.push(location.reference); references.set(key, previous)
    }
    for (const [key, target] of sources) {
      const observation = observations[key], snapshot = observation?.snapshot?.scope.space === null
        ? observation.lastPresentSnapshot ?? observation.snapshot : observation?.snapshot
      if (!snapshot) continue
      const sessionFacts = mountedSessionFacts(snapshot, metadata[key])
      for (const member of mountedSpaceRegions(snapshot)) {
        const sid = member.region.agentSessionId
        if (!sid) continue
        const fact = sessionFacts.get(member.key), current = fact?.current?.state
        const observed = current?.status === 'observed' ? current : fact?.last?.state.status === 'observed' ? fact.last.state : undefined
        // Source-local is explicitly defined by the original Core member contract.
        const runtimeId = member.region.execution?.runtimeId ?? fact?.current?.member.runtimeId ??
          (member.region.execution?.hostId === 'local' ? snapshot.reference.runtimeId : undefined)
        const identity = runtimeId ? focusSourceKey(runtimeId, sid) : JSON.stringify(['unconfirmed-region', snapshot.reference, member.region.regionId])
        const located = references.get(referenceKey(target, member.tab.tabId, member.region.regionId)) ?? []
        const locations: Location[] = (located.length ? located : [undefined]).map(reference => ({ source: target,
          tabId: member.tab.tabId, regionId: member.region.regionId, member, snapshot, ...(reference ? { reference } : {}) }))
        const original: Candidate = result.get(identity) ?? { key: identity, ...(runtimeId ? { runtimeId } : {}), sid, locations: [] }
        original.locations.push(...locations)
        const admission = member.region.association ? { kind: 'association' as const, operationId: member.region.association.operationId }
          : member.region.creationOperationId ? { kind: 'creation' as const, operationId: member.region.creationOperationId } : undefined
        if (!original.readingTarget && runtimeId && admission) original.readingTarget = { hostId: target.hostId, target: {
          kind: 'conversation', reference: target.reference, regionId: member.region.regionId, runtimeId, agentSessionId: sid, expectedAdmission: admission } }

        if (!original.target && runtimeId && observed?.authority.runtimeId === runtimeId && observed.session.agentSessionId === sid)
          original.target = { hostId: target.hostId, target: { reference: target.reference, regionId: member.region.regionId,
            runtimeId, agentSessionId: sid, expectedRun: observed.session.run,
            ...(member.region.creationOperationId ? { expectedAdmission: { kind: 'creation', operationId: member.region.creationOperationId } } : {}) } }
        if (!original.directName && runtimeId === target.reference.runtimeId) {
          const createOperationId = observed?.authority.runtimeId === runtimeId && observed.session.agentSessionId === sid ? observed.session.creation?.createOperationId : undefined
          original.directName = { hostId: target.hostId, target: { runtimeId, agentSessionId: sid },
            ...(createOperationId ? { changeTarget: { runtimeId, agentSessionId: sid, createOperationId } } : {}) }
        }
        if (observed) original.authorityKey = observed.authority.ownerInstanceId
        const issue = observation?.error ?? metadata[key]?.error ?? (current?.status === 'unavailable' || current?.status === 'unknown' ? current.issue.message : undefined)
        if (issue) original.issue = issue
        result.set(identity, original)
      }
    }
    for (const location of ordinaryLocations) {
      if (observations[spaceMountKey(location.source.reference)]?.snapshot) continue
      const member = location.presentation, sid = member.region.agentSessionId, runtimeId = member.region.execution?.runtimeId
      if (!sid || !runtimeId) continue
      const key = focusSourceKey(runtimeId, sid), prior: Candidate = result.get(key) ?? { key, runtimeId, sid, locations: [] }
      prior.locations.push({ source: location.source, tabId: location.reference.tabId, regionId: location.reference.regionId, member, reference: location.reference })
      if (!prior.directName && runtimeId === location.source.reference.runtimeId) prior.directName = { hostId: location.source.hostId, target: { runtimeId, agentSessionId: sid } }
      const issue = observations[spaceMountKey(location.source.reference)]?.error
      if (issue) prior.issue = issue
      result.set(key, prior)
    }
    return result
  }, [sources, observations, metadata, ordinaryLocations])
  const runtimeHosts = [...new Set([...candidates.values()].flatMap(candidate => [
    ...(ordinaryContexts.get(candidate.sid) ?? []).map(context => context.control?.hostId ?? context.hostId),
    ...candidate.locations.flatMap(location => location.member.zone?.hostId === 'local'
      ? resourceHosts.get(JSON.stringify([location.member.zone.workspaceId, location.member.zone.directoryPath])) ?? [] : [])
  ]))].sort().join('\n')
  const candidateKeys = [...candidates.keys()].sort().join('\n')
  useEffect(() => {
    const retained = new Set(candidates.keys())
    setFacts(previous => [...previous.keys()].some(key => !retained.has(key))
      ? new Map([...previous].filter(([key]) => retained.has(key))) : previous)
    const sourceKeys = new Set(sources.keys())
    setRefreshes(previous => [...previous.keys()].some(key => !retained.has(key) && !sourceKeys.has(key))
      ? new Map([...previous].filter(([key]) => retained.has(key) || sourceKeys.has(key))) : previous)
  }, [candidateKeys, sources])
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
    const now = Date.now(), delays = [...facts.values()].flatMap(fact => {
      const status = fact.session?.kind === 'agent' ? fact.session.semanticStatus : undefined
      const delay = status && msUntilSemanticStatusStale(status, now)
      return delay ? [delay] : []
    })
    if (delays.length) { const timer = setTimeout(() => setClock(Date.now()), Math.min(...delays)); return () => clearTimeout(timer) }
  }, [facts, visible, clock])
  const result = useMemo(() => {
    const rows: FocusContext[] = [], identities = new Map<string, FocusContextIdentity>()
    const aliases = new Map<string, FocusContextAccess>()
    const issues: Array<{ key: string; label: string; host: string; reference: SpaceMountRecord['reference']; message: string; reading: boolean; refresh(): void }> = [], readers: ReactNode[] = []
    for (const [key, source] of sources) {
      readers.push(<SourceReader key={'source:' + key} target={source} visible={visible} revision={refreshes.get(key) ?? 0} />)
      const issue = observations[key]?.error ?? metadata[key]?.error
      if (issue) issues.push({ key, label: observations[key]?.snapshot?.scope.space?.name ?? observations[key]?.lastPresentSnapshot?.scope.space?.name ?? 'Project source',
        host: config?.hosts.find(host => host.id === source.hostId)?.label ?? source.hostId, reference: source.reference,
        message: issue, reading: Boolean(observations[key]?.reading || metadata[key]?.reading), refresh: () => refresh(key) })
    }
    for (const candidate of candidates.values()) {
      const first = candidate.locations[0]!, workspace = focusSourceWorkspace(first.source, first.member, first.snapshot, config, runtimes)
      let focusedContext: FocusContext | undefined
      const navigate = (surface: 'agents' | 'workbench' | 'close', requested?: FocusContextAccess['locations'][number]) => {
        const rawLocations = (location: Location) => {
          const state = useAppStore.getState(), target = mountedSpaceTarget(state.mountedSpaceInputs, spaceMountKey(location.source.reference))
          if (!target || target.hostId !== location.source.hostId || target.zoneId !== location.source.zoneId || target.workspaceId !== location.source.workspaceId) return []
          return confirmedOriginalRawLocations(state, target).filter(reference => {
            const region = state.tabs[reference.tabId]?.regions[reference.regionId]
            return reference.tabId === location.tabId && reference.regionId === location.regionId && region?.kind === 'agent' && region.sessionId === candidate.sid
          })
        }
        // Closing addresses an existing display occurrence; it never opens a Source to create one.
        const locations = surface !== 'close' ? candidate.locations : candidate.locations.flatMap(location => {
          if (location.reference) return [location]
          const positions = [...rawLocations(location), ...catalog.locations.filter(reference => {
            const source = sourceRegionProjectionReference(tabs[reference.tabId]?.regions[reference.regionId])
            return source && spaceMountKey(source.reference) === spaceMountKey(location.source.reference) &&
              source.tabId === location.tabId && source.regionId === location.regionId && source.agentSessionId === candidate.sid
          })]
          return positions.length ? positions.map(reference => ({ ...location, reference: { displayWorkspaceId: reference.displayWorkspaceId,
            groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId } })) : [location]
        })
        const choose = (request: FocusContextAccess['locations'][number]) => {
          const location = locations.find(location => JSON.stringify([location.source.reference, location.tabId, location.regionId, location.reference]) ===
            JSON.stringify([request.source.reference, request.tabId, request.regionId, request.reference]))
          if (location) {
            if (surface === 'close') {
              const state = useAppStore.getState(), reference = location.reference
              const current = reference && state.tabs[reference.tabId]?.regions[reference.regionId], source = sourceRegionProjectionReference(current)
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
              if (!reference || !original) {
                state.reportError(Error('This original workface position is unconfirmed or changed. Its Agent and inputs are retained; choose its current exact position before closing.'))
                return
              }
              requestWorkbenchReferenceClose(reference, { keepAgentSessions: true })
              return
            }
            const selected = openSourceLocation(location, surface, onSelectLocation)
            if (selected && surface === 'agents' && !location.reference && focusedContext) onFocusContext?.(focusedContext)
          }
          else useAppStore.getState().reportError(Error('This position belongs to another original task. The current task and workface are retained.'))
        }
        const choices = requested ? locations.filter(location => JSON.stringify([location.source.reference, location.tabId, location.regionId]) ===
          JSON.stringify([requested.source.reference, requested.tabId, requested.regionId]) && (!requested.reference || JSON.stringify(location.reference) === JSON.stringify(requested.reference))) : locations
        if (choices.length === 1) choose(choices[0]!)
        else if (choices.length && onChooseLocation) onChooseLocation({ locations: choices, choose })
        else useAppStore.getState().reportError(Error('This task has several original positions. Choose an exact position before opening it.'))
      }
      const refreshCandidate = () => {
        refresh(candidate.key)
        for (const sourceKey of new Set(candidate.locations.map(location => spaceMountKey(location.source.reference)))) refresh(sourceKey)
      }
      const ordinary = candidate.runtimeId ? matchingFocusContext(ordinaryContexts.get(candidate.sid) ?? [], runtimes, candidate.runtimeId, candidate.sid) : undefined
      const resources = [...new Map(candidate.locations.flatMap(location => {
        const resource = focusSourceWorkspace(location.source, location.member, location.snapshot, config, runtimes)
        return resource ? [[JSON.stringify([resource.hostId, resource.id, resource.path]), resource] as const] : []
      })).values()]
      const occurrences: FocusContextOccurrence[] = candidate.locations.flatMap(location => {
        const member = location.member, resource = focusSourceWorkspace(location.source, member, location.snapshot, config, runtimes)
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
      if (ordinary) {
        focusedContext = ordinary
        const localKey = focusContextIdentityKey(ordinary.hostId, ordinary.id)
        aliases.set(localKey, { identity: { runtimeId: candidate.runtimeId ?? null, agentSessionId: candidate.sid },
          locations: candidate.locations, open: (location?: FocusContextAccess['locations'][number]) => navigate('workbench', location), select: (location?: FocusContextAccess['locations'][number]) => navigate('agents', location), refresh: refreshCandidate, close: (location?: FocusContextAccess['locations'][number]) => navigate('close', location) })
        identities.set(localKey, { tabs: [], occurrenceCount: candidate.locations.length,
          ...(resources.length ? { resources } : {}),
          locations: { status: occurrences.length === candidate.locations.length ? 'confirmed' : 'unconfirmed', occurrences } })
        continue
      }
      const memberKey = candidateFactKey(candidate), read = facts.get(candidate.key)
      const current = read?.key === memberKey ? read : undefined
      const issue = [current?.sessionIssue, current?.nameIssue, current?.nameSaveIssue, current?.readingIssue, candidate.issue].filter(Boolean).join(' · ') || undefined
      const session = !current?.sessionIssue && candidate.target && current?.session?.kind === 'agent' && current.session.control.run.runId === candidate.target.target.expectedRun.runId ? current.session : undefined
      const reading = current?.reading && focusRecordFacts(current.reading.records)
      // A current name reply, including an explicit clear, supersedes visit-time display facts.
      const userName = current?.name ? current.name.current.override ?? undefined : historyNames.get(candidate.key)
      const readingCurrent = current?.readingCurrent?.()
      const originalHosts = candidate.locations.map(location => location.member.region.execution?.hostId
        ? JSON.stringify([location.source.reference.runtimeId, location.member.region.execution.hostId]) : null)
      const executionHostId = originalHosts.every(Boolean) && new Set(originalHosts).size === 1 ? first.member.region.execution?.hostId : undefined
      const access: FocusContextAccess = { identity: { runtimeId: candidate.runtimeId ?? null, agentSessionId: candidate.sid },
        locations: candidate.locations, ...(session ? { session } : {}),
        ...(current?.session ? { retainedSession: current.session } : {}),
        observation: session ? 'current' : current?.session?.kind === 'agent' && candidate.target &&
          current.session.control.run.runId !== candidate.target.target.expectedRun.runId ? 'changed' : candidate.target ? 'unavailable' : 'unconfirmed',
        ...(executionHostId ? { executionHostId } : {}),
        ...(current?.name ? { nameRevision: current.name.current.nameRevision } : {}),
        ...(current?.rename ? { rename: current.rename } : {}),
        isCurrent: () => Boolean(session && candidate.target && session.control.run.runId === candidate.target.target.expectedRun.runId),
        ...(readingCurrent && current?.conversationPort ? { conversationPort: current.conversationPort, conversationReference: { hostId: 'local', agentSessionId: candidate.sid }, ...(current.readConversation ? { readConversation: current.readConversation } : {}) } : {}),
        ...(issue ? { issue } : {}), open: (location?: FocusContextAccess['locations'][number]) => navigate('workbench', location), select: (location?: FocusContextAccess['locations'][number]) => navigate('agents', location), refresh: refreshCandidate, close: (location?: FocusContextAccess['locations'][number]) => navigate('close', location) }
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
      rows.push(context)
      identities.set(focusContextIdentityKey(context.hostId, context.id), { tabs: [], occurrenceCount: candidate.locations.length,
        ...(resources.length ? { resources } : {}),
        locations: { status: occurrences.length === candidate.locations.length ? 'confirmed' : 'unconfirmed', occurrences } })
      readers.push(<SessionReader key={'session:' + candidate.key} candidate={candidate} visible={visible} publish={publish} refresh={refreshes.get(candidate.key) ?? 0} />)
      readers.push(<MemberReader key={'member:' + candidate.key} candidate={candidate} visible={visible} publish={publish} refresh={refreshes.get(candidate.key) ?? 0}  />)
    }
    return { contexts: rows, identities, aliases, issues, readers: <Fragment>{readers}</Fragment> }
  }, [sources, observations, metadata, candidates, contexts, ordinaryContexts, runtimes, facts, historyNames, refreshes, inputs, layouts, catalog, tabs, config, visible, clock, publish, refresh, onSelectLocation, onChooseLocation, onFocusContext])
  return result
}
