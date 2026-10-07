import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import type { FocusContext } from './focus-context'
import type { FocusContextIdentity } from './focus-context-identity'
import type { FocusGoalLinks } from './focus-goal-links'
import { useAppStore } from '../store'

/** One window's reading intent, not a Session, source cache or execution owner. */
export type AgentInformationPreview = {
  token: object
  id: string
  context: FocusContext
  identity?: FocusContextIdentity | undefined
  goalLinks?: FocusGoalLinks | undefined
  anchor: HTMLButtonElement
  keepOpen(): void
  restoreFocus(): void
  openWorkface(): void
  session: SessionSnapshot | undefined
  control: AgentSessionControl | undefined
  sourceKey: string | undefined
  enterReading: boolean
  pinned: boolean
}

let current: AgentInformationPreview | null = null
const listeners = new Set<() => void>()
function publish(next: AgentInformationPreview | null) {
  current = next
  for (const listener of listeners) listener()
}

export const agentInformationPreview = {
  get: () => current,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  show(request: Omit<AgentInformationPreview, 'session' | 'control' | 'sourceKey' | 'pinned'>): boolean {
    if (current?.pinned) return current.token === request.token
    if (current?.token === request.token) return true
    const session = useAppStore.getState().sessions.find(session => session.id === request.context.id &&
      session.hostId === request.context.hostId && session.control.run.runId === request.context.runId)
    const control = session?.kind === 'agent' && session.control.hostId === request.context.hostId ? session.control : undefined
    publish({ ...request, session, control, sourceKey: session?.kind === 'agent' ? nativeBindingKey(session) : undefined, pinned: false })
    return true
  },
  dismiss(token: object, explicit = false) {
    if (current?.token === token && (explicit || !current.pinned)) publish(null)
  },
  pin(token: object) {
    if (current?.token === token) publish({ ...current, pinned: !current.pinned })
  }
}
