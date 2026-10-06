import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeAgent, type AgentMuxClientEvent, type AgentMuxRun, type ContinuousProgressObservation } from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import { openDemandStore } from '@agentmux/demand'
import type { DemandDelegationAttention } from '@agentmux/demand/delegations'
import type { DemandDispatchIntent } from '@agentmux/demand'
import { GoalStartResponsibilityOwner } from '../src/main/goal-start-responsibility'

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const task: DemandDispatchIntent = { operationId: 'original-start', agentSessionId: 'worker', hostId: 'local', runId: 'worker-run', execution: 'finite', prompt: ' Original task\n with exact body. ' }
type Mode = 'idle' | 'busy' | 'draft' | 'unknown'
function processEvent(runId: string, state: AgentMuxRun['state']): AgentMuxClientEvent {
  return { type: 'process-state', run: { runId }, state, pid: null, evidence: { source: 'run-process', observedAt: Date.now() } }
}
async function record(scenario: string, proof: unknown) {
  const directory = process.env.AGENTMUX_GOAL_START_RECEIPT_DIR
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(join(directory, `${scenario}.json`), JSON.stringify({ schema: 'agentmux.goal-start-responsibility-owner.v1', scenario,
    proofBoundary: 'Actual event owner and Demand persistence; Runtime, native completion, input cursor and Core observation are explicit isolated ports. Does not prove installed Native input or GUI consumption.', proof }, null, 2) + '\n')
}
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'goal-start-owner-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root: join(root, 'goals') })
  await demands.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', assigneeSessionIds: ['owner', 'worker', 'next-owner'], supervisorSessionId: 'owner' })
  await demands.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Original result' }], openQuestions: [] })
  await demands.prepareDispatch('goal', task)
  const pending = new Set<Promise<unknown>>()
  const track = <T,>(promise: Promise<T>): Promise<T> => {
    pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise
  }
  // Drain actual public owner work, including filesystem awaits; waiting only for
  // the Core read would let negative assertions race the remaining input job.
  for (const method of ['snapshot', 'get', 'inspectDispatch', 'prepareDispatchAttention', 'markDispatchAttentionAttempt'] as const) {
    const original = demands[method].bind(demands)
    vi.spyOn(demands, method).mockImplementation(((...args: unknown[]) => track((original as (...values: unknown[]) => Promise<unknown>)(...args))) as never)
  }
  let releaseNative: (() => void) | undefined, nativeBarrier: Promise<void> | undefined, admissionSignal: AbortSignal | undefined
  const holdNative = () => { nativeBarrier = new Promise<void>(resolve => { releaseNative = resolve }) }
  const release = () => { releaseNative?.(); releaseNative = undefined; nativeBarrier = undefined }
  const state = { mode: 'idle' as Mode, workerRun: 'running' as AgentMuxRun['state'] | undefined, supervisorRun: 'owner-run', receiptConfirmed: false, submitUnknown: false, stopCalls: 0, draftText: '', inputReceipt: 'exact' as 'exact' | 'wrong-body' | 'wrong-key' | 'missing' }
  const notes = new Map<string, DemandDelegationAttention>(), receipts = new Map<string, unknown>()
  let listener: ((hostId: string, event: AgentMuxClientEvent) => void) | undefined
  let inputListener: ((control: { kind: 'agent'; hostId: string; agentSessionId: string; run: { runId: string } }) => void) | undefined
  const creation = (id: string) => ({ kind: 'agent' as const, agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: id === 'owner' ? state.supervisorRun : id + '-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100) })
  const actualInputs: Array<{ operationId: string; supervisorSessionId: string; supervisorRunId: string; note: string }> = []
  const runtime = {
    agentCreation: vi.fn(async (_hostId: string, id: string) => creation(id)),
    observeOriginalRun: vi.fn(async (_hostId: string, runId: string) => { if (!state.workerRun) throw new Error('Original Run observation unavailable'); return { runId, state: state.workerRun } }),
    inspectGoalStart: vi.fn(async () => state.inputReceipt === 'missing' ? null : ({ agentSessionId: task.agentSessionId, run: { runId: task.runId }, admission: { submissionId: task.operationId, acknowledged: true, inputKey: { kind: 'prompt', agentSessionId: task.agentSessionId, expectedRun: { runId: state.inputReceipt === 'wrong-key' ? 'another-run' : task.runId }, submissionId: task.operationId }, intent: { run: { runId: task.runId }, prompt: state.inputReceipt === 'wrong-body' ? task.prompt.trim() : task.prompt } } })),
    observeCoreEvents: vi.fn((_types: readonly AgentMuxClientEvent['type'][], consume: (hostId: string, event: AgentMuxClientEvent) => void) => {
      listener = consume; return () => { listener = undefined }
    }),
    observeInputOccupation: vi.fn((consume: typeof inputListener) => { inputListener = consume; return () => { inputListener = undefined } }),
    saveGoalAttention: vi.fn(async (attention: DemandDelegationAttention) => { notes.set(attention.intentId, structuredClone(attention)) }),
    inspectGoalAttention: vi.fn(async (attention: DemandDelegationAttention) => receipts.get(attention.operationId) ?? null),
    observeContinuousProgress: vi.fn(async (scope: { futureIntentId?: string }, tickId: string, now: number): Promise<ContinuousProgressObservation> => {
      const attention = scope.futureIntentId ? notes.get(scope.futureIntentId) : undefined
      const status = { state: state.mode === 'busy' ? 'working' as const : 'done' as const, source: 'native-hook' as const, observedAt: now }
      return { session: { agentSessionId: 'owner', hostId: 'local', providerId: 'codex', workspacePath: root, run: { runId: state.supervisorRun }, semanticStatus: status,
        futurePromptIntents: attention ? { [attention.intentId]: { operationId: attention.operationId, prompt: '', active: true, message: { systemContext: attention.agentMuxNote } } } : {} },
        observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now),
        tickId, now, inputOccupied: state.mode === 'draft', inputByte: state.mode === 'unknown' ? null : 0 }
    }),
    submitPrompt: vi.fn(async (control: { agentSessionId: string; run: { runId: string } }, prompt: string, operationId: string,
      condition: { expectedRun: { runId: string }; afterSubmissionId: string | null }, automation: { futureIntent: { intentId: string }; isCurrent(): boolean; signal?: AbortSignal },
      _choice: unknown, authorHuman: unknown, note: string) => {
      const saved = (await demands.get('goal'))!.dispatches!.find(start => start.attention?.operationId === operationId)!.attention!
      expect(saved.attemptedAt).toBeGreaterThan(0)
      expect(prompt).toBe(''); expect(authorHuman).toBeUndefined()
      expect(control).toMatchObject({ agentSessionId: saved.supervisorAgentSessionId, run: { runId: saved.supervisorRunId } })
      expect(condition.expectedRun).toEqual(control.run)
      expect(automation.futureIntent.intentId).toBe(saved.intentId)
      expect(automation.isCurrent()).toBe(true)
      expect(note).toBe(saved.agentMuxNote)
      admissionSignal = automation.signal
      if (nativeBarrier) await nativeBarrier
      if (automation.signal?.aborted || !automation.isCurrent()) return
      const composed = composeAgentPrompt(prompt, note)
      expect(composed.systemContext).toBe(note)
      expect(composed.text).toContain('<amux from="amux">')
      actualInputs.push({ operationId, supervisorSessionId: control.agentSessionId, supervisorRunId: control.run.runId, note })
      if (state.submitUnknown) throw new Error('Isolated Native reminder receipt is unconfirmed')
      if (state.receiptConfirmed) receipts.set(operationId, { agentSessionId: control.agentSessionId, run: control.run, admission: { submissionId: operationId,
        acknowledged: true, intent: { message: { systemContext: note } } } })
    }),
    stop: vi.fn(async () => { state.stopCalls++ })
  }
  for (const method of ['agentCreation', 'inspectGoalStart', 'observeOriginalRun', 'saveGoalAttention', 'inspectGoalAttention', 'observeContinuousProgress', 'submitPrompt'] as const) {
    const original = runtime[method].getMockImplementation()!
    runtime[method].mockImplementation(((...args: unknown[]) => track((original as (...values: unknown[]) => Promise<unknown>)(...args))) as never)
  }
  const changed = vi.fn()
  const createOwner = () => {
    const owner = new GoalStartResponsibilityOwner(demands, runtime as unknown as ConstructorParameters<typeof GoalStartResponsibilityOwner>[1], changed)
    cleanup.push(() => owner.dispose()); return owner
  }
  const owner = createOwner()
  const emit = (event: AgentMuxClientEvent, hostId = 'local') => { expect(listener).toEqual(expect.any(Function)); listener!(hostId, event) }
  const inputOccupation = (control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'owner', run: { runId: state.supervisorRun } }) => {
    expect(inputListener).toEqual(expect.any(Function)); inputListener!(control)
  }
  const nativeCompletion = () => emit({ type: 'agent-session', session: { ...creation('owner'), semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now() } } } as AgentMuxClientEvent)
  const idle = async () => {
    for (let quiet = 0; quiet < 3;) {
      await Promise.allSettled([...pending]); await new Promise<void>(resolve => setImmediate(resolve))
      quiet = pending.size === 0 ? quiet + 1 : 0
    }
  }
  cleanup.push(release)
  const proof = async () => ({ goal: await demands.get('goal'), actualInputs, notes: [...notes.values()], runtimeCalls: { read: runtime.inspectGoalStart.mock.calls.length,
    agentCreation: runtime.agentCreation.mock.calls.length, save: runtime.saveGoalAttention.mock.calls.length, observe: runtime.observeContinuousProgress.mock.calls.length,
    submit: runtime.submitPrompt.mock.calls.length, inspect: runtime.inspectGoalAttention.mock.calls.length, stop: runtime.stop.mock.calls.length } })
  const observe = async (selected = owner) => selected.observe((await demands.get('goal'))!, (await demands.inspectDispatch('goal', task.operationId))!)
  return { observe, root, demands, owner, createOwner, runtime, state, actualInputs, notes, receipts, changed, emit, nativeCompletion, idle, proof, holdNative, release, inputOccupation, admissionSignal: () => admissionSignal }
}

describe('original finite Start event responsibility', () => {
  it.each(['exited', 'interrupted'] as const)('uses the exact original %s Run and Core input for one platform-only Supervisor notice', async ended => {
    const f = await fixture(); f.state.receiptConfirmed = true; await f.owner.start(); await f.idle()
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    f.state.workerRun = ended; f.emit(processEvent(task.runId, ended)); await f.idle()
    expect(f.actualInputs).toHaveLength(1)
    const saved = (await f.demands.inspectDispatch('goal', task.operationId))!
    expect(saved.attention).toMatchObject({ hostId: task.hostId, supervisorAgentSessionId: 'owner', supervisorRunId: 'owner-run' })
    expect(JSON.parse(saved.attention!.agentMuxNote)).toMatchObject({ schema: 'agentmux.goal-start-attention.v1', goalId: 'goal', startOperationId: task.operationId, workerAgentSessionId: task.agentSessionId, originalRunId: task.runId })
    expect(await f.observe()).toMatchObject({ input: { state: 'confirmed' }, originalRun: { runId: task.runId, state: ended }, responsibility: 'original-worker-continuation', attention: { state: 'confirmed' } })
    expect((await f.demands.get('goal'))!).toMatchObject({ status: 'in_progress', alignment: { confirmedAt: null } })
    expect((await f.demands.get('goal'))!.grounding).toBeUndefined()
    expect((await f.demands.get('goal'))!.delegations).toBeUndefined(); expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('original-run-' + ended, await f.proof())
  })

  it.each(['wrong-body', 'wrong-key', 'missing'] as const)('keeps original input %s unknown without guessing death or changing the saved Start', async mismatch => {
    const f = await fixture(); f.state.inputReceipt = mismatch
    const frozen = await f.demands.inspectDispatch('goal', task.operationId)
    await f.owner.start(); await f.idle()
    expect(await f.observe()).toMatchObject({ input: { state: 'unknown' }, originalRun: { state: 'running' }, responsibility: 'observation-unknown' })
    expect((await f.observe()).input.proof).toBeUndefined()
    expect(await f.demands.inspectDispatch('goal', task.operationId)).toEqual(frozen)
    expect(f.runtime.stop).not.toHaveBeenCalled(); expect(f.actualInputs).toEqual([])
  })

  it('uses original machine userContent while preserving arbitrary platform note display, and refuses a different task body', async () => {
    const f = await fixture(), original = (await f.runtime.inspectGoalStart())!
    const actual = { ...original, admission: { ...original.admission, intent: { ...original.admission.intent,
      prompt: 'Arbitrary composed platform display and original task.', message: { userContent: task.prompt, systemContext: 'A different platform display note.' } } } }
    f.runtime.inspectGoalStart.mockResolvedValueOnce(actual)
    expect(await f.observe()).toMatchObject({ input: { state: 'confirmed', proof: { prompt: task.prompt } }, responsibility: 'working' })
    const mismatch = { ...actual, admission: { ...actual.admission, intent: { ...actual.admission.intent, prompt: task.prompt,
      message: { ...actual.admission.intent.message, userContent: 'Different original task.' } } } }
    f.runtime.inspectGoalStart.mockResolvedValueOnce(mismatch)
    expect(await f.observe()).toMatchObject({ input: { state: 'unknown' }, responsibility: 'observation-unknown' })
    expect(f.runtime.stop).not.toHaveBeenCalled()
  })

  it.each(['busy', 'draft', 'unknown'] as const)('preserves healthy %s Supervisor input and only tries after its actual completion', async mode => {
    const f = await fixture(); f.state.mode = mode; await f.owner.start(); await f.idle()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited')); await f.idle()
    const original = (await f.demands.inspectDispatch('goal', task.operationId))!
    expect(original.attention).toBeDefined(); expect(original.attention!.attemptedAt).toBeUndefined()
    expect(f.actualInputs).toEqual([]); expect((await f.observe()).attention!.state).toBe('prepared')
    f.state.mode = 'idle'; f.nativeCompletion(); await f.idle()
    expect(f.actualInputs).toHaveLength(1); expect(f.runtime.stop).not.toHaveBeenCalled()
  })

  it('reconciles the original attempted input after lost acknowledgement and event-owner restart without a second Native claim', async () => {
    const f = await fixture(); f.state.submitUnknown = true; await f.owner.start(); await f.idle()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited')); await f.idle()
    expect(f.actualInputs).toHaveLength(1)
    const frozen = (await f.demands.inspectDispatch('goal', task.operationId))!
    f.owner.dispose(); const restarted = f.createOwner(); await restarted.start(); await f.idle()
    for (let i = 0; i < 5; i++) { f.emit(processEvent(task.runId, 'exited')); f.nativeCompletion() }
    await f.idle(); expect(f.actualInputs).toHaveLength(1)
    expect(await f.demands.inspectDispatch('goal', task.operationId)).toEqual(frozen)
    expect((await f.observe(restarted)).attention).toMatchObject({ state: 'unknown' })
    expect(f.runtime.inspectGoalAttention).toHaveBeenCalledWith(frozen.attention)
    await record('unknown-receipt-restart', await f.proof())
  })

  it('persists the one attempt before a lost fsync receipt and leaves Native input unused', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle()
    const original = f.demands.markDispatchAttentionAttempt.bind(f.demands), originalOpen = fs.open.bind(fs); let injected = 0
    vi.spyOn(f.demands, 'markDispatchAttentionAttempt').mockImplementationOnce(async (...args) => {
      const fault = vi.spyOn(fs, 'open').mockImplementation(async (...values: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...values)
        if (values[0] === f.demands.root && injected === 0) { injected++; vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('Start attempt fsync EIO'), { code: 'EIO' })) }
        return handle
      })
      try { return await original(...args) } finally { fault.mockRestore() }
    })
    f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited')); await f.idle()
    const saved = (await f.demands.inspectDispatch('goal', task.operationId))!
    expect(injected).toBe(1); expect(saved.attention!.attemptedAt).toBeGreaterThan(0); expect(f.actualInputs).toEqual([])
    f.nativeCompletion(); f.emit(processEvent(task.runId, 'exited')); await f.idle()
    expect(f.actualInputs).toEqual([]); expect((await f.observe()).attention).toMatchObject({ state: 'unknown' })
    await record('attempt-marker-unknown', await f.proof())
  })

  it.each(['missing', 'same-ended'] as const)('retains explicit original Session recovery when Supervisor is %s', async scope => {
    const f = await fixture(); await f.demands.update('goal', { supervisorSessionId: scope === 'missing' ? null : task.agentSessionId })
    await f.owner.start(); await f.idle(); f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited')); await f.idle()
    expect((await f.observe()).responsibility).toBe('original-worker-continuation')
    expect((await f.observe()).unknown).toMatch(scope === 'missing' ? /No Supervisor/u : /same ended/u)
    expect(f.actualInputs).toEqual([]); expect((await f.demands.inspectDispatch('goal', task.operationId))!.attention).toBeUndefined()
    expect(f.runtime.stop).not.toHaveBeenCalled()
  })

  it('keeps Goal-level evidence separate from this Start, distinguishes captured old results, and exposes later proposals for human review', async () => {
    const f = await fixture(), proposal = { alignmentRevision: 1, summary: 'Goal-level evidence', checks: [{ criterionId: 'AC', outcome: 'met' as const, evidence: ['evidence/result.log:7'], note: '' }] }
    await f.demands.proposeGrounding('goal', proposal)
    await f.demands.prepareDispatch('goal', { ...task, operationId: 'after-old-result' })
    const old = (await f.demands.inspectDispatch('goal', 'after-old-result'))!
    f.state.workerRun = 'exited'
    expect(await f.owner.observe((await f.demands.get('goal'))!, old)).toMatchObject({ responsibility: 'original-worker-continuation', goalResult: { association: 'unknown', basis: 'captured', changedSinceStart: false } })
    const legacy = { ...old }; delete legacy.resultBasis
    expect(await f.owner.observe((await f.demands.get('goal'))!, legacy)).toMatchObject({ responsibility: 'original-worker-continuation', goalResult: { association: 'unknown', basis: 'unknown', changedSinceStart: null } })
    await f.demands.proposeGrounding('goal', { ...proposal, summary: 'New Goal-level evidence' })
    expect(await f.owner.observe((await f.demands.get('goal'))!, old)).toMatchObject({ responsibility: 'goal-result-review', goalResult: { association: 'unknown', changedSinceStart: true, grounding: { acceptedAt: null } } })
    await f.owner.start(); await f.idle()
    expect(f.actualInputs).toHaveLength(2); expect((await f.demands.get('goal'))!.status).toBe('in_progress')
    await record('goal-level-evidence-not-worker-report', { ...await f.proof(), capturedStart: old, legacyObservation: await f.owner.observe((await f.demands.get('goal'))!, legacy) })
  })

  it.each(['handoff', 'cancelled', 'draft'] as const)('cancels the exact Start notice before Native claim after %s changed', async change => {
    const f = await fixture(); await f.owner.start(); await f.idle(); f.holdNative()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited'))
    await vi.waitFor(() => expect(f.admissionSignal()).toBeDefined())
    if (change === 'handoff') await f.demands.update('goal', { supervisorSessionId: 'next-owner' })
    else if (change === 'cancelled') await f.demands.update('goal', { status: 'cancelled' })
    else {
      f.state.draftText = 'Retain this user draft.'
      f.inputOccupation({ kind: 'agent', hostId: 'different', agentSessionId: 'owner', run: { runId: 'owner-run' } }); expect(f.admissionSignal()!.aborted).toBe(false)
      f.inputOccupation({ kind: 'agent', hostId: 'local', agentSessionId: 'owner', run: { runId: 'other-run' } }); expect(f.admissionSignal()!.aborted).toBe(false)
      f.inputOccupation()
    }
    expect(f.admissionSignal()!.aborted).toBe(true)
    f.release(); await f.idle(); expect(f.actualInputs).toEqual([]); expect(f.runtime.stop).not.toHaveBeenCalled()
    if (change === 'draft') expect(f.state.draftText).toBe('Retain this user draft.')
    await record('preclaim-' + change, { ...await f.proof(), aborted: f.admissionSignal()!.aborted })
  })


  it('does not cancel a Start reminder for a new Goal-level result whose association to this worker remains unknown', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle(); f.holdNative()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited'))
    await vi.waitFor(() => expect(f.admissionSignal()).toBeDefined())
    await f.demands.proposeGrounding('goal', { alignmentRevision: 1, summary: 'Result from some Goal work', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['evidence/result.log:7'], note: '' }] })
    expect(f.admissionSignal()!.aborted).toBe(false)
    f.release(); await f.idle(); expect(f.actualInputs).toHaveLength(1)
    expect(await f.observe()).toMatchObject({ responsibility: 'goal-result-review', goalResult: { association: 'unknown', grounding: { acceptedAt: null } } })
    expect((await f.demands.get('goal'))!.status).toBe('in_progress')
    await record('other-goal-result-keeps-original-notice', await f.proof())
  })

  it('does not cancel the original notice for another Start and does no owner work for 100 unrelated Sessions and Runs', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle()
    const reads = f.runtime.inspectGoalStart.mock.calls.length
    for (let i = 0; i < 100; i++) {
      f.emit(processEvent('unrelated-' + i, 'exited'))
      f.emit({ type: 'agent-session', session: { kind: 'agent', hostId: 'local', agentSessionId: 'unrelated-' + i, run: { runId: 'unrelated-' + i } } } as AgentMuxClientEvent)
    }
    await f.idle(); expect(f.runtime.inspectGoalStart.mock.calls).toHaveLength(reads)
    f.holdNative(); f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited'))
    await vi.waitFor(() => expect(f.admissionSignal()).toBeDefined())
    await f.demands.prepareDispatch('goal', { ...task, operationId: 'other-start', agentSessionId: 'other-worker', runId: 'other-run' })
    expect(f.admissionSignal()!.aborted).toBe(false)
    f.release(); await f.idle(); expect(f.actualInputs.filter(input => input.operationId === (f.notes.values().next().value!).operationId)).toHaveLength(1)
    expect(f.runtime.stop).not.toHaveBeenCalled()
  })

  it('keeps healthy event registrations when the initial business snapshot is unavailable', async () => {
    const f = await fixture(); vi.spyOn(f.demands, 'snapshot').mockRejectedValueOnce(new Error('initial Goal read unavailable'))
    await expect(f.owner.start()).resolves.toBeUndefined()
    expect(f.runtime.observeCoreEvents).toHaveBeenCalledOnce(); expect((await f.observe()).unknown).toContain('initial Goal read unavailable')
    await f.demands.update('goal', { title: 'Original Goal updated' }); await f.idle()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.runId, 'exited')); await f.idle()
    expect(f.actualInputs).toHaveLength(1); expect(f.runtime.stop).not.toHaveBeenCalled()
  })
})
