import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '../store'
import { rendererPerformance } from './renderer-performance'
import { sessionPresentationById } from './session-presentation'
import { workbenchNavigationTabs } from './workbench-navigation-catalog'

type ConsumerKind = 'composer' | 'sessionPane'
type State = ReturnType<typeof useAppStore.getState>
// This is the read protocol for the retained Pane/Composer, not a second Store.
// A new fact read must join its notification owner here; actions are imperative.
const sharedFacts = {
  composer: ['config', 'scratchTopicSnapshots', 'providerCatalog', 'errorNoticeContext', 'error', 'lastError', 'lastActiveFileByWorkspace'],
  sessionPane: ['config', 'scratchTopicSnapshots', 'sessionNameMetadata', 'runtimeEndpointWarnings',
    'localHome', 'demandPmoTabIds', 'demands', 'layouts', 'spaceZoneBindings', 'spatialRequests', 'topicCategories', 'projectGroups']
} as const satisfies Record<ConsumerKind, readonly (keyof State)[]>
const navigationFacts = ['retainedSpatialFocus', 'workbenchNavigationInputPolicy', 'mainSurface', 'activeWorkspaceId', 'workbenchSpaceSelection'] as const
const sessionFacts = [
  'agentComposerDrafts', 'agentComposerHistoryNavigation', 'agentSteerInFlight', 'agentSteerInFlightPhase', 'agentSteerQueues', 'agentNames',
  'pendingAgentLaunches', 'viewModes', 'timelines', 'questionReplies', 'questionReplyDrafts'
] as const satisfies readonly (keyof State)[]
type ConsumerFacts<K extends ConsumerKind> = Pick<State, typeof sharedFacts[K][number] | typeof sessionFacts[number] | 'sessions' | 'recoveryCandidates' | (K extends 'sessionPane' ? 'tabs' | typeof navigationFacts[number] : never)>
export type RetainedConsumerScope = { readonly sessionIds: readonly string[]; readonly navigation: boolean }
type Listener = () => void
const listenersByScope = new Map<RetainedConsumerScope, { kind: ConsumerKind; listeners: Set<Listener> }>()
const scopesBySession = new Map<string, Set<RetainedConsumerScope>>()
let unsubscribe: (() => void) | undefined
// Revisions are notification watermarks, including preview's in-place timeline append.
// They never replace Store facts or supply selector results.
const timelineRevisions = new Map<string, number | undefined>()

function notify(current: State, previous: State): void {
  const changed = new Set<RetainedConsumerScope>()
  const addSession = (id: string): void => {
    for (const scope of scopesBySession.get(id) ?? []) changed.add(scope)
  }
  // Shared capabilities/configuration remain live when hidden. Only visible primary
  // Pane autofocus reads navigation facts; Composer and hidden Pane do not.
  const composerChanged = sharedFacts.composer.some(key => current[key] !== previous[key])
  const paneChanged = sharedFacts.sessionPane.some(key => current[key] !== previous[key])
  const navigationChanged = navigationFacts.some(key => current[key] !== previous[key])
  const tabsChanged = current.tabs !== previous.tabs && workbenchNavigationTabs(current.tabs) !== workbenchNavigationTabs(previous.tabs)
  if (composerChanged || paneChanged || navigationChanged || tabsChanged) {
    for (const [scope, group] of listenersByScope) {
      if (group.kind === 'composer' ? composerChanged : paneChanged || tabsChanged || scope.navigation && navigationChanged) changed.add(scope)
    }
  }
  if (current.sessions !== previous.sessions) {
    const before = sessionPresentationById(previous.sessions), after = sessionPresentationById(current.sessions)
    for (const id of scopesBySession.keys()) if (before.get(id) !== after.get(id)) addSession(id)
  }
  for (const key of sessionFacts) {
    if (current[key] === previous[key]) continue
    const before = previous[key], after = current[key]
    for (const id of scopesBySession.keys()) {
      if (before?.[id] !== after?.[id] || key === 'timelines' && timelineRevisions.get(id) !== current.timelines[id]?.revision) addSession(id)
    }
  }
  if (current.recoveryCandidates !== previous.recoveryCandidates) {
    // Pane consumes find(first); admission must preserve that even for overlapping observations.
    const before = new Map<string, State['recoveryCandidates'][number]>()
    const after = new Map<string, State['recoveryCandidates'][number]>()
    for (const candidate of previous.recoveryCandidates) if (!before.has(candidate.agentSessionId)) before.set(candidate.agentSessionId, candidate)
    for (const candidate of current.recoveryCandidates) if (!after.has(candidate.agentSessionId)) after.set(candidate.agentSessionId, candidate)
    for (const id of scopesBySession.keys()) if (before.get(id) !== after.get(id)) addSession(id)
  }
  if (current.timelines !== previous.timelines) {
    for (const id of scopesBySession.keys()) timelineRevisions.set(id, current.timelines[id]?.revision)
  }
  for (const scope of changed) for (const listener of listenersByScope.get(scope)?.listeners ?? []) listener()
}

function subscribe(kind: ConsumerKind, scope: RetainedConsumerScope, listener: Listener): () => void {
  let listeners = listenersByScope.get(scope)?.listeners
  if (!listeners) {
    listeners = new Set()
    listenersByScope.set(scope, { kind, listeners })
    for (const id of scope.sessionIds) {
      const scopes = scopesBySession.get(id) ?? new Set()
      scopes.add(scope); scopesBySession.set(id, scopes)
      timelineRevisions.set(id, useAppStore.getState().timelines[id]?.revision)
    }
  }
  listeners.add(listener)
  if (!unsubscribe) unsubscribe = useAppStore.subscribe(notify)
  return () => {
    listeners!.delete(listener)
    if (listeners!.size === 0) {
      listenersByScope.delete(scope)
      for (const id of scope.sessionIds) {
        const scopes = scopesBySession.get(id)!
        scopes.delete(scope)
        if (scopes.size === 0) { scopesBySession.delete(id); timelineRevisions.delete(id) }
      }
    }
    if (listenersByScope.size === 0) { unsubscribe?.(); unsubscribe = undefined }
  }
}

/** One shared admission, then only related consumers. Visibility never freezes live facts. */
export function useObservedAppStore<K extends ConsumerKind, T>(kind: K, visible: boolean, scope: RetainedConsumerScope, selector: (state: ConsumerFacts<K>) => T): T {
  const visibility = useRef(visible)
  visibility.current = visible
  const previous = useRef<T>(undefined as T)
  const initialized = useRef(false)
  const observed = useCallback(() => {
    const value = selector(useAppStore.getState())
    const changed = initialized.current && !Object.is(previous.current, value)
    previous.current = value
    initialized.current = true
    rendererPerformance.check(kind, visibility.current, changed)
    return value
  }, [kind, selector])
  const subscribeScope = useCallback((listener: Listener) => subscribe(kind, scope, listener), [kind, scope])
  // getSnapshot always consumes the current authoritative Store, including parent render/reveal.
  return useSyncExternalStore(subscribeScope, observed, observed)
}
/** One per component, after a successful commit; aborted renders are not commits. */
export function useObservedConsumerCommit(kind: ConsumerKind, visible: boolean): void {
  useLayoutEffect(() => { rendererPerformance.commit(kind, visible) })
}
