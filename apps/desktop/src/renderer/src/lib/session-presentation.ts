import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from './attention-vocabulary'
import { focusLaneForSession } from './agent-focus'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { topicIdForSession, workspaceForSession } from './workbench-tabs'
import type { SessionViewMode } from './session-state'

let indexedSessions: readonly SessionSnapshot[] | undefined
let index: ReadonlyMap<string, SessionSnapshot> = new Map()

/** Shared lookup over the immutable Store projection; references remain owned by the Store. */
export function sessionPresentationById(sessions: readonly SessionSnapshot[]): ReadonlyMap<string, SessionSnapshot> {
  if (sessions !== indexedSessions) {
    index = new Map(sessions.map((session) => [session.id, session]))
    indexedSessions = sessions
  }
  return index
}

/** An explicit choice wins; known Motes have one read-only Activity default in every consumer. */
export function effectiveSessionViewMode(state: {
  viewModes: Readonly<Record<string, SessionViewMode>>; sessions: readonly SessionSnapshot[]
  config: AppConfig | null; scratchTopicSnapshots: Readonly<Record<string, ScratchTopicsSnapshot>>
}, sessionId: string): SessionViewMode {
  const explicit = state.viewModes[sessionId]
  if (explicit !== undefined) return explicit
  const session = sessionPresentationById(state.sessions).get(sessionId)
  return session && focusLaneForSession(topicIdForSession(state.config, session),
    scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspaceForSession(state.config, session))) === 'pmo'
    ? 'activity' : 'terminal'
}

/** Human-readable status uses the same facts in Focus and a projected coordination context. */
export function sessionStatusLabel(session: SessionSnapshot): string {
  const state = session.status.state
  const pending = session.kind === 'agent' && Boolean(session.pendingInteraction)
  return state === 'error' ? 'Failed' : pending ? 'Request pending' : isNeedsYouState(state) ? (state === 'blocked' ? 'Blocked' : 'Needs reply')
    : state === 'done' ? 'Idle' : state === 'running' ? (session.kind === 'agent' ? 'Status unknown' : 'Shell open')
    : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? (session.kind === 'terminal' && session.status.exitReason !== 'user-stopped' ? 'Exited' : 'Stopped') : state === 'starting' ? 'Starting' : 'Working'
}
