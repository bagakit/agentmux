// @vitest-environment happy-dom
import { appendFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession, AgentMuxClientEvent } from '../../../packages/core/src/types'
import { continuitySession, hostedContinuityFixture } from '../../../packages/core/test/helpers/hosted-continuity'
import { agentPromptNotApplied, agentPromptPredecessor } from '../../../packages/core/src/agent-prompt-condition'
import { BUILT_IN_AGENT_PROVIDERS } from '../../../packages/core/src/agent-provider'
import { hostedPromptAdmissionSummary } from '@agentmux/core/hosted'
import { projectAgentMuxRuntimeSubjects } from '@agentmux/core/runtime'
import { hostedAgentSessionSummary } from '../../../packages/core/src/hosted-session-summary'
import { RuntimeController } from '../src/main/runtime-controller'
import { SESSION_EVENT_CHANNEL, type RuntimeEvent } from '../src/shared/contracts'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { currentContinuitySupervision } from '../src/renderer/src/lib/continuity-supervision'
import { ContinuitySupervisionNotice } from '../src/renderer/src/components/ContinuitySupervisionNotice'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import type { SpaceMountMemberEvent } from '../src/shared/space-mount'

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
  source.executorId = 'codex'
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
  const f = await hostedContinuityFixture([original], BUILT_IN_AGENT_PROVIDERS.filter(provider => provider.id === original.providerId))
  closes.push(f.dispose)
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

it('keeps the original recovery message in Core and out of Desktop Session carriers', async () => {
  const f = await fixture(), initial = session(), control = current().control
  vi.spyOn(f.client, 'runtimeIdentity').mockReturnValue({ hostId: 'local', buildIdentity: 'controlled-runtime',
    protocolVersion: 2, processId: 1, instanceId: 'controlled-runtime-instance' })
  const samples: Array<{ body: number; core: number; event: number; active: number; dormant: number; recovery: number; member: number }> = []
  const operationId = 'wire-original-operation-0', key = { kind: 'message' as const,
    agentSessionId: initial.agentSessionId, expectedRun: initial.run, messageId: 'owned-recovery-message' }
  const run = { ...initial.run, kind: 'agent' as const, providerId: initial.providerId, executorId: initial.executorId,
    agentSessionId: initial.agentSessionId, workspacePath: initial.workspacePath, pid: 1, state: 'running' as const,
    cols: 80, rows: 24, observedAt: 2, latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null }
  vi.spyOn(f.core, 'runtimeSubject').mockImplementation(async () => {
    const original = await f.core.readAgentSession(initial.agentSessionId)
    return projectAgentMuxRuntimeSubjects('local', [run], [original!])[0]!
  })
  // The selected transport routes its fixed member carrier to the same original Hosted owner.
  const memberFrames: SpaceMountMemberEvent[] = [], runtimeId = f.owner.runtimeId
  const mounted = spaceMountTransport(closes, [{ id: 'mounted-core', carrier: {
    forwardRpc: async (_method, input) => {
      const { call } = input as { call: { method: string; params: unknown } }
      return await f.port.call(call.method as never, call.params as never) as never
    },
    subscribeRpc: async (_method, input, handlers) => {
      const { call } = input as { call: { method: string; params: unknown } }
      return await f.port.subscribe(call.method, call.params, handlers as never) as never
    }
  } }], composerConfig)
  const member = await mounted.api.member({ hostId: 'mounted-core', target: { reference: { runtimeId, spaceId: 'original-space' },
    runtimeId, regionId: 'original-region', agentSessionId: initial.agentSessionId, expectedRun: initial.run } }, event => memberFrames.push(structuredClone(event)))
  closes.push(() => member.dispose())
  await vi.waitFor(() => expect(memberFrames.some(event => event.type === 'session')).toBe(true))
  for (const size of [1024, 1024 * 1024]) {
    const original = structuredClone(initial), root = Object.assign(original.continuityOperations![operationId]!, {
      coreOnlyExtension: 'FROZEN_CORE_ONLY_RECOVERY_EXTENSION_' + '界'.repeat(size)
    })
    const body = 'FROZEN_ORIGINAL_MESSAGE_' + '界'.repeat(size)
    root.trigger = 'input'
    root.kind = 'pending'
    root.messageInput = { ref: { key, waitGeneration: 1 }, key, admissionIntent: { kind: 'manual-actor', expectedRun: original.run },
      prompt: body, message: { userContent: body, authorHuman: true }, lifecycleOperationId: 'original-recovery-launch' }
    original.continuity = root
    const memberCut = memberFrames.length, frame = await f.publish(original), event = frame.event
    if (event.type !== 'agent-session') throw Error('Expected actual Session carrier')
    const assertDisplay = (value: unknown) => {
      expect(JSON.stringify(value), 'Original recovery body must stay in Core').not.toContain('FROZEN_ORIGINAL_MESSAGE_')
      expect(JSON.stringify(value), 'Future Core operation fields require explicit Desktop admission').not.toContain('FROZEN_CORE_ONLY_RECOVERY_EXTENSION_')
      expect(value).toMatchObject({ continuity: { operationId, hasMessageInput: true } })
      expect(value).not.toHaveProperty('continuity.messageInput')
      expect(value).not.toHaveProperty('continuity.coreOnlyExtension')
    }
    assertDisplay(event.session)
    assertDisplay(current())
    await vi.waitFor(() => expect(memberFrames.slice(memberCut).some(value => value.type === 'runtime' && value.event.event.type === 'agent-session')).toBe(true))
    const mountedEvent = memberFrames.slice(memberCut).find(value => value.type === 'runtime' && value.event.event.type === 'agent-session')
    if (mountedEvent?.type !== 'runtime' || mountedEvent.event.event.type !== 'agent-session') throw Error('Expected mounted Member Session event')
    assertDisplay(mountedEvent.event.event.session)
    const mountedSession = await member.call('read', {})
    assertDisplay(mountedSession)
    expect(mountedSession.control.run).toEqual(original.run)
    expect(event.session.continuityOperations?.[operationId]).toEqual(event.session.continuity)
    expect(current().continuityOperations?.[operationId]).toEqual(current().continuity)
    const full = f.internal.at(-1)
    if (full?.type !== 'agent-session') throw Error('Expected original internal Session event')
    expect(full.session.continuity?.messageInput?.prompt).toBe(body)
    expect(full.session.continuity).toHaveProperty('coreOnlyExtension', root.coreOnlyExtension)
    const inspected = await f.client.forwardRpc!('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
    expect(inspected.session.continuityOperations![operationId]!.messageInput).toEqual(root.messageInput)
    expect(inspected.session.continuityOperations![operationId]).toHaveProperty('coreOnlyExtension', root.coreOnlyExtension)

    vi.mocked(f.core.runtimeProjection).mockResolvedValueOnce({ hostId: 'local', subjects: [] })
    const dormant = structuredClone(await f.controller.snapshot(composerConfig)).recoveryCandidates[0]!
    assertDisplay(dormant)
    expect(dormant.continuityOperations?.[operationId]).toEqual(event.session.continuity)
    vi.mocked(f.core.runtimeProjection).mockResolvedValueOnce({ hostId: 'local',
      subjects: projectAgentMuxRuntimeSubjects('local', [run], [inspected.session]) })
    const active = structuredClone(await f.controller.snapshot(composerConfig)).sessions[0]!
    assertDisplay(active)
    expect(active.control.run).toEqual(original.run)
    expect(active.processState).toBe('running')

    // Controlled pending observation at the Core API. Hosted serialization and the Desktop recovery reply are production code.
    const pending = { kind: 'pending' as const, agentSessionId: original.agentSessionId, previousRun: original.run,
      reason: 'runtime-unverified' as const, evidence: { kind: 'run-unknown' as const, observedAt: 2, message: 'No Runtime observation' }, continuity: root }
    f.ensure.mockResolvedValueOnce(pending)
    const recovery = structuredClone(await f.controller.recoverSession(control, composerConfig, undefined, operationId))
    assertDisplay(recovery)
    expect(recovery).toMatchObject({ kind: 'pending', previousRun: original.run, reason: 'runtime-unverified', evidence: pending.evidence })
    expect(current().control).toEqual(control)
    samples.push({ body: Buffer.byteLength(body), core: bytes(full), event: bytes(frame), active: bytes(active),
      dormant: bytes(dormant), recovery: bytes(recovery), member: bytes(mountedEvent) })
  }
  await dom.render(<ContinuitySupervisionNotice session={current()} />)
  expect(dom.container.textContent).toContain('Attempt 2 of 2')
  expect(dom.draft(initial.agentSessionId)).toBe('Unsent original draft')
  expect(useAppStore.getState().agentSteerQueues[initial.agentSessionId]![0]).toMatchObject({ text: originalBody,
    resumeInputReceipt: { state: 'not-applied', input: { prompt: originalBody } } })
  const [short, long] = samples as [typeof samples[number], typeof samples[number]]
  expect(long.core - short.core).toBeGreaterThan(6 * 1024 * 1024)
  for (const carrier of ['event', 'active', 'dormant', 'recovery', 'member'] as const) expect(long[carrier], carrier).toBe(short[carrier])

  const request = { agentSessionId: initial.agentSessionId, expectedRun: initial.run, intentOperationId: operationId,
    operationId: 'own-recovery-control', action: 'cancel' as const }
  const controlled = structuredClone(await f.controller.controlContinuity('local', request))
  expect(controlled.result.receipt).toMatchObject({ request, outcome: 'cancelled' })
  if (controlled.result.state !== 'active') throw Error('Expected a retained Session')
  assertNoRecipe(controlled.result.session)
  const repeated = await f.client.controlAgentContinuity(request)
  expect(repeated.receipt).toEqual(controlled.result.receipt)
  if (repeated.state !== 'active') throw Error('Expected original retained Core Session')
  expect(repeated.session.continuityOperations![operationId]!.messageInput!.message.userContent).toContain('FROZEN_ORIGINAL_MESSAGE_')
  const creation = structuredClone(await f.controller.agentCreation('local', initial.agentSessionId))
  assertNoRecipe(creation)
  const launch = structuredClone(await f.controller.projectAgentCreation('local', repeated.session, composerConfig))
  expect(launch.created.run).toEqual(initial.run)
  assertNoRecipe(launch.created)
  assertNoRecipe(launch.session)
  fact({ kind: 'original-recovery-message-carriers', samples, coreControlReceiptPreserved: true })

  function assertNoRecipe(value: unknown) {
    expect(JSON.stringify(value)).not.toContain('FROZEN_ORIGINAL_MESSAGE_')
    expect(JSON.stringify(value)).not.toContain('FROZEN_CORE_ONLY_RECOVERY_EXTENSION_')
    expect(value).toHaveProperty(['continuityOperations', operationId, 'hasMessageInput'], true)
    expect(value).not.toHaveProperty(['continuityOperations', operationId, 'messageInput'])
  }
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
