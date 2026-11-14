import { optionalInputEpoch } from './agent-prompt-condition.js'
import { isDeepStrictEqual } from 'node:util'
import type { AgentMuxMessageTarget } from './control.js'
import { messageEnvelopeString } from './agent-message-envelope.js'
import { AgentMuxError } from './errors.js'

/** An ingress binding, not another message. Original content and delivery stay at the recipient. */
export type AgentMessageRoute = {
  operationId: string
  messageId: string
  hostId: string
  runtimeId: string | null
  targetKeyFingerprint?: string
  recipientInputEpoch?: string
  agentSessionId: string
  expectedRun: { runId: string }
  target: AgentMuxMessageTarget
  /** Frozen content, author and execution digest; never a capability or a duplicate body. */
  intentDigest: string
}

export function validateAgentMessageRoute(route: AgentMessageRoute): AgentMessageRoute {
  for (const field of ['operationId', 'messageId', 'hostId', 'agentSessionId', 'intentDigest'] as const) messageEnvelopeString(route[field], `Message route ${field}`)
  messageEnvelopeString(route.expectedRun.runId, 'Message route Run')
  if (route.runtimeId !== null) messageEnvelopeString(route.runtimeId, 'Message route Runtime')
  if (route.targetKeyFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(route.targetKeyFingerprint)) throw new AgentMuxError('Original message target key is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  optionalInputEpoch(route.recipientInputEpoch)
  const target = route.target
  if (target.kind === 'agent-session') messageEnvelopeString(target.agentSessionId, 'Message route target Session')
  else if (target.kind === 'region') messageEnvelopeString(target.regionId, 'Message route target Region')
  else if (target.kind === 'tab') messageEnvelopeString(target.tabId, 'Message route target Tab')
  else if (target.kind !== 'self') throw new AgentMuxError('Message route target is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  return structuredClone(route)
}

export function assertAgentMessageRouteIntent(route: AgentMessageRoute, input: Pick<AgentMessageRoute, 'messageId' | 'intentDigest' | 'target'>): void {
  if (route.messageId !== input.messageId || route.intentDigest !== input.intentDigest) throw new AgentMuxError(
    'This original message already has different content, author or execution. Its route and receipt are retained.', 'MESSAGE_ID_CONFLICT')
  if (!isDeepStrictEqual(route.target, input.target) &&
      !(input.target.kind === 'agent-session' && input.target.agentSessionId === route.agentSessionId && (input.target.hostId === undefined || input.target.hostId === route.hostId))) throw new AgentMuxError(
    'This original message already names another target. Its original route and input are retained.', 'MESSAGE_RECIPIENT_MISMATCH')
}
