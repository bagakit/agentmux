// @vitest-environment happy-dom
import { appendFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession, AgentMuxClientEvent } from '../../../packages/core/src/types'
import { continuitySession, hostedContinuityFixture } from '../../../packages/core/test/helpers/hosted-continuity'
import { agentPromptNotApplied, agentPromptPredecessor } from '../../../packages/core/src/agent-prompt-condition'
import { hostedPromptAdmissionSummary } from '@agentmux/core/hosted'
import { hostedAgentSessionSummary } from '../../../packages/core/src/hosted-session-summary'
import { RuntimeController } from '../src/main/runtime-controller'
import { SESSION_EVENT_CHANNEL, type RuntimeEvent } from '../src/shared/contracts'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { currentContinuitySupervision } from '../src/renderer/src/lib/continuity-supervision'
import { ContinuitySupervisionNotice } from '../src/renderer/src/components/ContinuitySupervisionNotice'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {} }))
const dom = composerDOM(), closes: Array<() => unknown | Promise<unknown>> = []
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const fact = (value: unknown) => { if (process.env.SESSION_ADMISSION_WIRE_FACTS) appendFileSync(process.env.SESSION_ADMISSION_WIRE_FACTS, JSON.stringify(value) + '\n') }
const originalBody = 'Original queued recovery words'
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'recover').mockRejectedValue(Error('No recovery was authorized by a display event'))
  vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(Error('No input was authorized by a display event'))
})
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function session() {
  const source = continuitySession('wire-original', 3), nativeTarget = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  source.nativeHandle = nativeTarget
  const root = source.continuityOperations!['wire-original-operation-0']!
  root.nativeTarget = nativeTarget
  root.newRun = source.run
  root.supervision = { phase: 'paused', activeAttemptOperationId: 'wire-original-operation-2', attemptCount: 2, attemptLimit: 2, observedAt: 2, reason: 'retry-budget-exhausted' }
  const child = source.continuity!
  child.intentOperationId = root.operationId; child.nativeTarget = nativeTarget
  const old = source.continuityOperations!['wire-original-operation-1']!
  old.previousRun = { runId: 'original-old-run' }
  old.launchInput = { input: { submissionId: old.operationId, prompt: originalBody, authorHuman: true },
    prompt: 'Original Core wire retained separately', message: { userContent: originalBody, authorHuman: true }, digest: 'original-digest',
    delivery: 'post-launch', lifecycleOperationId: 'original-launch', state: 'not-applied' }
  source.pendingInteraction = { request: { kind: 'question', id: 'original-question', agentSessionId: source.agentSessionId,
    questions: [{ id: 'choice', prompt: 'Original question', options: [{ id: 'retain', label: 'Retain original' }] }],
    evidence: { source: 'native-hook', run: source.run, observedAt: 2, hookReceiptId: 'original-question-hook' } } }
  return source
}
function current() {
  const value = useAppStore.getState().sessions.find(value => value.id === 'wire-original')
  if (!value || value.kind !== 'agent') throw Error('Original Agent projection missing')
  return value
}
async function fixture(original = session()) {
  const f = await hostedContinuityFixture([original]); closes.push(f.dispose)
  const client = await f.connect('full')
  const controller = new RuntimeController(f.store, async () => client); closes.push(() => controller.dispose())
  controller.commit(await controller.prepare(composerConfig))
  const frames: RuntimeEvent[] = [], internal: AgentMuxClientEvent[] = []
  closes.push(controller.observeCoreEvents(['agent-session', 'agent-status'], (_host, event) => { internal.push(structuredClone(event)) }))
  const queue: AgentSteerQueueEntry = { operationId: 'wire-original-operation-1', text: originalBody, status: 'deferred', awaitingExplicitSend: true,
    runId: 'original-old-run', resumeInputIntent: { control: { kind: 'agent', hostId: 'local', agentSessionId: original.agentSessionId, run: { runId: 'original-old-run' } },
      input: { submissionId: 'wire-original-operation-1', prompt: originalBody, authorHuman: true } } }
  useAppStore.setState({ config: composerConfig, sessions: [composerSession(original.agentSessionId)], loading: false, timelines: {},
    recoveryCandidates: [], pendingAgentLaunches: {}, continuityControlIntents: {}, agentComposerDrafts: { [original.agentSessionId]: 'Unsent original draft' },
    agentSteerQueues: { [original.agentSessionId]: [queue] }, agentSteerInFlight: {}, runtimeEndpointWarnings: [], error: null })
  const receive = vi.fn((channel: string, value: RuntimeEvent) => {
    expect(channel).toBe(SESSION_EVENT_CHANNEL)
    const cloned = structuredClone(value); frames.push(cloned)
    useAppStore.getState().applyEvent(cloned)
  })
  const target = { id: 71, isDestroyed: () => false, send: receive, on: vi.fn(), off: vi.fn() }
  closes.push(controller.attach(target as unknown as WebContents))
  const destroyed = vi.fn()
  closes.push(controller.attach({ ...target, id: 72, isDestroyed: () => true, send: destroyed } as unknown as WebContents))
  let clock = 3
  async function publish(value: AgentMuxStoredAgentSession) {
    const count = frames.length
    await act(async () => f.update(value))
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(count))
    const frame = frames.at(-1)!
    if (frame.event.type !== 'agent-session') throw Error('Expected actual Session carrier')
    return frame
  }
  return { ...f, client, controller, frames, internal, destroyed, publish,
    next: (admission: AgentMuxAgentSession['promptCompletionAdmission']) => {
      const { promptCompletionAdmission: _previous, ...rest } = original
      const identity = 'original-input-' + clock
      const next = admission && { ...structuredClone(admission), submissionId: identity, operationId: identity }
      if (next?.transport === 'launch') {
        const key = { kind: 'message' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, messageId: identity }
        next.inputKey = key
        next.inputDispatch = { ref: { key, waitGeneration: 1 }, gateId: 'original-gate-' + clock }
      }
      return { ...rest, updatedAt: clock++, ...(admission ? { promptCompletionAdmission: {
        ...next!
      } } : {}) }
    } }
}

it('narrows only actual registered-client admission bytes while original full receipts, questions and recovery consumers remain intact', async () => {
  const f = await fixture(), samples: Array<{ promptBytes: number; fullEventBytes: number; displayEventBytes: number }> = []
  for (const size of [2048, 16384]) {
    const prompt = 'PRIVATE_FROZEN_WIRE_' + '界🙂\\"\n'.repeat(size), original = f.next(structuredClone(session().promptCompletionAdmission))
    original.promptCompletionAdmission!.intent!.prompt = prompt
    original.promptCompletionAdmission!.intent!.message = { userContent: prompt, authorHuman: true }
    const frame = await f.publish(original), event = frame.event
    if (event.type !== 'agent-session') throw Error('Expected original Session')
    const admission = event.session.promptCompletionAdmission!, intent = original.promptCompletionAdmission!.intent!
    expect(admission, 'Frozen intent must not enter the actual registered display frame').not.toHaveProperty('intent')
    expect(JSON.stringify(frame), 'Frozen body must not enter the actual Main wire').not.toContain('PRIVATE_FROZEN_WIRE_')
    if (!('intentSummary' in admission)) throw Error('Original display admission summary missing')
    expect(admission.intentSummary).toEqual({ run: intent.run, ownerInstanceId: intent.ownerInstanceId, execution: 'immediate', planKind: 'native-rpc', promptBytes: Buffer.byteLength(prompt) })
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(prompt.length)
    const { promptCompletionAdmission: _summary, ...displayRest } = event.session
    const fullEvent = f.internal.at(-1)
    if (fullEvent?.type !== 'agent-session') throw Error('Original full business event missing')
    const { promptCompletionAdmission: _full, ...originalRest } = fullEvent.session
    expect(displayRest).toEqual(originalRest)
    expect(event.session).not.toHaveProperty('sessionProjection')
    expect(event.session.continuityOperations).toEqual(original.continuityOperations)
    expect(f.internal.at(-1)).toMatchObject({ type: 'agent-session', session: { promptCompletionAdmission: { intent: { prompt } } } })
    const exact = await f.client.readAgentSession(original.agentSessionId)
    expect(exact!.promptCompletionAdmission!.intent!.prompt).toBe(prompt)
    expect(f.client.agentSession(original.agentSessionId).promptCompletionAdmission!.intent!.prompt).toBe(prompt)
    const inspected = await f.client.forwardRpc!('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
    expect(inspected.session.promptCompletionAdmission!.intent!.message!.userContent).toBe(prompt)
    expect(current().continuityOperations).toEqual(original.continuityOperations)
    expect(current().pendingInteraction).toEqual(original.pendingInteraction!.request)
    expect(currentContinuitySupervision(current())).toMatchObject({ root: { operationId: 'wire-original-operation-0' }, attempt: { operationId: 'wire-original-operation-2' } })
    expect(useAppStore.getState().agentSteerQueues[original.agentSessionId]![0]).toMatchObject({ text: originalBody, awaitingExplicitSend: true,
      resumeInputReceipt: { state: 'not-applied', input: { prompt: originalBody } } })
    expect(useAppStore.getState().agentSteerQueues[original.agentSessionId]![0]!.archived).not.toBe(true)
    expect(current().promptSubmissionPredecessor).toBe(original.promptCompletionAdmission!.submissionId)
    expect(dom.draft(original.agentSessionId)).toBe('Unsent original draft')
    samples.push({ promptBytes: Buffer.byteLength(prompt), fullEventBytes: bytes(f.internal.at(-1)), displayEventBytes: bytes(frame) })
  }
  await dom.render(<ContinuitySupervisionNotice session={current()} />)
  expect(dom.container.textContent).toContain('Attempt 2 of 2')
  expect(samples[1]!.displayEventBytes - samples[0]!.displayEventBytes).toBeLessThan(32)
  expect(samples[1]!.fullEventBytes - samples[0]!.fullEventBytes).toBeGreaterThan(100000)
  expect(f.destroyed).not.toHaveBeenCalled()
  expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.submitPrompt).not.toHaveBeenCalled(); expect(api.sessions.recover).not.toHaveBeenCalled()
  fact({ kind: 'actual-carrier', samples, source: 'Core→HostedSDK→RuntimeController.attach→WebContents.send→AppStore + original queue/question/recovery notice', fullContinuityOperations: 3, rootAttemptJoined: true, oldRunLaunchReceipt: 'not-applied', noNewInput: true })
})

it('keeps original admission discrimination through actual Store events, including confirmed and unknown phases', async () => {
  const f = await fixture(), native = structuredClone(session().promptCompletionAdmission!)
  if (native.transport !== 'native') throw Error('Native original fixture required')
  const cases: Array<{ name: string; value: NonNullable<AgentMuxAgentSession['promptCompletionAdmission']>; refused: boolean }> = []
  const nativeRefused = { ...native, notApplied: true, native: { ...native.native!, outcome: 'not-applied' as const } }
  cases.push({ name: 'native-refused', value: nativeRefused, refused: true },
    { name: 'native-unknown', value: native, refused: false },
    { name: 'native-acknowledged', value: { ...native, acknowledged: true, native: { ...native.native, outcome: 'admitted' as const, turnId: 'original-confirmed-turn' } }, refused: false })
  const single = { kind: 'single-phase' as const, data: '\r' }
  const pty = { submissionId: native.submissionId!, operationId: 'pty-input', startByte: 0, endByte: 2, notApplied: true,
    intent: { ...native.intent!, plan: single } }
  cases.push({ name: 'pty-single-refused', value: pty, refused: true },
    { name: 'pty-partial-ack', value: { ...pty, notApplied: false, chunks: [
      { operationId: 'chunk-first', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: true },
      { operationId: 'chunk-next', inputByteRange: { startByte: 1, endByte: 2 }, acknowledged: false }] }, refused: false })
  const launchPlan = { kind: 'runtime-launch' as const, lifecycleOperationId: 'original-launch',
    nativeTarget: { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }, program: 'controlled', argsDigest: 'original-args' }
  cases.push({ name: 'launch-refused', value: { submissionId: native.submissionId!, operationId: 'launch-input', transport: 'launch', notApplied: true,
    launch: { plan: launchPlan, outcome: 'not-applied' }, intent: { ...native.intent!, plan: launchPlan,
      admissionIntent: { kind: 'session-conversation', expectedRun: native.intent!.run } } }, refused: true })
  for (const test of cases) {
    const original = f.next(test.value), frame = await f.publish(original)
    if (frame.event.type !== 'agent-session') throw Error('Expected actual Session')
    expect(agentPromptNotApplied(original) !== undefined, test.name + ': valid original control fixture').toBe(test.refused)
    expect(current().promptInputNotApplied !== undefined, test.name + ': actual Store must preserve original summary discrimination').toBe(test.refused)
    expect(current().promptSubmissionPredecessor).toBe(agentPromptPredecessor(original))
    expect(frame.event.session.promptCompletionAdmission).toEqual(hostedPromptAdmissionSummary(original.promptCompletionAdmission!))
  }
  fact({ kind: 'actual-control-consumer', cases: cases.map(({ name, refused }) => ({ name, refused })) })
})

it('preserves summary selection, optional clears, same-time changes, exact subject boundaries and other event types', async () => {
  const f = await fixture(), original = f.next(structuredClone(session().promptCompletionAdmission!))
  await f.publish(original)
  const first = current(), changed = structuredClone(original)
  changed.promptCompletionAdmission!.submissionId = 'changed-at-same-time'
  changed.promptCompletionAdmission!.operationId = 'changed-at-same-time'
  await f.publish(changed)
  expect(current().promptSubmissionPredecessor).toBe('changed-at-same-time')
  expect(first.promptSubmissionPredecessor).toBe(original.promptCompletionAdmission!.submissionId)
  const summary = hostedAgentSessionSummary(changed)
  expect(summary).toMatchObject({ sessionProjection: 'summary', promptCompletionAdmission: hostedPromptAdmissionSummary(changed.promptCompletionAdmission!) })
  expect(summary).not.toHaveProperty('continuityOperations')
  const { promptCompletionAdmission: _cleared, pendingInteraction: _question, ...clear } = changed
  await f.publish(clear)
  expect(current().promptSubmissionPredecessor).toBeNull(); expect(current().pendingInteraction).toBeUndefined(); expect(current().promptInputNotApplied).toBeUndefined()
  expect(f.frames.at(-1)!.event).not.toHaveProperty('session.promptCompletionAdmission')
  const preserved = current(), wrong = { ...clear, agentSessionId: 'wrong-session' }
  await expect(f.update(wrong)).rejects.toThrow()
  expect(useAppStore.getState().sessions.find(value => value.id === preserved.id)?.control).toEqual(preserved.control)
  // A non-Session fact follows the same original Main channel without prompt projection.
  const status: Extract<AgentMuxClientEvent, { type: 'agent-status' }> = { type: 'agent-status', agentSessionId: clear.agentSessionId, state: 'working', evidence: { source: 'native-hook', observedAt: 5, run: clear.run } }
  const count = f.frames.length
  ;(f.core as unknown as { publisher: { publish(event: AgentMuxClientEvent): void } }).publisher.publish(status)
  await vi.waitFor(() => expect(f.frames.length).toBeGreaterThan(count))
  expect(f.frames.at(-1)!.event).toEqual(status)
  fact({ kind: 'clear-and-protocol', sameTimeChange: true, optionalClear: true, oldRunControlRetained: true, otherEventIdentical: true })
})
