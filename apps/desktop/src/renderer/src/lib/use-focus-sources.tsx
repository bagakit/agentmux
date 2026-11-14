import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SpaceSnapshot } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import type { NameObservation } from '@agentmux/core/name-control'
import type { ConversationObservation, projectConversationWindow } from '@agentmux/core/conversation'
import type { ConversationReadApi } from '../../../shared/conversation-read'
import type { HostConfig, SessionSnapshot } from '../../../shared/contracts'
import { spaceMountKey, type SpaceMountMemberSurface, type SpaceMountMemberTarget, type SpaceMountRecord } from '../../../shared/space-mount'
import { api } from './api'
import { agentRegionLocationBindings, ordinaryAgentSpaceMember, useAppStore } from '../store'
import { workbenchSelectionCatalog } from './desktop-focus-navigation'
import { mountedSpaceInputs, mountedSpaceRegions, mountedSpaceTarget, type MountedSpaceRegion } from './space-mount-view'
import { mountedSessionFacts } from './space-mount-sessions'
import { useSpaceSourceReader } from '../components/SpaceSourceReaders'
import { agentContextForSession, agentContextForConversation, type FocusContext } from './focus-context'
import type { FocusContextAccess } from './focus-context-access'
import { focusContextIdentityKey, type FocusContextIdentity, type FocusContextOccurrence } from './focus-context-identity'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { focusSourceContextId, focusSourceHostId, focusSourceKey, focusSourceWorkspace, matchingFocusContext, unobservedFocusContext } from './focus-source-model'
import { readSourceConversationRecap, sourceConversationPort } from './focus-source-conversation'
import { originalSpaceResource, originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from './original-space-navigation'

type Location = FocusContextAccess['locations'][number] & { member: MountedSpaceRegion; snapshot?: SpaceSnapshot }
type Candidate = { key: string; runtimeId?: string; sid: string; locations: Location[]; target?: SpaceMountMemberTarget; issue?: string }
type SourceChoice = { locations: FocusContextAccess['locations']; choose(location: FocusContextAccess['locations'][number]): void }
type ReadFact = { key: string; session?: SessionSnapshot; name?: NameObservation; issue?: string;
  conversationPort?: ConversationReadApi; readConversation?: () => Promise<void>; reading?: ReturnType<typeof projectConversationWindow>;
  rename?: (name: string | null, expectedRevision: number) => Promise<boolean>; isCurrent?: () => boolean; nameSaveIssue?: string }

function SourceReader({ target, visible }: { target: SpaceMountRecord; visible: boolean }) {
  useSpaceSourceReader(target, visible)
  return null
}

/** Full source observations belong to this visible consumer, never the local Session Store. */
function MemberReader({ candidate, visible, publish, refresh, previous }: { candidate: Candidate; visible: boolean; publish(key: string, fact: ReadFact): void; refresh: number; previous: ReadFact | undefined }) {
  const target = candidate.target, address = target && JSON.stringify(target)
  // The read/name owner follows the chosen exact member target; another legal
  // display of this Session does not donate its admission or carrier.
  const first = target ? candidate.locations.find(location => location.source.hostId === target.hostId &&
    location.source.reference.runtimeId === target.target.reference.runtimeId && location.source.reference.spaceId === target.target.reference.spaceId &&
    location.regionId === target.target.regionId)! : candidate.locations[0]!
  useEffect(() => {
    if (!target || !visible) return
    const controller = new AbortController()
    let surface: SpaceMountMemberSurface | undefined
    const conversationObservations = new Map<string, (event: ConversationObservation) => void>()
    const current: ReadFact = { key: address!, ...(previous && previous.key === address && previous.nameSaveIssue ? { nameSaveIssue: previous.nameSaveIssue } : {}) }
    const failures = new Map<'session' | 'watch' | 'name' | 'name-save' | 'conversation' | 'conversation-watch', string>()
    if (current.nameSaveIssue) failures.set('name-save', current.nameSaveIssue)
    const emit = () => {
      if (failures.size) current.issue = [...failures.values()].join(' · ')
      else delete current.issue
      if (!controller.signal.aborted) publish(candidate.key, { ...current })
    }
    const issue = (cause: unknown, step: 'session' | 'watch' | 'name' | 'conversation' | 'conversation-watch' = 'session') => {
      failures.set(step, cause instanceof Error ? cause.message : String(cause)); emit()
    }
    void api.spaceMounts.member(target, event => {
      if (controller.signal.aborted) return
      if (event.type === 'session') { current.session = event.session; failures.delete('watch'); emit() }
      else if (event.type === 'conversation') conversationObservations.get(event.readerId)?.(event.observation)
      else if (event.type === 'error' || event.type === 'observation-error') issue(event.error.message, 'watch')
    }, controller.signal).then(async value => {
      if (controller.signal.aborted) { await value.dispose(); return }
      surface = value
      current.isCurrent = () => !controller.signal.aborted && current.session?.kind === 'agent' &&
        current.session.control.agentSessionId === target.target.agentSessionId && current.session.control.run.runId === target.target.expectedRun.runId
      current.conversationPort = sourceConversationPort(value, candidate.sid, conversationObservations, controller.signal)
      let recapRequest: Promise<void> | undefined, watchStarted = false, epoch = 0, attemptedEpoch = -1
      current.readConversation = () => {
        if (!watchStarted) {
          watchStarted = true
          // The optional watcher never gates the original fixed read. Re-read
          // once after its opening to close the initial read/watch gap.
          void current.conversationPort!.observeConversation({ hostId: 'local', agentSessionId: candidate.sid }, event => {
            if (event.kind === 'unavailable') issue(event.message ?? 'Conversation updates are unavailable.', 'conversation-watch')
            else { failures.delete('conversation-watch'); epoch++; void current.readConversation?.() }
          }, { signal: controller.signal }).then(() => {
            if (!controller.signal.aborted) { failures.delete('conversation-watch'); epoch++; void current.readConversation?.() }
          }).catch(cause => { if (!controller.signal.aborted) issue(cause, 'conversation-watch') })
        }
        if (recapRequest) return recapRequest
        if (attemptedEpoch === epoch) return Promise.resolve()
        const requestedEpoch = epoch; attemptedEpoch = requestedEpoch
        recapRequest = (async () => {
          try {
            current.reading = await readSourceConversationRecap(current.conversationPort!, candidate.sid, controller.signal)
            failures.delete('conversation'); emit()
          } catch (cause) { if (!controller.signal.aborted) issue(cause, 'conversation') }
          finally {
            recapRequest = undefined
            if (!controller.signal.aborted && epoch !== requestedEpoch) void current.readConversation?.()
          }
        })()
        return recapRequest
      }
      emit()
      try { current.session = await value.call('read', {}, controller.signal); failures.delete('session'); emit() } catch (cause) { issue(cause) }
      const operationId = first.member.region.creationOperationId ?? (current.session?.kind === 'agent' ? current.session.creation?.createOperationId : undefined)
      if (operationId) {
        const direct = !first.member.region.creationOperationId && target.target.runtimeId === first.source.reference.runtimeId
        const memberName = { object: 'agent' as const, target: { reference: first.source.reference, regionId: first.regionId,
          runtimeId: target.target.runtimeId, agentSessionId: target.target.agentSessionId, expectedAdmission: { kind: 'creation' as const, operationId } } }
        const agentName = { runtimeId: target.target.runtimeId, agentSessionId: target.target.agentSessionId, createOperationId: operationId }
        try {
          current.name = direct
            ? await api.spaceMounts.call('agentNameInspect', { hostId: first.source.hostId, expectedRuntimeId: target.target.runtimeId, name: agentName }, controller.signal)
            : await api.spaceMounts.call('memberNameInspect', { hostId: first.source.hostId, reference: first.source.reference, name: memberName }, controller.signal)
          current.rename = async (name, expectedNameRevision) => {
            const change = { kind: 'rename' as const, operationId: mintObjectId(), name, expectedNameRevision, source: 'manual' as const }
            const result = direct
              ? await api.spaceMounts.call('agentNameChange', { hostId: first.source.hostId, expectedRuntimeId: target.target.runtimeId, name: { ...agentName, change } })
              : await api.spaceMounts.call('memberNameChange', { hostId: first.source.hostId, reference: first.source.reference, name: { ...memberName, change } })
            if (result.applied) {
              current.name = { ...result, diskAcknowledgement: 'not-observed' }; failures.delete('name')
              if (result.save.diskDurability !== 'confirmed') {
                current.nameSaveIssue = `The original name was applied, but its save is unconfirmed (${change.operationId}). ${result.save.issue ?? 'The original name and task are retained.'}`
                failures.set('name-save', current.nameSaveIssue)
              } else { delete current.nameSaveIssue; failures.delete('name-save') }
              emit()
            }
            return result.applied
          }
          failures.delete('name'); emit()
        } catch (cause) { issue(cause, 'name') }
      }
    }).catch(issue)
    return () => { controller.abort(); void Promise.resolve(surface?.dispose()).catch(() => {}) }
  }, [address, visible, refresh, publish])
  return null
}

function openSourceLocation(location: Location, surface: 'agents' | 'workbench', onSelectLocation?: (reference: WorkbenchProjectionSelection) => void) {
  if (location.reference) {
    if (onSelectLocation) onSelectLocation(location.reference)
    else useAppStore.getState().selectMainRegion(location.reference)
    if (surface === 'workbench') useAppStore.setState({ mainSurface: surface })
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
    occurrence: { tabId: location.tabId, regionId: location.regionId, displayWorkspaceId: location.source.workspaceId } })
  useAppStore.setState({ mainSurface: surface })
  return true
}

/** Joins source-qualified facts to the common Context pipeline; it owns no task UI. */
export function useFocusSources({ visible, contexts, onSelectLocation, onChooseLocation, onFocusContext }: { visible: boolean; contexts: readonly FocusContext[];
  onSelectLocation?: (reference: WorkbenchProjectionSelection) => void; onChooseLocation?: (choice: SourceChoice) => void;
  onFocusContext?: (context: FocusContext) => void }) {
  const inputs = useAppStore(state => state.mountedSpaceInputs), observations = useAppStore(state => state.mountedSpaceObservations)
  const metadata = useAppStore(state => state.mountedSpaceSessions), config = useAppStore(state => state.config)
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
  const publish = useCallback((key: string, fact: ReadFact) => setFacts(previous => new Map(previous).set(key, fact)), [])
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
        // Source-local is explicitly defined by the original Core member contract.
        const runtimeId = member.region.execution?.runtimeId ?? fact?.current?.member.runtimeId ??
          (member.region.execution?.hostId === 'local' ? snapshot.reference.runtimeId : undefined)
        const identity = runtimeId ? focusSourceKey(runtimeId, sid) : JSON.stringify(['unconfirmed-region', snapshot.reference, member.region.regionId])
        const located = references.get(referenceKey(target, member.tab.tabId, member.region.regionId)) ?? []
        const locations: Location[] = (located.length ? located : [undefined]).map(reference => ({ source: target,
          tabId: member.tab.tabId, regionId: member.region.regionId, member, snapshot, ...(reference ? { reference } : {}) }))
        const original: Candidate = result.get(identity) ?? { key: identity, ...(runtimeId ? { runtimeId } : {}), sid, locations: [] }
        original.locations.push(...locations)
        if (!original.target && runtimeId && current?.status === 'observed' && current.authority.runtimeId === runtimeId && current.session.agentSessionId === sid)
          original.target = { hostId: target.hostId, target: { reference: target.reference, regionId: member.region.regionId,
            runtimeId, agentSessionId: sid, expectedRun: current.session.run,
            ...(member.region.creationOperationId ? { expectedAdmission: { kind: 'creation', operationId: member.region.creationOperationId } } : {}) } }
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
    const issues: Array<{ key: string; message: string; refresh(): void }> = [], readers: ReactNode[] = []
    for (const [key, source] of sources) {
      readers.push(<SourceReader key={'source:' + key + ':' + (refreshes.get(key) ?? 0)} target={source} visible={visible} />)
      const issue = observations[key]?.error ?? metadata[key]?.error
      if (issue) issues.push({ key, message: issue, refresh: () => refresh(key) })
    }
    for (const candidate of candidates.values()) {
      const first = candidate.locations[0]!, workspace = focusSourceWorkspace(first.source, first.member, first.snapshot, config, runtimes)
      let focusedContext: FocusContext | undefined
      const navigate = (surface: 'agents' | 'workbench', requested?: FocusContextAccess['locations'][number]) => {
        const choose = (request: FocusContextAccess['locations'][number]) => {
          const location = candidate.locations.find(location => JSON.stringify([location.source.reference, location.tabId, location.regionId, location.reference]) ===
            JSON.stringify([request.source.reference, request.tabId, request.regionId, request.reference]))
          if (location) {
            const selected = openSourceLocation(location, surface, onSelectLocation)
            if (selected && surface === 'agents' && !location.reference && focusedContext) onFocusContext?.(focusedContext)
          }
          else useAppStore.getState().reportError(Error('This position belongs to another original task. The current task and workface are retained.'))
        }
        if (requested) choose(requested)
        else if (candidate.locations.length === 1) choose(first)
        else if (onChooseLocation) onChooseLocation({ locations: candidate.locations, choose })
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
          locations: candidate.locations, open: (location?: FocusContextAccess['locations'][number]) => navigate('workbench', location), select: (location?: FocusContextAccess['locations'][number]) => navigate('agents', location), refresh: refreshCandidate })
        identities.set(localKey, { tabs: [], occurrenceCount: candidate.locations.length,
          ...(resources.length ? { resources } : {}),
          locations: { status: occurrences.length === candidate.locations.length ? 'confirmed' : 'unconfirmed', occurrences } })
        continue
      }
      const memberKey = candidate.target && JSON.stringify(candidate.target), read = facts.get(candidate.key)
      const current = read?.key === memberKey ? read : undefined
      const issue = current?.issue ?? candidate.issue
      const access: FocusContextAccess = { identity: { runtimeId: candidate.runtimeId ?? null, agentSessionId: candidate.sid },
        locations: candidate.locations, ...(current?.session ? { session: current.session } : {}),
        ...(current?.name ? { nameRevision: current.name.current.nameRevision } : {}),
        ...(current?.rename ? { rename: current.rename } : {}),
        ...(current?.isCurrent ? { isCurrent: current.isCurrent } : { isCurrent: () => false }),
        ...(current?.conversationPort ? { conversationPort: current.conversationPort, conversationReference: { hostId: 'local', agentSessionId: candidate.sid }, ...(current.readConversation ? { readConversation: current.readConversation } : {}) } : {}),
        ...(issue ? { issue } : {}), open: (location?: FocusContextAccess['locations'][number]) => navigate('workbench', location), select: (location?: FocusContextAccess['locations'][number]) => navigate('agents', location), refresh: refreshCandidate }
      let context = current?.session ? current.reading
        ? agentContextForConversation(current.session, current.reading.records, current.name?.current.override ?? undefined, workspace, null)
        : agentContextForSession(current.session, undefined, current.name?.current.override ?? undefined, workspace, null)
        : unobservedFocusContext(candidate.runtimeId ?? '', candidate.sid, workspace, first.member.tab.name ?? undefined, access.issue, access)
      const { control: _control, ...readOnly } = context
      context = { ...readOnly, id: candidate.runtimeId ? focusSourceContextId(candidate.runtimeId, candidate.sid) : candidate.key,
        hostId: focusSourceHostId(candidate.runtimeId ?? candidate.key), access, recap: context.recap ?? null }
      if (access.issue) context = { ...context,
        detail: context.detail === access.issue ? access.issue : `${context.detail} · Observation: ${access.issue}`,
        detailKind: context.bucket === 'attention' ? 'service' : 'observation', detailIsRecap: false }
      focusedContext = context
      rows.push(context)
      identities.set(focusContextIdentityKey(context.hostId, context.id), { tabs: [], occurrenceCount: candidate.locations.length,
        ...(resources.length ? { resources } : {}),
        locations: { status: occurrences.length === candidate.locations.length ? 'confirmed' : 'unconfirmed', occurrences } })
      readers.push(<MemberReader key={'member:' + candidate.key} candidate={candidate} visible={visible} publish={publish} refresh={refreshes.get(candidate.key) ?? 0} previous={current} />)
    }
    return { contexts: rows, identities, aliases, issues, readers: <Fragment>{readers}</Fragment> }
  }, [sources, observations, metadata, candidates, contexts, ordinaryContexts, runtimes, facts, refreshes, inputs, layouts, config, visible, clock, publish, refresh, onSelectLocation, onChooseLocation, onFocusContext])
  return result
}
