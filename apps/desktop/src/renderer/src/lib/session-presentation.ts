import { agentPresentationState, agentStatusLabel } from '@agentmux/client-ui/agent-presentation'
import { observeAgentSession } from './agent-observation'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from '@agentmux/client-ui/attention-vocabulary'
import { focusLaneForSession } from './agent-focus'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { topicIdForSession, workspaceForSession } from './workbench-tabs'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import type { AgentTimelineSnapshot } from '../../../shared/contracts'
import type { SessionViewMode } from './session-state'

type AgentSessionSnapshot = Extract<SessionSnapshot, { kind: 'agent' }>
type SessionPresentationIndex = { byId: ReadonlyMap<string, SessionSnapshot>; takeovers: readonly AgentSessionSnapshot[] }
const sessionIndexes = new WeakMap<readonly SessionSnapshot[], SessionPresentationIndex>()
let indexedAgentSessions: readonly SessionSnapshot[] | undefined
let agentIndex: ReadonlyMap<string, readonly Extract<SessionSnapshot, { kind: 'agent' }>[]> = new Map()
type SessionPaths = {
  paths: ReadonlyMap<string, ReadonlyMap<string, readonly SessionSnapshot[]>>
  children: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
}
const pathIndexes = new WeakMap<readonly SessionSnapshot[], SessionPaths>()
const NO_SESSIONS: readonly SessionSnapshot[] = []
const NO_PATHS: ReadonlySet<string> = new Set()

function sessionPresentations(sessions: readonly SessionSnapshot[]): SessionPresentationIndex {
  let index = sessionIndexes.get(sessions)
  if (!index) {
    const byId = new Map<string, SessionSnapshot>(), takeovers: AgentSessionSnapshot[] = []
    for (const session of sessions) {
      byId.set(session.id, session)
      if (session.kind === 'agent' && session.creation?.takeover) takeovers.push(session)
    }
    index = { byId, takeovers }
    sessionIndexes.set(sessions, index)
  }
  return index
}

/** Shared lookup over the immutable Store projection; references remain owned by the Store. */
export function sessionPresentationById(sessions: readonly SessionSnapshot[]): ReadonlyMap<string, SessionSnapshot> {
  return sessionPresentations(sessions).byId
}

/** A captured item can advance the recency clock independently of every control fact. */
export function onlyAgentActivityTimeChanged(previous: SessionSnapshot | undefined, next: SessionSnapshot | undefined): boolean {
  if (previous?.kind !== 'agent' || next?.kind !== 'agent' || previous.updatedAt === next.updatedAt ||
    previous.status !== next.status || previous.control !== next.control) return false
  const keys = Object.keys(previous) as (keyof AgentSessionSnapshot)[]
  return keys.length === Object.keys(next).length && keys.every(key =>
    key === 'updatedAt' || Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
}

/** Hidden workfaces hold a stable display result across clock-only changes. Reveal reads the current row. */
export function createSessionWorkfaceSelector(sessionId: string, visible: boolean) {
  let observed: SessionSnapshot | undefined
  let presented: SessionSnapshot | undefined
  return (state: { sessions: readonly SessionSnapshot[] }): SessionSnapshot | undefined => {
    const next = sessionPresentationById(state.sessions).get(sessionId)
    if (next !== observed) {
      observed = next
      if (visible || !onlyAgentActivityTimeChanged(presented, next)) presented = next
    }
    return presented
  }
}

export function sessionTakeoverPresentations(sessions: readonly SessionSnapshot[]): readonly AgentSessionSnapshot[] {
  return sessionPresentations(sessions).takeovers
}

/** Canonical references may have multiple Host-qualified presentations; callers qualify the exact target. */
export function agentSessionPresentationIndex(sessions: readonly SessionSnapshot[]) {
  if (sessions !== indexedAgentSessions) {
    const next = new Map<string, Extract<SessionSnapshot, { kind: 'agent' }>[]>(); indexedAgentSessions = sessions
    for (const session of sessions) if (session.kind === 'agent' && session.control.kind === 'agent') {
      for (const id of new Set([session.id, session.control.agentSessionId])) next.set(id, [...next.get(id) ?? [], session])
    }
    agentIndex = next
  }
  return agentIndex
}

/** Directory consumers lazily share one path projection per immutable Session snapshot. */
function indexSessionPaths(sessions: readonly SessionSnapshot[]): SessionPaths {
  let indexed = pathIndexes.get(sessions)
  if (!indexed) {
    const byHost = new Map<string, Map<string, SessionSnapshot[]>>()
    const childrenByHost = new Map<string, Map<string, Set<string>>>()
    for (const session of sessions) {
      const host = byHost.get(session.hostId) ?? new Map<string, SessionSnapshot[]>()
      const atPath = host.get(session.workspacePath) ?? []
      atPath.push(session); host.set(session.workspacePath, atPath); byHost.set(session.hostId, host)
      const parent = session.workspacePath.slice(0, Math.max(session.workspacePath.lastIndexOf('/'), session.workspacePath.lastIndexOf('\\')))
      const children = childrenByHost.get(session.hostId) ?? new Map<string, Set<string>>()
      const atParent = children.get(parent) ?? new Set<string>()
      atParent.add(session.workspacePath); children.set(parent, atParent); childrenByHost.set(session.hostId, children)
    }
    indexed = { paths: byHost, children: childrenByHost }; pathIndexes.set(sessions, indexed)
  }
  return indexed
}

export function sessionPresentationsAtPath(sessions: readonly SessionSnapshot[], hostId: string, path: string): readonly SessionSnapshot[] {
  return indexSessionPaths(sessions).paths.get(hostId)?.get(path) ?? NO_SESSIONS
}

/** Original direct-child directories only; membership remains the resource owner's decision. */
export function sessionPresentationChildPaths(sessions: readonly SessionSnapshot[], hostId: string, parent: string): ReadonlySet<string> {
  return indexSessionPaths(sessions).children.get(hostId)?.get(parent) ?? NO_PATHS
}

/** Only a valid own preference is explicit; opaque Session IDs also name Object properties. */
export function storedSessionViewMode(viewModes: Readonly<Record<string, SessionViewMode>>, sessionId: string): SessionViewMode | null {
  const mode = Object.hasOwn(viewModes, sessionId) ? viewModes[sessionId] : undefined
  return mode === 'terminal' || mode === 'activity' ? mode : null
}

/** An explicit choice wins; known Motes have one read-only Activity default in every consumer. */
export function effectiveSessionViewMode(state: {
  viewModes: Readonly<Record<string, SessionViewMode>>; sessions: readonly SessionSnapshot[]
  config: AppConfig | null; scratchTopicSnapshots: Readonly<Record<string, ScratchTopicsSnapshot>>
}, sessionId: string): SessionViewMode {
  const explicit = storedSessionViewMode(state.viewModes, sessionId)
  if (explicit !== null) return explicit
  const session = sessionPresentationById(state.sessions).get(sessionId)
  return session && focusLaneForSession(topicIdForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)),
    scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspaceForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)))) === 'pmo'
    ? 'activity' : 'terminal'
}

/** A retained consumer checks cheap facts first, before walking directory observations. */
export function createSessionViewModeSelector(sessionId: string) {
  let previous: readonly unknown[] | undefined
  let mode: SessionViewMode = 'terminal'
  return (state: Parameters<typeof effectiveSessionViewMode>[0]): SessionViewMode => {
    const explicit = storedSessionViewMode(state.viewModes, sessionId)
    if (explicit !== null) return explicit
    const session = sessionPresentationById(state.sessions).get(sessionId)
    const facts = [state.config, state.scratchTopicSnapshots, session?.kind, session?.hostId, session?.workspacePath]
    if (!previous || facts.some((fact, i) => fact !== previous![i])) {
      mode = effectiveSessionViewMode(state, sessionId)
      previous = facts
    }
    return mode
  }
}

/** Revision also covers preview appends that mutate the same timeline object. */
export function createFirstPromptSelector(sessionId: string) {
  let previous: readonly unknown[] | undefined
  let prompt: string | null = null
  return (state: { timelines: Readonly<Record<string, AgentTimelineSnapshot>> }): string | null => {
    const timeline = state.timelines[sessionId]
    const facts = [timeline, timeline?.revision, timeline?.items, timeline?.items.length]
    if (!previous || facts.some((fact, i) => fact !== previous![i])) {
      prompt = firstPromptFromTimeline(timeline)
      previous = facts
    }
    return prompt
  }
}

/** Human-readable status uses the same facts in Focus and a projected coordination context.
 * An Agent is read through its Core observation, so a running Agent whose native activity says idle
 * reads Idle, and a missing or stale activity signal is named instead of the bare process state. */
export function sessionStatusLabel(session: SessionSnapshot, now = Date.now()): string {
  if (session.kind !== 'agent') return agentStatusLabel(session)
  return agentPresentationState(session, observeAgentSession(session, now), false).stateLabel
}
