import { collaborationSubjectKey } from './agent-collaboration'
import type { FocusContext } from './focus-context'
import type { CollaborationPulse } from './use-collaboration-reading'

export type FocusListActivity = { pulse: CollaborationPulse; direction: 'sent' | 'received' | 'self' | 'updated' }

export function focusListActivityKey(context: Pick<FocusContext, 'id' | 'hostId' | 'control'>) {
  return collaborationSubjectKey({ hostId: context.control?.hostId ?? context.hostId, agentSessionId: context.control?.agentSessionId ?? context.id })
}

export function indexFocusListActivity(pulses: readonly CollaborationPulse[], previous: ReadonlyMap<string, FocusListActivity>) {
  const next = new Map<string, FocusListActivity>()
  for (const pulse of pulses) {
    for (const agentSessionId of new Set([pulse.sender, pulse.recipient])) {
      const key = collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId })
      const direction = pulse.kind === 'supervision' ? 'updated' : pulse.sender === pulse.recipient ? 'self' : agentSessionId === pulse.sender ? 'sent' : 'received'
      const held = previous.get(key)
      next.set(key, held?.pulse === pulse && held.direction === direction ? held : { pulse, direction })
    }
  }
  return next
}
