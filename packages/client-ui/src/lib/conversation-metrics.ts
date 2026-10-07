import type { AgentSessionHistoryItem, AgentSessionHistoryMetrics } from '@agentmux/core'

export type ConversationMetricsObservation = {
  metrics: AgentSessionHistoryMetrics
  /** Original records in this already-loaded source, never a complete-turn coverage claim. */
  recordIds: readonly string[]
  turnId?: string
}

/** Source-local reading projection. Each cumulative sample replaces, never adds to, its predecessor. */
export function projectConversationMetrics(items: readonly AgentSessionHistoryItem[]): Map<string, ConversationMetricsObservation> {
  const result = new Map<string, ConversationMetricsObservation>()
  const turns = new Map<string, { anchor: string; observation: ConversationMetricsObservation }>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const metrics = item.metrics
    if (!metrics) continue
    if (metrics.scope === 'response') {
      result.set(item.id, { metrics, recordIds: [item.id] })
    } else if (item.turnId) {
      const previous = turns.get(item.turnId)
      turns.set(item.turnId, { anchor: item.id, observation: {
        turnId: item.turnId,
        metrics: { ...previous?.observation.metrics, ...metrics },
        recordIds: [...previous?.observation.recordIds ?? [], item.id]
      } })
    }
  }
  for (const { anchor, observation } of turns.values()) result.set(anchor, observation)
  return result
}
