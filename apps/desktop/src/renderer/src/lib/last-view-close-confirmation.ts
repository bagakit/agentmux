import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { agentDisplayName, type WorkbenchTab } from './workbench-tabs'
import { agentSessionsWithoutViewsAfterClosing, type WorkbenchViewClosing } from './workbench-view-close'

/**
 * One confirmation for "this close removes the last View of these Agents", shared by Tab close and
 * split close. `agents` are stopped by the default action; `unconfirmed` are named but never stopped.
 */
export type LastViewCloseConfirmation = {
  agents: Array<{ sessionId: string; name: string }>
  unconfirmed: string[]
  dirtyCount: number
}

export function lastViewCloseConfirmation(input: {
  tabs: Readonly<Record<string, WorkbenchTab>>
  sessions: readonly SessionSnapshot[]
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
  agentNames: Readonly<Record<string, string>>
  isClosing: WorkbenchViewClosing
  dirtyCount: number
}): LastViewCloseConfirmation | null {
  const affected = agentSessionsWithoutViewsAfterClosing(input)
  if (affected.sessions.length === 0 && affected.unconfirmed.length === 0 && input.dirtyCount === 0) return null
  return {
    agents: affected.sessions.map((session) => ({
      sessionId: session.id,
      name: session.kind === 'agent'
        ? agentDisplayName({
            userName: input.agentNames[session.id],
            firstPrompt: firstPromptFromTimeline(input.timelines[session.id]),
            fallbackLabel: session.label,
            providerLabel: session.providerId
          })
        : session.label
    })),
    unconfirmed: affected.unconfirmed.map((item) => item.agentSessionId === null
      ? 'a Browser’s Agent'
      : input.agentNames[item.agentSessionId] ?? `Agent ${item.agentSessionId}`),
    dirtyCount: input.dirtyCount
  }
}

/** Whether the confirmation offers Stop: only for Agents whose Session and Run are confirmed live. */
export function lastViewCloseStops(confirmation: LastViewCloseConfirmation | null): boolean {
  return (confirmation?.agents.length ?? 0) > 0
}

export function lastViewCloseCopy(confirmation: LastViewCloseConfirmation, scope: 'tab' | 'tabs' | 'split'): {
  title: string
  description: string
  confirmLabel: string
  secondaryLabel?: string
} {
  const { agents, unconfirmed, dirtyCount } = confirmation
  const unsaved = dirtyCount > 0
    ? scope === 'split'
      ? ' Unsaved or retained editor contents in this split will be discarded.'
      : ' Unsaved or retained editor contents will be discarded.'
    : ''
  const unconfirmedSentence = unconfirmed.length > 0
    ? ` Whether ${list(unconfirmed)} still ${unconfirmed.length > 1 ? 'have' : 'has'} another View could not be confirmed; closing does not stop ${unconfirmed.length > 1 ? 'them' : 'it'}.`
    : ''
  if (agents.length > 0) {
    const many = agents.length > 1
    return {
      title: many ? `Stop ${agents.length} Agent Sessions?` : 'Stop Agent Session?',
      description: `This closes the last View of ${list(agents.map((agent) => agent.name))}. Stop & Close stops ${many ? 'their Runs' : 'its Run'}; Keep ${many ? 'Sessions' : 'Session'} & Close sends no new Stop; it does not cancel an earlier Stop.${unconfirmedSentence}${unsaved}`,
      confirmLabel: 'Stop & Close',
      secondaryLabel: many ? 'Keep Sessions & Close' : 'Keep Session & Close'
    }
  }
  if (unconfirmed.length > 0) {
    return {
      title: 'Close without confirming the Agent?',
      description: `This may close the last View of ${list(unconfirmed)}.${unconfirmedSentence}${unsaved}`,
      confirmLabel: dirtyCount > 0 ? 'Discard & Close' : 'Close'
    }
  }
  return {
    title: 'Discard editor contents?',
    description: scope === 'split'
      ? 'Closing this split will discard its unsaved or retained editor contents.'
      : scope === 'tabs'
        ? 'Closing these tabs will discard their unsaved or retained editor contents.'
        : 'Closing this editor tab will discard its unsaved or retained contents.',
    confirmLabel: 'Discard & Close'
  }
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Human copy consumes the Main-frozen plan, never a freshly inferred execution target. */
export function preparedCloseConfirmation(record: import('@agentmux/core').SpaceCloseReceipt, input: {
  sessions: readonly SessionSnapshot[]; timelines: Readonly<Record<string, AgentTimelineSnapshot>>; agentNames: Readonly<Record<string, string>>
}): LastViewCloseConfirmation | null {
  const projection = record.plan.projection
  const agents = projection.resources.flatMap(resource => {
    if (resource.kind !== 'session' || resource.control.kind !== 'agent') return []
    const session = input.sessions.find(s => s.id === resource.sessionId)
    return [{ sessionId: resource.sessionId, name: session?.kind === 'agent' ? agentDisplayName({ userName: input.agentNames[session.id],
      firstPrompt: firstPromptFromTimeline(input.timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId }) : resource.control.agentSessionId }]
  })
  const unconfirmed = projection.closesView ? projection.surfaces.filter(s => s.bindingAvailability === 'unconfirmed').map(s => s.binding?.agentSessionId ??
    (s.owner.kind === 'agent' ? s.owner.sessionId : 'the original Browser Agent')) : []
  const dirtyCount = projection.drafts.length
  return agents.length || unconfirmed.length || dirtyCount ? { agents, unconfirmed, dirtyCount } : null
}
