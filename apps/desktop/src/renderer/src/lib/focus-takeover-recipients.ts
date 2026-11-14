import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { SessionSnapshot } from '../../../shared/contracts'
import { desktopAgentExecutionFromSpatial } from './desktop-agent-presentation'
import { sessionTakeoverPresentations } from './session-presentation'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
type Regions = Readonly<AgentMuxSpatialGraph['regions']>
export type FocusTakeoverRecipient = {
  key: string; runtimeId: string; sessionId: string; subject: Agent['control']
  operationId: string; continued: boolean; label: string; providerId: string; executorId: string
}
const identity = (scope: string, sessionId: string) => JSON.stringify([scope, sessionId])
const regionsByAgent = new WeakMap<Regions, Map<string, Regions[number][]>>()

/** Ordinary Focus IDs are presentation keys. Only Core bindings qualify their Runtime. */
export function focusTakeoverRuntime(session: SessionSnapshot, regions: Regions | null): string | undefined {
  if (session.kind !== 'agent' || !regions) return
  let index = regionsByAgent.get(regions)
  if (!index) {
    index = new Map()
    for (const region of regions) {
      if (region.kind !== 'agent' || !region.agentSessionId || !region.execution) continue
      const key = identity(region.execution.hostId, region.agentSessionId)
      let members = index.get(key)
      if (!members) { members = []; index.set(key, members) }
      members.push(region)
    }
    regionsByAgent.set(regions, index)
  }
  let runtimeId: string | undefined
  for (const region of index.get(identity(session.control.hostId, session.control.agentSessionId)) ?? []) {
    const candidate = desktopAgentExecutionFromSpatial(region, session)?.runtimeId
    if (!candidate) continue
    if (runtimeId && runtimeId !== candidate) return
    runtimeId = candidate
  }
  return runtimeId
}

const empty: readonly FocusTakeoverRecipient[] = []
let last: { sessions: readonly SessionSnapshot[]; regions: Regions; bySource: ReadonlyMap<string, readonly FocusTakeoverRecipient[]> } | undefined

/** Reuse the same projection on every card. Independent feedback records and
 * admission-only positions do not prove a receiving Agent was created. */
export function focusTakeoverRecipients(sessions: readonly SessionSnapshot[], regions: Regions | null,
  source: { runtimeId: string; agentSessionId: string }): readonly FocusTakeoverRecipient[] {
  if (!regions) return empty
  if (last?.sessions !== sessions || last.regions !== regions) {
    const bySource = new Map<string, Map<string, FocusTakeoverRecipient>>()
    for (const session of sessionTakeoverPresentations(sessions)) {
      const creation = session.creation, original = creation?.takeover?.source
      if (!creation || !original?.agentSessionId) continue
      const runtimeId = focusTakeoverRuntime(session, regions)
      if (!runtimeId) continue
      const sourceKey = identity(original.runtimeId, original.agentSessionId)
      const key = identity(runtimeId, session.control.agentSessionId)
      let targets = bySource.get(sourceKey)
      if (!targets) { targets = new Map(); bySource.set(sourceKey, targets) }
      if (targets.has(key)) continue
      const previous = last?.bySource.get(sourceKey)?.[targets.size]
      const continued = creation.initialPrompt === 'confirmed'
      const target = previous?.key === key && previous.sessionId === session.id && previous.subject.hostId === session.control.hostId &&
        previous.subject.run.runId === session.control.run.runId &&
        previous.operationId === creation.createOperationId && previous.continued === continued && previous.label === session.label &&
        previous.executorId === session.executorId && previous.providerId === session.providerId ? previous
        : { key, runtimeId, subject: session.control, sessionId: session.id, operationId: creation.createOperationId,
          continued, label: session.label, providerId: session.providerId, executorId: session.executorId }
      targets.set(key, target)
    }
    const lists = new Map<string, readonly FocusTakeoverRecipient[]>()
    for (const [key, targets] of bySource) {
      const current = [...targets.values()], previous = last?.bySource.get(key)
      lists.set(key, previous?.length === current.length && current.every((target, index) => target === previous[index]) ? previous : current)
    }
    last = { sessions, regions, bySource: lists }
  }
  return last.bySource.get(identity(source.runtimeId, source.agentSessionId)) ?? empty
}
