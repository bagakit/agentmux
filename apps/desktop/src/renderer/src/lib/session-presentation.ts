import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from './attention-vocabulary'
import { focusLaneForSession } from './agent-focus'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { firstPromptFromTimeline, topicIdForSession, workspaceForSession } from './workbench-tabs'
import type { AgentTimelineSnapshot } from '../../../shared/contracts'
import type { SessionViewMode } from './session-state'

let indexedSessions: readonly SessionSnapshot[] | undefined
let index: ReadonlyMap<string, SessionSnapshot> = new Map()
let indexedPathSessions: readonly SessionSnapshot[] | undefined
let paths: ReadonlyMap<string, ReadonlyMap<string, readonly SessionSnapshot[]>> = new Map()
const NO_SESSIONS: readonly SessionSnapshot[] = []

/** Shared lookup over the immutable Store projection; references remain owned by the Store. */
export function sessionPresentationById(sessions: readonly SessionSnapshot[]): ReadonlyMap<string, SessionSnapshot> {
  if (sessions !== indexedSessions) {
    index = new Map(sessions.map(session => [session.id, session]))
    indexedSessions = sessions
  }
  return index
}

/** Directory consumers lazily share one path projection per immutable Session snapshot. */
export function sessionPresentationsAtPath(sessions: readonly SessionSnapshot[], hostId: string, path: string): readonly SessionSnapshot[] {
  if (sessions !== indexedPathSessions) {
    const byHost = new Map<string, Map<string, SessionSnapshot[]>>()
    for (const session of sessions) {
      const host = byHost.get(session.hostId) ?? new Map<string, SessionSnapshot[]>()
      const atPath = host.get(session.workspacePath) ?? []
      atPath.push(session); host.set(session.workspacePath, atPath); byHost.set(session.hostId, host)
    }
    paths = byHost; indexedPathSessions = sessions
  }
  return paths.get(hostId)?.get(path) ?? NO_SESSIONS
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

/** Human-readable status uses the same facts in Focus and a projected coordination context. */
export function sessionStatusLabel(session: SessionSnapshot): string {
  const state = session.status.state
  const pending = session.kind === 'agent' && Boolean(session.pendingInteraction)
  return state === 'error' ? 'Failed' : pending ? 'Request pending' : isNeedsYouState(state) ? (state === 'blocked' ? 'Blocked' : 'Needs reply')
    : state === 'done' ? 'Idle' : state === 'running' ? (session.kind === 'agent' ? 'Status unknown' : 'Shell open')
    : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? (session.kind === 'terminal' && session.status.exitReason !== 'user-stopped' ? 'Exited' : 'Stopped') : state === 'starting' ? 'Starting' : 'Working'
}
