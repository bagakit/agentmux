import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { AgentSteerQueueEntry } from '../store'

export type LocalInputTarget = { hostId: string; agentSessionId: string }
export type LocalRetainedInput = {
  kind: 'draft' | 'queue'
  key: string
  target?: LocalInputTarget | undefined
  text: string
  entry?: AgentSteerQueueEntry
}

function exactTarget(candidates: readonly (LocalInputTarget | undefined)[]): LocalInputTarget | undefined {
  const known = candidates.filter((value): value is LocalInputTarget => Boolean(value?.hostId && value.agentSessionId))
  const first = known[0]
  return first && known.every(value => value.hostId === first.hostId && value.agentSessionId === first.agentSessionId) ? first : undefined
}

/** A reading projection of existing client owners. Missing bindings retain the original key. */
export function localRetainedInputs(drafts: Readonly<Record<string, string>>, queues: Readonly<Record<string, readonly AgentSteerQueueEntry[]>>,
  graph: AgentMuxSpatialGraph | null): LocalRetainedInput[] {
  const regions = new Map<string, LocalInputTarget[]>()
  for (const region of graph?.regions ?? []) if (region.kind === 'agent' && region.agentSessionId && region.execution) {
    const targets = regions.get(region.regionId) ?? []
    targets.push({ hostId: region.execution.hostId, agentSessionId: region.agentSessionId })
    regions.set(region.regionId, targets)
  }
  const inputs: LocalRetainedInput[] = []
  for (const [key, text] of Object.entries(drafts)) if (text) inputs.push({ kind: 'draft', key, text,
    target: exactTarget(regions.get(key) ?? []) })
  for (const [key, queue] of Object.entries(queues)) for (const entry of queue) inputs.push({ kind: 'queue', key,
    text: entry.text, entry, target: exactTarget([entry.directInputControl, entry.resumeInputIntent?.control, entry.browserRecipient]) })
  return inputs
}
