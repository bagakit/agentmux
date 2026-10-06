import { AgentMuxError } from './errors.js'
import { validateAgentInputControlId, validateAgentInputWaitRef } from './agent-input-wait.js'
import { validateAgentPromptAdmissionIntent, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import type { AgentMuxRunRef, AgentMuxStoredAgentSession, AgentPromptInputPlan, AgentPromptSubmissionRecord, AgentTerminalPromptReadinessSource } from './types.js'

/** Pure original-input record decoding, shared by durable storage and public receipts. */
export const MAX_STORED_TEXT_BYTES = 1024 * 1024
const MAX_ID_BYTES = 512
const ENCODER = new TextEncoder()
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError(`${name} must be an object.`, 'INVALID_AGENT_SESSION_STORE')
  return value as Record<string, unknown>
}
function string(value: unknown, name: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || ENCODER.encode(value).length > maxBytes || /[\0\r\n]/.test(value)) throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
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
    ...(r.admission === undefined ? {} : { admission: normalizePromptCompletionAdmission(r.admission) }),
    ...(r.terminalPromptSubmission === undefined ? {} : { terminalPromptSubmission: terminalPromptSubmission(r.terminalPromptSubmission, run) })
  }
  if (!parsed.admission && !parsed.terminalPromptSubmission) throw new AgentMuxError('Original prompt record is empty.', 'INVALID_AGENT_SESSION_STORE')
  if (parsed.admission && parsed.terminalPromptSubmission && parsed.admission.submissionId !== parsed.terminalPromptSubmission.submissionId) throw new AgentMuxError(
    'Original prompt phases name different logical inputs.', 'INVALID_AGENT_SESSION_STORE')
  const inputKey = parsed.admission?.inputKey
  if (parsed.admission?.intent && parsed.admission.intent.run.runId !== run.runId || inputKey &&
      (inputKey.agentSessionId !== parsed.agentSessionId || inputKey.expectedRun.runId !== run.runId ||
        (inputKey.kind === 'prompt' ? inputKey.submissionId : inputKey.messageId) !== parsed.admission?.submissionId)) throw new AgentMuxError(
    'The original input record changed its Session, Run or logical identity.', 'INVALID_AGENT_SESSION_STORE')
  return parsed
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
  return {
    operationId: string(source.operationId, `${name}.operationId`),
    inputByteRange: { startByte, endByte },
    acknowledged: source.acknowledged,
    ...(source.notApplied === true ? { notApplied: true as const } : {})
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
    if (admission.transport === 'native') {
      if (admission.startByte !== undefined || admission.endByte !== undefined || admission.frameRefresh !== undefined || admission.uncertainTurn !== undefined) {
        throw new AgentMuxError('Native admission cannot contain PTY input facts.', 'INVALID_AGENT_SESSION_STORE')
      }
      const native = record(admission.native, 'native input admission'), plan = nativePromptPlan(native.plan)
      const intent = promptInputIntent(admission.intent)
      if (admission.submissionId === undefined || admission.operationId !== admission.submissionId || intent.message === undefined ||
          !['claimed', 'admitted', 'not-applied', 'unknown'].includes(String(native.outcome)) || JSON.stringify(intent.plan) !== JSON.stringify(plan) ||
          (native.outcome === 'admitted' ? admission.acknowledged !== true || typeof native.turnId !== 'string' || !native.turnId ||
            plan.operation !== 'start-or-steer' && native.turnId !== plan.expectedTurnId : admission.acknowledged === true) ||
          (native.outcome === 'not-applied') !== (admission.notApplied === true)) throw new AgentMuxError('Invalid native admission outcome.', 'INVALID_AGENT_SESSION_STORE')
      return { transport: 'native' as const, native: { plan, outcome: native.outcome as 'claimed' | 'admitted' | 'not-applied' | 'unknown',
        ...(native.turnId === undefined ? {} : { turnId: string(native.turnId, 'native admitted turn') }),
        ...(native.errorCode === undefined ? {} : { errorCode: (() => { if (!Number.isSafeInteger(native.errorCode)) throw new AgentMuxError('Invalid native error code.', 'INVALID_AGENT_SESSION_STORE'); return Number(native.errorCode) })() }) } }
    }
    if (admission.transport !== undefined && admission.transport !== 'pty' || admission.native !== undefined ||
        admission.intent !== undefined && promptInputIntent(admission.intent).plan.kind === 'native-rpc') throw new AgentMuxError('Invalid prompt transport.', 'INVALID_AGENT_SESSION_STORE')
    const startByte = timestamp(admission.startByte, 'promptCompletionAdmission.startByte')
    const endByte = positiveInteger(admission.endByte, 'promptCompletionAdmission.endByte')
    if (endByte <= startByte) throw new AgentMuxError('Invalid prompt input range.', 'INVALID_AGENT_SESSION_STORE')
    return { ...(admission.transport === 'pty' ? { transport: 'pty' as const } : {}), startByte, endByte }
  })()
  return {
    ...(admission.inputKey === undefined ? {} : { inputKey: validateAgentPromptInputKey(admission.inputKey) }),
    ...(admission.inputDispatch === undefined ? {} : { inputDispatch: (() => {
      const dispatch = record(admission.inputDispatch, 'original input dispatch gate')
      const ref = validateAgentInputWaitRef(dispatch.ref), key = validateAgentPromptInputKey(admission.inputKey)
      if (JSON.stringify(ref.key) !== JSON.stringify(key)) throw new AgentMuxError(
        'Original dispatch gate does not name this input.', 'INVALID_AGENT_SESSION_STORE')
      return { ref, gateId: validateAgentInputControlId(dispatch.gateId) }
    })() }),
    ...(admission.submissionId === undefined ? {} : { submissionId: string(admission.submissionId, 'promptCompletionAdmission.submissionId') }),
    ...(admission.completionId === undefined ? {} : { completionId: string(admission.completionId, 'promptCompletionAdmission.completionId') }),
    ...(admission.outputCursorBytes === undefined ? {} : { outputCursorBytes: timestamp(admission.outputCursorBytes, 'prompt admission output boundary') }),
    ...(admission.futureIntent === undefined ? {} : { futureIntent: (() => {
      const future = record(admission.futureIntent, 'future prompt occurrence')
      return { intentId: string(future.intentId, 'future intent id'), occurrenceAt: timestamp(future.occurrenceAt, 'future occurrence') }
    })() }),
    ...(admission.intent === undefined ? {} : { intent: promptInputIntent(admission.intent) }),
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

function promptInputIntent(value: unknown): NonNullable<NonNullable<AgentMuxStoredAgentSession['promptCompletionAdmission']>['intent']> {
  const source = record(value, 'promptCompletionAdmission.intent')
  const originalRun = runRef(source.run)
  const admissionIntent = source.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(source.admissionIntent)
  if (admissionIntent && (admissionIntent.kind === 'manual-actor' ? admissionIntent.expectedRun.runId
    : admissionIntent.condition.expectedRun.runId) !== originalRun.runId || admissionIntent?.kind === 'manual-actor' && source.execution !== 'immediate') {
    throw new AgentMuxError('Frozen admission intent changed its original Run or execution.', 'INVALID_AGENT_SESSION_STORE')
  }
  const plan = record(source.plan, 'promptCompletionAdmission.intent.plan')
  const bytes = (value: unknown): string => {
    if (typeof value !== 'string' || !value.length || ENCODER.encode(value).length > MAX_STORED_TEXT_BYTES) {
      throw new AgentMuxError('Frozen prompt input is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    return value
  }
  let input: AgentPromptInputPlan | import('./types.js').AgentNativePromptInputPlan
  if (plan.kind === 'single-phase') input = { kind: plan.kind, data: bytes(plan.data) }
  else if (plan.kind === 'render-then-submit') input = {
    kind: plan.kind, payload: bytes(plan.payload), renderedText: bytes(plan.renderedText), submit: bytes(plan.submit),
    ...(plan.prepare === undefined ? {} : { prepare: (() => {
      const prepare = record(plan.prepare, 'prompt input prepare')
      return { interrupt: bytes(prepare.interrupt), endEvent: bytes(prepare.endEvent),
        ...(prepare.refresh === undefined ? {} : { refresh: bytes(prepare.refresh) }) }
    })() })
  }
  else if (plan.kind === 'native-rpc') input = nativePromptPlan(plan)
  else throw new AgentMuxError('Frozen prompt input plan is invalid.', 'INVALID_AGENT_SESSION_STORE')
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
        ...(message.userContent === undefined ? {} : { userContent: bytes(message.userContent) }),
        ...(message.systemContext === undefined ? {} : { systemContext: bytes(message.systemContext) }),
        ...(message.authorAgentSessionId === undefined ? {} : { authorAgentSessionId: string(message.authorAgentSessionId, 'prompt message author') }),
        ...(message.authorHuman === true ? { authorHuman: true as const } : {}),
        ...(message.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(message.sourceDevice) }),
        ...(message.sourceChannel === undefined ? {} : { sourceChannel: normalizeMessageChannel(message.sourceChannel) })
      }
    })() }) }
}

function nativePromptPlan(value: unknown): import('./types.js').AgentNativePromptInputPlan {
  const plan = record(value, 'native prompt plan')
  if (plan.kind !== 'native-rpc' || Object.keys(plan).some(key => !['kind', 'protocolId', 'sourceId', 'actorId', 'threadId', 'operation', 'expectedTurnId'].includes(key))) {
    throw new AgentMuxError('Invalid native prompt plan.', 'INVALID_AGENT_SESSION_STORE')
  }
  const common = { kind: 'native-rpc' as const, protocolId: string(plan.protocolId, 'native protocol contract'), sourceId: string(plan.sourceId, 'native input source'), actorId: string(plan.actorId, 'native input actor'),
    threadId: string(plan.threadId, 'native input thread') }
  if (plan.operation === 'start-or-steer') {
    if (plan.expectedTurnId !== undefined) throw new AgentMuxError('A start-or-steer plan cannot claim an exact turn.', 'INVALID_AGENT_SESSION_STORE')
    return { ...common, operation: 'start-or-steer' }
  }
  if (plan.operation !== undefined && plan.operation !== 'steer') throw new AgentMuxError('Invalid native input operation.', 'INVALID_AGENT_SESSION_STORE')
  return { ...common, ...(plan.operation === undefined ? {} : { operation: 'steer' as const }), expectedTurnId: string(plan.expectedTurnId, 'native input expected turn') }
}

