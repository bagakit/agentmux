import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts'
import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTabDetail } from '../components/WorkbenchTopology'
import type { FocusContext } from './focus-context'
import { topicTabRegionCells } from './scratch-topic-layout'
import { tabDisplayName, type WorkbenchTab } from './workbench-tabs'

export const focusContextIdentityKey = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])
type RegionReference = { tabId: string; regionId: string; agentSessionId: string; expectedRunId?: string }
type ExecutionFor = (reference: RegionReference) => { hostId: string } | null
type Cached<T> = { dependencies: readonly unknown[]; value: T }
type Position = { tabId: string; regionIds: Set<string>; locationLabel?: string }
export type FocusContextOccurrence = {
  /** Business membership comes from the original Zone/Space, never from a display name. */
  source: { spaceId: string | null; zoneId: string | null; workspaceId: string; hostId: string | null;
    /** Existing Core resource facts survive a missing client registration. */
    resource?: AppConfig['workspaces'][number] }
  display: { workspaceId: string; hostId: string | null; groupId: string; tabId: string; regionId: string }
}
export type FocusContextIdentity = {
  /** Original business resources, independently of private display occurrences. */
  resources?: readonly AppConfig['workspaces'][number][]
  objects?: readonly FocusSourceObject[]
  sourceIssue?: string
  tabs: readonly WorkbenchTabDetail[]; occurrenceCount: number
  locations: { status: 'confirmed' | 'unconfirmed'; occurrences: readonly FocusContextOccurrence[] }
}
export type FocusSourceObject = { id: string; kind: 'topic' | 'mote'; name: string; hostId: string; workspaceId: string; path: string; topicId: string }
const NO_OCCURRENCES: readonly FocusContextOccurrence[] = []
const same = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => value === right[index])

/** Presentation IDs locate candidates; only the original execution owner qualifies one. */
export function focusContextAtRegion(candidates: readonly FocusContext[], reference: Pick<RegionReference, 'tabId' | 'regionId'>,
  executionFor: ExecutionFor): FocusContext | null {
  const matches = candidates.filter(candidate => candidate.kind === 'agent' && executionFor({ ...reference,
    agentSessionId: candidate.control?.agentSessionId ?? candidate.id,
    ...(candidate.control ? { expectedRunId: candidate.control.run.runId } : {}) })?.hostId === candidate.hostId)
  return matches.length === 1 ? matches[0]! : null
}

/**
 * One bounded projection at the Focus surface, using existing membership and Core
 * execution identities. Missing facts only omit the optional position decoration;
 * they never change the original card, navigation or Session capability.
 */
export function createFocusContextIdentitySelector() {
  let tabCache = new Map<string, Cached<WorkbenchTabDetail>>()
  let subjectCache = new Map<string, Cached<FocusContextIdentity>>()
  let previousResult: ReadonlyMap<string, FocusContextIdentity> = new Map()
  let locationCache: { inputs: readonly unknown[]; positions: Map<string, Map<string, Position>>;
    occurrences: Map<string, Set<string>>; relations: Map<string, FocusContextOccurrence[]>;
    subjectsByRegion: Map<string, string>; unconfirmed: Set<string> } | undefined
  return (catalog: AgentMuxSpaceCatalog, tabs: Readonly<Record<string, WorkbenchTab>>,
    contexts: readonly FocusContext[], config: AppConfig | null, layouts: Readonly<Record<string, WorkspaceLayout>>,
    executionFor: ExecutionFor, locationsKnown = false, executionBindings?: unknown): ReadonlyMap<string, FocusContextIdentity> => {
    const executors = config?.executors, retainedAvatars = config?.appearance.agentAvatars
    const contextsByKey = new Map(contexts.map(context => [focusContextIdentityKey(context.hostId, context.id), context]))
    const signature = contexts.map(context => JSON.stringify([context.hostId, context.id, context.control?.agentSessionId, context.control?.run.runId])).sort().join('\n')
    const inputs = [catalog, tabs, layouts, config?.workspaces, signature, executionFor, locationsKnown, executionBindings]
    if (!locationCache || !same(locationCache.inputs, inputs)) {
      const regions = new Map(catalog.regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region]))
      const subjectsByRegion = new Map<string, string>(), unconfirmed = new Set<string>()
      const contextsById = new Map<string, FocusContext[]>()
      for (const context of contexts) contextsById.set(context.id, [...(contextsById.get(context.id) ?? []), context])
      const positions = new Map<string, Map<string, Position>>()
      const occurrences = new Map<string, Set<string>>()
      const relations = new Map<string, FocusContextOccurrence[]>()
      const zones = new Map(catalog.zones.map(zone => [zone.zoneId, zone]))
      const spaces = new Map(catalog.spaces.map(space => [space.spaceId, space]))
      const workspaces = new Map(config?.workspaces.map(workspace => [workspace.id, workspace]))
      const displayNames = new Map(config?.workspaces.map(workspace => [workspace.id, workspace.name]))
      const groupOrders = new Map<string, string[]>()
      // Locations prove actual membership. A retained, detached Tab object is not a position.
      for (const location of catalog.locations) {
        const key = JSON.stringify([location.tabId, location.regionId])
        const fact = regions.get(key), surface = tabs[location.tabId]?.regions[location.regionId]
        if (!fact || !surface || fact.kind !== surface.kind || (surface.kind !== 'agent' && surface.kind !== 'terminal')) continue
        const candidates = contextsById.get(surface.sessionId) ?? []
        const context = focusContextAtRegion(candidates, { tabId: location.tabId, regionId: location.regionId }, executionFor)
        if (!context) { for (const candidate of candidates) unconfirmed.add(focusContextIdentityKey(candidate.hostId, candidate.id)); continue }
        const subject = focusContextIdentityKey(context.hostId, surface.sessionId)
        const originalOccurrences = occurrences.get(subject) ?? new Set<string>()
        originalOccurrences.add(JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]))
        occurrences.set(subject, originalOccurrences)
        const held = relations.get(subject) ?? []
        const zone = location.zoneId ? zones.get(location.zoneId) : undefined, space = location.spaceId ? spaces.get(location.spaceId) : undefined
        const resource = zone?.directoryPath && zone.hostId && !zone.issue && space?.kind === 'folder' && space.hostId === zone.hostId
          ? { id: zone.workspaceId, hostId: zone.hostId, path: zone.directoryPath, name: space.name, kind: 'folder' as const,
            ...(space.directoryPath && space.directoryPath !== zone.directoryPath ? { repoPath: space.directoryPath } : {}),
            ...(zone.branch ? { branch: zone.branch } : {}) } : undefined
        held.push({ source: { spaceId: location.spaceId, zoneId: location.zoneId,
          workspaceId: location.workspaceId, hostId: zone?.hostId ?? null, ...(resource ? { resource } : {}) },
          display: { workspaceId: location.displayWorkspaceId, hostId: workspaces.get(location.displayWorkspaceId)?.hostId
            ?? (location.displayWorkspaceId === location.workspaceId ? zone?.hostId : null) ?? null,
            groupId: location.groupId, tabId: location.tabId, regionId: location.regionId } })
        relations.set(subject, held)
        subjectsByRegion.set(key, subject)
        const occurrenceKey = JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId])
        const layout = layouts[location.displayWorkspaceId], displayName = displayNames.get(location.displayWorkspaceId)
        const order = groupOrders.get(location.displayWorkspaceId) ?? (layout ? groupIds(layout.root) : [])
        groupOrders.set(location.displayWorkspaceId, order)
        const groupIndex = order.indexOf(location.groupId)
        const locationLabel = displayName && groupIndex >= 0 ? `${displayName} · Group ${groupIndex + 1}` : undefined
        const subjectPositions = positions.get(subject) ?? new Map<string, Position>()
        const position = subjectPositions.get(occurrenceKey) ?? { tabId: location.tabId, regionIds: new Set<string>(), ...(locationLabel ? { locationLabel } : {}) }
        position.regionIds.add(location.regionId); subjectPositions.set(occurrenceKey, position); positions.set(subject, subjectPositions)
      }
      locationCache = { inputs, positions, occurrences, relations, subjectsByRegion, unconfirmed }
    }
    const { positions, occurrences, relations, subjectsByRegion, unconfirmed } = locationCache
    const contextForRegion = new Map([...subjectsByRegion].map(([key, subject]) => [key, contextsByKey.get(subject)!]))
    const nextTabs = new Map<string, Cached<WorkbenchTabDetail>>()
    for (const subjectPositions of positions.values()) for (const { tabId } of subjectPositions.values()) {
      if (nextTabs.has(tabId)) continue
      const tab = tabs[tabId]!
      const cells = topicTabRegionCells(tab)
      const held = cells.map(cell => contextForRegion.get(JSON.stringify([tabId, cell.regionId])))
      const dependencies = [tab, executors, retainedAvatars, ...held], previous = tabCache.get(tabId)
      if (previous && same(previous.dependencies, dependencies)) { nextTabs.set(tabId, previous); continue }
      const details = cells.map((cell, index) => {
        const context = held[index], executor = context?.executorId ? executors?.[context.executorId] : undefined
        const labels = { agent: 'Agent', terminal: 'Terminal', browser: 'Browser', file: 'File', git: 'Git history', 'git-diff': 'Git diff', launcher: 'Launcher' }
        const executorLabel = context ? executor?.label ?? context.executorId ?? 'Agent' : labels[cell.surfaceKind ?? 'launcher']
        return { ...cell, executorLabel, activity: context?.detail ?? 'No recent activity',
          ...(context?.providerId ? { agent: { sessionId: context.id, providerId: context.providerId,
            executorId: context.executorId, appearance: executor?.avatar ?? (context.executorId ? retainedAvatars?.[context.executorId] : undefined), state: context.state, label: context.name } } : {}) }
      })
      const value: WorkbenchTabDetail = { tabId, active: false, regions: details,
        title: tabDisplayName({ tab, fallback: 'Workbench', agentFactsFor: sessionId => {
          const matches = held.filter(context => context?.id === sessionId)
          const context = matches[0]
          // A naming API accepts SID only. Conflicting Hosts remain unnamed here.
          return context && matches.every(match => match?.hostId === context.hostId)
            ? { userName: context.name, fallbackLabel: context.name, providerLabel: context.executorId ?? context.providerId ?? 'Agent' } : null
        } }) }
      nextTabs.set(tabId, { dependencies, value })
    }
    const nextSubjects = new Map<string, Cached<FocusContextIdentity>>()
    const result = new Map<string, FocusContextIdentity>()
    for (const [subject, subjectPositions] of positions) {
      if (unconfirmed.has(subject)) continue
      const occurrenceCount = occurrences.get(subject)!.size
      const subjectRelations = relations.get(subject)!
      const dependencies = [occurrenceCount, JSON.stringify(subjectRelations), ...[...subjectPositions].flatMap(([occurrenceKey, { tabId, regionIds: ids, locationLabel }]) => [occurrenceKey, locationLabel, nextTabs.get(tabId)!.value, ...ids])]
      const previous = subjectCache.get(subject)
      const value = previous && same(previous.dependencies, dependencies) ? previous.value
        : { tabs: [...subjectPositions].map(([occurrenceKey, { tabId, regionIds: ids, locationLabel }]) => ({ ...nextTabs.get(tabId)!.value, occurrenceKey,
          ...(locationLabel ? { locationLabel } : {}), highlightedRegionIds: [...ids] })), occurrenceCount,
          locations: previous?.value.locations.status === 'confirmed' && previous.value.locations.occurrences === subjectRelations
            ? previous.value.locations : { status: 'confirmed' as const, occurrences: subjectRelations } }
      nextSubjects.set(subject, { dependencies, value }); result.set(subject, value)
    }
    for (const subject of contextsByKey.keys()) {
      if (result.has(subject)) continue
      const previous = subjectCache.get(subject)
      const status: FocusContextIdentity['locations']['status'] = locationsKnown && !unconfirmed.has(subject) ? 'confirmed' : 'unconfirmed'
      const held = status === 'unconfirmed' ? previous?.value.locations.occurrences ?? NO_OCCURRENCES : NO_OCCURRENCES
      const value = previous?.value.occurrenceCount === 0 && previous.value.locations.status === status && previous.value.locations.occurrences === held
        ? previous.value : { tabs: [], occurrenceCount: 0, locations: { status, occurrences: held } }
      nextSubjects.set(subject, { dependencies: [], value }); result.set(subject, value)
    }
    tabCache = nextTabs; subjectCache = nextSubjects
    if (previousResult.size !== result.size || [...result].some(([key, value]) => previousResult.get(key) !== value)) previousResult = result
    return previousResult
  }
}
