import { parseExternalConversationReference, parseExternalConversationAuthority, parseExternalConversationReceipt } from './external-conversation.js'
import { validateAgentPromptAdmissionIntent } from './agent-prompt-condition.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor, parseConnectionApplication } from './room-binding-codec.js'
import { parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor } from './external-author.js'
import { parseAgentInputSubmissionReceipt } from './agent-input-receipt-codec.js'
import type { ConnectionIngressAddressing, ConnectionIngressMethod, ConnectionIngressParamsMap, ConnectionIngressRecord, ConnectionIngressResultMap } from './ingress-contract.js'

export const INGRESS_RPC_METHODS = { 'connection.ingress.inspect': 'long', 'connection.ingress.ls': 'long', 'connection.ingress.authority': 'long', 'connection.ingress.record-authority': 'long' } as const
export const isIngressMethod = (value: unknown): value is ConnectionIngressMethod => typeof value === 'string' && Object.hasOwn(INGRESS_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Ingress data does not describe its original intake or input.', 'INVALID_CONNECTION_INGRESS') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_INGRESS')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const CONNECTION_INGRESS_AUTHORITY_CODES = ['INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_CLAIM_UNAVAILABLE', 'INGRESS_CONNECTION_UNAVAILABLE', 'INGRESS_BINDING_UNAVAILABLE', 'INGRESS_ACTOR_NOT_AUTHORIZED', 'INGRESS_INPUT_OUTSIDE_SCOPE', 'INGRESS_ADDRESSING_UNCONFIRMED', 'INGRESS_AUTHORITY_REVISED', 'INGRESS_STORAGE_UNCONFIRMED'] as const satisfies readonly import('./ingress-contract.js').ConnectionIngressAuthorityCode[]
function addressing(value: unknown): ConnectionIngressAddressing {
  const p = object(value, ['replyToMessageId', 'state', 'selection', 'reason']), replyToMessageId = text(p.replyToMessageId)
  if (p.state === 'confirmed' && (p.selection === 'reply' || p.selection === 'message') && p.reason === undefined) return { replyToMessageId, state: 'confirmed', selection: p.selection }
  if (p.selection !== undefined) fail()
  if (p.state === 'unknown' && p.reason === 'reply-unconfirmed') return { replyToMessageId, state: 'unknown', reason: 'reply-unconfirmed' }
  if (p.state === 'unavailable' && (p.reason === 'adapter-unavailable' || p.reason === 'credential-missing')) return { replyToMessageId, state: 'unavailable', reason: p.reason }
  return fail()
}
export function parseConnectionIngressRecord(value: unknown): ConnectionIngressRecord {
  if (value && typeof value === 'object' && !Array.isArray(value) && Reflect.get(value, 'kind') === 'action') {
    const p = object(value, ['kind', 'ingressId', 'connectionId', 'application', 'eventId', 'actor', 'externalConversationId', 'sourceMessageId', 'actionRef', 'state', 'code', 'input'])
    const application = parseConnectionApplication(p.application)
    const actor = p.actor === undefined ? undefined : parseConnectionActor(p.actor)
    if (!['received', 'claimed', 'refused'].includes(String(p.state)) || actor && !equal(actor.application, application)) fail()
    const base = { kind: 'action' as const, ingressId: text(p.ingressId), connectionId: text(p.connectionId), application, eventId: text(p.eventId),
      ...(actor === undefined ? {} : { actor }), ...(p.externalConversationId === undefined ? {} : { externalConversationId: text(p.externalConversationId) }),
      ...(p.sourceMessageId === undefined ? {} : { sourceMessageId: text(p.sourceMessageId) }), ...(p.actionRef === undefined ? {} : { actionRef: text(p.actionRef) }),
      }
    if (p.state === 'refused') { if (p.input !== undefined || p.code !== 'INGRESS_ACTION_UNSUPPORTED' && !CONNECTION_INGRESS_AUTHORITY_CODES.includes(p.code as never)) fail(); return { ...base, state: 'refused', code: p.code as NonNullable<import('./ingress-contract.js').ConnectionIngressAction['code']> } }
    if (!base.actor || !base.externalConversationId || !base.sourceMessageId || !base.actionRef || p.code !== undefined) fail()
    if (p.state === 'received') { if (p.input !== undefined) fail(); return { ...base, state: 'received' } }
    const input = object(p.input, ['hostId','agentSessionId','expectedRun','operationId','intentDigest','author']), run = object(input.expectedRun, ['runId']), author = parseAgentExternalInteractionAuthor(input.author)
    if (!/^[a-f0-9]{64}$/u.test(text(input.intentDigest)) || author.connectionId !== base.connectionId || !equal(author.actor, base.actor) || author.externalConversationId !== base.externalConversationId || author.sourceMessageId !== base.sourceMessageId || author.actionRef !== base.actionRef) fail()
    return { ...base, state: 'claimed', input: { hostId: text(input.hostId), agentSessionId: text(input.agentSessionId), expectedRun: { runId: text(run.runId) }, operationId: text(input.operationId), intentDigest: text(input.intentDigest), author } }
  }
  const p = object(value, ['ingressId', 'connectionId', 'application', 'eventId', 'externalMessageId', 'externalConversationId', 'conversationKind', 'actor', 'body', 'state', 'code', 'input', 'addressing', 'group'])
  const actor = parseConnectionActor(p.actor), app = object(p.application, ['domain', 'appId'])
  const application = { domain: text(app.domain), appId: text(app.appId) }
  if (!equal(actor.application, application) || typeof p.body !== 'string' || p.state !== 'received' && p.state !== 'refused' && p.state !== 'claimed') fail()
  if (p.conversationKind !== undefined && p.conversationKind !== 'direct' && p.conversationKind !== 'group') fail()
  const base = { ingressId: text(p.ingressId), connectionId: text(p.connectionId), application, eventId: text(p.eventId), externalMessageId: text(p.externalMessageId), externalConversationId: text(p.externalConversationId), actor, body: p.body as string, ...(p.conversationKind === undefined ? {} : { conversationKind: p.conversationKind as 'direct' | 'group' }), ...(p.addressing === undefined ? {} : { addressing: addressing(p.addressing) }) }
  let group: import('./ingress-contract.js').ConnectionIngressMessage['group']
  if (p.group !== undefined) {
    if (p.conversationKind !== 'group') fail()
    const g = object(p.group, ['target', 'recorded', 'recording'])
    let recording: NonNullable<import('./ingress-contract.js').ConnectionIngressMessage['group']>['recording']
    if (g.recording !== undefined) { const r = object(g.recording, ['state', 'code']); if (!['unavailable', 'refused'].includes(String(r.state))) fail(); recording = { state: r.state as 'unavailable' | 'refused', code: text(r.code) } }
    if (g.target === null) { if (g.recorded !== undefined) fail(); group = { target: null } }
    else {
      const t = object(g.target, ['hostId', 'agentSessionId', 'connectionId', 'bindingId', 'bindingRevision'])
      if (!Number.isSafeInteger(t.bindingRevision) || Number(t.bindingRevision) < 1) fail()
      const target = { hostId: text(t.hostId), agentSessionId: text(t.agentSessionId), connectionId: text(t.connectionId), bindingId: text(t.bindingId), bindingRevision: t.bindingRevision as number }
      group = { target, ...(recording ? { recording } : {}), ...(g.recorded === undefined ? {} : { recorded: parseExternalConversationReceipt(g.recorded, { agentSessionId: target.agentSessionId, ingressId: base.ingressId }) }) }
    }
  }
  const projected = { ...base, ...(group === undefined ? {} : { group }) }
  if (p.state === 'refused') { if (p.input !== undefined) fail(); return { ...projected, state: 'refused', code: text(p.code) } }
  if (p.code !== undefined) fail()
  if (p.state === 'received') { if (p.input !== undefined) fail(); return { ...projected, state: 'received' } }
  const input = object(p.input, ['hostId', 'agentSessionId', 'expectedRun', 'operationId', 'messageId', 'author', 'admissionIntent']), run = object(input.expectedRun, ['runId'])
  const admissionIntent = input.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(input.admissionIntent)
  if (admissionIntent && (admissionIntent.kind === 'exact-condition' || admissionIntent.expectedRun.runId !== run.runId)) fail()
  const author = parseAgentExternalMessageAuthor(input.author), operationId = text(input.operationId), messageId = text(input.messageId)
  // Intake retains its receiver alias; the author names the independently authorized Binding connection.
  if (operationId === messageId || !equal(author.actor, actor) || author.externalMessageId !== base.externalMessageId || author.externalConversationId !== base.externalConversationId) fail()
  return { ...projected, state: 'claimed', input: { hostId: text(input.hostId), agentSessionId: text(input.agentSessionId), expectedRun: { runId: text(run.runId) }, operationId, messageId, author, ...(admissionIntent === undefined ? {} : { admissionIntent: admissionIntent as Exclude<typeof admissionIntent, { kind: 'exact-condition' }> }) } }
}
export function parseIngressParams<M extends ConnectionIngressMethod>(method: M, value: unknown): ConnectionIngressParamsMap[M] {
  if (method === 'connection.ingress.record-authority') return parseExternalConversationReference(value) as ConnectionIngressParamsMap[M]
  if (method === 'connection.ingress.authority') { const p = object(value, ['operationId']); return { operationId: text(p.operationId) } as ConnectionIngressParamsMap[M] }
  if (method === 'connection.ingress.inspect') { const p = object(value, ['ingressId']); return { ingressId: text(p.ingressId) } as ConnectionIngressParamsMap[M] }
  const p = object(value, ['connectionId', 'bindingId', 'afterIngressId', 'limit'])
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100)) fail()
  return { connectionId: text(p.connectionId), ...(p.bindingId === undefined ? {} : { bindingId: text(p.bindingId) }), ...(p.afterIngressId === undefined ? {} : { afterIngressId: text(p.afterIngressId) }), ...(p.limit === undefined ? {} : { limit: p.limit as number }) } as ConnectionIngressParamsMap[M]
}
export function parseIngressResult<M extends ConnectionIngressMethod>(method: M, value: unknown, input: ConnectionIngressParamsMap[M]): ConnectionIngressResultMap[M] {
  if (method === 'connection.ingress.record-authority') return parseExternalConversationAuthority(value) as ConnectionIngressResultMap[M]
  if (method === 'connection.ingress.authority') {
    const p = object(value, ['ingress', 'authority', 'code']), ingress = p.ingress === null ? null : parseConnectionIngressRecord(p.ingress)
    if (ingress && (ingress.state !== 'claimed' || ingress.input?.operationId !== (input as ConnectionIngressParamsMap['connection.ingress.authority']).operationId)) fail()
    if (p.authority !== 'current' && p.authority !== 'refused' && p.authority !== 'unavailable') fail()
    if (p.authority === 'current' ? !ingress || p.code !== undefined : !CONNECTION_INGRESS_AUTHORITY_CODES.includes(p.code as never)) fail()
    const unavailable = p.code === 'INGRESS_SERVICE_UNCONFIRMED' || p.code === 'INGRESS_STORAGE_UNCONFIRMED' || p.code === 'INGRESS_ADDRESSING_UNCONFIRMED'
    if (p.authority === 'unavailable' ? !unavailable : unavailable) fail()
    return { ingress, authority: p.authority, ...(p.code === undefined ? {} : { code: p.code }) } as ConnectionIngressResultMap[M]
  }
  if (method === 'connection.ingress.inspect') {
    const p = object(value, ['ingress', 'inputReceipt', 'interactionReceipt', 'observation']), ingress = p.ingress === null ? null : parseConnectionIngressRecord(p.ingress)
    const receipt = p.inputReceipt === null ? null : parseAgentInputSubmissionReceipt(p.inputReceipt)
    if (ingress && ingress.ingressId !== (input as ConnectionIngressParamsMap['connection.ingress.inspect']).ingressId || !['not-started', 'observed', 'unavailable'].includes(String(p.observation))) fail()
    if (!ingress?.input && (receipt || p.observation !== 'not-started') || ingress?.input && p.observation === 'not-started' || p.observation === 'unavailable' && receipt) fail()
    if (ingress?.kind === 'action') {
      if (receipt) fail()
      let interactionReceipt: import('./ingress-contract.js').ConnectionIngressInspection['interactionReceipt']
      if (p.interactionReceipt === null) interactionReceipt = null
      else if (p.interactionReceipt !== undefined) {
        const value = object(p.interactionReceipt, ['operationId','agentSessionId','run','delivery','nativeAdoption']), run = object(value.run, ['runId'])
        if (!ingress.input || value.operationId !== ingress.input.operationId || value.agentSessionId !== ingress.input.agentSessionId || run.runId !== ingress.input.expectedRun.runId || !['saved','unknown','bytes-accepted','hook-written','acp-acknowledged'].includes(String(value.delivery)) || value.nativeAdoption !== 'unknown' || p.observation !== 'observed') fail()
        interactionReceipt = { operationId: text(value.operationId), agentSessionId: text(value.agentSessionId), run: { runId: text(run.runId) }, delivery: value.delivery as NonNullable<typeof interactionReceipt>['delivery'], nativeAdoption: 'unknown' }
      }
      return { ingress, inputReceipt: null, observation: p.observation, ...(interactionReceipt === undefined ? {} : { interactionReceipt }) } as ConnectionIngressResultMap[M]
    }
    if (p.interactionReceipt !== undefined) fail()
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
