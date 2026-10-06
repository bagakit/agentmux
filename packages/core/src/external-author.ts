import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor } from './room-binding-codec.js'
import type { ConnectionActor } from './connections-contract.js'

/** Recorded external attribution, never a serialized authorization or a local human identity. */
export type AgentExternalMessageAuthor = {
  kind: 'external'
  connectionId: string
  actor: ConnectionActor
  externalConversationId: string
  externalMessageId: string
  bindingId: string
  bindingRevision: number
  grantId: string
  grantRevision: number
}
export type AgentExternalInputIntent = {
  agentSessionId: string; expectedRun: { runId: string }; operationId: string; messageId: string; body: string
}

/** Original Host-owned claim/current-authority reader. Never serialized or inferred from a wire author. */
export interface AgentExternalInputAuthorityPort {
  assertCurrent(author: AgentExternalMessageAuthor, intent: AgentExternalInputIntent): void | Promise<void>
}

export function parseAgentExternalMessageAuthor(value: unknown): AgentExternalMessageAuthor {
  const p = rpcRecord(value, ['kind', 'connectionId', 'actor', 'externalConversationId', 'externalMessageId', 'bindingId', 'bindingRevision', 'grantId', 'grantRevision'], 'INVALID_EXTERNAL_AUTHOR')
  const fail = (): never => { throw new AgentMuxError('External attribution is malformed.', 'INVALID_EXTERNAL_AUTHOR') }
  const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v as string }
  const revision = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 1) fail(); return v as number }
  if (p.kind !== 'external') fail()
  return { kind: 'external', connectionId: text(p.connectionId), actor: parseConnectionActor(p.actor), externalConversationId: text(p.externalConversationId), externalMessageId: text(p.externalMessageId), bindingId: text(p.bindingId), bindingRevision: revision(p.bindingRevision), grantId: text(p.grantId), grantRevision: revision(p.grantRevision) }
}
