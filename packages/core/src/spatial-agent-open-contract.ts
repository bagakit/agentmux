import { safeId } from './agent-identifiers.js'
import { deriveObjectId } from './object-id.js'
import { parseMoteMainRolloverDecision, type MoteMainRolloverDecision } from './mote-main-period.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { parseAgentInputSubmit } from './agent-input-submit.js'
import type { AgentMuxAgentSession } from './types.js'
import type { AgentMuxSpaceAgentFact, AgentMuxSpaceAddress, AgentMuxSpaceControlRequest } from './space-control.js'
import type { AgentMuxSpatialGraph } from './spatial-graph.js'
import { parseMotePreferencesTarget, parseMoteDefaultConversation, parseMoteQuickBaseline, parseMotePreferencesSaveResult, sameMoteQuickDefaults, sameMotePreferencesTarget, effectiveMoteQuickSave, moteChangedMainRoleRevision, type MotePreferencesTarget, type MoteQuickBaseline, type MoteQuickPreferencesSaveParams, type MoteQuickPreferencesSaveResult } from './mote-preferences.js'
import { rpcRecord } from './rpc-data.js'
import { AgentMuxError } from './errors.js'
import type { FileReadResource } from './public-rpc-files.js'
import type { MoteDefaultConversation } from './mote-preferences.js'

/** Correlation on the original creation admission. It grants no Main role or input authority. */
export type MoteMainBaseline = Omit<MoteQuickBaseline, 'document'> & { documentRevision: string | null }
export const moteMainBaseline = (baseline: MoteQuickBaseline): MoteMainBaseline => ({ resource: baseline.resource, documentRevision: baseline.document?.revision ?? null, defaults: baseline.defaults })
export function parseMoteMainBaseline(value: unknown, target: MotePreferencesTarget, code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' | 'INVALID_CLI_ARGUMENT' = 'INVALID_CONTROL_REQUEST'): MoteMainBaseline {
  const p = rpcRecord(value, ['resource','documentRevision','defaults'], code)
  // Structural resource/default parsing does not record a File observation.
  const parsed = parseMoteQuickBaseline({ resource: p.resource, document: null, defaults: p.defaults }, target, code)
  if (p.documentRevision !== null && (typeof p.documentRevision !== 'string' || !p.documentRevision || /[\0\r\n]/u.test(p.documentRevision))) throw new AgentMuxError('The original MOTE revision is invalid.', code)
  return { resource: parsed.resource, defaults: parsed.defaults, documentRevision: p.documentRevision as string | null }
}
export function sameMoteMainBaseline(a: MoteMainBaseline, b: MoteMainBaseline): boolean {
  return a.documentRevision === b.documentRevision && sameMoteQuickDefaults(a.defaults, b.defaults) &&
    Object.keys(a.resource).length === Object.keys(b.resource).length && Object.entries(a.resource).every(([key,value]) => b.resource[key as keyof typeof b.resource] === value)
}
/** A read snapshot and a writer's source association prove different original facts. */
export type MoteMainBindingObservation = {kind:'preferences';source:MoteMainBaseline} |
  {kind:'source';operationId:string;file:{resource:FileReadResource;revision:string};reference:MoteDefaultConversation;roleRevision:string}
export type MoteMainBindingReceipt = { operationId: string; status: MoteQuickPreferencesSaveResult['status']; source: MoteMainBaseline | null; message: string | null }
export type MoteMainFollowUpInput = { requestId: string; step: 'source' | 'binding'; receipt?: MoteQuickPreferencesSaveResult; baselineChanged?: MoteMainBaseline }
export type MoteMainDeferredInput = Pick<import('./agent-input-submit.js').AgentInputSubmit,'operationId'|'prompt'|'sourceChannel'|'inputImages'>
export type MoteMainCreationIntent = { target: MotePreferencesTarget; baseline: MoteMainBaseline;
  expectedRoleRevision: string | null; sourceOperationId: string; bindOperationId: string; deferredInput?: MoteMainDeferredInput; handover?: true; rollover?:MoteMainRolloverDecision }
export function parseMoteMainCreationIntent(value: unknown, code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' | 'INVALID_CLI_ARGUMENT' = 'INVALID_CONTROL_REQUEST'): MoteMainCreationIntent {
  const p = rpcRecord(value, ['target','baseline','expectedRoleRevision','sourceOperationId','bindOperationId','deferredInput','handover','rollover'], code)
  const target = parseMotePreferencesTarget(p.target, code), baseline = parseMoteMainBaseline(p.baseline, target, code)
  for (const key of ['sourceOperationId','bindOperationId','expectedRoleRevision']) {
    if (key === 'expectedRoleRevision' && p[key] === null) continue
    if (typeof p[key] !== 'string' || !(p[key] as string).trim() || /[\0\r\n]/u.test(p[key] as string)) throw new AgentMuxError('The original Main creation references are invalid.', code)
  }
  if (baseline.defaults.conversation && !p.expectedRoleRevision || !baseline.defaults.executorId || p.sourceOperationId === p.bindOperationId)
    throw new AgentMuxError('Main creation requires the original configured default and role generation.', code)
  let deferredInput: MoteMainDeferredInput | undefined
  if (p.deferredInput !== undefined) {
    const d=rpcRecord(p.deferredInput,['operationId','prompt','sourceChannel','inputImages'],code)
    const parsed=parseAgentInputSubmit({...d,agentSessionId:'deferred-main',expectedRun:{runId:'deferred-main'},afterSubmissionId:null})
    safeId(parsed.operationId,'Agent prompt operation id')
    deferredInput={operationId:parsed.operationId,prompt:parsed.prompt,...(parsed.sourceChannel ? {sourceChannel:parsed.sourceChannel} : {}),...(parsed.inputImages ? {inputImages:parsed.inputImages} : {})}
    if ([p.sourceOperationId,p.bindOperationId].includes(deferredInput.operationId)) throw new AgentMuxError('The deferred input keeps a distinct original operation.',code)
  }
  if(p.handover !== undefined && (p.handover !== true || !baseline.defaults.conversation)) throw new AgentMuxError('Main handover requires the original predecessor role.',code)
  const rollover=p.rollover===undefined?undefined:parseMoteMainRolloverDecision(p.rollover,code)
  if(rollover&&(!sameMotePreferencesTarget(rollover.target,target)||rollover.expectedRoleRevision!==p.expectedRoleRevision||!deferredInput||deferredInput.operationId!==rollover.queryOperationId))throw new AgentMuxError('The rollover belongs to another original Query or Mote.',code)
  return { ...(rollover?{rollover}:{}), ...(deferredInput ? {deferredInput} : {}), ...(p.handover ? {handover:true as const} : {}), target, baseline, expectedRoleRevision: p.expectedRoleRevision as string | null,
    sourceOperationId: p.sourceOperationId as string, bindOperationId: p.bindOperationId as string }
}

export const AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE = 'core:agent-open'
export type AgentMuxSpatialAgentOpenRequest = Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' }>
/** A background local creation has no native focus, resource creation or cross-Workspace launch effect.
 * Only a confirmed foreign Zone retains its Desktop owner; an observation gap never changes owner. */
export function isBackgroundLocalAgentOpen(request: { operation: string; content?: unknown; destination?: unknown; focus?: unknown }, graph?: Pick<AgentMuxSpatialGraph, 'zones'> | null): request is
  Omit<AgentMuxSpatialAgentOpenRequest, 'content'> & { content: Extract<AgentMuxSpatialAgentOpenRequest['content'], { kind: 'new-agent' }> } {
  if (request.operation !== 'agent.open' || request.focus !== false || !request.content || typeof request.content !== 'object' ||
      !request.destination || typeof request.destination !== 'object') return false
  const content = request.content as Record<string, unknown>, destination = request.destination as Record<string, unknown>
  return !graph?.zones.some(zone => zone.zoneId === destination.zoneId && zone.hostId && zone.hostId !== 'local') &&
    content.kind === 'new-agent' && content.executionWorkspaceId === undefined && content.toolWorkspaceId === undefined && content.nativeResumeSource === undefined &&
    typeof destination.spaceId === 'string' && typeof destination.zoneId === 'string' && destination.newZone === undefined && destination.split === undefined &&
    destination.displayWorkspaceId === undefined && destination.groupId === undefined &&
    (destination.newTab === true && destination.tabId === undefined && destination.regionId === undefined ||
      destination.newTab === undefined && typeof destination.tabId === 'string' && typeof destination.regionId === 'string')
}
/** Spatial intent only. Creation, input and Run facts remain with the original Core Session. */
export type AgentMuxSpatialAgentOpenRecord = {
  requestId: string; digest: string; agentSessionId: string; executorId: string; address: AgentMuxSpaceAddress
  execution: { hostId: string; workspacePath: string; workspaceId: string }
  moteMain?: MoteMainCreationIntent
  /** Dispatch markers only. Actual outcomes are read from the original source and Files owners. */
  moteMainFollowUps?: { sourceStarted?: true; bindStarted?: true; bindingReceipt?: MoteMainBindingReceipt; refusedBeforeBinding?: MoteMainBaseline; bindingObserved?: MoteMainBindingObservation; deferredInputObserved?:'admitted'|'terminal-confirmed'|'not-applied'; deferredInputKey?: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey,{kind:'prompt'}>; handoverInputKey?: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey,{kind:'prompt'}> }
}
/** Original creation reference, never current-role authority. */
export function moteMainCreatedReference(record: AgentMuxSpatialAgentOpenRecord) {
  const { displayWorkspaceId, groupId, tabId, regionId } = record.address
  return { hostId: record.execution.hostId, sessionId: record.agentSessionId, displayWorkspaceId, groupId, tabId, regionId }
}
export function moteMainBindingDefaults(record: AgentMuxSpatialAgentOpenRecord) {
  const intent = record.moteMain!
  return { ...intent.baseline.defaults, conversation: moteMainCreatedReference(record), conversationRevision: moteChangedMainRoleRevision(intent.target.spaceId, intent.bindOperationId, intent.baseline.documentRevision) }
}
/** Original CAS, using full bytes only from a fresh read of that same original revision. */
export function moteMainBindingInput(record: AgentMuxSpatialAgentOpenRecord, baseline: MoteQuickBaseline): MoteQuickPreferencesSaveParams {
  const intent = record.moteMain
  if (!intent || !sameMoteMainBaseline(intent.baseline, moteMainBaseline(baseline))) throw new AgentMuxError('The original MOTE baseline changed before binding. The created Agent is retained.', 'MOTE_MAIN_BASELINE_CHANGED')
  const { displayWorkspaceId, groupId, tabId, regionId } = record.address
  return { kind: 'quick', target: intent.target, operationId: intent.bindOperationId, baseline,
    values: { ...intent.baseline.defaults, conversation: moteMainCreatedReference(record) }, destination: { kind: 'occurrence', displayWorkspaceId, groupId, tabId, regionId } }
}
export function retainedMoteMainBindingReceipt(record: AgentMuxSpatialAgentOpenRecord, raw: MoteQuickPreferencesSaveResult): MoteMainBindingReceipt {
  const result = parseMotePreferencesSaveResult(raw)
  if (result.kind !== 'quick' || result.operationId !== record.moteMain!.bindOperationId || !sameMotePreferencesTarget(result.target,record.moteMain!.target))
    throw new AgentMuxError('Another original Main binding receipt was returned.', 'CONTROL_PROTOCOL_ERROR')
  const retained = { operationId: result.operationId, status: result.status, source: result.source ? moteMainBaseline(result.source) : null, message: result.message }
  validateMoteMainBindingReceipt(record, retained)
  return retained
}
export function validateMoteMainBindingReceipt(record: AgentMuxSpatialAgentOpenRecord, value: MoteMainBindingReceipt) {
  const p = rpcRecord(value, ['operationId','status','source','message'], 'CONTROL_PROTOCOL_ERROR')
  const source = p.source === null ? null : parseMoteMainBaseline(p.source, record.moteMain!.target, 'CONTROL_PROTOCOL_ERROR')
  if (p.operationId !== record.moteMain!.bindOperationId || !['saved','unchanged','refused-before-write','unconfirmed'].includes(String(p.status)) ||
    p.message !== null && typeof p.message !== 'string' ||
    (p.status === 'saved' || p.status === 'unchanged' ? !source?.documentRevision || !sameMoteQuickDefaults(source.defaults, moteMainBindingDefaults(record)) : source !== null || !p.message))
    throw new AgentMuxError('The original Main binding receipt references are invalid.', 'CONTROL_PROTOCOL_ERROR')
}
/** Original unfinished first creation, independent of unrelated MOTE edits or client-local pointers. */
export function pendingMoteMainCreation(graph: AgentMuxSpatialGraph, target: MotePreferencesTarget, expectedRoleRevision?:string|null): AgentMuxSpatialAgentOpenRecord | null {
  const matches = Object.keys(spatialAgentOpenDocument(graph).requests).flatMap(id => {
    const record = spatialAgentOpenRecord(graph, id)!, intent = record.moteMain, receipt = record.moteMainFollowUps?.bindingReceipt
    if (!intent || expectedRoleRevision!==undefined&&intent.expectedRoleRevision!==expectedRoleRevision || record.moteMainFollowUps?.refusedBeforeBinding || receipt && receipt.status !== 'unconfirmed' || record.moteMainFollowUps?.bindingObserved) return []
    const original = intent.target
    return original.spaceId === target.spaceId && original.zoneId === target.zoneId &&
      original.expectedResource.hostId === target.expectedResource.hostId && original.expectedResource.workspaceId === target.expectedResource.workspaceId &&
      original.expectedResource.workspacePath === target.expectedResource.workspacePath ? [record] : []
  })
  if (matches.length > 1) throw new AgentMuxError('Several original Main creations remain unconfirmed. Keep every Agent and inspect their original requests.', 'MOTE_MAIN_CREATION_CONFLICT')
  return matches[0] ?? null
}

export function spatialAgentFact(session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'run' | 'providerId' | 'executorId' | 'workspacePath' | 'creation' | 'forkedFrom' | 'toolExecution'>, hostId: string): AgentMuxSpaceAgentFact {
  return { agentSessionId: session.agentSessionId, runId: session.run.runId, providerId: session.providerId,
    executorId: session.executorId, hostId, cwd: session.workspacePath,
    createOperationId: session.creation?.createOperationId ?? null, initialPrompt: session.creation?.initialPrompt ?? 'unknown',
    ...(session.creation?.executorRevision ? { executorRevision: session.creation.executorRevision } : {}),
    ...(session.creation?.initialMessageOrigin ? { initialMessageOrigin: session.creation.initialMessageOrigin } : {}),
    ...(session.creation?.createdBy ? { createdBy: session.creation.createdBy } : {}),
    ...(session.creation?.createdRun ? { createdRun: session.creation.createdRun } : {}),
    ...(session.creation?.initialMessageId ? { initialMessageId: session.creation.initialMessageId } : {}),
    ...(session.creation?.agentMuxContext ? { agentMuxContext: session.creation.agentMuxContext } : {}),
    ...(session.creation?.persistence ? { creationPersistence: session.creation.persistence } : {}),
    ...(session.creation?.failure ? { creationFailure: session.creation.failure } : {}),
    ...(session.toolExecution ? { toolExecution: structuredClone(session.toolExecution) } : {}),
    ...(session.forkedFrom ? { forkedFrom: session.forkedFrom } : {}) }
}

type Document = { schema: 'agentmux.spatial-agent-open.v1'; requests: Record<string, AgentMuxSpatialAgentOpenRecord> }
export function spatialAgentOpenDocument(graph: AgentMuxSpatialGraph): Document {
  const stored = graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE]
  if (stored === undefined) return { schema: 'agentmux.spatial-agent-open.v1', requests: {} }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.schema !== 'agentmux.spatial-agent-open.v1' ||
      !stored.requests || typeof stored.requests !== 'object' || Array.isArray(stored.requests)) throw new AgentMuxError(
    'The original spatial creation associations are unreadable. Keep their graph and inspect the original operation.', 'SPATIAL_CREATION_UNCONFIRMED')
  return stored as unknown as Document
}
export function spatialAgentOpenRecord(graph: AgentMuxSpatialGraph, requestId: string): AgentMuxSpatialAgentOpenRecord | null {
  const requests = spatialAgentOpenDocument(graph).requests
  const original = Object.hasOwn(requests, requestId) ? requests[requestId] : undefined
  if (!original) return null
  if (original.requestId !== requestId || typeof original.digest !== 'string' || typeof original.agentSessionId !== 'string' ||
      !original.address || !original.execution || typeof original.execution.hostId !== 'string' || typeof original.execution.workspacePath !== 'string') throw new AgentMuxError(
    'The exact spatial creation association is unconfirmed. Keep its Session and original request.', 'SPATIAL_CREATION_UNCONFIRMED')
  if (original.moteMain) parseMoteMainCreationIntent(original.moteMain, 'CONTROL_PROTOCOL_ERROR')
  if (original.moteMainFollowUps && Object.entries(original.moteMainFollowUps).some(([key,value]) => !['sourceStarted','bindStarted','bindingReceipt','refusedBeforeBinding','bindingObserved','deferredInputKey','handoverInputKey','deferredInputObserved'].includes(key) || !['bindingReceipt','refusedBeforeBinding','bindingObserved','deferredInputKey','handoverInputKey','deferredInputObserved'].includes(key) && value !== true))
    throw new AgentMuxError('The original Main follow-up admission is unreadable.', 'SPATIAL_CREATION_UNCONFIRMED')
  if(original.moteMainFollowUps?.deferredInputObserved&&!original.moteMainFollowUps.deferredInputKey)throw new AgentMuxError('An input observation needs its exact original input key.','SPATIAL_CREATION_UNCONFIRMED')
  if(original.moteMainFollowUps?.deferredInputObserved&&!['admitted','terminal-confirmed','not-applied'].includes(original.moteMainFollowUps.deferredInputObserved))throw new AgentMuxError('The original Main input observation is invalid.','SPATIAL_CREATION_UNCONFIRMED')
  for (const field of ['deferredInputKey','handoverInputKey'] as const) {
    const value=original.moteMainFollowUps?.[field]
    if(value) {const key=validateAgentPromptInputKey(value);if(key.kind!=='prompt'||key.agentSessionId!==original.agentSessionId||key.submissionId!==(field==='deferredInputKey'?original.moteMain?.deferredInput?.operationId:moteMainHandoverInputId(original.requestId)))throw new AgentMuxError('The original Main input key belongs to another admission.','SPATIAL_CREATION_UNCONFIRMED')}
  }
  if (original.moteMainFollowUps?.bindingReceipt) validateMoteMainBindingReceipt(original, original.moteMainFollowUps.bindingReceipt)
  if (original.moteMainFollowUps?.bindingObserved) validateMoteMainBindingObservation(original, original.moteMainFollowUps.bindingObserved)
  if (original.moteMainFollowUps?.refusedBeforeBinding) {
    const observed = parseMoteMainBaseline(original.moteMainFollowUps.refusedBeforeBinding, original.moteMain!.target, 'CONTROL_PROTOCOL_ERROR')
    if (original.moteMainFollowUps.bindStarted || sameMoteMainBaseline(observed, original.moteMain!.baseline)) throw new AgentMuxError('The original pre-submission refusal is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return structuredClone(original)
}

/** Actual writer input must still match every original target, baseline, role and occurrence. */
export function matchesMoteMainBindingInput(record: AgentMuxSpatialAgentOpenRecord, input: MoteQuickPreferencesSaveParams): boolean {
  if (!record.moteMain || input.operationId !== record.moteMain.bindOperationId || !sameMotePreferencesTarget(input.target,record.moteMain.target) ||
    !sameMoteMainBaseline(moteMainBaseline(input.baseline), record.moteMain.baseline) || !sameMoteQuickDefaults(effectiveMoteQuickSave(input),moteMainBindingDefaults(record))) return false
  const ref = moteMainCreatedReference(record), destination = input.destination
  return destination.kind === 'occurrence' && destination.displayWorkspaceId === ref.displayWorkspaceId && destination.groupId === ref.groupId && destination.tabId === ref.tabId && destination.regionId === ref.regionId
}
export function validateMoteMainBindingObservation(record: AgentMuxSpatialAgentOpenRecord, value: MoteMainBindingObservation): void {
  const code = 'CONTROL_PROTOCOL_ERROR', raw = rpcRecord(value,undefined,code), expected = moteMainBindingDefaults(record)
  if (raw.kind === 'preferences') {
    rpcRecord(raw,['kind','source'],code)
    const source = parseMoteMainBaseline(raw.source,record.moteMain!.target,code)
    if (source.documentRevision && sameMoteQuickDefaults(source.defaults,expected)) return
  } else if (raw.kind === 'source') {
    rpcRecord(raw,['kind','operationId','file','reference','roleRevision'],code)
    const file = rpcRecord(raw.file,['resource','revision'],code)
    const source = parseMoteMainBaseline({resource:file.resource,documentRevision:file.revision,defaults:expected},record.moteMain!.target,code)
    const reference = parseMoteDefaultConversation(raw.reference,code)
    if (source.documentRevision && raw.operationId === record.moteMain!.bindOperationId && raw.roleRevision === expected.conversationRevision &&
      sameMoteQuickDefaults({conversation:reference},{conversation:expected.conversation})) return
  }
  throw new AgentMuxError('The observed Main writer role belongs to another original operation.', code)
}

/** Original started first Query, including a bound role whose input is not yet inspected. */
export function retainedMoteMainStarts(graph: AgentMuxSpatialGraph, target: MotePreferencesTarget): AgentMuxSpatialAgentOpenRecord[] {
  const matches=Object.keys(spatialAgentOpenDocument(graph).requests).map(id=>spatialAgentOpenRecord(graph,id)!).filter(record=>record.moteMain?.deferredInput&&sameMotePreferencesTarget(record.moteMain.target,target))
  return matches
}

/** Related original starts still awaiting an accepted input observation; never choose by array position. */
export function pendingMoteMainStarts(graph:AgentMuxSpatialGraph,target:MotePreferencesTarget):AgentMuxSpatialAgentOpenRecord[] {
 return retainedMoteMainStarts(graph,target).filter(record=>!record.moteMainFollowUps?.deferredInputObserved&&!record.moteMainFollowUps?.refusedBeforeBinding&&record.moteMainFollowUps?.bindingReceipt?.status!=='refused-before-write')
}

export function moteMainHandoverInputId(requestId:string):string {return 'mote-main-handover-'+deriveObjectId('mote-main-handover',requestId)}
