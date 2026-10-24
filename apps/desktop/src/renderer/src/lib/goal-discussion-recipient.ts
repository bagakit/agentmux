import { useShallow } from 'zustand/react/shallow'
import { useAppStore, currentCoreSpatialGraph } from '../store'
import { readGoalDiscussionBinding, resolveGoalDiscussionBinding } from '@agentmux/host/goal-discussion-bindings'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { agentDisplayName } from './workbench-tabs'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { agentSessionPresentationIndex, sessionPresentationById } from './session-presentation'

type State = Pick<ReturnType<typeof useAppStore.getState>, 'demandPmoTabIds' | 'tabs' | 'layouts'>
/** Read the same dedicated workface used by the original discussion owner. Never substitute the Supervisor. */
export function goalDiscussionTarget(state: State, goalId: string, graph: AgentMuxSpatialGraph | null = currentCoreSpatialGraph()) {
  if (!graph) return { kind: 'unconfirmed' as const }
  try {
    const binding = readGoalDiscussionBinding(graph, goalId)
    if (!binding) return state.demandPmoTabIds[goalId] ? { kind: 'unconfirmed' as const } : { kind: 'new' as const }
    resolveGoalDiscussionBinding(graph, binding)
    const tab = state.tabs[binding.tabId], region = tab?.regions[binding.regionId]
    if (!tab || !region || region.kind !== binding.recipient.kind) return { kind: 'unconfirmed' as const }
    return { kind: 'existing' as const, tabId: binding.tabId, tab, region, recipient: binding.recipient }
  } catch { return { kind: 'unconfirmed' as const } }
}

export function useGoalDiscussionRecipient(goalId: string) {
  const data = useAppStore(useShallow(state => {
    const target = goalDiscussionTarget(state, goalId)
    const session = target.kind === 'existing' && target.region.kind === 'agent' ? sessionPresentationById(state.sessions).get(target.region.sessionId) : undefined
    const known = target.kind === 'existing' && target.recipient.kind === 'agent' && session?.kind === 'agent' && session.control.kind === 'agent' &&
      session.control.hostId === target.recipient.hostId && session.control.agentSessionId === target.recipient.agentSessionId
    const name = known ? agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId }) : null
    return { kind: target.kind, name, launcher: target.kind === 'existing' && target.region.kind === 'launcher', outlined: Boolean(state.demands[goalId]?.alignment) }
  }))
  const recipient = data.name ?? 'the goal discussion'
  return { kind: data.kind, name: data.name,
    openLabel: data.kind === 'new' ? 'Start goal discussion' : data.name ? `Open discussion with ${data.name}` : 'Open original discussion',
    requestLabel: (mode: 'grill' | 'grounding') => mode === 'grounding' ? `Ask ${recipient} to check results` : data.name ? `${data.outlined ? 'Discuss changes' : 'Clarify goal'} with ${data.name}` : data.outlined ? 'Discuss changes in goal discussion' : 'Clarify goal in discussion',
    description: data.kind === 'new' ? 'Starts a dedicated discussion in your primary Mote.' : data.name ? 'Sends to this goal’s dedicated discussion.' : data.launcher ? 'The original discussion launcher is kept. Open it to choose an Agent; a request prepares this discussion.' : 'The original discussion Agent is not yet confirmed. Its identity and request are kept.' }
}

/** Presentation for one exact canonical recipient; absence never selects a replacement. */
export function useGoalAgentName(agentSessionId: string | null | undefined, hostId?: string): string | null {
  return useAppStore(state => {
    if (!agentSessionId) return null
    const matches = (agentSessionPresentationIndex(state.sessions).get(agentSessionId) ?? []).filter(session => session.control.agentSessionId === agentSessionId &&
      session.control.hostId === session.hostId && (hostId === undefined || session.control.hostId === hostId))
    const session = matches.length === 1 ? matches[0] : undefined
    return session?.kind === 'agent' ? agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId }) : null
  })
}
