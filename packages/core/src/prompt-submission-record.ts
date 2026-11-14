import { preparedAuthorProfileFields } from './author-profile.js'
import { parseAgentInputImages } from './agent-input-resource.js'
import { agentInputContextCaptureProofFields } from './agent-input-context-capture.js'
import { normalizeAgentContinuityLaunchInput } from './agent-session-recovery/continuity-contract.js'
import { parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor } from './external-author.js'
import { AgentMuxError } from './errors.js'
import { browserInputContextFields } from './browser-input-context.js'
import { agentInputDeliveryKey, validateAgentInputControlId, validateAgentInputDeliveryKey, validateAgentInputWaitRef } from './agent-input-wait.js'
import { agentPromptInputId, validateAgentLaunchPromptInputPlan, validateAgentPromptAdmissionIntent, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { dequal } from 'dequal'
import { nativeInputCorrelationKey } from './native-input-correlation.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64urlnopad } from '@scure/base'
import type { AgentMuxRunRef, AgentMuxStoredAgentSession, AgentPromptInputPlan, AgentPromptSubmissionRecord, AgentTerminalInputPhaseState, AgentTerminalPromptReadinessSource } from './types.js'

/** Pure original-input record decoding, shared by durable storage and public receipts. */
export const MAX_STORED_TEXT_BYTES = 1024 * 1024
const MAX_ID_BYTES = 512
function utf8ByteLength(value: string, maxBytes = Infinity): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++ } else bytes += 3
    } else bytes += 3
    if (bytes > maxBytes) return bytes
  }
  return bytes
}
/**
 * Whether the UTF-8 encoding of `value` stays within `maxBytes`, without encoding it.
 * Every stored Session row is normalized on each read and write, and these bodies can be
 * hundreds of KB; allocating a full copy only to read its length dominated that cost.
 * A UTF-16 unit encodes to 1..3 bytes (a surrogate pair to 4 = 2 units x 2), so the
 * length bounds decide almost every value; only the ambiguous band is counted exactly.
 * Lone surrogates count 3 bytes, matching TextEncoder's U+FFFD replacement.
 */
function utf8WithinBytes(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return false
  if (value.length * 3 <= maxBytes) return true
  return utf8ByteLength(value, maxBytes) <= maxBytes
}
const encoder = new TextEncoder()
const promptDigest = (text: string): string => base64urlnopad.encode(sha256(encoder.encode(text)))

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError(`${name} must be an object.`, 'INVALID_AGENT_SESSION_STORE')
  return value as Record<string, unknown>
}
function string(value: unknown, name: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || !utf8WithinBytes(value, maxBytes) || /[\0\r\n]/.test(value)) throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  return value
}
function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  return value as number
}
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  return value as number
}
function runRef(value: unknown): AgentMuxRunRef {
  const source = record(value, 'run')
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'runId')) throw new AgentMuxError('run must contain only runId.', 'INVALID_AGENT_SESSION_STORE')
  return { runId: string(source.runId, 'run.runId') }
}
const TERMINAL_PROMPT_READINESS_SOURCE_MEMBERS: Record<AgentTerminalPromptReadinessSource, true> = {
  'initial-composer': true,
  'native-stop': true
}
const TERMINAL_PROMPT_READINESS_SOURCES = Object.keys(
  TERMINAL_PROMPT_READINESS_SOURCE_MEMBERS
) as readonly AgentTerminalPromptReadinessSource[]

export function terminalPromptReadinessSource(
  value: unknown,
  name: string
): AgentTerminalPromptReadinessSource {
  if (!TERMINAL_PROMPT_READINESS_SOURCES.includes(value as AgentTerminalPromptReadinessSource)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as AgentTerminalPromptReadinessSource
}

export function parsePromptSubmissionRecord(value: unknown): AgentPromptSubmissionRecord {
  const r = record(value, 'original prompt record'), run = runRef(r.run)
  const parsed: AgentPromptSubmissionRecord = {
    agentSessionId: string(r.agentSessionId, 'original prompt Session'), run,
    nativeResult: { state: 'unknown', reason: 'not-recorded' },
    ...(r.launch === undefined ? {} : { launch: normalizeAgentContinuityLaunchInput(r.launch) }),
    ...(r.admission === undefined ? {} : { admission: normalizePromptCompletionAdmission(r.admission) }),
    ...(r.terminalPromptSubmission === undefined ? {} : { terminalPromptSubmission: terminalPromptSubmission(r.terminalPromptSubmission, run) })
  }
  if (parsed.launch && (parsed.launch.delivery !== 'launch' || parsed.launch.state !== 'launch-carried' ||
      parsed.launch.key?.agentSessionId !== parsed.agentSessionId || parsed.launch.key.expectedRun.runId !== run.runId || parsed.admission || parsed.terminalPromptSubmission)) throw new AgentMuxError('Original launch input changed its carrier.', 'INVALID_AGENT_SESSION_STORE')
  if (!parsed.launch && !parsed.admission && !parsed.terminalPromptSubmission) throw new AgentMuxError('Original prompt record is empty.', 'INVALID_AGENT_SESSION_STORE')
  if (parsed.admission?.transport === 'launch' && parsed.terminalPromptSubmission) throw new AgentMuxError(
    'A Runtime launch input cannot also claim terminal submission.', 'INVALID_AGENT_SESSION_STORE')
  if (parsed.admission && parsed.terminalPromptSubmission && parsed.admission.submissionId !== parsed.terminalPromptSubmission.submissionId) throw new AgentMuxError(
    'Original prompt phases name different logical inputs.', 'INVALID_AGENT_SESSION_STORE')
  if (r.semanticIdle !== undefined) {
    const idle = record(r.semanticIdle, 'original input semantic idle')
    const source = idle.source
    if (idle.state !== 'idle' || runRef(idle.run).runId !== run.runId ||
        idle.promptSubmissionId !== (parsed.admission?.submissionId ?? parsed.launch?.key?.submissionId) ||
        !Number.isSafeInteger(idle.sequence) || Number(idle.sequence) < 1 ||
        source !== 'native-hook' && source !== 'native-status') throw new AgentMuxError(
      'The idle source does not belong to this original input.', 'INVALID_AGENT_SESSION_STORE')
    parsed.semanticIdle = { state: 'idle', run,
      observedAt: timestamp(idle.observedAt, 'idle observation'),
      sourceId: string(idle.sourceId, 'idle source'), sequence: Number(idle.sequence),
      nativeSessionId: string(idle.nativeSessionId, 'idle native source'),
      nativeTurnId: string(idle.nativeTurnId, 'idle native turn'),
      promptSubmissionId: string(idle.promptSubmissionId, 'idle original input'),
      ...(source === 'native-status'
        ? { source, recordId: string(idle.recordId, 'idle native record') }
        : { source, hookReceiptId: string(idle.hookReceiptId, 'idle receipt') }) }
  }
  const inputKey = parsed.admission?.inputKey
  if (parsed.admission?.intent && parsed.admission.intent.run.runId !== run.runId || inputKey &&
      (inputKey.agentSessionId !== parsed.agentSessionId || inputKey.expectedRun.runId !== run.runId ||
        agentPromptInputId(inputKey) !== parsed.admission?.submissionId)) throw new AgentMuxError(
    'The original input record changed its Session, Run or logical identity.', 'INVALID_AGENT_SESSION_STORE')
  if (r.nativeSource !== undefined) {
    const source = record(r.nativeSource, 'native input source'), handle = record(source.nativeHandle, 'native input locator')
    const claim = parsed.admission
    if (claim?.transport !== 'native' || source.actorId !== claim.native.plan.actorId || handle.kind !== 'provider' ||
        handle.sessionId !== claim.native.plan.threadId || claim.native.plan.sourceId !== JSON.stringify([handle.providerId, handle.sessionId]) ||
        Object.keys(source).some(key => !['nativeHandle', 'actorId'].includes(key)) ||
        Object.keys(handle).some(key => !['kind', 'providerId', 'sessionId', 'transcriptPath'].includes(key)))
      throw new AgentMuxError('The native locator does not belong to this original input.', 'INVALID_AGENT_SESSION_STORE')
    parsed.nativeSource = { actorId: string(source.actorId, 'native input actor'), nativeHandle: { kind: 'provider',
      providerId: string(handle.providerId, 'native input Provider'), sessionId: string(handle.sessionId, 'native input Session'),
      ...(handle.transcriptPath === undefined ? {} : { transcriptPath: string(handle.transcriptPath, 'native input path', MAX_STORED_TEXT_BYTES) }) } }
  }
  if (r.nativeResult !== undefined) {
    const result = record(r.nativeResult, 'original native result'), state = result.state
    const invalid = () => { throw new AgentMuxError('The native result does not belong to this original input.', 'INVALID_AGENT_SESSION_STORE') }
    if (state === 'unknown' || state === 'unsupported') {
      if (Object.keys(result).some(key => !['state', 'reason'].includes(key)) ||
          (state === 'unsupported' ? result.reason !== 'uncorrelated-carrier' :
            !['not-recorded', 'native-input-unconfirmed', 'native-outcome-unconfirmed'].includes(String(result.reason)))) invalid()
      parsed.nativeResult = result as NonNullable<AgentPromptSubmissionRecord['nativeResult']>
    } else {
      const claim = parsed.admission, plan = claim?.transport === 'native' ? claim.native.plan : undefined
      const correlation = record(result.correlation, 'native result correlation')
      if (!['completed', 'failed', 'interrupted'].includes(String(state)) || Object.keys(result).some(key =>
          !['state', 'run', 'promptSubmissionId', 'sourceId', 'nativeSessionId', 'nativeTurnId', 'recordId', 'observedAt', 'nativeObservedAt', 'sequence', 'correlation'].includes(key)) ||
          claim?.transport !== 'native' || claim.native.outcome !== 'admitted' || !claim.acknowledged || !plan?.clientCorrelation || !parsed.nativeSource ||
          !dequal(nativeInputCorrelationKey(plan.clientCorrelation), inputKey) || !dequal(claim.intent?.plan, plan) ||
          result.promptSubmissionId !== claim.submissionId || runRef(result.run).runId !== run.runId ||
          result.sourceId !== plan.sourceId || result.nativeSessionId !== plan.threadId ||
          correlation.clientCorrelation !== plan.clientCorrelation || !dequal(Object.keys(correlation).sort(),
            (correlation.kind === 'native-ack' ? ['kind', 'clientCorrelation'] : ['kind', 'clientCorrelation', 'queuedSubmissionId', 'nativeRecordId']).sort()) ||
          (correlation.kind === 'native-ack' ? claim.native.turnId !== result.nativeTurnId :
            correlation.kind !== 'native-adoption' || !claim.native.queuedSubmissionId || correlation.queuedSubmissionId !== claim.native.queuedSubmissionId ||
            typeof correlation.nativeRecordId !== 'string' || !correlation.nativeRecordId)) invalid()
      parsed.nativeResult = { state: state as 'completed' | 'failed' | 'interrupted', run,
        promptSubmissionId: string(result.promptSubmissionId, 'native result input'),
        sourceId: string(result.sourceId, 'native result source'), nativeSessionId: string(result.nativeSessionId, 'native result conversation'),
        nativeTurnId: string(result.nativeTurnId, 'native result turn'), recordId: string(result.recordId, 'native result record'),
        observedAt: timestamp(result.observedAt, 'native result time'),
        ...(result.nativeObservedAt === undefined ? {} : { nativeObservedAt: timestamp(result.nativeObservedAt, 'native result native time') }),
        ...(result.sequence === undefined ? {} : { sequence: positiveInteger(result.sequence, 'native result sequence') }),
        correlation: correlation as Extract<NonNullable<AgentPromptSubmissionRecord['nativeResult']>, { state: 'completed' | 'failed' | 'interrupted' }>['correlation'] }
    }
  }
  if (r.ptyRefreshHistory !== undefined) {
    if (!Array.isArray(r.ptyRefreshHistory) || !parsed.admission || parsed.admission.intent?.plan.kind !== 'render-then-submit' ||
        !parsed.admission.intent.plan.prepare?.refresh || ['native', 'launch'].includes(parsed.admission.transport ?? 'pty'))
      throw new AgentMuxError('Original redraw history requires its PTY claim.', 'INVALID_AGENT_SESSION_STORE')
    const ids = new Set<string>()
    parsed.ptyRefreshHistory = r.ptyRefreshHistory.map(value => {
      const refresh = normalizePromptCompletionAdmission({ ...parsed.admission, frameRefresh: value }).frameRefresh!
      if (!refresh.acknowledged || refresh.notApplied || ids.has(refresh.operationId) || refresh.operationId === parsed.admission!.frameRefresh?.operationId)
        throw new AgentMuxError('Original redraw history changed its acknowledged phase.', 'INVALID_AGENT_SESSION_STORE')
      ids.add(refresh.operationId)
      return refresh
    })
    validatePtyPlan(parsed)
  }
  return parsed
}

/** The original machine identity used by both phase dispatch and its retained receipt. */
export function terminalPromptPhaseOperationIdentity(session: { agentSessionId: string; run: AgentMuxRunRef }, submissionId: string,
  phase: 'refresh' | 'interrupt' | 'payload' | 'submit', data: string): string {
  return promptDigest(JSON.stringify(['agentmux-terminal-prompt-v1', session.agentSessionId,
    session.run.runId, submissionId, phase, data]))
}

const ptyConflict = (): never => { throw new AgentMuxError('The original PTY input claim or phase receipt changed.', 'AGENT_PROMPT_OPERATION_CONFLICT') }
type PtyAdmission = Extract<NonNullable<AgentPromptSubmissionRecord['admission']>, { transport?: 'pty' }>
type Refresh = NonNullable<PtyAdmission['frameRefresh']>

/** Missing observations preserve evidence. Existing IDs/timestamps are not renewed by a late projection. */
function retainPtyEvidence<T>(before: T | undefined, after: T | undefined): T | undefined {
  if (before === undefined) return after
  if (after === undefined || dequal(before, after)) return before
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return ptyConflict()
  const result = { ...before } as Record<string, unknown>
  for (const [name, value] of Object.entries(after)) result[name] = retainPtyEvidence(result[name], value)
  return result as T
}

function mergePtyPhase<T extends AgentTerminalInputPhaseState>(before: T | undefined, after: T | undefined): T | undefined {
  if (!before) return after
  if (!after) return before
  const { acknowledged: oldAck, notApplied: oldRefusal, chunks: oldChunks, ...original } = before
  const { acknowledged: newAck, notApplied: newRefusal, chunks: newChunks, ...incoming } = after
  if (!dequal(original, incoming) || oldAck && newRefusal || oldRefusal && newAck) return ptyConflict()
  let chunks = oldChunks ?? newChunks
  if (oldChunks && newChunks) {
    if (oldChunks.length !== newChunks.length) return ptyConflict()
    chunks = oldChunks.map((chunk, index) => mergePtyPhase(chunk, newChunks[index])!)
  }
  if ((oldRefusal || newRefusal) && chunks?.some(chunk => chunk.acknowledged)) return ptyConflict()
  return { ...after, acknowledged: oldAck || newAck,
    ...(oldRefusal || newRefusal ? { notApplied: true } : {}), ...(chunks ? { chunks } : {}) }
}

function ptyClaim(value: PtyAdmission) {
  const { acknowledged, notApplied, chunks, frameRefresh, operationId, startByte, endByte, outputCursorBytes, uncertainTurn, transport, ...claim } = value
  return claim
}

function refreshClaim(value: PtyAdmission, terminal: AgentPromptSubmissionRecord['terminalPromptSubmission']): value is PtyAdmission & { frameRefresh: Refresh } {
  const refresh = value.frameRefresh
  return !terminal && !!refresh && value.operationId === refresh.operationId && value.startByte === refresh.inputByteRange.startByte &&
    value.endByte === refresh.inputByteRange.endByte && !value.acknowledged && !value.notApplied
}

function validatePtyPlan(value: AgentPromptSubmissionRecord): void {
  const admission = value.admission as PtyAdmission | undefined, plan = admission?.intent?.plan
  if (!admission || !plan || plan.kind === 'native-rpc' || plan.kind === 'runtime-launch') return
  const terminal = value.terminalPromptSubmission
  if (plan.kind === 'single-phase') {
    if (terminal || admission.endByte - admission.startByte !== utf8ByteLength(plan.data)) return ptyConflict()
  } else if (terminal) {
    const first = terminal.prepare?.interrupt ?? terminal.payload
    if (terminal.run.runId !== value.run.runId || terminal.submissionId !== admission.submissionId ||
        terminal.promptDigest !== promptDigest(admission.intent!.prompt) ||
        terminal.payload.operationId !== terminalPromptPhaseOperationIdentity(value, terminal.submissionId, 'payload', plan.payload) ||
        terminal.submit.operationId !== terminalPromptPhaseOperationIdentity(value, terminal.submissionId, 'submit', plan.submit) ||
        first.operationId !== admission.operationId || first.inputByteRange.startByte !== admission.startByte ||
        terminal.submit.inputByteRange.endByte !== admission.endByte ||
        terminal.payload.inputByteRange.endByte !== terminal.submit.inputByteRange.startByte ||
        terminal.payload.inputByteRange.endByte - terminal.payload.inputByteRange.startByte !== utf8ByteLength(plan.payload) ||
        terminal.submit.inputByteRange.endByte - terminal.submit.inputByteRange.startByte !== utf8ByteLength(plan.submit) ||
        terminal.prepare?.interrupt && (plan.kind !== 'render-then-submit' || !plan.prepare ||
          terminal.prepare.interrupt.operationId !== terminalPromptPhaseOperationIdentity(value, terminal.submissionId, 'interrupt', plan.prepare.interrupt) ||
          terminal.prepare.interrupt.inputByteRange.endByte !== terminal.payload.inputByteRange.startByte ||
          terminal.prepare.interrupt.inputByteRange.endByte - terminal.prepare.interrupt.inputByteRange.startByte !== utf8ByteLength(plan.prepare.interrupt))) return ptyConflict()
  }
  const refreshes = [...(value.ptyRefreshHistory ?? []), ...(admission.frameRefresh ? [admission.frameRefresh] : [])]
  for (let index = 0; index < refreshes.length; index++) {
    const refresh = refreshes[index]!, previous = refreshes[index - 1]
    if (plan.kind !== 'render-then-submit' || !plan.prepare?.refresh || !admission.submissionId ||
        refresh.operationId !== terminalPromptPhaseOperationIdentity(value, admission.submissionId, 'refresh',
          JSON.stringify([plan.prepare.refresh, refresh.nativeSourceId, refresh.resizeRevision])) ||
        refresh.inputByteRange.endByte - refresh.inputByteRange.startByte !== utf8ByteLength(plan.prepare.refresh) ||
        previous && (previous.nativeSourceId !== refresh.nativeSourceId || previous.resizeRevision >= refresh.resizeRevision ||
          previous.inputByteRange.endByte > refresh.inputByteRange.startByte) ||
        !refreshClaim(admission, terminal) && refresh.inputByteRange.endByte > admission.startByte) return ptyConflict()
  }
}

/** One frozen logical input; physical redraw/main phases retain their own immutable operation and byte range. */
export function mergePtyPromptRecord(before: AgentPromptSubmissionRecord, incoming: AgentPromptSubmissionRecord, settlement = false): AgentPromptSubmissionRecord {
  if (before.agentSessionId !== incoming.agentSessionId || !dequal(before.run, incoming.run) ||
      before.launch || incoming.launch || before.admission && ['native', 'launch'].includes(before.admission.transport ?? 'pty') ||
      incoming.admission && ['native', 'launch'].includes(incoming.admission.transport ?? 'pty')) return ptyConflict()
  const oldClaim = before.admission as PtyAdmission | undefined, newClaim = incoming.admission as PtyAdmission | undefined
  if (!!oldClaim !== !!newClaim || oldClaim && newClaim && !dequal(ptyClaim(oldClaim), ptyClaim(newClaim))) return ptyConflict()
  const result = { ...incoming }
  if (oldClaim && newClaim) {
    const samePhase = oldClaim.operationId === newClaim.operationId && oldClaim.startByte === newClaim.startByte && oldClaim.endByte === newClaim.endByte
    let history = before.ptyRefreshHistory
    if (incoming.ptyRefreshHistory && !dequal(incoming.ptyRefreshHistory, history)) {
      const prefix = Math.min(history?.length ?? 0, incoming.ptyRefreshHistory.length)
      if (!dequal((history ?? []).slice(0, prefix), incoming.ptyRefreshHistory.slice(0, prefix))) return ptyConflict()
      if (incoming.ptyRefreshHistory.length > (history?.length ?? 0)) {
        if (!settlement) return ptyConflict()
        history = incoming.ptyRefreshHistory
      }
    }
    let refresh: Refresh | undefined
    if (oldClaim.frameRefresh && newClaim.frameRefresh && oldClaim.frameRefresh.operationId !== newClaim.frameRefresh.operationId) {
      if (!refreshClaim(oldClaim, before.terminalPromptSubmission) || !oldClaim.frameRefresh.acknowledged ||
          !refreshClaim(newClaim, incoming.terminalPromptSubmission)) return ptyConflict()
      history = [...(history ?? []), oldClaim.frameRefresh]
      refresh = newClaim.frameRefresh
    } else refresh = mergePtyPhase(oldClaim.frameRefresh, newClaim.frameRefresh)
    if (!samePhase) {
      if (!refreshClaim(oldClaim, before.terminalPromptSubmission) || !oldClaim.frameRefresh.acknowledged ||
          newClaim.startByte < oldClaim.endByte || (!refreshClaim(newClaim, incoming.terminalPromptSubmission) && !incoming.terminalPromptSubmission)) return ptyConflict()
    }
    const phase = samePhase ? mergePtyPhase({ operationId: oldClaim.operationId,
      inputByteRange: { startByte: oldClaim.startByte, endByte: oldClaim.endByte }, acknowledged: oldClaim.acknowledged ?? false,
      ...(oldClaim.notApplied ? { notApplied: true } : {}), ...(oldClaim.chunks ? { chunks: oldClaim.chunks } : {}) },
    { operationId: newClaim.operationId, inputByteRange: { startByte: newClaim.startByte, endByte: newClaim.endByte },
      acknowledged: newClaim.acknowledged ?? false, ...(newClaim.notApplied ? { notApplied: true } : {}), ...(newClaim.chunks ? { chunks: newClaim.chunks } : {}) })! : undefined
    result.admission = { ...newClaim, ...(phase && (oldClaim.acknowledged !== undefined || newClaim.acknowledged !== undefined) ? { acknowledged: phase.acknowledged } : {}),
      ...(phase?.notApplied ? { notApplied: true } : {}), ...(phase?.chunks ? { chunks: phase.chunks } : {}),
      ...(refresh ? { frameRefresh: refresh } : {}), ...(oldClaim.uncertainTurn ? { uncertainTurn: true } : {}),
      ...(oldClaim.outputCursorBytes === undefined ? {} : { outputCursorBytes: Math.max(oldClaim.outputCursorBytes, newClaim.outputCursorBytes ?? 0) }) }
    if (history) result.ptyRefreshHistory = history
  } else if (before.ptyRefreshHistory || incoming.ptyRefreshHistory) return ptyConflict()
  const oldTerminal = before.terminalPromptSubmission, nextTerminal = incoming.terminalPromptSubmission
  if (oldTerminal && nextTerminal) {
    const { payload: oldPayload, submit: oldSubmit, prepare: oldPrepare, outputCursorBytes: oldCursor, ...original } = oldTerminal
    const { payload, submit, prepare, outputCursorBytes, ...next } = nextTerminal
    const oldInterrupt = oldPrepare?.interrupt, interrupt = prepare?.interrupt
    const oldPreparation = oldPrepare && { ...oldPrepare }, preparation = prepare && { ...prepare }
    delete oldPreparation?.interrupt; delete preparation?.interrupt
    const retainedPrepare = retainPtyEvidence(oldPreparation, preparation)
    result.terminalPromptSubmission = { ...retainPtyEvidence(original, next)!, outputCursorBytes: Math.max(oldCursor, outputCursorBytes),
      payload: mergePtyPhase(oldPayload, payload)!, submit: mergePtyPhase(oldSubmit, submit)!,
      ...(retainedPrepare ? { prepare: { ...retainedPrepare, ...(oldInterrupt || interrupt ? { interrupt: mergePtyPhase(oldInterrupt, interrupt)! } : {}) } } : {}) }
  } else if (oldTerminal) result.terminalPromptSubmission = oldTerminal
  // Validate newly introduced physical evidence; old incomplete records are not backfilled or reinterpreted on reads.
  if (!dequal(result.terminalPromptSubmission, oldTerminal) || !dequal(result.ptyRefreshHistory, before.ptyRefreshHistory) ||
      !oldClaim?.acknowledged && result.admission?.acknowledged ||
      oldClaim?.operationId !== result.admission?.operationId || oldClaim?.frameRefresh?.operationId !== result.admission?.frameRefresh?.operationId) validatePtyPlan(result)
  parsePromptSubmissionRecord(result)
  return result
}

function terminalInputPhase(
  value: unknown,
  name: string
): NonNullable<AgentMuxStoredAgentSession['terminalPromptSubmission']>['payload'] {
  const source = record(value, name)
  const inputByteRange = record(source.inputByteRange, `${name}.inputByteRange`)
  const startByte = timestamp(inputByteRange.startByte, `${name}.inputByteRange.startByte`)
  const endByte = positiveInteger(inputByteRange.endByte, `${name}.inputByteRange.endByte`)
  if (endByte <= startByte || typeof source.acknowledged !== 'boolean' ||
    (source.notApplied !== undefined && (source.notApplied !== true || source.acknowledged))) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  let chunks: NonNullable<AgentMuxStoredAgentSession['terminalPromptSubmission']>['payload']['chunks']
  if (source.chunks !== undefined) {
    if (!Array.isArray(source.chunks) || source.chunks.length < 2) throw new AgentMuxError(`${name}.chunks is invalid.`, 'INVALID_AGENT_SESSION_STORE')
    let through = startByte, unacknowledged = false
    const ids = new Set<string>([string(source.operationId, `${name}.operationId`)])
    chunks = source.chunks.map((value, index) => {
      const chunk = record(value, `${name}.chunks[${index}]`)
      const range = record(chunk.inputByteRange, `${name}.chunks[${index}].inputByteRange`)
      const operationId = string(chunk.operationId, `${name}.chunks[${index}].operationId`)
      const start = timestamp(range.startByte, `${name}.chunks[${index}].startByte`)
      const end = positiveInteger(range.endByte, `${name}.chunks[${index}].endByte`)
      if (start !== through || end <= start || end > endByte || ids.has(operationId) ||
          typeof chunk.acknowledged !== 'boolean' || unacknowledged && chunk.acknowledged ||
          source.acknowledged && !chunk.acknowledged || source.notApplied && chunk.acknowledged) {
        throw new AgentMuxError(`${name}.chunks does not preserve its original contiguous phase.`, 'INVALID_AGENT_SESSION_STORE')
      }
      ids.add(operationId); through = end; unacknowledged ||= !chunk.acknowledged
      return { operationId, inputByteRange: { startByte: start, endByte: end }, acknowledged: chunk.acknowledged }
    })
    if (through !== endByte) throw new AgentMuxError(`${name}.chunks does not cover its original phase.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    operationId: string(source.operationId, `${name}.operationId`),
    inputByteRange: { startByte, endByte },
    acknowledged: source.acknowledged,
    ...(source.notApplied === true ? { notApplied: true as const } : {}),
    ...(chunks ? { chunks } : {})
  }
}

export function terminalPromptSubmission(
  value: unknown,
  currentRun: AgentMuxRunRef
): NonNullable<AgentMuxStoredAgentSession['terminalPromptSubmission']> {
  const source = record(value, 'terminalPromptSubmission')
  const run = runRef(source.run)
  const payload = terminalInputPhase(source.payload, 'terminalPromptSubmission.payload')
  const submit = terminalInputPhase(source.submit, 'terminalPromptSubmission.submit')
  const outputCursorBytes = timestamp(
    source.outputCursorBytes,
    'terminalPromptSubmission.outputCursorBytes'
  )
  if (
    run.runId !== currentRun.runId ||
    payload.operationId === submit.operationId ||
    payload.inputByteRange.endByte !== submit.inputByteRange.startByte ||
    (submit.acknowledged && !payload.acknowledged)
  ) {
    throw new AgentMuxError(
      'Terminal prompt submission does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    run,
    submissionId: string(source.submissionId, 'terminalPromptSubmission.submissionId'),
    promptDigest: string(source.promptDigest, 'terminalPromptSubmission.promptDigest'),
    ...(source.readinessEvidence === undefined ? {} : { readinessEvidence: (() => {
      const evidence = record(source.readinessEvidence, 'terminalPromptSubmission.readinessEvidence')
      return {
        source: terminalPromptReadinessSource(evidence.source, 'readinessEvidence.source'),
        id: string(evidence.id, 'readinessEvidence.id'),
        outputCursorBytes: timestamp(evidence.outputCursorBytes, 'readinessEvidence.outputCursorBytes'),
        readyThroughByte: timestamp(evidence.readyThroughByte, 'readinessEvidence.readyThroughByte')
      }
    })() }),
    outputCursorBytes,
    ...(source.payloadConsumption === undefined ? {} : { payloadConsumption: (() => {
      const consumed = record(source.payloadConsumption, 'terminalPromptSubmission.payloadConsumption')
      const receipt = consumed.receipt === undefined ? undefined : record(consumed.receipt, 'payload consumption receipt')
      return { sourceId: string(consumed.sourceId, 'payload consumption sourceId'), baselineId: string(consumed.baselineId, 'payload consumption baselineId'),
        ...(receipt ? { receipt: { id: string(receipt.id, 'payload consumption receipt id'), observedAt: timestamp(receipt.observedAt, 'payload consumption observedAt') } } : {}) }
    })() }),
    ...(source.prepare === undefined ? {} : { prepare: (() => {
      const prepare = record(source.prepare, 'terminalPromptSubmission.prepare')
      if (prepare.context !== 'idle' && prepare.context !== 'interruptible') {
        throw new AgentMuxError('Prompt preparation context is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const interrupt = prepare.interrupt === undefined ? undefined : terminalInputPhase(prepare.interrupt, 'prompt prepare interrupt')
      if ((prepare.context === 'interruptible') !== (interrupt !== undefined) ||
          (interrupt && interrupt.inputByteRange.endByte !== payload.inputByteRange.startByte) ||
          (prepare.context === 'interruptible' && prepare.nativeTurnId === undefined) ||
          (prepare.readyThroughByte !== undefined && (prepare.context === 'interruptible' &&
            (prepare.barrierReceiptId === undefined || !interrupt?.acknowledged)))) {
        throw new AgentMuxError('Prompt preparation receipt is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return { context: prepare.context,
        ...(interrupt ? { interrupt } : {}),
        ...(prepare.nativeTurnId === undefined ? {} : { nativeTurnId: string(prepare.nativeTurnId, 'prepare.nativeTurnId') }),
        ...(prepare.nativeSourceId === undefined ? {} : { nativeSourceId: string(prepare.nativeSourceId, 'prepare.nativeSourceId') }),
        ...(prepare.previousReceiptId === undefined ? {} : { previousReceiptId: string(prepare.previousReceiptId, 'prepare.previousReceiptId') }),
        ...(prepare.barrierReceiptId === undefined ? {} : { barrierReceiptId: string(prepare.barrierReceiptId, 'prepare.barrierReceiptId') }),
        ...(prepare.readyThroughByte === undefined ? {} : { readyThroughByte: timestamp(prepare.readyThroughByte, 'prepare.readyThroughByte') }) }
    })() }),
    payload,
    submit
  }
}

export function normalizePromptCompletionAdmission(value: unknown): NonNullable<AgentMuxStoredAgentSession['promptCompletionAdmission']> {
  const admission = record(value, 'promptCompletionAdmission')
  const transport = (() => {
    if (admission.transport === 'launch') {
      if (['startByte', 'endByte', 'chunks', 'native', 'frameRefresh', 'uncertainTurn', 'outputCursorBytes', 'completionId', 'futureIntent'].some(key => admission[key] !== undefined)) throw new AgentMuxError(
        'Runtime launch admission cannot contain PTY, turn or native acceptance facts.', 'INVALID_AGENT_SESSION_STORE')
      const launch = record(admission.launch, 'Runtime launch input admission'), plan = validateAgentLaunchPromptInputPlan(launch.plan)
      const intent = normalizePromptInputIntent(admission.intent), key = validateAgentPromptInputKey(admission.inputKey)
      if (Object.keys(launch).some(key => !['plan', 'outcome', 'receipt'].includes(key)) || key.kind !== 'message' ||
          admission.submissionId !== agentPromptInputId(key) || admission.operationId !== admission.submissionId || !admission.inputDispatch ||
          intent.message === undefined || intent.run.runId !== key.expectedRun.runId || intent.execution !== 'immediate' ||
          !intent.admissionIntent || !['manual-actor', 'session-conversation'].includes(intent.admissionIntent.kind) ||
          !dequal(intent.plan, plan) || !['claimed', 'launch-carried', 'not-applied', 'unknown'].includes(String(launch.outcome)) ||
          (launch.outcome === 'launch-carried') !== (admission.acknowledged === true) ||
          (launch.outcome === 'not-applied') !== (admission.notApplied === true)) throw new AgentMuxError(
        'Invalid Runtime launch admission outcome or original input.', 'INVALID_AGENT_SESSION_STORE')
      if (launch.outcome === 'launch-carried') {
        const receipt = record(launch.receipt, 'Runtime launch receipt'), run = runRef(receipt.run)
        if (Object.keys(receipt).some(key => !['kind', 'operationId', 'run', 'observedAt'].includes(key)) ||
            receipt.kind !== 'runtime-launch' || receipt.operationId !== plan.lifecycleOperationId || run.runId === key.expectedRun.runId) throw new AgentMuxError(
          'Runtime launch receipt changed its original operation or successor Run.', 'INVALID_AGENT_SESSION_STORE')
        return { transport: 'launch' as const, launch: { plan, outcome: 'launch-carried' as const,
          receipt: { kind: 'runtime-launch' as const, operationId: plan.lifecycleOperationId, run,
            observedAt: timestamp(receipt.observedAt, 'Runtime launch receipt observation') } } }
      }
      if (launch.receipt !== undefined) throw new AgentMuxError('An unconfirmed Runtime launch cannot claim a Run receipt.', 'INVALID_AGENT_SESSION_STORE')
      return { transport: 'launch' as const, launch: { plan, outcome: launch.outcome as 'claimed' | 'not-applied' | 'unknown' } }
    }
    if (admission.transport === 'native') {
      if (admission.startByte !== undefined || admission.endByte !== undefined || admission.frameRefresh !== undefined || admission.uncertainTurn !== undefined || admission.chunks !== undefined || admission.launch !== undefined) {
        throw new AgentMuxError('Native admission cannot contain PTY input facts.', 'INVALID_AGENT_SESSION_STORE')
      }
      const native = record(admission.native, 'native input admission'), plan = nativePromptPlan(native.plan)
      const intent = normalizePromptInputIntent(admission.intent)
      if (admission.submissionId === undefined || admission.operationId !== admission.submissionId || intent.message === undefined ||
          !['claimed', 'admitted', 'not-applied', 'unknown'].includes(String(native.outcome)) || JSON.stringify(intent.plan) !== JSON.stringify(plan) ||
          (plan.operation === 'submit' && native.outcome === 'admitted'
            ? typeof native.requestId !== 'string' || !native.requestId || native.turnId !== undefined || native.queuedSubmissionId !== undefined
            : native.requestId !== undefined) ||
          (native.outcome === 'admitted' ? admission.acknowledged !== true || (plan.operation === 'queue-idle'
            ? typeof native.queuedSubmissionId !== 'string' || !native.queuedSubmissionId || native.turnId !== undefined
            : plan.operation !== 'submit' && (typeof native.turnId !== 'string' || !native.turnId || native.queuedSubmissionId !== undefined ||
              plan.expectedTurnId !== undefined && native.turnId !== plan.expectedTurnId)) : admission.acknowledged === true || native.queuedSubmissionId !== undefined) ||
          (native.outcome === 'not-applied') !== (admission.notApplied === true)) throw new AgentMuxError('Invalid native admission outcome.', 'INVALID_AGENT_SESSION_STORE')
      return { transport: 'native' as const, native: { plan, outcome: native.outcome as 'claimed' | 'admitted' | 'not-applied' | 'unknown',
        ...(native.turnId === undefined ? {} : { turnId: string(native.turnId, 'native admitted turn') }),
        ...(native.queuedSubmissionId === undefined ? {} : { queuedSubmissionId: string(native.queuedSubmissionId, 'native queued submission') }),
        ...(native.requestId === undefined ? {} : { requestId: string(native.requestId, 'native protocol request') }),
        ...(native.errorCode === undefined ? {} : { errorCode: (() => { if (!Number.isSafeInteger(native.errorCode)) throw new AgentMuxError('Invalid native error code.', 'INVALID_AGENT_SESSION_STORE'); return Number(native.errorCode) })() }) } }
    }
    if (admission.transport !== undefined && admission.transport !== 'pty' || admission.native !== undefined || admission.launch !== undefined ||
        admission.intent !== undefined && ['native-rpc', 'runtime-launch'].includes(normalizePromptInputIntent(admission.intent).plan.kind)) throw new AgentMuxError('Invalid prompt transport.', 'INVALID_AGENT_SESSION_STORE')
    const startByte = timestamp(admission.startByte, 'promptCompletionAdmission.startByte')
    const endByte = positiveInteger(admission.endByte, 'promptCompletionAdmission.endByte')
    if (endByte <= startByte) throw new AgentMuxError('Invalid prompt input range.', 'INVALID_AGENT_SESSION_STORE')
    const chunks = admission.chunks === undefined ? undefined : terminalInputPhase({
      operationId: admission.operationId, inputByteRange: { startByte, endByte }, acknowledged: admission.acknowledged ?? false,
      ...(admission.notApplied === true ? { notApplied: true } : {}), chunks: admission.chunks
    }, 'promptCompletionAdmission').chunks
    if (chunks && normalizePromptInputIntent(admission.intent).plan.kind !== 'single-phase') throw new AgentMuxError(
      'Only a single-phase admission owns direct input chunks.', 'INVALID_AGENT_SESSION_STORE')
    return { ...(admission.transport === 'pty' ? { transport: 'pty' as const } : {}), startByte, endByte, ...(chunks ? { chunks } : {}) }
  })()
  return {
    ...(admission.inputKey === undefined ? {} : { inputKey: validateAgentPromptInputKey(admission.inputKey) }),
    ...(admission.inputDispatch === undefined ? {} : { inputDispatch: (() => {
      const dispatch = record(admission.inputDispatch, 'original input dispatch gate')
      const ref = validateAgentInputWaitRef(dispatch.ref), key = validateAgentPromptInputKey(admission.inputKey)
      const deliveryKey = dispatch.deliveryKey === undefined ? undefined : validateAgentInputDeliveryKey(ref.key, dispatch.deliveryKey)
      if (!dequal(agentInputDeliveryKey({ ref, ...(deliveryKey ? { deliveryKey } : {}) }), key)) throw new AgentMuxError(
        'Original dispatch gate does not name this input.', 'INVALID_AGENT_SESSION_STORE')
      return { ref, gateId: validateAgentInputControlId(dispatch.gateId), ...(deliveryKey ? { deliveryKey } : {}) }
    })() }),
    ...(admission.submissionId === undefined ? {} : { submissionId: string(admission.submissionId, 'promptCompletionAdmission.submissionId') }),
    ...(admission.completionId === undefined ? {} : { completionId: string(admission.completionId, 'promptCompletionAdmission.completionId') }),
    ...(admission.outputCursorBytes === undefined ? {} : { outputCursorBytes: timestamp(admission.outputCursorBytes, 'prompt admission output boundary') }),
    ...(admission.futureIntent === undefined ? {} : { futureIntent: (() => {
      const future = record(admission.futureIntent, 'future prompt occurrence')
      return { intentId: string(future.intentId, 'future intent id'), occurrenceAt: timestamp(future.occurrenceAt, 'future occurrence') }
    })() }),
    ...(admission.intent === undefined ? {} : { intent: normalizePromptInputIntent(admission.intent) }),
    ...(admission.frameRefresh === undefined ? {} : { frameRefresh: (() => {
      const refresh = record(admission.frameRefresh, 'prompt native frame refresh')
      return { ...terminalInputPhase(refresh, 'prompt native frame refresh'),
        outputCursorBytes: timestamp(refresh.outputCursorBytes, 'refresh output fence'),
        resizeRevision: timestamp(refresh.resizeRevision, 'refresh geometry revision'),
        nativeSourceId: string(refresh.nativeSourceId, 'refresh native source') }
    })() }),
    ...(admission.uncertainTurn === undefined ? {} : {
      uncertainTurn: (() => {
        if (typeof admission.uncertainTurn !== 'boolean') throw new AgentMuxError('Invalid prompt admission turn risk fact.', 'INVALID_AGENT_SESSION_STORE')
        return admission.uncertainTurn
      })()
    }),
    ...(admission.acknowledged === undefined ? {} : { acknowledged: (() => {
      if (typeof admission.acknowledged !== 'boolean') throw new AgentMuxError('Invalid prompt acknowledgement.', 'INVALID_AGENT_SESSION_STORE')
      return admission.acknowledged
    })() }),
    ...(admission.notApplied === undefined ? {} : { notApplied: (() => {
      if (typeof admission.notApplied !== 'boolean') throw new AgentMuxError('Invalid prompt Input disposition.', 'INVALID_AGENT_SESSION_STORE')
      return admission.notApplied
    })() }),
    operationId: string(admission.operationId, 'promptCompletionAdmission.operationId'), ...transport }
}

/** Decode the exact frozen input before journal admission or durable storage. */
/** Decode the same frozen carrier plan before journal gating and after a claim. */
export function normalizePromptInputPlan(value: unknown): import('./types.js').AgentPromptInputPlan | import('./types.js').AgentNativePromptInputPlan | import('./types.js').AgentLaunchPromptInputPlan {
  const plan = record(value, 'promptCompletionAdmission.intent.plan')
  const bytes = (value: unknown): string => {
    if (typeof value !== 'string' || !value.length || !utf8WithinBytes(value, MAX_STORED_TEXT_BYTES)) {
      throw new AgentMuxError('Frozen prompt input is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    return value
  }
  let input: AgentPromptInputPlan | import('./types.js').AgentNativePromptInputPlan | import('./types.js').AgentLaunchPromptInputPlan
  if (plan.kind === 'single-phase') input = { kind: plan.kind, data: bytes(plan.data) }
  else if (plan.kind === 'render-then-submit') input = {
    kind: plan.kind, payload: bytes(plan.payload), renderedText: bytes(plan.renderedText), submit: bytes(plan.submit),
    ...(plan.prepare === undefined ? {} : { prepare: (() => {
      const prepare = record(plan.prepare, 'prompt input prepare')
      return { interrupt: bytes(prepare.interrupt), endEvent: bytes(prepare.endEvent),
        ...(prepare.refresh === undefined ? {} : { refresh: bytes(prepare.refresh) }) }
    })() })
  }
  else if (plan.kind === 'payload-then-submit') {
    if (!Number.isSafeInteger(plan.minimumSubmitDelayMs) || Number(plan.minimumSubmitDelayMs) < 0 || Number(plan.minimumSubmitDelayMs) > 10_000) {
      throw new AgentMuxError('Frozen native payload interval is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    input = { kind: plan.kind, payload: bytes(plan.payload), payloadText: bytes(plan.payloadText), submit: bytes(plan.submit), minimumSubmitDelayMs: Number(plan.minimumSubmitDelayMs) }
  }
  else if (plan.kind === 'native-rpc') input = nativePromptPlan(plan)
  else if (plan.kind === 'runtime-launch') input = validateAgentLaunchPromptInputPlan(plan)
  else throw new AgentMuxError('Frozen prompt input plan is invalid.', 'INVALID_AGENT_SESSION_STORE')
  return input
}

export function normalizePromptInputIntent(value: unknown): NonNullable<NonNullable<AgentMuxStoredAgentSession['promptCompletionAdmission']>['intent']> {
  const source = record(value, 'promptCompletionAdmission.intent')
  const originalRun = runRef(source.run)
  const admissionIntent = source.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(source.admissionIntent)
  if (admissionIntent && (admissionIntent.kind === 'exact-condition' ? admissionIntent.condition.expectedRun.runId
    : admissionIntent.expectedRun.runId) !== originalRun.runId || admissionIntent !== undefined && admissionIntent.kind !== 'exact-condition' && source.execution !== 'immediate') {
    throw new AgentMuxError('Frozen admission intent changed its original Run or execution.', 'INVALID_AGENT_SESSION_STORE')
  }
  const bytes = (value: unknown): string => {
    if (typeof value !== 'string' || !value.length || !utf8WithinBytes(value, MAX_STORED_TEXT_BYTES)) {
      throw new AgentMuxError('Frozen prompt input is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    return value
  }
  const input = normalizePromptInputPlan(source.plan)
  return { run: originalRun, ownerInstanceId: string(source.ownerInstanceId, 'promptCompletionAdmission.intent.ownerInstanceId'),
    prompt: bytes(source.prompt), plan: input,
    ...(admissionIntent === undefined ? {} : { admissionIntent }),
    ...(source.execution === undefined ? {} : { execution: (() => {
      if (source.execution !== 'default' && source.execution !== 'immediate') {
        throw new AgentMuxError('Prompt execution intent is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return source.execution
    })() }),
    ...(source.message === undefined ? {} : { message: (() => {
      const message = record(source.message, 'promptCompletionAdmission.intent.message')
      return {
        ...(message.a2aNotificationId === undefined ? {} : { a2aNotificationId: string(message.a2aNotificationId, 'original A2A notification identity') }),
        ...preparedAuthorProfileFields(message.authorProfile),
        ...(message.inputImages === undefined ? {} : { inputImages: parseAgentInputImages(message.inputImages) }),
        ...browserInputContextFields(message), ...agentInputContextCaptureProofFields(message),
        ...(message.userContent === undefined ? {} : { userContent: bytes(message.userContent) }),
        ...(message.systemContext === undefined ? {} : { systemContext: bytes(message.systemContext) }),
        ...(message.authorAgentSessionId === undefined ? {} : { authorAgentSessionId: string(message.authorAgentSessionId, 'prompt message author') }),
        ...(message.authorHuman === true ? { authorHuman: true as const } : {}),
        ...(message.authorExternal === undefined ? {} : { authorExternal: parseAgentExternalMessageAuthor(message.authorExternal) }),
        ...(message.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(message.sourceDevice) }),
        ...(message.sourceChannel === undefined ? {} : { sourceChannel: normalizeMessageChannel(message.sourceChannel) }),
        ...(message.questionReply === undefined ? {} : { questionReply: (() => {
          const question = record(message.questionReply, 'original question reply'), source = record(question.source, 'original question source')
          if (Object.keys(question).some(key => !['source', 'turnId', 'recordId', 'questionIds', 'externalAction'].includes(key)) ||
              Object.keys(source).some(key => !['providerId', 'nativeSessionId'].includes(key)) ||
              !Array.isArray(question.questionIds) || !question.questionIds.length || new Set(question.questionIds).size !== question.questionIds.length) throw new AgentMuxError(
            'Original question reply identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
          return { source: { providerId: string(source.providerId, 'original question Provider'), nativeSessionId: string(source.nativeSessionId, 'original question source') },
            turnId: string(question.turnId, 'original question turn'), recordId: string(question.recordId, 'original question record'),
            questionIds: question.questionIds.map(id => string(id, 'original question identity', MAX_STORED_TEXT_BYTES)),
            ...(question.externalAction === undefined ? {} : { externalAction: parseAgentExternalInteractionAuthor(question.externalAction) }) }
        })() })
      }
    })() }) }
}

function nativePromptPlan(value: unknown): import('./types.js').AgentNativePromptInputPlan {
  const plan = record(value, 'native prompt plan')
  if (plan.kind !== 'native-rpc' || Object.keys(plan).some(key => !['kind', 'protocolId', 'sourceId', 'actorId', 'threadId', 'operation', 'expectedTurnId', 'clientCorrelation', 'interactionQueue'].includes(key)) ||
      plan.interactionQueue !== undefined && plan.interactionQueue !== true) {
    throw new AgentMuxError('Invalid native prompt plan.', 'INVALID_AGENT_SESSION_STORE')
  }
  const common = { kind: 'native-rpc' as const, protocolId: string(plan.protocolId, 'native protocol contract'), sourceId: string(plan.sourceId, 'native input source'), actorId: string(plan.actorId, 'native input actor'),
    threadId: string(plan.threadId, 'native input thread'), ...(plan.clientCorrelation === undefined ? {} : { clientCorrelation: string(plan.clientCorrelation, 'original native input correlation', 8192) }),
    ...(plan.interactionQueue === true ? { interactionQueue: true as const } : {}) }
  if (plan.operation === 'submit' || plan.operation === 'start-or-steer' || plan.operation === 'queue-idle') {
    if (plan.expectedTurnId !== undefined) throw new AgentMuxError('A native start or idle queue plan cannot claim an exact turn.', 'INVALID_AGENT_SESSION_STORE')
    return { ...common, operation: plan.operation }
  }
  if (plan.operation !== undefined && plan.operation !== 'steer') throw new AgentMuxError('Invalid native input operation.', 'INVALID_AGENT_SESSION_STORE')
  return { ...common, ...(plan.operation === undefined ? {} : { operation: 'steer' as const }), expectedTurnId: string(plan.expectedTurnId, 'native input expected turn') }
}

