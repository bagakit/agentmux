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
  contentChanged: boolean
}

let current: AgentInformationPreview | null = null
const listeners = new Set<() => void>()
let pending: { token: object; cancel(): void } | null = null
function cancelIntent(token?: object) {
  if (pending && (!token || pending.token === token)) { const intent = pending; pending = null; intent.cancel() }
}
function publish(next: AgentInformationPreview | null) {
  current = next
  for (const listener of listeners) listener()
}

export const agentInformationPreview = {
  get: () => current,
  cancelIntent,
  schedule(token: object, cancel: () => void): boolean {
    cancelIntent()
    if (current?.pinned) return false
    pending = { token, cancel }; return true
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  show(request: Omit<AgentInformationPreview, 'session' | 'control' | 'sourceKey' | 'pinned' | 'contentChanged'>): boolean {
    cancelIntent()
    if (current?.pinned) return current.token === request.token
    if (current?.token === request.token) return true
    const session = useAppStore.getState().sessions.find(session => session.id === request.context.id &&
      session.hostId === request.context.hostId && session.control.run.runId === request.context.runId)
    const control = session?.kind === 'agent' && session.control.hostId === request.context.hostId ? session.control : undefined
    publish({ ...request, session, control, sourceKey: session?.kind === 'agent' ? nativeBindingKey(session) : undefined, pinned: false, contentChanged: false })
    return true
  },
  noteContent(token: object, context: FocusContext) {
    const request = current
    if (!request?.pinned || request.token !== token || request.contentChanged) return
    const original = useAppStore.getState().sessions.find(session => session.id === request.context.id &&
      session.hostId === request.context.hostId && session.control.run.runId === request.context.runId)
    if (context.hostId !== request.context.hostId || context.id !== request.context.id || context.runId !== request.context.runId ||
      !original || original.kind === 'agent' && (original.control.hostId !== request.control?.hostId || original.control.agentSessionId !== request.control?.agentSessionId || nativeBindingKey(original) !== request.sourceKey)) return
    const before = request.context.recap, after = context.recap
    // A changed display projection is not a new authenticated message identity.
    if (before?.source !== after?.source || before?.origin !== after?.origin ||
      (before?.reading?.text ?? before?.text) !== (after?.reading?.text ?? after?.text)) publish({ ...request, contentChanged: true })
  },
  dismiss(token: object, explicit = false) {
    cancelIntent(token)
    if (current?.token === token && (explicit || !current.pinned)) publish(null)
  },
  pin(token: object) {
    if (current?.token === token) publish({ ...current, pinned: !current.pinned })
  }
}
