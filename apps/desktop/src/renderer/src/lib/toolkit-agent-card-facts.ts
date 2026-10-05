import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { ToolkitAgentCardField, ToolkitAgentCardReference } from '@agentmux/core/control'
import type { AgentAvatarAppearance, AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { sessionStatusLabel } from './session-presentation'

export type ToolkitAgentCardFacts = {
  state: 'resolved' | 'unavailable' | 'ambiguous'
  reason?: string | undefined
  name?: string | undefined
  provider?: AgentProviderId | undefined
  status?: AgentDisplayState | undefined
  statusLabel?: string | undefined
  workspace?: string | undefined
  host?: string | undefined
  sessionId?: string | undefined
  runId?: string | undefined
  executorId?: string | undefined
  appearance?: AgentAvatarAppearance | undefined
}
type State = { sessions: readonly SessionSnapshot[]; config: AppConfig | null }
const EMPTY: ReadonlyMap<string, ToolkitAgentCardFacts> = new Map()
export const toolkitAgentCardKey = (reference: ToolkitAgentCardReference) => reference.kind === 'session'
  ? JSON.stringify(['session', reference.hostId, reference.sessionId])
  : JSON.stringify(['run', reference.hostId, reference.runId])

// All visible Toolkit consumers share one immutable Session index. It contains references,
// not a second registry or copied lifecycle facts; candidate arrays preserve ambiguity.
let indexed: readonly SessionSnapshot[] | undefined
let byReference: ReadonlyMap<string, readonly SessionSnapshot[]> = new Map()
function references(sessions: readonly SessionSnapshot[]) {
  if (sessions !== indexed) {
    const next = new Map<string, SessionSnapshot[]>()
    for (const session of sessions) {
      const keys = [toolkitAgentCardKey({ kind: 'run', hostId: session.hostId, runId: session.control.run.runId })]
      if (session.kind === 'agent' && session.control.kind === 'agent') keys.push(toolkitAgentCardKey({ kind: 'session', hostId: session.hostId, sessionId: session.control.agentSessionId }))
      for (const key of keys) { const candidates = next.get(key); if (candidates) candidates.push(session); else next.set(key, [session]) }
    }
    indexed = sessions; byReference = next
  }
  return byReference
}

function project(candidates: readonly SessionSnapshot[] | undefined, fields: ReadonlySet<ToolkitAgentCardField>, config: AppConfig | null): ToolkitAgentCardFacts {
  if (!candidates?.length) return { state: 'unavailable', reason: 'Agent identity unavailable' }
  if (candidates.length !== 1) return { state: 'ambiguous', reason: 'Agent identity is ambiguous' }
  const session = candidates[0]!
  if (session.kind !== 'agent' || session.control.kind !== 'agent') return { state: 'unavailable', reason: 'Referenced Run is not an Agent Session' }
  const avatar = fields.has('avatar')
  const appearance = avatar ? config?.executors[session.executorId]?.avatar ?? config?.appearance.agentAvatars?.[session.executorId] : undefined
  return {
    state: 'resolved', name: fields.has('name') || avatar ? session.label : undefined,
    provider: fields.has('provider') || avatar ? session.providerId : undefined,
    status: fields.has('status') ? session.status.state : undefined,
    statusLabel: fields.has('status') ? sessionStatusLabel(session) : undefined,
    workspace: fields.has('workspace') ? session.workspacePath : undefined,
    host: fields.has('host') ? session.hostId : undefined,
    sessionId: fields.has('sessionId') ? session.control.agentSessionId : undefined,
    runId: fields.has('runId') ? session.control.run.runId : undefined,
    executorId: avatar ? session.executorId : undefined,
    appearance: appearance ? { ...(appearance.tint === undefined ? {} : { tint: appearance.tint }), ...(appearance.badge === undefined ? {} : { badge: appearance.badge }) } : undefined
  }
}
function same(a: ToolkitAgentCardFacts | undefined, b: ToolkitAgentCardFacts) {
  return a?.state === b.state && a.reason === b.reason && a.name === b.name && a.provider === b.provider &&
    a.status === b.status && a.statusLabel === b.statusLabel && a.workspace === b.workspace && a.host === b.host &&
    a.sessionId === b.sessionId && a.runId === b.runId && a.executorId === b.executorId &&
    a.appearance?.tint === b.appearance?.tint && a.appearance?.badge === b.appearance?.badge
}

export function createToolkitAgentCardSelector(refs: readonly ToolkitAgentCardReference[], fields: readonly ToolkitAgentCardField[], active: boolean) {
  const selected = new Set(fields), wanted = new Map(refs.map(reference => [toolkitAgentCardKey(reference), reference]))
  let sessions: State['sessions'] | undefined, executors: AppConfig['executors'] | undefined
  let appearances: AppConfig['appearance']['agentAvatars'] | undefined
  let previous: ReadonlyMap<string, ToolkitAgentCardFacts> = EMPTY
  return (state: State): ReadonlyMap<string, ToolkitAgentCardFacts> => {
    if (!active || !selected.size || !wanted.size) return EMPTY
    const nextExecutors = selected.has('avatar') ? state.config?.executors : undefined
    const nextAppearances = selected.has('avatar') ? state.config?.appearance.agentAvatars : undefined
    if (sessions === state.sessions && executors === nextExecutors && appearances === nextAppearances) return previous
    sessions = state.sessions; executors = nextExecutors; appearances = nextAppearances
    const index = references(state.sessions), next = new Map<string, ToolkitAgentCardFacts>()
    let changed = previous.size !== wanted.size
    for (const key of wanted.keys()) {
      const projected = project(index.get(key), selected, state.config), old = previous.get(key)
      if (same(old, projected)) next.set(key, old!)
      else { next.set(key, projected); changed = true }
    }
    if (changed) previous = next
    return previous
  }
}
