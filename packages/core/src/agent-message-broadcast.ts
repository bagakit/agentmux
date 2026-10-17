import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { messageEnvelopeString } from './agent-message-envelope.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { isAgentDeliveryState } from './agent-message.js'
import type { DurableAgentMuxMessageQueue, AgentMuxMessageDeliveryState } from './agent-global-message-queue.js'
import type { AgentMessageChannel, AgentOperationDevice } from './types.js'

export type AgentMuxMessageBroadcastInput = {
  operationId: string
  recipientSessionIds: readonly string[]
  text: string
  sourceChannel?: AgentMessageChannel
}
export type AgentMuxBroadcastAuthor = { hostId: string; agentSessionId: string; runId: string }
export type AgentMuxBroadcastIssue = { code: string; message: string }
export type AgentMuxBroadcastTarget = {
  agentSessionId: string
  hostId: string | null
  runId: string | null
  operationId: string
  messageId: string
  unavailable?: AgentMuxBroadcastIssue
}
/** One original batch intent lives in the existing message journal, before any single-message effect. */
export type AgentMuxMessageBroadcastIntent = {
  operationId: string
  author: AgentMuxBroadcastAuthor
  body: string
  sourceChannel: AgentMessageChannel
  sourceDevice?: AgentOperationDevice
  createdAt: number
  targets: readonly AgentMuxBroadcastTarget[]
}
export type AgentMuxBroadcastTargetResult = {
  agentSessionId: string
  messageId: string
  operationId: string
  hostId: string | null
  runId: string | null
  claimSequence: number | null
  resultSequence: number | null
  outcome: 'pending' | 'saved' | 'not-applied' | 'unconfirmed'
  issue?: AgentMuxBroadcastIssue
  message?: { sequence: number; delivery: AgentMuxMessageDeliveryState; deliveryMode?: 'reference' }
}
export type AgentMuxMessageBroadcastReceipt = {
  operationId: string
  sequence: number
  author: AgentMuxBroadcastAuthor
  bodySHA256: string
  bodyBytes: number
  createdAt: number
  targets: readonly AgentMuxBroadcastTargetResult[]
}

export function normalizeBroadcastInput(value: AgentMuxMessageBroadcastInput): Required<AgentMuxMessageBroadcastInput> {
  const operationId = messageEnvelopeString(value.operationId, 'Broadcast operation ID')
  if (typeof value.text !== 'string' || !Array.isArray(value.recipientSessionIds) || !value.recipientSessionIds.length) throw new AgentMuxError(
    'A broadcast requires an original body and an explicit nonempty Session ID array.', 'INVALID_CONTROL_REQUEST')
  const ids = [...new Set(value.recipientSessionIds.map(id => {
    if (typeof id !== 'string' || id !== id.trim()) throw new AgentMuxError('Broadcast recipients require complete exact Session IDs.', 'INVALID_CONTROL_REQUEST')
    return messageEnvelopeString(id, 'Broadcast recipient Session ID')
  }))].sort()
  return { operationId, recipientSessionIds: ids, text: value.text, sourceChannel: normalizeMessageChannel(value.sourceChannel ?? 'api') }
}
export function broadcastTargetIdentity(operationId: string, agentSessionId: string): Pick<AgentMuxBroadcastTarget, 'operationId' | 'messageId'> {
  const digest = createHash('sha256').update(JSON.stringify(['broadcast-target', operationId, agentSessionId])).digest('hex')
  return { operationId: 'broadcast-send-' + digest, messageId: 'broadcast-message-' + digest }
}
export function validateBroadcastIntent(value: AgentMuxMessageBroadcastIntent): AgentMuxMessageBroadcastIntent {
  const input = normalizeBroadcastInput({ operationId: value.operationId, recipientSessionIds: value.targets.map(target => target.agentSessionId), text: value.body, sourceChannel: value.sourceChannel })
  for (const item of Object.values(value.author)) messageEnvelopeString(item, 'Broadcast original author')
  if (!Number.isFinite(value.createdAt) || !isDeepStrictEqual(value.targets.map(target => target.agentSessionId), input.recipientSessionIds)) throw new AgentMuxError('The frozen broadcast target set is invalid.', 'BROADCAST_INTENT_CONFLICT')
  for (const target of value.targets) {
    if (target.hostId !== null) messageEnvelopeString(target.hostId, 'Broadcast target Host')
    if (target.runId !== null) messageEnvelopeString(target.runId, 'Broadcast target Run')
    if (!isDeepStrictEqual(broadcastTargetIdentity(value.operationId, target.agentSessionId), { operationId: target.operationId, messageId: target.messageId }) ||
        !target.unavailable && (target.hostId === null || target.runId === null)) throw new AgentMuxError('The frozen broadcast target identity is invalid.', 'BROADCAST_INTENT_CONFLICT')
    if (target.unavailable) { messageEnvelopeString(target.unavailable.code, 'Broadcast issue code'); if (typeof target.unavailable.message !== 'string') throw new AgentMuxError('The broadcast issue is invalid.', 'BROADCAST_INTENT_CONFLICT') }
  }
  return structuredClone({ ...value, sourceChannel: input.sourceChannel,
    ...(value.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(value.sourceDevice) }) })
}
export function assertBroadcastIntent(intent: AgentMuxMessageBroadcastIntent, input: Required<AgentMuxMessageBroadcastInput>, author: AgentMuxBroadcastAuthor, device?: AgentOperationDevice): void {
  if (intent.body !== input.text || intent.sourceChannel !== input.sourceChannel || !isDeepStrictEqual(intent.author, author) ||
      !isDeepStrictEqual(intent.targets.map(target => target.agentSessionId), input.recipientSessionIds) || !isDeepStrictEqual(intent.sourceDevice, device)) throw new AgentMuxError(
    'This original broadcast already names another author, body or recipient set. Keep its original operation and target message IDs.', 'BROADCAST_INTENT_CONFLICT')
}
const issue = (error: unknown): AgentMuxBroadcastIssue => ({ code: error instanceof AgentMuxError ? error.code : 'BROADCAST_TARGET_UNCONFIRMED',
  message: error instanceof Error ? error.message : String(error) })

/** The finite batch coordinator delegates every effect to the existing single-message owner. */
export async function runAgentMessageBroadcast(input: AgentMuxMessageBroadcastInput, ports: {
  queue: DurableAgentMuxMessageQueue
  authorize(): Promise<AgentMuxBroadcastAuthor>
  resolve(agentSessionId: string): Promise<{ hostId: string; agentSessionId: string; runId: string }>
  send(intent: AgentMuxMessageBroadcastIntent, target: AgentMuxBroadcastTarget): Promise<unknown>
  sourceDevice?: AgentOperationDevice
}): Promise<AgentMuxMessageBroadcastReceipt> {
  const normalized = normalizeBroadcastInput(input), author = await ports.authorize()
  const reauthorize = async () => {
    if (!isDeepStrictEqual(await ports.authorize(), author)) throw new AgentMuxError('The original broadcast author Run changed.', 'AGENT_CAPABILITY_STALE_RUN')
  }
  let original = await ports.queue.readBroadcastIntent(normalized.operationId, reauthorize)
  if (original) assertBroadcastIntent(original, normalized, author, ports.sourceDevice)
  else {
    const targets = await Promise.all(normalized.recipientSessionIds.map(async agentSessionId => {
      const identity = broadcastTargetIdentity(normalized.operationId, agentSessionId)
      try {
        const target = await ports.resolve(agentSessionId)
        if (target.agentSessionId !== agentSessionId) throw new AgentMuxError('Broadcast requires the complete original Session ID, not a prefix.', 'INVALID_CONTROL_REQUEST')
        if (target.hostId !== author.hostId) throw new AgentMuxError('Broadcast does not grant cross-owner Agent authority.', 'CONTROL_PERMISSION_DENIED')
        return { agentSessionId, hostId: target.hostId, runId: target.runId, ...identity }
      } catch (error) { return { agentSessionId, hostId: null, runId: null, ...identity, unavailable: issue(error) } }
    }))
    original = await ports.queue.claimBroadcast({ operationId: normalized.operationId, author, body: normalized.text,
      sourceChannel: normalized.sourceChannel, ...(ports.sourceDevice ? { sourceDevice: ports.sourceDevice } : {}), createdAt: Date.now(), targets }, reauthorize)
    assertBroadcastIntent(original, normalized, author, ports.sourceDevice)
  }
  for (const target of original.targets) {
    if (!await ports.queue.claimBroadcastTarget(original.operationId, target.agentSessionId, reauthorize)) continue
    if (target.unavailable) {
      await ports.queue.recordBroadcastResult(original.operationId, target.agentSessionId, 'not-applied', target.unavailable)
      continue
    }
    try {
      await reauthorize()
      await ports.send(original, target)
      await ports.queue.recordBroadcastResult(original.operationId, target.agentSessionId, 'saved')
    } catch (error) {
      // A lost acknowledgement is never permission to call send again. The inspector reads the
      // same MID from the original journal; later independent targets continue normally.
      await ports.queue.recordBroadcastResult(original.operationId, target.agentSessionId,
        error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied' ? 'not-applied' : 'unconfirmed', issue(error))
    }
  }
  return (await ports.queue.inspectBroadcast(original.operationId, reauthorize))!
}

export function parseBroadcastReceipt(value: unknown, operationId: string, participantSessionId?: string, body?: string): AgentMuxMessageBroadcastReceipt {
  const fail = (): never => { throw new AgentMuxError('The original broadcast receipt is malformed or belongs to another author.', 'CONTROL_PROTOCOL_ERROR') }
  const obj = (value: unknown, keys: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail()
    return value as Record<string, any>
  }
  const p = obj(value, ['operationId', 'sequence', 'author', 'bodySHA256', 'bodyBytes', 'createdAt', 'targets'])
  const author = obj(p.author, ['hostId', 'agentSessionId', 'runId'])
  for (const key of ['hostId', 'agentSessionId', 'runId']) if (typeof author[key] !== 'string' || !author[key].trim()) fail()
  if (p.operationId !== operationId || participantSessionId !== undefined && author.agentSessionId !== participantSessionId ||
      !Number.isSafeInteger(p.sequence) || p.sequence < 1 || !Number.isSafeInteger(p.bodyBytes) || p.bodyBytes < 0 || !/^[a-f0-9]{64}$/u.test(p.bodySHA256) ||
      typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt) || !Array.isArray(p.targets) || !p.targets.length) fail()
  if (body !== undefined && (p.bodySHA256 !== createHash('sha256').update(body).digest('hex') || p.bodyBytes !== Buffer.byteLength(body))) fail()
  let previous = ''
  for (const value of p.targets) {
    const target = obj(value, ['agentSessionId', 'messageId', 'operationId', 'hostId', 'runId', 'claimSequence', 'resultSequence', 'outcome', 'issue', 'message'])
    if (typeof target.agentSessionId !== 'string' || !target.agentSessionId || target.agentSessionId <= previous ||
        !['pending', 'saved', 'not-applied', 'unconfirmed'].includes(target.outcome) ||
        !isDeepStrictEqual(broadcastTargetIdentity(operationId, target.agentSessionId), { operationId: target.operationId, messageId: target.messageId })) fail()
    if (target.claimSequence !== null && (!Number.isSafeInteger(target.claimSequence) || target.claimSequence <= p.sequence) ||
        target.resultSequence !== null && (!Number.isSafeInteger(target.resultSequence) || target.claimSequence === null || target.resultSequence <= target.claimSequence) ||
        target.outcome === 'pending' && target.claimSequence !== null || target.outcome !== 'pending' && target.claimSequence === null) fail()
    previous = target.agentSessionId
    for (const key of ['hostId', 'runId']) if (target[key] !== null && (typeof target[key] !== 'string' || !target[key].trim())) fail()
    if ((target.hostId === null) !== (target.runId === null)) fail()
    if (target.issue !== undefined) { const issue = obj(target.issue, ['code', 'message']); if (typeof issue.code !== 'string' || !issue.code || typeof issue.message !== 'string') fail() }
    if (target.message !== undefined) {
      const message = obj(target.message, ['sequence', 'delivery', 'deliveryMode']), delivery = obj(message.delivery, ['state', 'at', 'reason'])
      if (!Number.isSafeInteger(message.sequence) || message.sequence <= (target.claimSequence ?? p.sequence) || !isAgentDeliveryState(delivery.state) || typeof delivery.at !== 'number' || !Number.isFinite(delivery.at) ||
          delivery.reason !== undefined && typeof delivery.reason !== 'string' || message.deliveryMode !== undefined && message.deliveryMode !== 'reference') fail()
    }
    if (target.outcome === 'saved' && !target.message) fail()
  }
  return p as AgentMuxMessageBroadcastReceipt
}
