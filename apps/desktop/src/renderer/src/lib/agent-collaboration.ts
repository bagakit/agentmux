import type { AgentMuxMessageEvent, AgentMuxMessageEventReference, AgentMuxSpawnRecord } from '@agentmux/core'
import type { SessionHistoryReference } from '../../../shared/contracts'
import type { FocusContext } from './focus-context'

export type CollaborationSubject = SessionHistoryReference
export const collaborationSubjectKey = (subject: CollaborationSubject) => JSON.stringify([subject.hostId, subject.agentSessionId])
export type CollaborationArea = { id: string; name: string; kind: 'mote' | 'topic' | 'project' | 'unplaced'; members: readonly string[]; issue?: string | null }
export type CollaborationReading = {
  subject: CollaborationSubject
  incarnation: string | null
  events: readonly AgentMuxMessageEvent[]
  spawns: readonly AgentMuxSpawnRecord[]
  /** Ephemeral page deltas for this reader; original flat rows remain the facts. */
  changes?: CollaborationChanges | undefined
}
export type CollaborationChanges = {
  previous: CollaborationChanges | undefined
  events: readonly AgentMuxMessageEvent[]
  spawns: readonly AgentMuxSpawnRecord[]
}
export type CollaborationEvidence =
  | { kind: 'communication'; id: string; subject: CollaborationSubject; incarnation: string | null; message: AgentMuxMessageEventReference; events: readonly AgentMuxMessageEvent[] }
  | { kind: 'creation'; id: string; subject: CollaborationSubject; record: AgentMuxSpawnRecord }
  | { kind: 'supervision'; id: string; subject: CollaborationSubject; incarnation: string | null; events: readonly AgentMuxMessageEvent[] }
export type CollaborationRelation = {
  id: string; source: string; target: string; kind: CollaborationEvidence['kind']; evidence: CollaborationEvidence[]
}
export type CollaborationAgent = { id: string; subject: CollaborationSubject | null; sessionId: string; context?: FocusContext; provenance?: string }

/** Original owner + Session is identity. Display context IDs and area membership are not. */
export function collaborationAgents(contexts: readonly FocusContext[]): Map<string, CollaborationAgent> {
  const result = new Map<string, CollaborationAgent>()
  for (const context of contexts) if (context.control) {
    const subject = { hostId: context.control.hostId, agentSessionId: context.control.agentSessionId }, id = collaborationSubjectKey(subject)
    if (!result.has(id)) result.set(id, { id, subject, sessionId: subject.agentSessionId, context })
  }
  return result
}

type MessageContribution = { subject: CollaborationSubject; incarnation: string | null; ref: AgentMuxMessageEventReference; events: Map<number, AgentMuxMessageEvent> }
type CreationContribution = { subject: CollaborationSubject; record: AgentMuxSpawnRecord }
type SourceProjection = { reading: CollaborationReading; messages: Set<string>; creations: Set<string> }

/** Incremental, disposable projection of original rows. It performs no IO and owns no journal. */
export function createCollaborationProjector() {
  const sources = new Map<string, SourceProjection>()
  const messages = new Map<string, Map<string, MessageContribution>>()
  const creations = new Map<string, Map<string, CreationContribution>>()
  const relationEvidence = new Map<string, Map<string, CollaborationEvidence>>()
  const dirtyRelations = new Map<string, { kind: CollaborationRelation['kind']; source: string; target: string }>()
  const relations = new Map<string, CollaborationRelation>()
  const agentUses = new Map<string, number>()
  let agents = new Map<string, CollaborationAgent>(), relationList: CollaborationRelation[] = []
  let result = { agents, relations: relationList }, copiedAgents = false, relationsChanged = false
  function useAgent(agent: CollaborationAgent, delta: number) {
    const count = (agentUses.get(agent.id) ?? 0) + delta
    if (count > 0) agentUses.set(agent.id, count)
    else agentUses.delete(agent.id)
    if (count > 0 && !agents.has(agent.id) || count === 0 && agents.has(agent.id)) {
      if (!copiedAgents) { agents = new Map(agents); copiedAgents = true }
      if (count > 0) agents.set(agent.id, agent); else agents.delete(agent.id)
    }
  }
  const agent = (subject: CollaborationSubject): CollaborationAgent => ({ id: collaborationSubjectKey(subject), subject, sessionId: subject.agentSessionId })
  function setEvidence(kind: CollaborationRelation['kind'], from: CollaborationAgent, to: CollaborationAgent, id: string, evidence?: CollaborationEvidence) {
    const relationId = JSON.stringify([kind, from.id, to.id])
    const held = relationEvidence.get(relationId) ?? new Map<string, CollaborationEvidence>()
    if (held.get(id) === evidence) return
    const existed = held.size > 0
    relationsChanged = true; dirtyRelations.set(relationId, { kind, source: from.id, target: to.id })
    if (evidence) held.set(id, evidence); else held.delete(id)
    if (held.size) {
      relationEvidence.set(relationId, held)
      if (!existed) { useAgent(from, 1); useAgent(to, 1) }
    } else {
      relationEvidence.delete(relationId)
      if (existed) { useAgent(from, -1); useAgent(to, -1) }
    }
  }

  function messageEvidence(id: string, previous?: MessageContribution) {
    const contributors = messages.get(id), first = contributors?.values().next().value as MessageContribution | undefined
    const owner = first ?? previous
    if (!owner) return
    const from = agent({ hostId: owner.subject.hostId, agentSessionId: owner.ref.senderSessionId })
    const to = agent({ hostId: owner.subject.hostId, agentSessionId: owner.ref.recipientSessionId })
    const events = new Map<number, AgentMuxMessageEvent>()
    if (contributors) for (const source of contributors.values()) for (const [sequence, event] of source.events) if (!events.has(sequence)) events.set(sequence, event)
    const ordered = [...events.values()].sort((a, b) => a.sequence - b.sequence)
    const communication = relationEvidence.get(JSON.stringify(['communication', from.id, to.id]))?.get(id)
    // Another participant may report the same immutable original event. Preserve the evidence owner and reference.
    const unchanged = first && communication?.kind === 'communication' && communication.subject === first.subject && communication.events.length === ordered.length && communication.events.every((event, index) => event.sequence === ordered[index]!.sequence)
    if (unchanged) return
    setEvidence('communication', from, to, id, first ? { kind: 'communication', id, subject: first.subject, incarnation: first.incarnation, message: first.ref, events: ordered } : undefined)
    const supervised = ordered.filter(event => event.kind === 'dispatch-open' || event.kind === 'dispatch-event')
    setEvidence('supervision', from, to, id, first && supervised.length ? { kind: 'supervision', id, subject: first.subject, incarnation: first.incarnation, events: supervised } : undefined)
  }
  function creationEvidence(id: string, previous?: CreationContribution) {
    const contributors = creations.get(id), first = contributors?.values().next().value as CreationContribution | undefined
    const owner = first ?? previous
    if (!owner) return
    const creator = owner.record.creation.createdBy, hostId = owner.subject.hostId
    const from = creator.owner.kind === 'local' ? agent({ hostId, agentSessionId: creator.agentSessionId }) : {
      id: JSON.stringify(['runtime-reference', creator.owner.runtimeId, creator.agentSessionId]), subject: null, sessionId: creator.agentSessionId, provenance: `Runtime ${creator.owner.runtimeId}` }
    const to = agent({ hostId, agentSessionId: owner.record.agentSessionId })
    const held = relationEvidence.get(JSON.stringify(['creation', from.id, to.id]))?.get(id)
    if (first && held?.kind === 'creation' && held.subject === first.subject && held.record === first.record) return
    setEvidence('creation', from, to, id, first ? { kind: 'creation', id, subject: first.subject, record: first.record } : undefined)
  }
  return (readings: readonly CollaborationReading[]) => {
    copiedAgents = false; relationsChanged = false; dirtyRelations.clear()
    const active = new Set(readings.map(reading => collaborationSubjectKey(reading.subject)))
    const dirtyMessages = new Map<string, MessageContribution | undefined>(), dirtyCreations = new Map<string, CreationContribution | undefined>()
    function remove(key: string, held: SourceProjection) {
      for (const id of held.messages) { const group = messages.get(id)!; dirtyMessages.set(id, group.get(key)); group.delete(key); if (!group.size) messages.delete(id) }
      for (const id of held.creations) { const group = creations.get(id)!; dirtyCreations.set(id, group.get(key)); group.delete(key); if (!group.size) creations.delete(id) }
    }
    for (const [key, held] of sources) if (!active.has(key)) { remove(key, held); sources.delete(key) }
    for (const reading of readings) {
      const key = collaborationSubjectKey(reading.subject), old = sources.get(key)
      if (old?.reading === reading) continue
      let reset = !old || old.reading.incarnation !== reading.incarnation
      const changes: CollaborationChanges[] = []
      if (!reset && reading.changes !== old!.reading.changes) {
        let change = reading.changes
        while (change && change !== old!.reading.changes) { changes.push(change); change = change.previous }
        if (change !== old!.reading.changes) reset = true
      }
      // Standalone callers have original flat rows without the reader's page hints.
      if (!reading.changes && old && (reading.events !== old.reading.events || reading.spawns !== old.reading.spawns)) reset = true
      if (reset && old) remove(key, old)
      const held = reset ? { reading, messages: new Set<string>(), creations: new Set<string>() } : old!
      const eventPages = reset ? [reading.events] : changes.reverse().map(change => change.events)
      const spawnPages = reset ? [reading.spawns] : changes.map(change => change.spawns)
      const { hostId } = reading.subject
      for (const events of eventPages) for (const event of events) for (const ref of event.messages) {
        const id = JSON.stringify([hostId, reading.incarnation, ref.messageId])
        const group = messages.get(id) ?? new Map<string, MessageContribution>()
        const contribution = group.get(key) ?? { subject: reading.subject, incarnation: reading.incarnation, ref, events: new Map<number, AgentMuxMessageEvent>() }
        if (!contribution.events.has(event.sequence)) { contribution.events.set(event.sequence, event); dirtyMessages.set(id, undefined) }
        group.set(key, contribution); messages.set(id, group); held.messages.add(id)
      }
      for (const records of spawnPages) for (const record of records) {
        const id = JSON.stringify([hostId, record.agentSessionId]), group = creations.get(id) ?? new Map<string, CreationContribution>()
        group.set(key, { subject: reading.subject, record }); creations.set(id, group); held.creations.add(id); dirtyCreations.set(id, undefined)
      }
      held.reading = reading; sources.set(key, held)
    }
    for (const [id, previous] of dirtyMessages) messageEvidence(id, previous)
    for (const [id, previous] of dirtyCreations) creationEvidence(id, previous)
    for (const [id, endpoints] of dirtyRelations) {
      const evidence = relationEvidence.get(id)
      if (evidence) relations.set(id, { id, ...endpoints, evidence: [...evidence.values()] }); else relations.delete(id)
    }
    if (relationsChanged) relationList = [...relations.values()]
    if (result.agents !== agents || result.relations !== relationList) result = { agents, relations: relationList }
    return result
  }
}

/** One-shot use of the same original metadata projection; UI owners retain the projector. */
export function projectCollaboration(readings: readonly CollaborationReading[], originals: Map<string, CollaborationAgent>) {
  const result = createCollaborationProjector()(readings)
  return originals.size ? { ...result, agents: new Map([...result.agents, ...originals]) } : result
}

/** Areas can overlap; each relation keeps one source identity through folding. */
export function visibleCollaboration(relations: readonly CollaborationRelation[], members: ReadonlySet<string>, kinds: ReadonlySet<CollaborationRelation['kind']>, focus?: string) {
  return relations.filter(relation => kinds.has(relation.kind) && (focus ? relation.source === focus || relation.target === focus : members.has(relation.source) || members.has(relation.target)))
}
