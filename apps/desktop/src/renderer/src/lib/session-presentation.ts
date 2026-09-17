import type { SessionSnapshot } from '../../../shared/contracts'

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
