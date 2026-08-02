import { assertUnreachableSurface } from './workbench-surface-kinds'
import { workbenchSurfaces, type WorkbenchSurface, type WorkbenchTab } from './workbench-tabs'

/**
 * The Session id a single Region can be addressed by, or null when that Region carries no addressable
 * Agent identity.
 *
 * This is deliberately NOT `isSessionSurface`. A Terminal is a Session — it has a `sessionId` — but it
 * is not an *Agent*, and the messaging/session addresses this feeds (`agentmux send --to-session=…`)
 * only mean something for an Agent. So the two questions genuinely differ, and conflating them would
 * hand out an address that resolves to nothing.
 *
 * The switch is exhaustive rather than a bare `kind === 'agent'` test because "can this surface be
 * addressed as an Agent" is a per-kind question the union must answer: the day a second Agent-bearing
 * kind lands (a remote Agent, an Agent-in-browser), a `kind === 'agent'` test silently answers "no
 * address available" and the Region's copy-address entries vanish with no compile error. Here that day
 * is a type error instead.
 */
export function addressableAgentSessionId(surface: WorkbenchSurface): string | null {
  switch (surface.kind) {
    case 'agent':
      return surface.sessionId
    case 'terminal':
    case 'file':
    case 'launcher':
    case 'browser':
      return null
    default:
      return assertUnreachableSurface(surface)
  }
}

/**
 * The Session id a whole Tab can be addressed by: defined only when the Tab holds exactly one distinct
 * Agent. With two Agents on screen there is no unambiguous Session to name, so the caller is expected
 * to right-click the specific Region instead — which routes through `addressableAgentSessionId` above,
 * the same per-Region decision this folds over.
 */
export function copyableAgentSessionIdForTab(tab: WorkbenchTab): string | null {
  const agentSessionIds = new Set(
    workbenchSurfaces(tab).flatMap((surface) => {
      const sessionId = addressableAgentSessionId(surface)
      return sessionId === null ? [] : [sessionId]
    })
  )
  return agentSessionIds.size === 1 ? (agentSessionIds.values().next().value ?? null) : null
}
