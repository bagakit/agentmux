import type { FocusContext } from './focus-context'
import { useAppStore } from '../store'

export const FOCUS_AGENT_PIN_SCOPE = 'focus:agents'
export const EMPTY_FOCUS_AGENT_PINS: readonly string[] = []

/** Use the original Agent identity. Run, display position, and name can change. */
export function focusAgentPinKey(context: FocusContext): string | undefined {
  if (context.kind !== 'agent') return undefined
  if (context.access) {
    const identity = context.access.identity
    return identity.runtimeId ? JSON.stringify(['runtime', identity.runtimeId, identity.agentSessionId]) : undefined
  }
  const control = context.control
  return control ? JSON.stringify(['host', control.hostId, control.agentSessionId]) : undefined
}

/** Preserve an unobserved preference without deriving an actionable target from saved text. */
export function focusAgentPinLabel(key: string): string {
  try {
    const parts: unknown = JSON.parse(key)
    if (Array.isArray(parts) && parts.length === 3 && (parts[0] === 'host' || parts[0] === 'runtime') && typeof parts[2] === 'string') {
      return `Agent · ${parts[2]}`
    }
  } catch { /* The saved key is still removable. */ }
  return 'Saved Agent'
}

export function setFocusAgentPinned(key: string, wanted: boolean): void {
  const state = useAppStore.getState()
  const pinned = state.pinnedItems[FOCUS_AGENT_PIN_SCOPE]?.includes(key) === true
  if (pinned !== wanted) state.togglePinnedItem(FOCUS_AGENT_PIN_SCOPE, key)
}
