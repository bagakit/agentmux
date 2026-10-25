import { parseExternalConversationReference, parseExternalConversationAuthority, parseExternalConversationReceipt } from './external-conversation.js'
import { validateAgentPromptAdmissionIntent } from './agent-prompt-condition.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor, parseConnectionApplication } from './room-binding-codec.js'
import { parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor, parseAgentExternalAuthoritySource } from './external-author.js'
import { parseAgentInputSubmissionReceipt } from './agent-input-receipt-codec.js'
import { channelActorKey, parseChannelActorProfileObservation } from './channel-profile.js'
import { parseChannelTranscriptQuote } from './channel-quote.js'
import type { ConnectionIngressAddressing, ConnectionIngressMethod, ConnectionIngressParamsMap, ConnectionIngressRecord, ConnectionIngressResultMap } from './ingress-contract.js'

export const INGRESS_RPC_METHODS = { 'connection.ingress.inspect': 'long', 'connection.ingress.ls': 'long', 'connection.ingress.authority': 'long', 'connection.ingress.record-authority': 'long' } as const
export const isIngressMethod = (value: unknown): value is ConnectionIngressMethod => typeof value === 'string' && Object.hasOwn(INGRESS_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Ingress data does not describe its original intake or input.', 'INVALID_CONNECTION_INGRESS') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_INGRESS')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export function parseConnectionQuestionAnswerSubmissions(value: unknown): import('./ingress-contract.js').ConnectionQuestionAnswerSubmission[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail()
  const ids = new Set<string>()
  return (value as unknown[]).map(value => {
    const answer = object(value, ['questionId', 'optionIds', 'text']), questionId = text(answer.questionId)
    if (ids.has(questionId)) fail()
    ids.add(questionId)
    if (answer.text !== undefined && (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 131_072)) fail()
    if (answer.optionIds !== undefined && (!Array.isArray(answer.optionIds) || !answer.optionIds.length || answer.optionIds.length > 100 || new Set(answer.optionIds).size !== answer.optionIds.length)) fail()
    if (answer.text === undefined && answer.optionIds === undefined || answer.text !== undefined && answer.optionIds !== undefined) fail()
    return { questionId, ...(answer.text === undefined ? {} : { text: answer.text as string }),
      ...(answer.optionIds === undefined ? {} : { optionIds: (answer.optionIds as unknown[]).map(text) }) }
  })
}
export const CONNECTION_INGRESS_AUTHORITY_CODES = ['INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_CLAIM_UNAVAILABLE', 'INGRESS_CONNECTION_UNAVAILABLE', 'INGRESS_BINDING_UNAVAILABLE', 'INGRESS_ACTOR_NOT_AUTHORIZED', 'INGRESS_INPUT_OUTSIDE_SCOPE', 'INGRESS_ADDRESSING_UNCONFIRMED', 'INGRESS_AUTHORITY_REVISED', 'INGRESS_TARGET_UNCONFIRMED', 'INGRESS_STORAGE_UNCONFIRMED'] as const satisfies readonly import('./ingress-contract.js').ConnectionIngressAuthorityCode[]
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
    const p = object(value, ['kind', 'ingressId', 'connectionId', 'application', 'eventId', 'actor', 'externalConversationId', 'sourceMessageId', 'actionRef', 'answers', 'state', 'code', 'input'])
    const application = parseConnectionApplication(p.application)
    const actor = p.actor === undefined ? undefined : parseConnectionActor(p.actor)
    if (!['received', 'claimed', 'refused'].includes(String(p.state)) || actor && !equal(actor.application, application)) fail()
    const base = { kind: 'action' as const, ingressId: text(p.ingressId), connectionId: text(p.connectionId), application, eventId: text(p.eventId),
      ...(actor === undefined ? {} : { actor }), ...(p.externalConversationId === undefined ? {} : { externalConversationId: text(p.externalConversationId) }),
      ...(p.sourceMessageId === undefined ? {} : { sourceMessageId: text(p.sourceMessageId) }), ...(p.actionRef === undefined ? {} : { actionRef: text(p.actionRef) }),
      ...(p.answers === undefined ? {} : { answers: parseConnectionQuestionAnswerSubmissions(p.answers) }),
      }
    if (p.state === 'refused') { if (p.input !== undefined || p.code !== 'INGRESS_ACTION_UNSUPPORTED' && p.code !== 'INGRESS_QUESTION_ANSWER_INVALID' && !CONNECTION_INGRESS_AUTHORITY_CODES.includes(p.code as never)) fail(); return { ...base, state: 'refused', code: p.code as NonNullable<import('./ingress-contract.js').ConnectionIngressAction['code']> } }
    if (!base.actor || !base.externalConversationId || !base.sourceMessageId || !base.actionRef || p.code !== undefined) fail()
    if (p.state === 'received') { if (p.input !== undefined) fail(); return { ...base, state: 'received' } }
    const input = object(p.input, ['hostId','agentSessionId','expectedRun','operationId','intentDigest','author','responseKind']), run = object(input.expectedRun, ['runId']), author = parseAgentExternalInteractionAuthor(input.author)
    if (input.responseKind !== undefined && input.responseKind !== 'question') fail()
    if (!/^[a-f0-9]{64}$/u.test(text(input.intentDigest)) || author.connectionId !== base.connectionId || !equal(author.actor, base.actor) || author.externalConversationId !== base.externalConversationId || author.sourceMessageId !== base.sourceMessageId || author.actionRef !== base.actionRef) fail()
    return { ...base, state: 'claimed', input: { hostId: text(input.hostId), agentSessionId: text(input.agentSessionId), expectedRun: { runId: text(run.runId) }, operationId: text(input.operationId), intentDigest: text(input.intentDigest), author, ...(input.responseKind === 'question' ? { responseKind: 'question' as const } : {}) } }
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
      const t = object(g.target, ['hostId', 'agentSessionId', 'connectionId', 'bindingId', 'bindingRevision', 'publicationRevision', 'authoritySource'])
      if (!Number.isSafeInteger(t.bindingRevision) || Number(t.bindingRevision) < 1) fail()
      if (t.publicationRevision !== undefined && (!Number.isSafeInteger(t.publicationRevision) || Number(t.publicationRevision) < 1 || Number(t.publicationRevision) > Number(t.bindingRevision))) fail()
      const target = { hostId: text(t.hostId), agentSessionId: text(t.agentSessionId), connectionId: text(t.connectionId), bindingId: text(t.bindingId), bindingRevision: t.bindingRevision as number, ...(t.publicationRevision === undefined ? {} : { publicationRevision: t.publicationRevision as number }), ...(t.authoritySource === undefined ? {} : { authoritySource: parseAgentExternalAuthoritySource(t.authoritySource) }) }
      group = { target, ...(recording ? { recording } : {}), ...(g.recorded === undefined ? {} : { recorded: parseExternalConversationReceipt(g.recorded, { agentSessionId: target.agentSessionId, ingressId: base.ingressId, ...(target.authoritySource ? { authoritySource: target.authoritySource } : {}) }) }) }
    }
  }
  const projected = { ...base, ...(group === undefined ? {} : { group }) }
  if (p.state === 'refused') { if (p.input !== undefined) fail(); return { ...projected, state: 'refused', code: text(p.code) } }
  if (p.state === 'received') { if (p.input !== undefined) fail(); return { ...projected, state: 'received', ...(p.code === undefined ? {} : { code: text(p.code) }) } }
  if (p.code !== undefined) fail()
  const input = object(p.input, ['hostId', 'agentSessionId', 'expectedRun', 'operationId', 'messageId', 'author', 'admissionIntent', 'channelProfile', 'channelQuote', 'contextSource', 'contextObservation']), run = object(input.expectedRun, ['runId'])
  const channelProfile = input.channelProfile === undefined ? undefined : parseChannelActorProfileObservation(input.channelProfile)
  const contextSource = input.contextSource === undefined ? undefined : (() => { const s = object(input.contextSource, ['providerId', 'nativeSessionId']); return { providerId: text(s.providerId), nativeSessionId: text(s.nativeSessionId) } })()
  if (input.contextObservation !== undefined && input.contextObservation !== 'known-publications-unavailable') fail()
  const channelQuote = input.channelQuote === undefined ? undefined : parseChannelTranscriptQuote(input.channelQuote)
  if (channelQuote && (!equal(channelQuote.application, application) || channelQuote.externalConversationId !== base.externalConversationId || channelQuote.range.throughMessageId !== base.externalMessageId)) fail()
  if (input.contextObservation && (!channelQuote || !contextSource)) fail()
  if (channelProfile && channelActorKey(channelProfile.actor) !== channelActorKey(actor)) fail()
  const admissionIntent = input.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(input.admissionIntent)
  if (admissionIntent && (admissionIntent.kind === 'exact-condition' || admissionIntent.expectedRun.runId !== run.runId)) fail()
  const author = parseAgentExternalMessageAuthor(input.author), operationId = text(input.operationId), messageId = text(input.messageId)
  if (group?.target && !equal(author.authoritySource, group.target.authoritySource)) fail()
  // Intake retains its receiver alias; the author names the independently authorized Binding connection.
  if (operationId === messageId || !equal(author.actor, actor) || author.externalMessageId !== base.externalMessageId || author.externalConversationId !== base.externalConversationId) fail()
  return { ...projected, state: 'claimed', input: { hostId: text(input.hostId), agentSessionId: text(input.agentSessionId), expectedRun: { runId: text(run.runId) }, operationId, messageId, author, ...(channelProfile ? { channelProfile } : {}), ...(channelQuote ? { channelQuote } : {}), ...(contextSource ? { contextSource } : {}), ...(input.contextObservation ? { contextObservation: 'known-publications-unavailable' as const } : {}), ...(admissionIntent === undefined ? {} : { admissionIntent: admissionIntent as Exclude<typeof admissionIntent, { kind: 'exact-condition' }> }) } }
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
    const p = object(value, ['ingress', 'inputReceipt', 'interactionReceipt', 'questionReceipt', 'observation', 'context']), ingress = p.ingress === null ? null : parseConnectionIngressRecord(p.ingress)
    const receipt = p.inputReceipt === null ? null : parseAgentInputSubmissionReceipt(p.inputReceipt)
    if (ingress && ingress.ingressId !== (input as ConnectionIngressParamsMap['connection.ingress.inspect']).ingressId || !['not-started', 'observed', 'unavailable'].includes(String(p.observation))) fail()
    if (!ingress?.input && (receipt || p.observation !== 'not-started') || ingress?.input && p.observation === 'not-started' || p.observation === 'unavailable' && receipt) fail()
    if (ingress?.kind === 'action') {
      if (p.context !== undefined) fail()
      if (ingress.input?.responseKind === 'question') {
        if (p.interactionReceipt !== undefined || receipt) fail()
        let questionReceipt: import('./ingress-contract.js').ConnectionIngressInspection['questionReceipt']
        if (p.questionReceipt === null) questionReceipt = null
        else if (p.questionReceipt !== undefined) {
          const q = object(p.questionReceipt, ['agentSessionId','expectedRun','operationId','source','recordId','questionIds','outcome']), run = object(q.expectedRun, ['runId']), source = object(q.source, ['providerId','nativeSessionId'])
          if (q.agentSessionId !== ingress.input.agentSessionId || q.operationId !== ingress.input.operationId || run.runId !== ingress.input.expectedRun.runId ||
              !['saved','unknown','not-applied','submitted'].includes(String(q.outcome)) || !Array.isArray(q.questionIds) || !q.questionIds.length || new Set(q.questionIds).size !== q.questionIds.length || p.observation !== 'observed') fail()
          questionReceipt = { agentSessionId: text(q.agentSessionId), expectedRun: { runId: text(run.runId) }, operationId: text(q.operationId),
            source: { providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId) }, recordId: text(q.recordId), questionIds: (q.questionIds as unknown[]).map(text), outcome: q.outcome as NonNullable<typeof questionReceipt>['outcome'] }
        }
        return { ingress, inputReceipt: null, observation: p.observation, ...(questionReceipt === undefined ? {} : { questionReceipt }) } as ConnectionIngressResultMap[M]
      }
      if (p.questionReceipt !== undefined) fail()
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
    if (p.interactionReceipt !== undefined || p.questionReceipt !== undefined) fail()
    if (receipt && (receipt.key.kind !== 'message' || receipt.key.messageId !== ingress?.input?.messageId || receipt.key.agentSessionId !== ingress?.input?.agentSessionId || !equal(receipt.key.expectedRun, ingress?.input?.expectedRun) || receipt.originalControlOperationId !== ingress?.input?.operationId)) fail()
    const context = p.context === undefined ? undefined : parseIngressContextObservation(p.context)
    if (context && (!ingress?.input?.channelQuote || context.coverage !== ingress.input.channelQuote.coverage ||
        context.quotedMessages !== ingress.input.channelQuote.records.length || context.gapCount !== ingress.input.channelQuote.gaps.length)) fail()
    return { ingress, inputReceipt: receipt, observation: p.observation, ...(context ? { context } : {}) } as ConnectionIngressResultMap[M]
  }
  const p = object(value, ['ingresses', 'nextAfterIngressId']), expected = input as ConnectionIngressParamsMap['connection.ingress.ls']
  if (!Array.isArray(p.ingresses) || p.ingresses.length > (expected.limit ?? 25)) fail()
  const ingresses = (p.ingresses as unknown[]).map(parseConnectionIngressRecord)
  if (new Set(ingresses.map(i => i.ingressId)).size !== ingresses.length || ingresses.some(i => i.connectionId !== expected.connectionId || expected.bindingId !== undefined && (i.kind !== 'action' ? i.group?.target?.bindingId ?? i.input?.author.bindingId : i.input?.author.bindingId) !== expected.bindingId || i.ingressId === expected.afterIngressId)) fail()
  const nextAfterIngressId = p.nextAfterIngressId === null ? null : text(p.nextAfterIngressId)
  if (nextAfterIngressId !== null && nextAfterIngressId !== ingresses.at(-1)?.ingressId) fail()
  return { ingresses, nextAfterIngressId } as ConnectionIngressResultMap[M]
}

export function parseIngressContextObservation(value: unknown): import('./ingress-contract.js').ConnectionIngressContextObservation {
  const p = object(value, ['coverage', 'quotedMessages', 'gapCount', 'positionMessageId', 'observation', 'code'])
  if (p.code !== undefined && p.code !== 'known-publications-unavailable') fail()
  if (typeof p.coverage !== 'string' || !['complete', 'partial', 'unavailable'].includes(p.coverage) ||
      typeof p.observation !== 'string' || !['observed', 'unavailable'].includes(p.observation) ||
      !Number.isSafeInteger(p.quotedMessages) || Number(p.quotedMessages) < 0 ||
      !Number.isSafeInteger(p.gapCount) || Number(p.gapCount) < 0 ||
      (p.coverage === 'complete' ? Number(p.gapCount) !== 0 : Number(p.gapCount) === 0) ||
      p.observation === 'unavailable' && p.positionMessageId !== null) fail()
  return { coverage: p.coverage as import('./ingress-contract.js').ConnectionIngressContextObservation['coverage'],
    quotedMessages: Number(p.quotedMessages), gapCount: Number(p.gapCount),
    positionMessageId: p.positionMessageId === null ? null : text(p.positionMessageId),
    observation: p.observation as 'observed' | 'unavailable', ...(p.code ? { code: 'known-publications-unavailable' as const } : {}) }
}
