import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import { assertDispatchEventKind, type DispatchEventKind, type DispatchObservation, type DispatchIdentityDiagnostic } from '../agent-handoff.js'
import { readGoalDelegationSource } from '../goal-delegation-source.js'
import type { MoteDialogueRead, MoteDialoguePage, MoteDialogueLink } from './dialogue-contract.js'

export type MoteSupervisionRead = Omit<MoteDialogueRead, 'kind'>
export type MoteWorkSource = Extract<MoteDialogueLink, { kind: 'work' }>
/** Frozen delegation references only. Current standards and authority remain with the Goal owner. */
export type MoteSupervisionGoal = { goalId: string; delegationOperationId: string; alignmentRevision: number; planNodeId?: string }
export type MoteSupervisionObservation = {
  sequence: number
  communication: {
    originAwaits: boolean
    /** Original lineage references, including replies without a Dispatch event. */
    replyMessageIds: string[]
    events: Array<{ kind: DispatchEventKind; replyMessageId: string }>
    identityDiagnostics: readonly DispatchIdentityDiagnostic[]
    goal: MoteSupervisionGoal | null
  } | null
  issue: string | null
}
export type MoteSupervisionPage = MoteDialoguePage & { observations: MoteSupervisionObservation[] }

/** Project only the exact original protocol source; no inferred progress or acceptance. */
export function observeMoteWorkSource(link: MoteWorkSource, observed: DispatchObservation): MoteSupervisionObservation {
  const { dispatch, source } = observed, origin = link.origin, envelope = source.envelope
  if (dispatch.sourceMessageId !== origin.messageId || envelope.messageId !== origin.messageId ||
    dispatch.threadId !== origin.threadId || envelope.threadId !== origin.threadId ||
    dispatch.ownerAgentSessionId !== origin.senderSessionId || dispatch.workerAgentSessionId !== origin.recipientSessionId ||
    envelope.senderSessionId !== origin.senderSessionId || envelope.recipientSessionId !== origin.recipientSessionId)
    throw new AgentMuxError('The observed Dispatch belongs to another original work source. Keep the saved link and inspect its original message.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
  const original = envelope.application?.schema === 'agentmux.goal-delegation.v1' ? readGoalDelegationSource(source) : null
  const goal = original ? { goalId: original.goalId, delegationOperationId: original.delegationOperationId,
    alignmentRevision: original.alignmentRevision, ...(original.planNodeId ? { planNodeId: original.planNodeId } : {}) } : null
  return { sequence: link.sequence, communication: { originAwaits: dispatch.originAwaits,
    replyMessageIds: observed.replies.map(reply => reply.envelope.messageId),
    events: dispatch.events.map(({ kind, replyMessageId }) => ({ kind, replyMessageId })),
    identityDiagnostics: observed.identityDiagnostics, goal }, issue: null }
}

export function parseMoteSupervisionObservations(value: unknown, links: MoteDialogueLink[]): MoteSupervisionObservation[] {
  const fail = (): never => { throw new AgentMuxError('The supervision observation does not match its original paged sources.', 'CONTROL_PROTOCOL_ERROR') }
  const id = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) fail() }
  const message = (value: unknown) => { if (typeof value !== 'string' || !value.trim()) fail() }
  const count = (value: unknown, minimum = 0) => { if (!Number.isSafeInteger(value) || Number(value) < minimum) fail() }
  if (!Array.isArray(value) || value.length !== links.length) return fail()
  for (const [index, raw] of value.entries()) {
    const item = rpcRecord(raw, ['sequence', 'communication', 'issue'], 'CONTROL_PROTOCOL_ERROR')
    if (links[index]?.kind !== 'work' || item.sequence !== links[index]?.sequence) return fail()
    if (item.communication === null) { message(item.issue); continue }
    if (item.issue !== null) return fail()
    const communication = rpcRecord(item.communication, ['originAwaits', 'replyMessageIds', 'events', 'identityDiagnostics', 'goal'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof communication.originAwaits !== 'boolean' || !Array.isArray(communication.replyMessageIds) || !Array.isArray(communication.events) || !Array.isArray(communication.identityDiagnostics)) return fail()
    for (const reply of communication.replyMessageIds) id(reply)
    if (new Set(communication.replyMessageIds).size !== communication.replyMessageIds.length) return fail()
    const replies = new Set<string>()
    for (const rawEvent of communication.events) {
      const event = rpcRecord(rawEvent, ['kind', 'replyMessageId'], 'CONTROL_PROTOCOL_ERROR')
      assertDispatchEventKind(event.kind); id(event.replyMessageId)
      if (!communication.replyMessageIds.includes(event.replyMessageId)) return fail()
      if (replies.has(event.replyMessageId as string)) return fail()
      replies.add(event.replyMessageId as string)
    }
    for (const rawDiagnostic of communication.identityDiagnostics) {
      const diagnostic = rpcRecord(rawDiagnostic, ['agentSessionId', 'runId', 'code', 'message'], 'CONTROL_PROTOCOL_ERROR')
      id(diagnostic.agentSessionId); id(diagnostic.runId); message(diagnostic.message)
      if (!['DISPATCH_IDENTITY_UNAVAILABLE', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'].includes(String(diagnostic.code))) return fail()
      const origin = (links[index] as MoteWorkSource).origin
      if (diagnostic.agentSessionId !== origin.senderSessionId && diagnostic.agentSessionId !== origin.recipientSessionId) return fail()
    }
    if (communication.goal !== null) {
      const goal = rpcRecord(communication.goal, ['goalId', 'delegationOperationId', 'alignmentRevision', 'planNodeId'], 'CONTROL_PROTOCOL_ERROR')
      id(goal.goalId); id(goal.delegationOperationId); count(goal.alignmentRevision, 1)
      if (goal.planNodeId !== undefined) id(goal.planNodeId)
    }
  }
  return value as MoteSupervisionObservation[]
}
