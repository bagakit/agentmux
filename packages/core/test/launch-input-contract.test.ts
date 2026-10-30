import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentPromptNotApplied, validateAgentLaunchPromptInputPlan } from '../src/agent-prompt-condition.js'
import { agentInputSubmissionStatus, type AgentInputSubmissionReceipt, type AgentInputWaitControl } from '../src/agent-input-wait.js'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import { parsePromptSubmissionRecord } from '../src/prompt-submission-record.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { parseAgentInputSubmissionObservation } from '../src/agent-input-conversation.js'
import { parsePendingMessage } from '../src/pending-message-control.js'
import { moteInputObservationId, parseMoteInputObservation } from '../src/mote-input.js'
import { moteInputNoticeWire, parseMoteInputNotice } from '../src/mote-input-notice.js'
import type { AgentLaunchPromptInputPlan, AgentMuxStoredAgentSession, AgentPromptSubmissionRecord } from '../src/types.js'
import { fixturePath } from './helpers/fixture-values.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from '../src/agent-native-locator.js'

const key = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, messageId: 'original-message' }
const ref = { key, waitGeneration: 1 }
const control: AgentInputWaitControl = { ref, state: 'dispatch-authorized', gateId: 'original-gate', at: 10 }
const plan: AgentLaunchPromptInputPlan = { kind: 'runtime-launch', lifecycleOperationId: 'original-start',
  nativeTarget: { kind: 'provider', providerId: 'fixture', sessionId: 'original-native-session' }, program: 'fixture-cli', argsDigest: 'original-argv-digest' }
const body = 'Original external message\nSecond line remains part of the same input.'
type Outcome = 'claimed' | 'unknown' | 'not-applied' | 'launch-carried'
function claim(outcome: Outcome = 'claimed'): AgentPromptSubmissionRecord {
  return { agentSessionId: key.agentSessionId, run: { ...key.expectedRun }, admission: {
    inputKey: structuredClone(key), inputDispatch: { ref: structuredClone(ref), gateId: control.gateId },
    submissionId: key.messageId, operationId: key.messageId, transport: 'launch',
    intent: { run: { ...key.expectedRun }, ownerInstanceId: 'original-owner', prompt: body, plan: structuredClone(plan),
      execution: 'immediate', admissionIntent: { kind: 'session-conversation', expectedRun: { ...key.expectedRun } },
      message: { userContent: body, sourceChannel: 'agent-message' } },
    ...(outcome === 'launch-carried' ? { acknowledged: true, launch: { plan: structuredClone(plan), outcome,
      receipt: { kind: 'runtime-launch', operationId: plan.lifecycleOperationId, run: { runId: 'successor-run' }, observedAt: 20 } } }
      : { acknowledged: false, ...(outcome === 'not-applied' ? { notApplied: true } : {}), launch: { plan: structuredClone(plan), outcome } })
  } }
}
function receipt(outcome: Outcome): AgentInputSubmissionReceipt {
  const admission = claim(outcome)
  return { key, ref, control, originalControlOperationId: 'original-control', persistence: 'confirmed', admission,
    status: agentInputSubmissionStatus(control, admission), observation: 'closed' }
}
function session(record = claim()): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: key.agentSessionId, providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath: fixturePath('launch-input-workspace'), run: { ...key.expectedRun }, retiredRuns: [],
    hookBindingId: 'original-binding', hookToken: 'fixture-hook-token', createdAt: 1, updatedAt: 10,
    nativeHandle: structuredClone(plan.nativeTarget), promptCompletionAdmission: record.admission }
}

it('browser locator decodes the original launch receipt without Node globals', () => {
  const values = ['/tmp/native-session.jsonl', 'C:\\fixture\\native-session.jsonl', 'relative/native-session.jsonl'].map(transcriptPath => {
    const value = JSON.parse(JSON.stringify(receipt('launch-carried')))
    value.admission.admission.launch.plan.nativeTarget.transcriptPath = transcriptPath
    value.admission.admission.intent.plan.nativeTarget.transcriptPath = transcriptPath
    return value
  })
  const originalProcess = globalThis.process, originalBuffer = globalThis.Buffer
  const decoded: unknown[] = []
  try {
    Object.assign(globalThis, { process: undefined, Buffer: undefined })
    for (const value of values) {
      try { decoded.push(parseAgentInputSubmissionReceipt(value)) } catch (error) { decoded.push(error) }
    }
  } finally { Object.assign(globalThis, { process: originalProcess, Buffer: originalBuffer }) }
  expect(decoded[0]).toEqual(values[0])
  expect(decoded[1]).toEqual(values[1])
  expect(decoded[2]).toBeInstanceOf(Error)
})

it('browser locator preserves the execution Host native absolute-path decision', () => {
  for (const path of ['/tmp/native-session.jsonl', 'relative/native-session.jsonl', 'C:\\fixture\\native-session.jsonl', '\\\\server\\share']) {
    expect(Boolean(normalizeNativeTranscriptPath(path)), path).toBe(isAbsolute(path))
  }
})

it('browser locator keeps UTF-8 session identity limits without Buffer', () => {
  const previous = globalThis.Buffer
  let values: Array<string | undefined>
  try {
    Object.assign(globalThis, { Buffer: undefined })
    values = [normalizeNativeSessionId('界'.repeat(170)), normalizeNativeSessionId('界'.repeat(171)),
      normalizeNativeSessionId('🙂'.repeat(128)), normalizeNativeSessionId('🙂'.repeat(129))]
  } finally { Object.assign(globalThis, { Buffer: previous }) }
  expect(values).toEqual(['界'.repeat(170), undefined, '🙂'.repeat(128), undefined])
})

it.each(['claimed', 'unknown', 'not-applied', 'launch-carried'] as const)('preserves the original message receipt for %s without claiming native admission', outcome => {
  const value = receipt(outcome), expected = outcome === 'claimed' ? 'unknown' : outcome
  expect(parseAgentInputSubmissionReceipt(JSON.parse(JSON.stringify(value)))).toEqual(value)
  expect(value.status).toBe(expected)
  expect(value.admission!.run).toEqual(key.expectedRun)
  expect(value.status).not.toBe('admitted')
  expect(Boolean(agentPromptNotApplied(session(value.admission!)))).toBe(outcome === 'not-applied')
  expect(parseAgentInputSubmissionObservation({ status: value.status, observation: 'closed' })).toEqual({ status: expected, observation: 'closed' })
})

it('rejects transport, receipt, target and original-key substitutions in strict public decoding', () => {
  const mutations: Array<(value: any) => void> = [
    value => { value.status = 'admitted' },
    value => { value.admission.admission.launch.receipt.operationId = 'another-start' },
    value => { value.admission.admission.launch.receipt.run = key.expectedRun },
    value => { value.admission.run = { runId: 'successor-run' } },
    value => { value.admission.admission.inputKey = { ...key, kind: 'prompt', submissionId: key.messageId } },
    value => { value.admission.admission.startByte = 0; value.admission.admission.endByte = 1 },
    value => { value.admission.admission.native = { outcome: 'admitted', turnId: 'invented-turn' } },
    value => { value.admission.admission.launch.plan.argsDigest = 'another-argv' },
    value => { value.admission.admission.inputDispatch.gateId = 'another-gate' },
    value => { value.admission.admission.launch.outcome = 'unknown'; value.admission.admission.acknowledged = false; value.status = 'unknown' }
  ]
  for (const mutate of mutations) {
    const value = JSON.parse(JSON.stringify(receipt('launch-carried')))
    mutate(value)
    expect(() => parseAgentInputSubmissionReceipt(value)).toThrow()
  }
  expect(() => validateAgentLaunchPromptInputPlan({ ...plan, nativeTarget: { ...plan.nativeTarget, kind: 'acp' } })).toThrow()
  expect(() => validateAgentLaunchPromptInputPlan({ ...plan, nativeTarget: { ...plan.nativeTarget, transcriptPath: 'relative-history' } })).toThrow()
})

it('keeps an existing authored prompt launch record unchanged', () => {
  const record: AgentPromptSubmissionRecord = { agentSessionId: 'authored-session', run: { runId: 'authored-run' }, launch: {
    input: { submissionId: 'authored-input', prompt: 'Existing authored input' }, prompt: 'Existing authored input',
    message: { userContent: 'Existing authored input' }, digest: 'authored-digest', delivery: 'launch', lifecycleOperationId: 'authored-start',
    state: 'launch-carried', key: { kind: 'prompt', agentSessionId: 'authored-session', expectedRun: { runId: 'authored-run' }, submissionId: 'authored-input' },
    receipt: { kind: 'runtime-launch', operationId: 'authored-start', run: { runId: 'authored-run' }, observedAt: 10 }
  } }
  expect(parsePromptSubmissionRecord(record)).toEqual(record)
})

it('carries the status through pending and Mote decoders without inventing native adoption or a result', () => {
  const pending = { pendingId: 'authored-input', text: body, runId: 'original-run', enqueuedAt: 10,
    status: 'deferred', phase: null, editable: false, delivery: 'confirmed', errorCode: null, error: null, archived: true,
    inputWait: { ref: { key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: key.expectedRun, submissionId: 'authored-input' }, waitGeneration: 1 },
      status: 'launch-carried', observation: 'closed', controlState: 'dispatch-authorized' } }
  expect(parsePendingMessage(pending)).toEqual(pending)
  const origin = { kind: 'prompt' as const, key }, source = { spaceId: 'space', zoneId: 'zone', tabId: 'tab', regionId: 'region' }
  const observation = parseMoteInputObservation({ id: moteInputObservationId(origin), revision: 1, origin, source,
    binding: { source, primary: { hostId: 'local', agentSessionId: 'primary' }, moteRevision: 'mote-revision', spatialRevision: 1 },
    sourceStatus: 'confirmed', issue: null, input: 'launch-carried', notices: {} })
  const notice = parseMoteInputNotice(moteInputNoticeWire(observation, 'input'))
  expect(notice?.input).toBe('launch-carried')
  expect(notice?.origin).toEqual(origin)
  expect(notice?.result).toBeUndefined()
  expect(observation.nativeInput).toBeUndefined()
  expect(observation.result).toBeUndefined()
  expect(parseMoteInputNotice(moteInputNoticeWire(observation, 'result'))).toBeNull()
})

for (const kind of ['memory', 'file'] as const) describe(`${kind} original launch settlement`, () => {
  it('retains unknown across Run replacement and only settles the exact original claim', async () => {
    const directory = await mkdtemp(fixturePath('tmp/agentmux-launch-contract-')), path = join(directory, 'sessions.json')
    let store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(path)
    try {
      const original = claim(), stored = session(original), carried = claim('launch-carried')
      await store.compareAndSwapMetadata(null, stored)
      await expect(store.compareAndSwapMetadata(stored, session(carried))).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      for (const changed of [
        { ...carried, run: { runId: 'another-run' } },
        { ...carried, admission: { ...carried.admission!, intent: { ...carried.admission!.intent!, prompt: 'replacement body' } } },
        { ...carried, admission: { ...carried.admission!, inputDispatch: { ref, gateId: 'replacement-gate' } } }
      ]) await expect(store.settlePromptAdmission(original, changed)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      const unknown = claim('unknown')
      await store.settlePromptAdmission(original, unknown)
      const current = (await store.readMetadata(key.agentSessionId))!
      const next = { ...current, run: { runId: 'successor-run' }, retiredRuns: [key.expectedRun], updatedAt: 30 }
      delete next.promptCompletionAdmission
      await store.compareAndSwapMetadata(current, next)
      if (kind === 'file') store = new AgentMuxFileAgentSessionStore(path)
      expect(await store.readPromptAdmission(key.agentSessionId, key.expectedRun, key.messageId)).toEqual(unknown)
      await expect(store.settlePromptAdmission(original, carried)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
      await store.settlePromptAdmission(unknown, carried)
      expect(await store.readPromptAdmission(key.agentSessionId, key.expectedRun, key.messageId)).toEqual(carried)
      expect(await store.readPromptAdmission(key.agentSessionId, next.run, key.messageId)).toBeNull()
      expect((await store.readMetadata(key.agentSessionId))?.run).toEqual(next.run)
      expect((await store.readMetadata(key.agentSessionId))?.promptCompletionAdmission).toBeUndefined()
      await expect(store.settlePromptAdmission(carried, claim('not-applied'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
