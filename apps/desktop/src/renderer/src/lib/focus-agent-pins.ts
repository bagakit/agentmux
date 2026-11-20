import type { FocusContext } from './focus-context'
import { focusScanPreferenceKey, type FocusScanLane } from './focus-collection-lanes'
import { focusContextIdentityKey } from './focus-context-identity'
import { useAppStore } from '../store'

export const FOCUS_AGENT_PIN_SCOPE = 'focus:agents'
export const EMPTY_FOCUS_AGENT_PINS: readonly string[] = []
export const focusAgentPinScope = (group: string) => `${FOCUS_AGENT_PIN_SCOPE}:${group}`
export type FocusAgentPinGroup = { scope: string; originalPins: readonly string[] }

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

/** The original saved preference can only project into a uniquely confirmed group. */
export function originalFocusPinGroups(keys: readonly string[], contexts: readonly FocusContext[], lanes: readonly FocusScanLane[]) {
  const resolved = new Map<string, string[]>()
  if (!keys.length) return resolved
  const wanted = new Set(keys), subjectByRow = new Map<string, string>(), groupBySubject = new Map<string, string | null>()
  for (const context of contexts) {
    const key = focusAgentPinKey(context)
    if (key && wanted.has(key)) subjectByRow.set(focusContextIdentityKey(context.hostId, context.id), key)
  }
  for (const lane of lanes) {
    const group = focusScanPreferenceKey(lane)
    for (const ref of lane.contextRefs) {
      const subject = subjectByRow.get(focusContextIdentityKey(ref.hostId, ref.id))
      if (!subject) continue
      const previous = groupBySubject.get(subject)
      if (!group || (previous !== undefined && previous !== group)) groupBySubject.set(subject, null)
      else groupBySubject.set(subject, group)
    }
  }
  for (const subject of keys) {
    const group = groupBySubject.get(subject)
    if (!group) continue
    const scope = focusAgentPinScope(group), items = resolved.get(scope) ?? []
    items.push(subject)
    resolved.set(scope, items)
  }
  return resolved
}

export function setFocusAgentPinned(group: FocusAgentPinGroup, key: string, wanted: boolean): void {
  const state = useAppStore.getState()
  const pinned = state.pinnedItems[group.scope]?.includes(key) === true
  if (pinned !== wanted) state.togglePinnedItem(group.scope, key)
  if (!wanted && group.originalPins.includes(key) && state.pinnedItems[FOCUS_AGENT_PIN_SCOPE]?.includes(key)) state.togglePinnedItem(FOCUS_AGENT_PIN_SCOPE, key)
}
