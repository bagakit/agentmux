import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../../../shared/contracts'

const HOUR = 60 * 60_000
export type FolderIconTone = 'full' | 'subdued' | 'quiet' | 'unknown'

/** Read the already-owned Core facts; process updates and output are not activity observations. */
export function folderLastActivityAt(sessions: readonly SessionSnapshot[], now: number): number | null {
  let latest: number | null = null
  for (const session of sessions) {
    if (session.kind !== 'agent' || !session.semanticStatus || !isAgentActivityStatusSource(session.semanticStatus.source)) continue
    const observedAt = session.semanticStatus.observedAt
    if (!Number.isFinite(observedAt) || observedAt <= 0 || observedAt > now) continue
    if (latest === null || observedAt > latest) latest = observedAt
  }
  return latest
}

/** Age is a view projection, never a new activity fact. Inclusive boundaries advance one millisecond later. */
export function folderIconRecency(lastActivityAt: number | null, now: number): { tone: FolderIconTone; nextBoundaryAt: number | null } {
  if (lastActivityAt === null || !Number.isFinite(lastActivityAt) || lastActivityAt <= 0 || lastActivityAt > now || !Number.isFinite(now)) {
    return { tone: 'unknown', nextBoundaryAt: null }
  }
  const age = now - lastActivityAt
  if (age <= HOUR) return { tone: 'full', nextBoundaryAt: lastActivityAt + HOUR + 1 }
  if (age <= 12 * HOUR) return { tone: 'subdued', nextBoundaryAt: lastActivityAt + 12 * HOUR + 1 }
  return { tone: 'quiet', nextBoundaryAt: null }
}
