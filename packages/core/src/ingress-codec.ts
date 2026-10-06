import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor } from './room-binding-codec.js'
import { parseAgentExternalMessageAuthor } from './external-author.js'
import { parseAgentInputSubmissionReceipt } from './agent-input-receipt-codec.js'
import type { ConnectionIngressMethod, ConnectionIngressParamsMap, ConnectionIngressRecord, ConnectionIngressResultMap } from './ingress-contract.js'

export const INGRESS_RPC_METHODS = { 'connection.ingress.inspect': 'long', 'connection.ingress.ls': 'long' } as const
export const isIngressMethod = (value: unknown): value is ConnectionIngressMethod => typeof value === 'string' && Object.hasOwn(INGRESS_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Ingress data does not describe its original intake or input.', 'INVALID_CONNECTION_INGRESS') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_INGRESS')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export function parseConnectionIngressRecord(value: unknown): ConnectionIngressRecord {
  const p = object(value, ['ingressId', 'connectionId', 'application', 'eventId', 'externalMessageId', 'externalConversationId', 'actor', 'body', 'state', 'code', 'input'])
  const actor = parseConnectionActor(p.actor), app = object(p.application, ['domain', 'appId'])
  const application = { domain: text(app.domain), appId: text(app.appId) }
  if (!equal(actor.application, application) || typeof p.body !== 'string' || !['received', 'refused', 'claimed'].includes(String(p.state))) fail()
  const base = { ingressId: text(p.ingressId), connectionId: text(p.connectionId), application, eventId: text(p.eventId), externalMessageId: text(p.externalMessageId), externalConversationId: text(p.externalConversationId), actor, body: p.body as string }
  if (p.state === 'refused') { if (p.input !== undefined) fail(); return { ...base, state: 'refused', code: text(p.code) } }
  if (p.code !== undefined) fail()
  if (p.state === 'received') { if (p.input !== undefined) fail(); return { ...base, state: 'received' } }
  const input = object(p.input, ['hostId', 'agentSessionId', 'expectedRun', 'operationId', 'messageId', 'author']), run = object(input.expectedRun, ['runId'])
  const author = parseAgentExternalMessageAuthor(input.author), operationId = text(input.operationId), messageId = text(input.messageId)
  if (operationId === messageId || author.connectionId !== base.connectionId || !equal(author.actor, actor) || author.externalMessageId !== base.externalMessageId || author.externalConversationId !== base.externalConversationId) fail()
  return { ...base, state: 'claimed', input: { hostId: text(input.hostId), agentSessionId: text(input.agentSessionId), expectedRun: { runId: text(run.runId) }, operationId, messageId, author } }
}
export function parseIngressParams<M extends ConnectionIngressMethod>(method: M, value: unknown): ConnectionIngressParamsMap[M] {
  if (method === 'connection.ingress.inspect') { const p = object(value, ['ingressId']); return { ingressId: text(p.ingressId) } as ConnectionIngressParamsMap[M] }
  const p = object(value, ['connectionId', 'bindingId', 'afterIngressId', 'limit'])
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100)) fail()
  return { connectionId: text(p.connectionId), ...(p.bindingId === undefined ? {} : { bindingId: text(p.bindingId) }), ...(p.afterIngressId === undefined ? {} : { afterIngressId: text(p.afterIngressId) }), ...(p.limit === undefined ? {} : { limit: p.limit as number }) } as ConnectionIngressParamsMap[M]
}
export function parseIngressResult<M extends ConnectionIngressMethod>(method: M, value: unknown, input: ConnectionIngressParamsMap[M]): ConnectionIngressResultMap[M] {
  if (method === 'connection.ingress.inspect') {
    const p = object(value, ['ingress', 'inputReceipt', 'observation']), ingress = p.ingress === null ? null : parseConnectionIngressRecord(p.ingress)
    const receipt = p.inputReceipt === null ? null : parseAgentInputSubmissionReceipt(p.inputReceipt)
    if (ingress && ingress.ingressId !== (input as ConnectionIngressParamsMap['connection.ingress.inspect']).ingressId || !['not-started', 'observed', 'unavailable'].includes(String(p.observation))) fail()
    if (!ingress?.input && (receipt || p.observation !== 'not-started') || ingress?.input && p.observation === 'not-started' || p.observation === 'unavailable' && receipt) fail()
    if (receipt && (receipt.key.kind !== 'message' || receipt.key.messageId !== ingress?.input?.messageId || receipt.key.agentSessionId !== ingress?.input?.agentSessionId || !equal(receipt.key.expectedRun, ingress?.input?.expectedRun) || receipt.originalControlOperationId !== ingress?.input?.operationId)) fail()
    return { ingress, inputReceipt: receipt, observation: p.observation } as ConnectionIngressResultMap[M]
  }
  const p = object(value, ['ingresses', 'nextAfterIngressId']), expected = input as ConnectionIngressParamsMap['connection.ingress.ls']
  if (!Array.isArray(p.ingresses) || p.ingresses.length > (expected.limit ?? 25)) fail()
  const ingresses = (p.ingresses as unknown[]).map(parseConnectionIngressRecord)
  if (new Set(ingresses.map(i => i.ingressId)).size !== ingresses.length || ingresses.some(i => i.connectionId !== expected.connectionId || expected.bindingId !== undefined && i.input?.author.bindingId !== expected.bindingId || i.ingressId === expected.afterIngressId)) fail()
  const nextAfterIngressId = p.nextAfterIngressId === null ? null : text(p.nextAfterIngressId)
  if (nextAfterIngressId !== null && nextAfterIngressId !== ingresses.at(-1)?.ingressId) fail()
  return { ingresses, nextAfterIngressId } as ConnectionIngressResultMap[M]
}
