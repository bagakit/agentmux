import { parseMoteMainPeriod, parseMoteMainRolloverDecision, type MoteMainPeriod, type MoteMainRolloverReading } from './mote-main-period.js'
import { dequal } from 'dequal'
import { parseAgentInputSubmit, type AgentInputSubmit } from './agent-input-submit.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { parseAgentInputSubmissionReceipt } from './agent-input-receipt-codec.js'
import { parsePromptSubmissionRecord } from './prompt-submission-record.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'
import type { AgentPromptSubmissionRecord } from './types.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMotePreferencesReadInput, parseMoteQuickDefaults, parseMoteDefaultConversation, sameMotePreferencesTarget, type MotePreferencesTarget } from './mote-preferences.js'
import type { FileReadResource } from './public-rpc-files.js'
import type { MoteDialogueIdentity, MoteMainSnapshot } from './mote-dialogue.js'
import { normalizeAgentContinuityOperation, type AgentMuxContinuityOperation } from './agent-session-recovery/continuity-contract.js'
import { parseMoteMainEntrySource, sameMoteMainEntrySource, unconfirmedMoteMainEntryOperation, type MoteMainEntrySource } from './mote-main-entry-source.js'
export { sameMoteMainEntrySource, unconfirmedMoteMainEntryOperation } from './mote-main-entry-source.js'
import type { AgentMuxRunRef } from './types.js'
import { moteMainHandoverInputId, moteMainBindingDefaults, validateMoteMainBindingObservation, validateMoteMainBindingReceipt, spatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRecord, type MoteMainBindingObservation, type MoteMainBindingReceipt } from './spatial-agent-open-contract.js'

export type MoteDialogueLink = {
  sequence: number
  identity: MoteDialogueIdentity
  operationId: string
  associatedAt: number
} & ({ kind: 'main'; roleRevision: string; reference: import('./mote-preferences.js').MoteDefaultConversation;
  /** No inferred message cut: this source is the complete original Session, with original coverage. */
  range: 'whole-session'; period?: MoteMainPeriod; file: { resource: FileReadResource; revision: string } }
  | { kind: 'work'; eventId: string; mainRoleRevision: string; main: { hostId: string; agentSessionId: string };
    origin: { hostId: string; messageId: string; threadId: string; senderSessionId: string; recipientSessionId: string; createdAt: number | null } })
export type MoteDialogueCursor = { identity: MoteDialogueIdentity; incarnation: string; selection: string; throughSequence: number; beforeSequence: number }
export type MoteDialogueRead = { target: MotePreferencesTarget; kind?: 'main' | 'work'; eventId?: string; operationId?: string; cursor?: MoteDialogueCursor; limit?: number }
export type MoteDialoguePage = { main: MoteMainSnapshot; links: MoteDialogueLink[]; incarnation: string | null; throughSequence: number;
  next: MoteDialogueCursor | null; coverage: 'linked-sources-only'; sourceStatus: 'read' | 'unconfirmed'; sourceIssue: string | null }
export type MoteDialogueWrite = { target: MotePreferencesTarget; operationId: string; expectedRoleRevision: string;
  source: { kind: 'main' } | { kind: 'work'; messageHostId: string; messageId: string; eventId?: string } }
export type MoteDialogueReceipt = { operationId: string; links: MoteDialogueLink[] }
/** Frozen intake in the original Core input journal; never a current-role registry or another input. */
export type MoteDialogueInputRoute = {
  identity: MoteDialogueIdentity; operationId: string; roleRevision: string
  reference: import('./mote-preferences.js').MoteDefaultConversation
  key: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  runtimeId: string | null; intentDigest: string; admittedAt: number; rollover?:MoteMainRolloverReading
  /** Original native recovery operation; its actual launch input key remains with that lifecycle owner. */
  recoveryOperationId?: string
}
export type MoteDialogueInputSubmit = { target: MotePreferencesTarget; expectedRoleRevision: string; input: AgentInputSubmit;
  recovery?: { operationId: string; /** Explicit original recovery reconciliation only; ordinary repeats remain reads. */ reconcile?: true } }
export type MoteDialogueInputRead = { target: MotePreferencesTarget; operationId: string }
export type MoteDialogueRecoveryRequest = MoteMainEntrySource & { expectedRun: AgentMuxRunRef; operationId: string }
/** A requested receipt, or the same original Session/Run's unresolved operation.
 * A completed attachment under another key cannot establish current liveness. */
export type MoteDialogueRecoveryInspection = { operation: AgentMuxContinuityOperation | null }
export type MoteDialogueInputInspection = { route: MoteDialogueInputRoute | null; record: AgentPromptSubmissionRecord | null; input: AgentInputSubmissionReceipt | null;
  /** The exact original retained operation, not a reconstructed recovery result or acceptance. */
  recovery?: AgentMuxContinuityOperation | null; rollover?: MoteMainRolloverReading; disposition?: 'rollover-required' }
/** Exact-condition receipt reference for clients; it grants no controlled waiting or replay contract. */
export type MoteDialogueInputReference = { inputKey: Extract<AgentPromptInputKey,{kind:'prompt'}>; record: AgentPromptSubmissionRecord;
  outcome: 'admitted' | 'terminal-confirmed'; moteObservationId?: string }
/** Follow-ups on one original agent.open admission. This never authorizes creation or recovery. */
export type MoteMainSetupRequest = { target: MotePreferencesTarget; creation: { hostId: string; operationId: string } }
export type MoteMainSetupResult = {
  operationId: string; ownerHostId: string; record: AgentMuxSpatialAgentOpenRecord | null
  reference: import('./mote-preferences.js').MoteDefaultConversation | null
  creation: 'confirmed' | 'unconfirmed'; source: 'confirmed' | 'not-needed' | 'unconfirmed'
  binding: 'confirmed' | 'refused' | 'unconfirmed'; issue: string | null
  /** Original File receipt references; an observed writer role is deliberately separate. */
  bindingReceipt: MoteMainBindingReceipt | null; bindingObserved: MoteMainBindingObservation | null
  deferredInput?: MoteDialogueInputInspection | null; handoverInput?: MoteDialogueInputInspection | null
}
export type MoteDialogueParamsMap = { 'space.mote.dialogue.read': MoteDialogueRead; 'space.mote.dialogue.link': MoteDialogueWrite; 'space.mote.dialogue.input.submit': MoteDialogueInputSubmit; 'space.mote.dialogue.input.inspect': MoteDialogueInputRead;
  'space.mote.dialogue.recovery.ensure': MoteDialogueRecoveryRequest; 'space.mote.dialogue.recovery.inspect': MoteDialogueRecoveryRequest;
  'space.mote.dialogue.setup.inspect': MoteMainSetupRequest; 'space.mote.dialogue.setup.advance': MoteMainSetupRequest }
export type MoteDialogueResultMap = { 'space.mote.dialogue.read': MoteDialoguePage; 'space.mote.dialogue.link': MoteDialogueReceipt; 'space.mote.dialogue.input.submit': MoteDialogueInputInspection; 'space.mote.dialogue.input.inspect': MoteDialogueInputInspection;
  'space.mote.dialogue.recovery.ensure': MoteDialogueRecoveryInspection; 'space.mote.dialogue.recovery.inspect': MoteDialogueRecoveryInspection;
  'space.mote.dialogue.setup.inspect': MoteMainSetupResult; 'space.mote.dialogue.setup.advance': MoteMainSetupResult }
export type MoteDialogueMethod = keyof MoteDialogueParamsMap
export const MOTE_DIALOGUE_METHODS = { 'space.mote.dialogue.read': 'short', 'space.mote.dialogue.link': 'long', 'space.mote.dialogue.input.submit': 'long', 'space.mote.dialogue.input.inspect': 'short',
  'space.mote.dialogue.recovery.ensure': 'long', 'space.mote.dialogue.recovery.inspect': 'short', 'space.mote.dialogue.setup.inspect': 'short', 'space.mote.dialogue.setup.advance': 'long' } as const
export function isMoteDialogueMethod(method: unknown): method is MoteDialogueMethod { return typeof method === 'string' && Object.hasOwn(MOTE_DIALOGUE_METHODS, method) }
export type MoteDialogueCallContext = { caller?: { hostId: string; agentSessionId: string }; signal?: AbortSignal; assertCurrent?(): Promise<void> }
export interface MoteDialoguePort {
  /** Trusted original MOTE owner for logical-main intake; not a wire-supplied snapshot. */
  mainInput?: import('./mote-dialogue.js').MoteMainReader
  read(input: MoteDialogueRead, context?: MoteDialogueCallContext): Promise<MoteDialoguePage>
  link(input: MoteDialogueWrite, context?: MoteDialogueCallContext): Promise<MoteDialogueReceipt>
}
const fail = (code: string): never => { throw new AgentMuxError('The exact original Mote dialogue, source or cursor is invalid. Existing work and references are retained.', code) }
function text(value: unknown, code: string): string { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) return fail(code); return value }
function count(value: unknown, code: string, min = 0): number { if (!Number.isSafeInteger(value) || Number(value) < min) return fail(code); return value as number }
export function parseMoteDialogueIdentity(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): MoteDialogueIdentity {
  const p = rpcRecord(value, ['hostId', 'moteId'], code)
  return { hostId: text(p.hostId, code), moteId: text(p.moteId, code) }
}
export function sameMoteDialogue(a: MoteDialogueIdentity, b: MoteDialogueIdentity): boolean { return a.hostId === b.hostId && a.moteId === b.moteId }
export function parseMoteDialogueLink(value: unknown, code: 'CONTROL_PROTOCOL_ERROR' | 'INVALID_CONTROL_REQUEST' = 'CONTROL_PROTOCOL_ERROR'): MoteDialogueLink {
  const p = rpcRecord(value, undefined, code)
  rpcRecord(p, ['sequence','identity','operationId','associatedAt', ...(p.kind === 'main' ? ['kind','roleRevision','reference','range','file','period'] : ['kind','eventId','mainRoleRevision','main','origin'])], code)
  count(p.sequence, code, 1); count(p.associatedAt, code); parseMoteDialogueIdentity(p.identity, code); text(p.operationId, code)
  if (p.kind === 'main') {
    text(p.roleRevision, code); parseMoteDefaultConversation(p.reference, code); if(p.period!==undefined){const period=parseMoteMainPeriod(p.period);if(period.roleRevision!==p.roleRevision||!dequal(period.reference,p.reference))return fail(code)}
    if (p.range !== 'whole-session') return fail(code)
    const file = rpcRecord(p.file, ['resource','revision'], code), resource = rpcRecord(file.resource, ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'], code)
    for (const key of ['hostId','workspaceId','workspacePath','zoneId','zonePath','path']) text(resource[key],code)
    if (resource.logicalDirectory !== undefined) text(resource.logicalDirectory,code)
    text(file.revision,code)
  } else if (p.kind === 'work') {
    text(p.eventId,code);text(p.mainRoleRevision,code)
    const main=rpcRecord(p.main,['hostId','agentSessionId'],code)
    text(main.hostId,code);text(main.agentSessionId,code)
    const origin=rpcRecord(p.origin,['hostId','messageId','threadId','senderSessionId','recipientSessionId','createdAt'],code)
    for(const key of ['hostId','messageId','threadId','senderSessionId','recipientSessionId'])text(origin[key],code)
    if(origin.createdAt!==null)count(origin.createdAt,code)
    if(origin.senderSessionId!==main.agentSessionId || origin.hostId!==main.hostId)return fail(code)
  } else return fail(code)
  return p as MoteDialogueLink
}
export function parseMoteDialogueParams<M extends MoteDialogueMethod>(method:M,value:unknown):MoteDialogueParamsMap[M] {
  if (method === 'space.mote.dialogue.setup.inspect' || method === 'space.mote.dialogue.setup.advance') {
    const p = rpcRecord(value, ['target','creation'])
    parseMotePreferencesReadInput({kind:'quick', target:p.target})
    const creation = rpcRecord(p.creation, ['hostId','operationId'])
    text(creation.hostId, 'INVALID_CONTROL_REQUEST'); text(creation.operationId, 'INVALID_CONTROL_REQUEST')
    return p as MoteDialogueParamsMap[M]
  }
  if (method === 'space.mote.dialogue.recovery.ensure' || method === 'space.mote.dialogue.recovery.inspect') {
    const p = rpcRecord(value, ['target','expectedRoleRevision','reference','expectedRun','operationId'])
    parseMoteMainEntrySource({ target:p.target, expectedRoleRevision:p.expectedRoleRevision, reference:p.reference })
    text(p.operationId, 'INVALID_CONTROL_REQUEST')
    const run = rpcRecord(p.expectedRun, ['runId'])
    text(run.runId, 'INVALID_CONTROL_REQUEST')
    return p as MoteDialogueParamsMap[M]
  }
  if (method === 'space.mote.dialogue.input.submit' || method === 'space.mote.dialogue.input.inspect') {
    const p = rpcRecord(value, method === 'space.mote.dialogue.input.submit' ? ['target','expectedRoleRevision','input','recovery'] : ['target','operationId'])
    parseMotePreferencesReadInput({kind:'quick',target:p.target})
    if (method === 'space.mote.dialogue.input.submit') {
      text(p.expectedRoleRevision,'INVALID_CONTROL_REQUEST'); const input = parseAgentInputSubmit(p.input)
      if (p.recovery !== undefined) {
        const recovery = rpcRecord(p.recovery,['operationId','reconcile'])
        text(recovery.operationId,'INVALID_CONTROL_REQUEST')
        if (recovery.reconcile !== undefined && recovery.reconcile !== true) return fail('INVALID_CONTROL_REQUEST')
        if (input.admissionIntent?.kind !== 'manual-actor' || input.execution !== 'immediate') throw new AgentMuxError(
          'Native recovery accepts an explicit new manual input only. The original native source, turn or exact condition cannot be replaced by a resumed actor; keep that original request.', 'MOTE_MAIN_RECOVERY_INTENT_MISMATCH')
        if (input.inputImages?.length) throw new AgentMuxError('The original native recovery input cannot carry selected images. Keep this original text, capture and image draft; restore the same Session without input before sending the intact draft.', 'AGENT_INPUT_IMAGES_RECOVERY_UNAVAILABLE')
        if (input.preparationRetry || input.allowUncertainTurn) return fail('INVALID_CONTROL_REQUEST')
      }
    }
    else text(p.operationId,'INVALID_CONTROL_REQUEST')
    return p as MoteDialogueParamsMap[M]
  }
  const code='INVALID_CONTROL_REQUEST',p=rpcRecord(value,method==='space.mote.dialogue.read'?['target','kind','eventId','operationId','cursor','limit']:['target','operationId','expectedRoleRevision','source'],code)
  parseMotePreferencesReadInput({kind:'quick',target:p.target})
  if(method==='space.mote.dialogue.link'){
    text(p.operationId,code);text(p.expectedRoleRevision,code)
    const source=rpcRecord(p.source,undefined,code)
    if(source.kind==='main')rpcRecord(source,['kind'],code)
    else if(source.kind==='work'){
      rpcRecord(source,['kind','messageHostId','messageId','eventId'],code);text(source.messageHostId,code);text(source.messageId,code)
      if(source.eventId!==undefined)text(source.eventId,code)
    }else return fail(code)
  }else{
    if(p.kind!==undefined&&!['main','work'].includes(String(p.kind)))return fail(code)
    for(const key of ['eventId','operationId'])if(p[key]!==undefined)text(p[key],code)
    if(p.eventId!==undefined&&p.kind==='main')return fail(code)
    if(p.limit!==undefined&&(count(p.limit,code,1)>100))return fail(code)
    if(p.cursor!==undefined){const c=rpcRecord(p.cursor,['identity','incarnation','selection','throughSequence','beforeSequence'],code);parseMoteDialogueIdentity(c.identity,code);text(c.incarnation,code);text(c.selection,code);count(c.throughSequence,code);count(c.beforeSequence,code,1);if(Number(c.beforeSequence)>Number(c.throughSequence)+1)return fail(code)}
  }
  return p as MoteDialogueParamsMap[M]
}
export function parseMoteDialogueResult<M extends MoteDialogueMethod>(method:M,value:unknown,input:MoteDialogueParamsMap[M]):MoteDialogueResultMap[M]{
  if (method === 'space.mote.dialogue.setup.inspect' || method === 'space.mote.dialogue.setup.advance') {
    const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId','ownerHostId','record','reference','creation','source','binding','issue','bindingReceipt','bindingObserved','deferredInput','handoverInput'], code), query = input as MoteMainSetupRequest
    if (p.operationId !== query.creation.operationId || p.ownerHostId !== query.creation.hostId || !['confirmed','unconfirmed'].includes(String(p.creation)) ||
      !['confirmed','not-needed','unconfirmed'].includes(String(p.source)) || !['confirmed','refused','unconfirmed'].includes(String(p.binding)) || p.issue !== null && typeof p.issue !== 'string') return fail(code)
    if (p.reference !== null) parseMoteDefaultConversation(p.reference,code)
    if (p.record !== null) {
      const raw = rpcRecord(p.record,['requestId','digest','agentSessionId','executorId','address','execution','moteMain','moteMainFollowUps'],code)
      for (const key of ['requestId','digest','agentSessionId','executorId']) text(raw[key],code)
      const address = rpcRecord(raw.address,['spaceId','zoneId','workspaceId','displayWorkspaceId','groupId','tabId','regionId'],code)
      for (const key of ['spaceId','zoneId','workspaceId','displayWorkspaceId','groupId','tabId','regionId']) text(address[key],code)
      const execution = rpcRecord(raw.execution,['hostId','workspacePath','workspaceId'],code)
      for (const key of ['hostId','workspacePath','workspaceId']) text(execution[key],code)
      const record = spatialAgentOpenRecord({ resources: { 'core:agent-open': {schema:'agentmux.spatial-agent-open.v1', requests:{ [query.creation.operationId]:p.record }} } } as unknown as import('./spatial-graph.js').AgentMuxSpatialGraph, query.creation.operationId)
      if (!record?.moteMain || !sameMotePreferencesTarget(record.moteMain.target,query.target) || !dequal(p.reference, {hostId:record.execution.hostId,sessionId:record.agentSessionId,displayWorkspaceId:record.address.displayWorkspaceId,groupId:record.address.groupId,tabId:record.address.tabId,regionId:record.address.regionId}) && p.reference !== null) return fail(code)
      if (p.creation === 'confirmed' && p.reference === null || p.source === 'not-needed' && record?.moteMain?.baseline.defaults.conversation || p.source === 'confirmed' && !record?.moteMain?.baseline.defaults.conversation || p.binding === 'confirmed' && p.bindingObserved === null && !['saved','unchanged'].includes(String((p.bindingReceipt as MoteMainBindingReceipt | null)?.status)) || p.binding === 'refused' && !record?.moteMainFollowUps?.refusedBeforeBinding && (p.bindingReceipt as MoteMainBindingReceipt | null)?.status !== 'refused-before-write') return fail(code)
      if (record && p.bindingReceipt !== null) validateMoteMainBindingReceipt(record,p.bindingReceipt as MoteMainBindingReceipt)
      if (record && p.bindingObserved !== null) validateMoteMainBindingObservation(record,p.bindingObserved as MoteMainBindingObservation)
      for(const field of ['deferredInput','handoverInput'] as const) if(p[field]!==undefined) {
        const operationId=field==='deferredInput'?record.moteMain.deferredInput?.operationId:record.moteMain.handover?moteMainHandoverInputId(record.requestId):undefined
        if(!operationId)return fail(code)
        if(p[field]!==null){const observed=parseMoteDialogueResult('space.mote.dialogue.input.inspect',p[field],{target:query.target,operationId});if(observed.route&&(!dequal(observed.route.reference,p.reference)||observed.route.roleRevision!==moteMainBindingDefaults(record).conversationRevision))return fail(code)}
      }
    } else if (p.reference !== null || p.creation !== 'unconfirmed' || p.bindingReceipt !== null || p.bindingObserved !== null) return fail(code)
    return p as MoteDialogueResultMap[M]
  }
  if (method === 'space.mote.dialogue.recovery.ensure' || method === 'space.mote.dialogue.recovery.inspect') {
    const p = rpcRecord(value, ['operation'], 'CONTROL_PROTOCOL_ERROR'), query = input as MoteDialogueRecoveryRequest
    if (p.operation !== null) {
      const op = normalizeAgentContinuityOperation(p.operation)
      if (op.agentSessionId !== query.reference.sessionId || !dequal(op.previousRun, query.expectedRun) ||
          op.operationId !== query.operationId && (!unconfirmedMoteMainEntryOperation(op) || !sameMoteMainEntrySource(op.moteMainEntry, query)) ||
          op.moteMainEntry && op.operationId === query.operationId && !dequal(op.moteMainEntry, { target:query.target, expectedRoleRevision:query.expectedRoleRevision, reference:query.reference })) return fail('CONTROL_PROTOCOL_ERROR')
    }
    return p as MoteDialogueResultMap[M]
  }
  if (method === 'space.mote.dialogue.input.submit' || method === 'space.mote.dialogue.input.inspect') {
    const p = rpcRecord(value, ['route','record','input','recovery','rollover','disposition'], 'CONTROL_PROTOCOL_ERROR')
    if(p.rollover!==undefined){const r=rpcRecord(p.rollover,['status','decision','issue'],'CONTROL_PROTOCOL_ERROR');if(!['keep-current','not-due','due','unconfirmed'].includes(String(r.status))||r.issue!==null&&typeof r.issue!=='string')return fail('CONTROL_PROTOCOL_ERROR');if(r.status==='due'){const d=parseMoteMainRolloverDecision(r.decision,'CONTROL_PROTOCOL_ERROR'),q=input as MoteDialogueInputSubmit;if(p.disposition!=='rollover-required'||!('input' in q)||d.queryOperationId!==q.input.operationId||d.expectedRoleRevision!==q.expectedRoleRevision||!sameMotePreferencesTarget(d.target,q.target))return fail('CONTROL_PROTOCOL_ERROR')}else if(r.decision!==null)return fail('CONTROL_PROTOCOL_ERROR')}
    if (p.route === null) { if (method !== 'space.mote.dialogue.input.inspect' && p.disposition!=='rollover-required' || p.record !== null || p.input !== null || p.recovery !== undefined) return fail('CONTROL_PROTOCOL_ERROR') }
    else {
      const route = parseMoteDialogueInputRoute(p.route), query = input as MoteDialogueInputSubmit | MoteDialogueInputRead
      if (route.operationId !== ('input' in query ? query.input.operationId : query.operationId) || route.identity.hostId !== query.target.expectedResource.hostId) return fail('CONTROL_PROTOCOL_ERROR')
      if ('input' in query && (route.roleRevision !== query.expectedRoleRevision || !dequal(route.key, { kind:'prompt',agentSessionId:query.input.agentSessionId,expectedRun:query.input.expectedRun,submissionId:query.input.operationId }))) return fail('CONTROL_PROTOCOL_ERROR')
      if ('input' in query && route.recoveryOperationId !== query.recovery?.operationId) return fail('CONTROL_PROTOCOL_ERROR')
      const recovery = p.recovery == null ? null : normalizeAgentContinuityOperation(p.recovery)
      if (recovery && (!route.recoveryOperationId || recovery.operationId !== route.recoveryOperationId || recovery.agentSessionId !== route.key.agentSessionId ||
        recovery.previousRun.runId !== route.key.expectedRun.runId || recovery.trigger !== 'input' || recovery.launchInput && recovery.launchInput.input.submissionId !== route.operationId)) return fail('CONTROL_PROTOCOL_ERROR')
      if (route.recoveryOperationId ? p.recovery === undefined : p.recovery !== undefined) return fail('CONTROL_PROTOCOL_ERROR')
      const originalKey = recovery?.launchInput?.key ?? route.key
      const observed = p.input === null ? null : parseAgentInputSubmissionReceipt(p.input)
      if (observed && (!dequal(observed.key,originalKey) || !dequal(observed.admission,p.record))) return fail('CONTROL_PROTOCOL_ERROR')
      if (p.record !== null) {
        const record = parsePromptSubmissionRecord(p.record)
        if (!observed && (record.agentSessionId !== originalKey.agentSessionId || !dequal(record.run,originalKey.expectedRun) || (record.admission?.submissionId ?? record.launch?.input.submissionId) !== route.operationId)) return fail('CONTROL_PROTOCOL_ERROR')
      }
    }
    return p as MoteDialogueResultMap[M]
  }
  const code='CONTROL_PROTOCOL_ERROR',p=rpcRecord(value,method==='space.mote.dialogue.read'?['main','links','incarnation','throughSequence','next','coverage','sourceStatus','sourceIssue']:['operationId','links'],code)
  if(!Array.isArray(p.links))return fail(code)
  const links=p.links.map(link=>parseMoteDialogueLink(link,code))
  if(method==='space.mote.dialogue.link'){
    if(p.operationId!==(input as MoteDialogueWrite).operationId||links.some(link=>link.operationId!==p.operationId))return fail(code)
  }else{
    const query=input as MoteDialogueRead,main=rpcRecord(p.main,['target','identity','status','resource','documentRevision','roleRevision','current','issue','transition'],code)
    if(!sameMotePreferencesTarget(main.target as MotePreferencesTarget,query.target)||!['ready','unconfirmed'].includes(String(main.status)))return fail(code)
    if(main.transition!==undefined)parseMoteQuickDefaults({conversationTransition:main.transition},code)
    const identity=main.identity===null?null:parseMoteDialogueIdentity(main.identity,code)
    if(main.current!==null)parseMoteDefaultConversation(main.current,code)
    for(const key of ['documentRevision','roleRevision','issue'])if(main[key]!==null)text(main[key],code)
    count(p.throughSequence,code);if(p.incarnation!==null)text(p.incarnation,code)
    if(p.coverage!=='linked-sources-only'||links.length>(query.limit??50)||links.some(link=>!identity||!sameMoteDialogue(identity,link.identity)))return fail(code)
    if(p.sourceStatus==='read' ? p.sourceIssue!==null : p.sourceStatus!=='unconfirmed'||typeof p.sourceIssue!=='string'||!p.sourceIssue)return fail(code)
    if(query.cursor&&(p.incarnation!==query.cursor.incarnation||p.throughSequence!==query.cursor.throughSequence))return fail(code)
    let previous=query.cursor?.beforeSequence??Number.MAX_SAFE_INTEGER
    for(const link of links){if(link.sequence>=previous||link.sequence>Number(p.throughSequence)||query.kind&&link.kind!==query.kind||query.eventId&&(link.kind!=='work'||link.eventId!==query.eventId)||query.operationId&&link.operationId!==query.operationId)return fail(code);previous=link.sequence}
    if(p.next!==null){const c=rpcRecord(p.next,['identity','incarnation','selection','throughSequence','beforeSequence'],code);if(!links.length||!identity||!sameMoteDialogue(parseMoteDialogueIdentity(c.identity,code),identity)||c.incarnation!==p.incarnation||c.selection!==moteDialogueSelection(query)||c.throughSequence!==p.throughSequence||c.beforeSequence!==links.at(-1)!.sequence)return fail(code)}
  }
  return p as MoteDialogueResultMap[M]
}

export function parseMoteDialogueInputRoute(value: unknown): MoteDialogueInputRoute {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['identity','operationId','roleRevision','reference','key','runtimeId','intentDigest','admittedAt','recoveryOperationId','rollover'], code)
  parseMoteDialogueIdentity(p.identity, code); text(p.operationId,code); text(p.roleRevision,code)
  const reference = parseMoteDefaultConversation(p.reference,code), key = validateAgentPromptInputKey(p.key)
  if (key.kind !== 'prompt' || key.agentSessionId !== reference.sessionId || key.submissionId !== p.operationId || typeof p.intentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.intentDigest)) return fail(code)
  if (p.runtimeId !== null) text(p.runtimeId,code)
  if (p.recoveryOperationId !== undefined) text(p.recoveryOperationId,code)
  if(p.rollover!==undefined){const r=rpcRecord(p.rollover,['status','decision','issue'],code);if(!['keep-current','not-due','unconfirmed'].includes(String(r.status))||r.decision!==null||r.issue!==null&&typeof r.issue!=='string')return fail(code)}
  count(p.admittedAt,code)
  return p as MoteDialogueInputRoute
}
export function moteDialogueInputScope(identity: MoteDialogueIdentity): string { return JSON.stringify([identity.hostId,identity.moteId]) }

export function moteDialogueSelection(query: Pick<MoteDialogueRead,'kind'|'eventId'|'operationId'>): string { return JSON.stringify([query.kind ?? null,query.eventId ?? null,query.operationId ?? null]) }
