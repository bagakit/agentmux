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

/** Rebuildable metadata projection. No message body, task verdict or permission is inferred. */
export function projectCollaboration(readings: readonly CollaborationReading[], originals: Map<string, CollaborationAgent>) {
  const agents = new Map(originals), relations = new Map<string, CollaborationRelation>()
  const eventSources = new Map<string, Map<string, AgentMuxMessageEvent>>()
  const messages = new Map<string, { subject: CollaborationSubject; incarnation: string | null; ref: AgentMuxMessageEventReference }>()
  const supervision = new Map<string, { subject: CollaborationSubject; incarnation: string | null; ref: AgentMuxMessageEventReference }>()
  function agent(subject: CollaborationSubject, provenance?: string) {
    const id = collaborationSubjectKey(subject)
    if (!agents.has(id)) agents.set(id, { id, subject, sessionId: subject.agentSessionId, ...(provenance ? { provenance } : {}) })
    return id
  }
  function add(kind: CollaborationRelation['kind'], source: string, target: string, evidence: CollaborationEvidence) {
    const id = JSON.stringify([kind, source, target]), held = relations.get(id) ?? { id, source, target, kind, evidence: [] }
    if (!held.evidence.some(item => item.id === evidence.id)) held.evidence.push(evidence)
    relations.set(id, held)
  }
  for (const reading of readings) {
    const { hostId } = reading.subject
    for (const event of reading.events) for (const ref of event.messages) {
      const id = JSON.stringify([hostId, reading.incarnation, ref.messageId])
      if (!messages.has(id)) messages.set(id, { subject: reading.subject, incarnation: reading.incarnation, ref })
      const events = eventSources.get(id) ?? new Map()
      events.set(JSON.stringify([reading.incarnation, event.sequence]), event); eventSources.set(id, events)
      if (event.kind === 'dispatch-open' || event.kind === 'dispatch-event') supervision.set(id, { subject: reading.subject, incarnation: reading.incarnation, ref, ...supervision.get(id) })
    }
    for (const record of reading.spawns) {
      const creator = record.creation.createdBy
      const child = agent({ hostId, agentSessionId: record.agentSessionId })
      // A recorded Runtime is not a Desktop route. Preserve it as an unresolved reference.
      let parent: string
      if (creator.owner.kind === 'local') parent = agent({ hostId, agentSessionId: creator.agentSessionId })
      else {
        parent = JSON.stringify(['runtime-reference', creator.owner.runtimeId, creator.agentSessionId])
        if (!agents.has(parent)) agents.set(parent, { id: parent, subject: null, sessionId: creator.agentSessionId, provenance: `Runtime ${creator.owner.runtimeId}` })
      }
      add('creation', parent, child, { kind: 'creation', id: JSON.stringify([hostId, record.agentSessionId]), subject: reading.subject, record })
    }
  }
  for (const [id, { subject, incarnation, ref }] of messages) {
    const source = agent({ hostId: subject.hostId, agentSessionId: ref.senderSessionId }), target = agent({ hostId: subject.hostId, agentSessionId: ref.recipientSessionId })
    add('communication', source, target, { kind: 'communication', id, subject, incarnation, message: ref, events: [...eventSources.get(id)!.values()].sort((a, b) => a.sequence - b.sequence) })
  }
  for (const [id, { subject, incarnation, ref }] of supervision) {
    add('supervision', agent({ hostId: subject.hostId, agentSessionId: ref.senderSessionId }), agent({ hostId: subject.hostId, agentSessionId: ref.recipientSessionId }),
      { kind: 'supervision', id, subject, incarnation, events: [...(eventSources.get(id)?.values() ?? [])].filter(event => event.kind.startsWith('dispatch-')).sort((a, b) => a.sequence - b.sequence) })
  }
  return { agents, relations: [...relations.values()] }
}

/** Areas can overlap; each relation keeps one source identity through folding. */
export function visibleCollaboration(relations: readonly CollaborationRelation[], members: ReadonlySet<string>, kinds: ReadonlySet<CollaborationRelation['kind']>, focus?: string) {
  return relations.filter(relation => kinds.has(relation.kind) && (focus ? relation.source === focus || relation.target === focus : members.has(relation.source) || members.has(relation.target)))
}
