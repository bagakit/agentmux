import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts'
import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTabDetail } from '../components/WorkbenchTopology'
import type { FocusContext } from './focus-context'
import { topicTabRegionCells } from './scratch-topic-layout'
import { tabDisplayName, type WorkbenchTab } from './workbench-tabs'

export const focusContextIdentityKey = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])
type RegionReference = { tabId: string; regionId: string; agentSessionId: string }
type ExecutionFor = (reference: RegionReference) => { hostId: string } | null
type Cached<T> = { dependencies: readonly unknown[]; value: T }
type Position = { tabId: string; regionIds: Set<string>; locationLabel?: string }
export type FocusContextIdentity = { tabs: readonly WorkbenchTabDetail[]; occurrenceCount: number }
const same = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => value === right[index])

/**
 * One bounded projection at the Focus surface, using existing membership and Core
 * execution identities. Missing facts only omit the optional position decoration;
 * they never change the original card, navigation or Session capability.
 */
export function createFocusContextIdentitySelector() {
  let tabCache = new Map<string, Cached<WorkbenchTabDetail>>()
  let subjectCache = new Map<string, Cached<FocusContextIdentity>>()
  return (catalog: AgentMuxSpaceCatalog, tabs: Readonly<Record<string, WorkbenchTab>>,
    contexts: readonly FocusContext[], config: AppConfig | null, layouts: Readonly<Record<string, WorkspaceLayout>>,
    executionFor: ExecutionFor): ReadonlyMap<string, FocusContextIdentity> => {
    const executors = config?.executors, retainedAvatars = config?.appearance.agentAvatars
    const contextsByKey = new Map(contexts.map(context => [focusContextIdentityKey(context.hostId, context.id), context]))
    const regions = new Map(catalog.regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region]))
    const contextForRegion = new Map<string, FocusContext>()
    const positions = new Map<string, Map<string, Position>>()
    const occurrences = new Map<string, Set<string>>()
    const displayNames = new Map(config?.workspaces.map(workspace => [workspace.id, workspace.name]))
    const groupOrders = new Map<string, string[]>()
    // Locations prove actual membership. A retained, detached Tab object is not a position.
    for (const location of catalog.locations) {
      const key = JSON.stringify([location.tabId, location.regionId])
      const fact = regions.get(key), surface = tabs[location.tabId]?.regions[location.regionId]
      if (fact?.kind !== 'agent' || surface?.kind !== 'agent' || fact.agentSessionId !== surface.sessionId) continue
      const execution = executionFor({ tabId: location.tabId, regionId: location.regionId, agentSessionId: surface.sessionId })
      if (!execution) continue
      const subject = focusContextIdentityKey(execution.hostId, surface.sessionId), context = contextsByKey.get(subject)
      if (!context) continue
      const originalOccurrences = occurrences.get(subject) ?? new Set<string>()
      originalOccurrences.add(JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]))
      occurrences.set(subject, originalOccurrences)
      contextForRegion.set(key, context)
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
      const occurrenceCount = occurrences.get(subject)!.size
      const dependencies = [occurrenceCount, ...[...subjectPositions].flatMap(([occurrenceKey, { tabId, regionIds: ids, locationLabel }]) => [occurrenceKey, locationLabel, nextTabs.get(tabId)!.value, ...ids])]
      const previous = subjectCache.get(subject)
      const value = previous && same(previous.dependencies, dependencies) ? previous.value
        : { tabs: [...subjectPositions].map(([occurrenceKey, { tabId, regionIds: ids, locationLabel }]) => ({ ...nextTabs.get(tabId)!.value, occurrenceKey,
          ...(locationLabel ? { locationLabel } : {}), highlightedRegionIds: [...ids] })), occurrenceCount }
      nextSubjects.set(subject, { dependencies, value }); result.set(subject, value)
    }
    tabCache = nextTabs; subjectCache = nextSubjects
    return result
  }
}
