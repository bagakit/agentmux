const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createAgentInputContextCaptureRecord } from '@agentmux/core/agent-input-context-capture'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-continuity'
import type { AgentInputSubmissionReceipt, AgentMuxContinuityOperation, AgentMuxAgentSession } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import type { BrowserCapturedInput } from '../src/renderer/src/lib/browser-contextual-input'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

// Real Store, admission, drain and event projection. Only the native Desktop API is a test port.
// Actual Main/Host/Provider consumers are covered by the native feature verifier.
const initial = useAppStore.getState(), body = '  Original opinion\n<amux>Authored example</amux>', note = 'Original platform note'
const session = () => composerSession('browser-opinion-recipient')
const reference = (operationId: string) => ({ hostId: 'local', operationId })
function captured(operationId: string, control: AgentSessionControl = session().control, url = 'https://page.invalid/original'): BrowserCapturedInput {
  const record = createAgentInputContextCaptureRecord({ reference: reference(operationId),
    binding: { executionHostId: control.hostId, agentSessionId: control.agentSessionId, originRun: control.run }, prompt: body, agentMuxNote: note,
    inputContext: { kind: 'browser', version: 1, capturedAt: _batchFixtureEpoch(0, 0, 10),
      browser: { hostId: 'local', browserId: 'original-browser', navigationId: 'original-navigation' }, page: { url },
      activity: { operationId: 'browser-operation', stepSequence: 3, phase: 'running', observedAt: _batchFixtureEpoch(0, 0, 9) } } })
  return { control: structuredClone(control), capture: { reference: reference(operationId), record, diskDurability: 'confirmed' } }
}
function enqueue(operationId: string, execution?: 'default' | 'immediate', input = captured(operationId)) {
  const rejected = vi.fn()
  expect(useAppStore.getState().enqueueAgentSteer(session().id, body, rejected, operationId, 'manual', note,
    { browserInput: input, sourceChannel: 'message-tool', ...(execution ? { execution } : {}) })).toBe(true)
  expect(rejected).not.toHaveBeenCalled()
  return useAppStore.getState().agentSteerQueues[session().id]!.find(entry => entry.operationId === operationId)!
}
function waiting(operationId: string, control = session().control): AgentInputSubmissionReceipt {
  const key = { kind: 'prompt' as const, agentSessionId: control.agentSessionId, expectedRun: control.run, submissionId: operationId }, ref = { key, waitGeneration: 1 }
  return { key, ref, persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
    control: { ref, state: 'enabled', at: _batchFixtureEpoch(0, 0, 10), waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' } } }
}
const pending: Promise<unknown>[] = [], gates: Array<() => void> = []
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  gates.push(() => resolve(undefined as T))
  return { promise, resolve }
}
function send(operationId: string) {
  const promise = useAppStore.getState().sendQueuedAgentSteer(session().id, operationId)
  pending.push(promise); return promise
}
beforeEach(async () => {
  const dispose = await useAppStore.getState().initialize(); dispose()
  useAppStore.setState(initial, true)
  const tab = createWorkbenchTab('original-browser-recipient-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'original-region', sessionId: session().id })
  useAppStore.setState({ sessions: [session()], config: composerConfig, loading: false, tabs: { [tab.id]: tab }, layouts: {},
    agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, agentComposerDrafts: { [session().id]: 'Independent current draft' }, error: null })
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const current = useAppStore.getState().sessions.find(value => control.kind === 'agent' && value.id === control.agentSessionId)
    if (!current) throw new Error('Missing exact fixture recipient')
    return current
  })
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
})
afterEach(async () => {
  gates.splice(0).forEach(resolve => resolve())
  await Promise.allSettled(pending.splice(0))
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

it('admits one immutable original capture and rejects different scenes or new IDs carrying its old reference', () => {
  const input = captured('capture-admission'), original = structuredClone(input), entry = enqueue('capture-admission', undefined, input)
  input.capture.record.inputContext.page.url = 'https://page.invalid/later'
  input.control.run.runId = 'later-run'
  expect(entry.browserInput).toEqual(original)
  expect(() => useAppStore.getState().editQueuedAgentSteer(session().id, entry.operationId, body, 'Changed message')).toThrow()
  expect(useAppStore.getState().agentSteerQueues[session().id]![0]?.text).toBe(body)
  const rejected = vi.fn()
  expect(useAppStore.getState().enqueueAgentSteer(session().id, body, rejected, 'capture-admission', 'manual', note,
    { browserInput: captured('capture-admission', session().control, 'https://page.invalid/another-scene'), sourceChannel: 'message-tool' })).toBe(false)
  expect(useAppStore.getState().enqueueAgentSteer(session().id, body, rejected, 'new-input-id', 'manual', note,
    { browserInput: original, sourceChannel: 'message-tool' })).toBe(false)
  expect(rejected).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().agentSteerQueues[session().id]).toHaveLength(1)
})

it('passes only the original reference through direct manual input and joins Core waiting without a second submit', async () => {
  const id = 'capture-direct', receipt = waiting(id), submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(receipt)
  enqueue(id, 'immediate')
  await expect(send(id)).resolves.toBe('unconfirmed')
  expect(submit).toHaveBeenCalledExactlyOnceWith(session().control, body, id,
    { expectedRun: session().control.run, admissionIntent: { kind: 'manual-actor' } }, { execution: 'immediate' }, true, note, 'message-tool', undefined, undefined, undefined, reference(id))
  expect(useAppStore.getState().agentSteerQueues[session().id]![0]?.inputReceipt?.key).toEqual(receipt.key)
  vi.mocked(api.sessions.inspectInput).mockResolvedValue(receipt)
  const rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting').mockResolvedValue(receipt)
  await expect(send(id)).resolves.toBe('unconfirmed')
  expect(rejoin).toHaveBeenCalledExactlyOnceWith(session().control, receipt.ref)
  expect(submit).toHaveBeenCalledOnce()
  expect(JSON.stringify(submit.mock.calls)).not.toContain('inputContextCaptureProof')
})

it('keeps a lost direct intake reply on its original ID and reads that owner on explicit retry', async () => {
  const id = 'capture-unknown', submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('Original intake reply was lost'))
  enqueue(id, 'immediate')
  await expect(send(id)).rejects.toThrow('Original intake reply was lost')
  const entry = useAppStore.getState().agentSteerQueues[session().id]![0]!
  expect(entry).toMatchObject({ operationId: id, inputIntakeStarted: true, awaitingExplicitSend: true, browserInput: captured(id) })
  vi.mocked(api.sessions.inspectInput).mockResolvedValue(waiting(id))
  vi.spyOn(api.sessions, 'rejoinInputWaiting').mockResolvedValue(waiting(id))
  await expect(send(id)).resolves.toBe('unconfirmed')
  expect(submit).toHaveBeenCalledOnce()
  expect(useAppStore.getState().agentSteerQueues[session().id]!.map(value => value.operationId)).toEqual([id])
})

it('carries the reference through the exact conditional queue path without attaching a producer proof', async () => {
  const id = 'capture-exact', submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  enqueue(id, 'default')
  await expect(send(id)).resolves.toBe('submitted')
  expect(submit).toHaveBeenCalledExactlyOnceWith(session().control, body, id,
    { expectedRun: session().control.run, afterSubmissionId: null }, { allowUncertainTurn: true }, true, note, 'message-tool', undefined, undefined, undefined, reference(id))
  expect(useAppStore.getState().agentSteerQueues[session().id]).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts[session().id]).toBe('Independent current draft')
})

it('keeps a malformed persisted capture instead of submitting its body as plain input', async () => {
  const id = 'capture-damaged', original = enqueue(id, 'default'), damaged = structuredClone(original)
  damaged.browserInput!.capture.record.intentDigest = 'not-an-original-digest'
  const retained = structuredClone(damaged)
  // Corruption happens after admission, as it can in a restored workbench projection.
  useAppStore.setState({ agentSteerQueues: { [session().id]: [damaged] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await expect(send(id)).rejects.toThrow()
  expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[session().id]![0]).toMatchObject({
    operationId: id, text: body, browserInput: retained.browserInput, awaitingExplicitSend: true
  })
})

it.each(['host', 'run'] as const)('does not rebind a queued captured opinion when its %s changes before Send', async dimension => {
  const id = 'capture-route-' + dimension, original = enqueue(id, 'default'), changed = session()
  if (dimension === 'host') { changed.hostId = 'another-host'; changed.control.hostId = 'another-host' }
  else changed.control.run.runId = 'another-run'
  useAppStore.setState({ sessions: [changed] })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await expect(send(id)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[session().id]![0]).toMatchObject({ operationId: id, runId: original.runId, browserInput: captured(id) })
})

it('cannot make a wholly refused capture into a new input by copying its frozen reference', async () => {
  const id = 'capture-refused', original = enqueue(id, 'default'), current = session()
  useAppStore.setState({ sessions: [{ ...current, promptInputNotApplied: { submissionId: id, run: current.control.run, observedAt: _batchFixtureEpoch(0, 0, 10) } } as never],
    agentSteerQueues: { [current.id]: [{ ...original, promptCondition: { expectedRun: current.control.run, afterSubmissionId: null } }] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await expect(useAppStore.getState().resendRefusedAgentSteer(current.id, id)).rejects.toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED' })
  expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[current.id]!.map(entry => entry.operationId)).toEqual([id])
})

function recovery(operationId: string, input: NonNullable<NonNullable<Parameters<typeof api.sessions.recover>[3]>['input']>, capture: BrowserCapturedInput, wrongProof = false) {
  const current = session(), run = { runId: 'actual-recovered-run' }, record = capture.capture.record
  const proof = { reference: record.reference, binding: record.binding, intentDigest: wrongProof ? 'f'.repeat(64) : record.intentDigest }
  const operation: AgentMuxContinuityOperation = { operationId, agentSessionId: current.id, trigger: 'input', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
    previousRun: current.control.run, newRun: run, admittedAt: _batchFixtureEpoch(0, 0, 10), observedAt: _batchFixtureEpoch(0, 0, 11), rechecks: 0, kind: 'resumed', reason: 'explicit-request',
    evidence: { kind: 'run-ended', state: 'exited', observedAt: _batchFixtureEpoch(0, 0, 10) }, launchInput: { input: structuredClone(input),
      // The authoritative frozen wire can contain recovery guidance different from today's formatter.
      prompt: 'Original Core wire with retained recovery guidance', digest: 'original-core-wire-digest',
      message: { userContent: body, authorHuman: true, sourceChannel: 'message-tool', systemContext: 'Original Core recovery guidance\n' + note,
        inputContext: record.inputContext, inputContextSource: 'host-capture', inputContextCaptureProof: proof },
      delivery: 'launch', lifecycleOperationId: 'original-launch', state: 'launch-carried',
      key: { kind: 'prompt', agentSessionId: current.id, expectedRun: run, submissionId: operationId },
      receipt: { kind: 'runtime-launch', operationId: 'original-launch', run, observedAt: _batchFixtureEpoch(0, 0, 11) } } }
  return { ...current, control: { ...current.control, run }, continuity: operation, continuityOperations: { [operationId]: operation } }
}

it.each([false, true])('reconciles continuity from typed original capture fields rather than current wire formatting (wrongProof=%s)', async wrongProof => {
  const id = 'capture-continuity-' + wrongProof, capture = captured(id), current = { ...session(), processState: 'exited' as const }
  useAppStore.setState({ sessions: [current] })
  enqueue(id, 'immediate', capture)
  const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async (control, _cwd, operationId, request) => {
    expect(control).toEqual(capture.control)
    expect(request?.input).toEqual({ submissionId: id, prompt: body, agentMuxNote: note, inputContextCapture: reference(id), authorHuman: true, sourceChannel: 'message-tool' })
    return { kind: 'resumed', session: recovery(operationId!, request!.input!, capture, wrongProof) }
  })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  if (wrongProof) await expect(send(id)).rejects.toThrow('unconfirmed')
  else {
    let error: unknown
    const result = await send(id).catch(reason => { error = reason })
    expect(error, 'Typed original capture and receipt must settle without rebuilding their wire').toBeUndefined()
    expect(result).toBe('submitted')
  }
  expect(recover).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled()
  const entry = useAppStore.getState().agentSteerQueues[current.id]![0]!
  expect(entry.operationId).toBe(id)
  expect(entry.resumeInputIntent?.control).toEqual(capture.control)
  expect(entry.browserInput).toEqual(capture)
  if (wrongProof) { expect(entry.archived).not.toBe(true); expect(entry.resumeInputReceipt).toBeUndefined() }
  else { expect(entry.archived).toBe(true); expect(entry.resumeInputReceipt?.key?.expectedRun.runId).toBe('actual-recovered-run') }
})

it('keeps unknown continuity on its original ID and settles only its later Core event without another input', async () => {
  const id = 'capture-lost-continuity', capture = captured(id), current = session()
  useAppStore.setState({ sessions: [{ ...current, processState: 'exited' }] })
  enqueue(id, 'immediate', capture)
  const recover = vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Original recovery reply was lost'))
  vi.mocked(api.sessions.refresh).mockRejectedValue(new Error('Original receipt lookup unavailable'))
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await expect(send(id)).rejects.toThrow('Original recovery reply was lost')
  const original = useAppStore.getState().agentSteerQueues[current.id]![0]!
  expect(original).toMatchObject({ operationId: id, inputIntakeStarted: true, awaitingExplicitSend: true,
    resumeInputIntent: { control: capture.control, input: { submissionId: id, inputContextCapture: reference(id) } } })
  const restored = recovery(id, original.resumeInputIntent!.input, capture)
  const core: AgentMuxAgentSession = { kind: 'agent', agentSessionId: current.id, providerId: current.providerId, executorId: current.executorId,
    hostId: current.hostId, workspacePath: current.workspacePath, run: restored.control.run, retiredRuns: [current.control.run], createdAt: _batchFixtureEpoch(0, 0, 10), updatedAt: _batchFixtureEpoch(0, 0, 11),
    continuity: restored.continuity, continuityOperations: restored.continuityOperations }
  useAppStore.getState().applyEvent({ type: 'core', hostId: current.hostId, event: { type: 'agent-session', session: core } })
  const settled = useAppStore.getState().agentSteerQueues[current.id]![0]!
  expect(settled).toMatchObject({ operationId: id, archived: true, browserInput: capture,
    resumeInputReceipt: { key: { expectedRun: restored.control.run, submissionId: id } } })
  expect(recover).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled()
})

it('does not decorate a newer Host queue with a late failure from the old captured input', async () => {
  const id = 'capture-late', original = enqueue(id, 'default'), started = gate<void>(), response = gate<void>()
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => { started.resolve(); await response.promise; throw new Error('Late original Host failure') })
  const sending = send(id)
  const rejection = expect(sending).rejects.toThrow('Late original Host failure')
  await started.promise
  const changed = session(); changed.hostId = 'another-host'; changed.control.hostId = 'another-host'
  const next = { ...original, operationId: 'newer-host-input', browserInput: captured('newer-host-input', changed.control), browserRecipient: changed.control }
  useAppStore.setState({ sessions: [changed], agentSteerQueues: { [changed.id]: [next] } })
  response.resolve(); await rejection
  expect(submit).toHaveBeenCalledOnce()
  expect(useAppStore.getState().agentSteerQueues[changed.id]).toEqual([next])
})
