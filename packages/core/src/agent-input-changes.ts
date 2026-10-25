import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseAgentInputJournalCut, type AgentInputJournalCut } from './agent-input-conversation.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'

/** A position is a source fence, never a grant to read another recipient. */
export type AgentInputChangePosition = AgentInputJournalCut & { agentSessionId: string }
export type AgentInputChangesCursor = { after: AgentInputChangePosition; throughSequence: number }
export type AgentInputChangesRead = {
  agentSessionId: string
  after?: AgentInputChangePosition
  cursor?: AgentInputChangesCursor
  limit?: number
}
export type AgentInputChangesPage = {
  agentSessionId: string
  source: { queueId: string; incarnation: string }
  throughSequence: number
  changes: readonly { key: AgentPromptInputKey; controlSequence: number }[]
  nextCursor: AgentInputChangesCursor | null
  checkpoint: AgentInputChangePosition | null
  coverage: 'input-journal-membership-and-control'
}

function invalid(): never { throw new AgentMuxError('The original input changes position is invalid.', 'INVALID_AGENT_INPUT_READ') }
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
  return value as number
}
function recipient(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) invalid()
  return value
}
function position(value: unknown): AgentInputChangePosition {
  const p = rpcRecord(value, ['queueId', 'incarnation', 'sequence', 'agentSessionId'], 'INVALID_AGENT_INPUT_READ')
  return { ...parseAgentInputJournalCut({ queueId: p.queueId, incarnation: p.incarnation, sequence: p.sequence }), agentSessionId: recipient(p.agentSessionId) }
}
function cursor(value: unknown): AgentInputChangesCursor {
  const p = rpcRecord(value, ['after', 'throughSequence'], 'INVALID_AGENT_INPUT_READ')
  const after = position(p.after), throughSequence = count(p.throughSequence)
  if (after.sequence > throughSequence) invalid()
  return { after, throughSequence }
}
export function parseAgentInputChangesRead(value: unknown): AgentInputChangesRead {
  const p = rpcRecord(value, ['agentSessionId', 'after', 'cursor', 'limit'], 'INVALID_AGENT_INPUT_READ')
  const agentSessionId = recipient(p.agentSessionId)
  if (p.after !== undefined && p.cursor !== undefined) invalid()
  const after = p.after === undefined ? undefined : position(p.after)
  const next = p.cursor === undefined ? undefined : cursor(p.cursor)
  const original = after ?? next?.after
  if (original && original.agentSessionId !== agentSessionId) invalid()
  if (p.limit !== undefined && (count(p.limit) < 1 || (p.limit as number) > 100)) invalid()
  return { agentSessionId, ...(after ? { after } : {}), ...(next ? { cursor: next } : {}), ...(p.limit === undefined ? {} : { limit: p.limit as number }) }
}

/** Coalesced keys only: consumers inspect their original receipt for current facts. */
export function parseAgentInputChangesPage(value: unknown, request: AgentInputChangesRead): AgentInputChangesPage {
  try {
    const input = parseAgentInputChangesRead(request)
    const p = rpcRecord(value, ['agentSessionId', 'source', 'throughSequence', 'changes', 'nextCursor', 'checkpoint', 'coverage'], 'CONTROL_PROTOCOL_ERROR')
    const source = rpcRecord(p.source, ['queueId', 'incarnation'], 'CONTROL_PROTOCOL_ERROR')
    const through = position({ ...source, sequence: p.throughSequence, agentSessionId: p.agentSessionId })
    const after = input.after ?? input.cursor?.after
    if (through.agentSessionId !== input.agentSessionId || p.coverage !== 'input-journal-membership-and-control' ||
        after && (after.queueId !== through.queueId || after.incarnation !== through.incarnation || after.sequence > through.sequence) ||
        input.cursor && input.cursor.throughSequence !== through.sequence || !Array.isArray(p.changes) || p.changes.length > (input.limit ?? 25)) invalid()
    let previous = after?.sequence ?? through.sequence
    const seen = new Set<string>()
    for (const value of p.changes) {
      const change = rpcRecord(value, ['key', 'controlSequence'], 'CONTROL_PROTOCOL_ERROR')
      const key = validateAgentPromptInputKey(change.key), sequence = count(change.controlSequence), id = JSON.stringify(key)
      if (key.agentSessionId !== input.agentSessionId || sequence <= previous || sequence > through.sequence || seen.has(id)) invalid()
      previous = sequence; seen.add(id)
    }
    if (p.nextCursor !== null) {
      const next = cursor(p.nextCursor)
      if (!p.changes.length || p.checkpoint !== null || next.throughSequence !== through.sequence ||
          next.after.sequence !== previous || next.after.agentSessionId !== through.agentSessionId ||
          next.after.queueId !== through.queueId || next.after.incarnation !== through.incarnation) invalid()
    } else {
      const checkpoint = position(p.checkpoint)
      if (checkpoint.sequence !== through.sequence || checkpoint.agentSessionId !== through.agentSessionId ||
          checkpoint.queueId !== through.queueId || checkpoint.incarnation !== through.incarnation) invalid()
    }
    return value as AgentInputChangesPage
  } catch {
    throw new AgentMuxError('The input changes page does not match its original recipient and source.', 'CONTROL_PROTOCOL_ERROR')
  }
}
