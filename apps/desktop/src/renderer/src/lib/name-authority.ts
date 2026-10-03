import { AGENTMUX_DISPLAY_LABEL_RESOURCE, displayLabelDocument, nameTargetKey,
  type AgentMuxDisplayLabel, type AgentMuxSpatialState } from '@agentmux/core/spatial-graph'

/** A cache of acknowledged host labels, never a second naming owner. */
export type NameProjection = { nameAuthorityRevision: number; nameLabels: Record<string, AgentMuxDisplayLabel>;
  agentNames: Record<string, string>; surveyExplorationNames: Record<string, string> }
export function acknowledgedNameProjection(state: AgentMuxSpatialState, currentRevision: number): NameProjection | null {
  if (state.revision < currentRevision || !Object.hasOwn(state.graph.resources, AGENTMUX_DISPLAY_LABEL_RESOURCE)) return null
  const document = displayLabelDocument(state.graph), agentNames: Record<string, string> = {}, surveyExplorationNames: Record<string, string> = {}
  for (const label of Object.values(document.labels)) {
    if (label.value === null) continue
    if (label.target.kind === 'agent-session') agentNames[label.target.id] = label.value
    if (label.target.kind === 'zone') surveyExplorationNames[label.target.id] = label.value
  }
  return { nameAuthorityRevision: state.revision, nameLabels: document.labels, agentNames, surveyExplorationNames }
}
export function projectedNameRevision(labels: Record<string, AgentMuxDisplayLabel>, kind: string, id: string): number {
  return labels[nameTargetKey({ kind, id })]?.nameRevision ?? 0
}
