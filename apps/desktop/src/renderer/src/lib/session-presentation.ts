import type { SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from './attention-vocabulary'

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

/** Human-readable status uses the same facts in Focus and a projected coordination context. */
export function sessionStatusLabel(session: SessionSnapshot): string {
  const state = session.status.state
  const pending = session.kind === 'agent' && Boolean(session.pendingInteraction)
  return state === 'error' ? 'Failed' : pending ? 'Request pending' : isNeedsYouState(state) ? (state === 'blocked' ? 'Blocked' : 'Needs reply')
    : state === 'done' ? 'Idle' : state === 'running' ? (session.kind === 'agent' ? 'Status unknown' : 'Shell open')
    : state === 'disconnected' ? 'Disconnected' : state === 'exited' ? (session.kind === 'terminal' && session.status.exitReason !== 'user-stopped' ? 'Exited' : 'Stopped') : state === 'starting' ? 'Starting' : 'Working'
}
