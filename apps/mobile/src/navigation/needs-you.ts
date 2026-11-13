import type { AgentDisplayState } from '@agentmux/core'
import { AGENT_DISPLAY_STATES, isNeedsYouState } from '@agentmux/client-ui/attention-vocabulary'
import type { MobileAgentPresentation } from './mobile-agent-status'

/**
 * Presentation-only attention facts for the phone shell.
 *
 * Membership reads only the typed group/state/stateMark published by the original Focus
 * presentation owner, which already folds a pending interaction into its attention group.
 * Display labels are never read, and nothing here grants input, permission or recovery.
 */
export type MobileNeedsYouReason = 'waiting' | 'error'
export type MobileNeedsYouItem = { agentSessionId: string; reason: MobileNeedsYouReason; row: MobileAgentPresentation | undefined }

export function mobileNeedsYouReason(row: MobileAgentPresentation | undefined): MobileNeedsYouReason | null {
  if (!row) return null
  if (row.state === 'error' || row.stateMark === 'error') return 'error'
  const displayState = (AGENT_DISPLAY_STATES as readonly string[]).includes(row.state) ? row.state as AgentDisplayState : null
  if (row.group === 'attention' || row.stateMark === 'attention' || displayState && isNeedsYouState(displayState)) return 'waiting'
  return null
}

/** Waits first, then errors; ties keep the original owner order. */
export function mobileNeedsYou(rows: readonly MobileAgentPresentation[] | undefined): MobileNeedsYouItem[] {
  const rank: Record<MobileNeedsYouReason, number> = { waiting: 0, error: 1 }
  const seen = new Set<string>(), items: MobileNeedsYouItem[] = []
  for (const row of rows ?? []) {
    if (seen.has(row.agentSessionId)) continue
    seen.add(row.agentSessionId)
    const reason = mobileNeedsYouReason(row)
    if (reason) items.push({ agentSessionId: row.agentSessionId, reason, row })
  }
  return items.map((item, index) => ({ item, index })).sort((a, b) => rank[a.item.reason] - rank[b.item.reason] || a.index - b.index).map(value => value.item)
}

/** Other objects waiting for the person, excluding the conversation currently in front of them. */
export function mobileNeedsYouElsewhere(items: readonly MobileNeedsYouItem[], currentSessionId: string | null): number {
  return items.filter(item => item.agentSessionId !== currentSessionId).length
}
