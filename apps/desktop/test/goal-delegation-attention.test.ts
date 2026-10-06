import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeAgent, type AgentMuxClientEvent, type AgentMuxRun, type ContinuousProgressObservation } from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import { openDemandStore } from '@agentmux/demand'
import type { DemandDelegationAttention, DemandDelegationIntent } from '@agentmux/demand/delegations'
import { GoalDelegationAttentionOwner } from '../src/main/goal-delegation-attention'
import type { GoalDelegationOwner } from '../src/main/goal-delegation-owner'

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const task: DemandDelegationIntent = { operationId: 'delegation', sourceMessageId: 'source', hostId: 'local', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker',
  ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'thread', text: 'Original task', alignmentRevision: 1, criterionIds: ['AC'] }
type Mode = 'idle' | 'busy' | 'draft' | 'unknown'
function processEvent(runId: string, state: AgentMuxRun['state']): AgentMuxClientEvent {
  return { type: 'process-state', run: { runId }, state, pid: null, evidence: { source: 'run-process', observedAt: Date.now() } }
}
async function record(scenario: string, proof: unknown) {
  const directory = process.env.AGENTMUX_GOAL_DELEGATION_ATTENTION_RECEIPT_DIR
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(join(directory, `${scenario}.json`), JSON.stringify({ schema: 'agentmux.goal-delegation-attention-owner.v1', scenario,
    proofBoundary: 'Actual event owner and Demand persistence; Runtime, native completion, input cursor and Core observation are explicit isolated ports. Does not prove installed Native input or GUI consumption.', proof }, null, 2) + '\n')
}
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'goal-attention-owner-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root: join(root, 'goals') })
  await demands.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', assigneeSessionIds: ['owner', 'worker', 'next-owner'], supervisorSessionId: 'owner' })
  await demands.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Original result' }], openQuestions: [] })
  await demands.prepareDelegation('goal', task, 'owner'); await demands.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
  const pending = new Set<Promise<unknown>>()
  const track = <T,>(promise: Promise<T>): Promise<T> => {
    pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise
  }
  // Drain actual public owner work, including filesystem awaits; waiting only for
  // the Core read would let negative assertions race the remaining input job.
  for (const method of ['snapshot', 'get', 'inspectDelegation', 'prepareDelegationAttention', 'markDelegationAttentionAttempt'] as const) {
    const original = demands[method].bind(demands)
    vi.spyOn(demands, method).mockImplementation(((...args: unknown[]) => track((original as (...values: unknown[]) => Promise<unknown>)(...args))) as never)
  }
  let releaseNative: (() => void) | undefined, nativeBarrier: Promise<void> | undefined, admissionSignal: AbortSignal | undefined
  const holdNative = () => { nativeBarrier = new Promise<void>(resolve => { releaseNative = resolve }) }
  const release = () => { releaseNative?.(); releaseNative = undefined; nativeBarrier = undefined }
  const state = { mode: 'idle' as Mode, workerRun: 'running' as AgentMuxRun['state'] | undefined, supervisorRun: 'owner-run', receiptConfirmed: false, submitUnknown: false, stopCalls: 0, draftText: '' }
  const notes = new Map<string, DemandDelegationAttention>(), receipts = new Map<string, unknown>()
  let listener: ((hostId: string, event: AgentMuxClientEvent) => void) | undefined
  let inputListener: ((control: { kind: 'agent'; hostId: string; agentSessionId: string; run: { runId: string } }) => void) | undefined
  const creation = (id: string) => ({ kind: 'agent' as const, agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: id === 'owner' ? state.supervisorRun : id + '-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100) })
  const actualInputs: Array<{ operationId: string; supervisorSessionId: string; supervisorRunId: string; note: string }> = []
  const runtime = {
    agentCreation: vi.fn(async (_hostId: string, id: string) => creation(id)),
    observeOriginalRun: vi.fn(async (_hostId: string, runId: string) => ({ runId, state: state.workerRun ?? 'running' })),
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
      const saved = (await demands.inspectDelegation('goal', task.operationId))!.attention!
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
  for (const method of ['agentCreation', 'observeOriginalRun', 'saveGoalAttention', 'inspectGoalAttention', 'observeContinuousProgress', 'submitPrompt'] as const) {
    const original = runtime[method].getMockImplementation()!
    runtime[method].mockImplementation(((...args: unknown[]) => track((original as (...values: unknown[]) => Promise<unknown>)(...args))) as never)
  }
  const readOwner = { observeDelegation: vi.fn(async () => track((async () => {
    await demands.get('goal')
    return { operationId: task.operationId, ...(state.workerRun ? { workerRun: { runId: task.workerRunId, state: state.workerRun } }
      : { unknown: 'Original Run observation is unavailable.' }) }
  })())) }
  const changed = vi.fn()
  const createOwner = () => {
    const owner = new GoalDelegationAttentionOwner(demands, runtime as unknown as ConstructorParameters<typeof GoalDelegationAttentionOwner>[1], readOwner as unknown as GoalDelegationOwner, changed)
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
  const proof = async () => ({ goal: await demands.get('goal'), actualInputs, notes: [...notes.values()], runtimeCalls: { read: readOwner.observeDelegation.mock.calls.length,
    agentCreation: runtime.agentCreation.mock.calls.length, save: runtime.saveGoalAttention.mock.calls.length, observe: runtime.observeContinuousProgress.mock.calls.length,
    submit: runtime.submitPrompt.mock.calls.length, inspect: runtime.inspectGoalAttention.mock.calls.length, stop: runtime.stop.mock.calls.length } })
  return { root, demands, owner, createOwner, runtime, readOwner, state, actualInputs, notes, receipts, changed, emit, nativeCompletion, idle, proof, holdNative, release, inputOccupation, admissionSignal: () => admissionSignal }
}

describe('event-driven original Goal responsibility notice', () => {
  it.each(['exited', 'interrupted'] as const)('reacts to an exact %s worker Run with one frozen platform note and one eligible Supervisor input', async ended => {
    const f = await fixture(); f.state.receiptConfirmed = true
    await f.owner.start(); await f.idle()
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    f.state.workerRun = ended; f.emit(processEvent(task.workerRunId, ended))
    await vi.waitFor(() => expect(f.actualInputs).toHaveLength(1))
    expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
    const saved = (await f.demands.inspectDelegation('goal', task.operationId))!
    expect(saved.attention).toMatchObject({ hostId: 'local', supervisorAgentSessionId: 'owner', supervisorRunId: 'owner-run' })
    const note = JSON.parse(saved.attention!.agentMuxNote)
    expect(note).toMatchObject({ schema: 'agentmux.goal-attention.v1', goalId: 'goal', sourceMessageId: task.sourceMessageId, workerRunId: task.workerRunId })
    expect(f.actualInputs, JSON.stringify(await f.owner.observe('goal', saved))).toHaveLength(1)
    expect((await f.owner.observe('goal', saved))!.state).toBe('confirmed')
    expect((await f.demands.get('goal'))!).toMatchObject({ status: 'in_progress', supervisorSessionId: 'owner', alignment: { confirmedAt: null } })
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('ended-' + ended, await f.proof())
  })

  it.each(['busy', 'draft', 'unknown'] as const)('defers for %s input facts and tries once only after the original Supervisor native completion', async mode => {
    const f = await fixture(); f.state.mode = mode
    await f.owner.start(); await f.idle()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalled())
    const saved = (await f.demands.inspectDelegation('goal', task.operationId))!
    expect(saved.attention).toBeDefined()
    expect(saved.attention!.attemptedAt).toBeUndefined()
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    expect((await f.owner.observe('goal', saved))!.state).toBe('prepared')
    f.state.mode = 'idle'; f.nativeCompletion()
    await vi.waitFor(() => expect(f.actualInputs).toHaveLength(1))
    expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
    for (let count = 0; count < 4; count++) f.nativeCompletion()
    await f.idle()
    expect(f.actualInputs).toHaveLength(1)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('deferred-' + mode, await f.proof())
  })

  it('does not submit another original notice after repeated events, an unknown receipt or event-owner restart', async () => {
    const f = await fixture(); f.state.submitUnknown = true
    await f.owner.start(); await f.idle(); f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.actualInputs).toHaveLength(1))
    const saved = (await f.demands.inspectDelegation('goal', task.operationId))!
    for (let count = 0; count < 5; count++) f.emit(processEvent(task.workerRunId, 'exited'))
    await f.idle(); expect(f.actualInputs).toHaveLength(1)
    f.owner.dispose(); const restarted = f.createOwner(); await restarted.start(); await f.idle()
    expect(await f.demands.inspectDelegation('goal', task.operationId)).toEqual(saved)
    expect((await restarted.observe('goal', saved))!.state).toBe('unknown')
    expect(f.runtime.inspectGoalAttention).toHaveBeenCalledWith(saved.attention)
    expect(f.actualInputs).toHaveLength(1)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('unknown-receipt-restart-no-replay', await f.proof())
  })

  it('retains the original attempted reference after marker fsync uncertainty and never sends or retries its unconfirmed input', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle()
    const originalMark = f.demands.markDelegationAttentionAttempt.bind(f.demands), originalOpen = fs.open.bind(fs)
    let injected = 0
    vi.spyOn(f.demands, 'markDelegationAttentionAttempt').mockImplementationOnce(async (...args) => {
      const fault = vi.spyOn(fs, 'open').mockImplementation(async (...openArgs: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...openArgs)
        if (openArgs[0] === f.demands.root && injected === 0) { injected++; vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('isolated attempt marker EIO'), { code: 'EIO' })) }
        return handle
      })
      try { return await originalMark(...args) } finally { fault.mockRestore() }
    })
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalled())
    expect(injected).toBe(1)
    const saved = (await f.demands.inspectDelegation('goal', task.operationId))!
    expect(saved.attention!.attemptedAt).toBeGreaterThan(0)
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    f.emit(processEvent(task.workerRunId, 'exited')); f.nativeCompletion(); await f.idle()
    expect((await f.owner.observe('goal', saved))!.state).toBe('unknown')
    expect(await f.demands.inspectDelegation('goal', task.operationId)).toEqual(saved)
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('attempt-marker-replaced-receipt-unknown', await f.proof())
  })

  it.each(['collected', 'handoff'] as const)('stops stale input when the original Goal is %s before a deferred notice attempt', async change => {
    const f = await fixture(); f.state.mode = 'busy'
    await f.owner.start(); await f.idle(); f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalled())
    const original = (await f.demands.inspectDelegation('goal', task.operationId))!.attention!
    if (change === 'handoff') await f.demands.update('goal', { supervisorSessionId: 'next-owner' })
    else {
      await f.demands.submitDelegationReport('goal', task.operationId, { operationId: 'report', replyMessageId: 'reply', authorAgentSessionId: 'worker',
        grounding: { alignmentRevision: 1, summary: 'Result', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['evidence/result.log:7'], note: '' }] } }, 'worker')
      await f.demands.collectDelegationReport('goal', task.operationId, { operationId: 'collect', replyMessageId: 'reply' }, { kind: 'agent', id: 'owner' })
    }
    f.state.mode = 'idle'; f.nativeCompletion(); f.emit(processEvent(task.workerRunId, 'exited')); await f.idle()
    expect((await f.demands.inspectDelegation('goal', task.operationId))!.attention).toEqual(original)
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('stale-input-' + change, await f.proof())
  })

  it.each(['collected', 'handoff'] as const)('cancels the original reminder when responsibility is %s after Main checks but before the Native input claim', async change => {
    const f = await fixture(); await f.owner.start(); await f.idle(); f.holdNative()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.admissionSignal()).toBeDefined())
    const original = (await f.demands.inspectDelegation('goal', task.operationId))!.attention!
    expect(original.attemptedAt).toBeGreaterThan(0)
    expect(f.actualInputs).toEqual([])
    if (change === 'handoff') await f.demands.update('goal', { supervisorSessionId: 'next-owner' })
    else {
      await f.demands.submitDelegationReport('goal', task.operationId, { operationId: 'report', replyMessageId: 'reply', authorAgentSessionId: 'worker',
        grounding: { alignmentRevision: 1, summary: 'Result', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['evidence/result.log:7'], note: '' }] } }, 'worker')
      await f.demands.collectDelegationReport('goal', task.operationId, { operationId: 'collect', replyMessageId: 'reply' }, { kind: 'agent', id: 'owner' })
    }
    expect(f.admissionSignal()!.aborted).toBe(true)
    f.release(); await f.idle()
    expect(f.actualInputs).toEqual([])
    expect((await f.demands.inspectDelegation('goal', task.operationId))!.attention).toEqual(original)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('preclaim-cancel-' + change, { ...await f.proof(), originalSignalAborted: f.admissionSignal()!.aborted })
  })

  it('cancels only the exact Supervisor reminder before the Native claim when a trusted GUI draft occupation event arrives, retaining its user text', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle(); f.holdNative()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.admissionSignal()).toBeDefined())
    const original = (await f.demands.inspectDelegation('goal', task.operationId))!.attention!
    f.inputOccupation({ kind: 'agent', hostId: 'other-host', agentSessionId: 'owner', run: { runId: 'owner-run' } })
    f.inputOccupation({ kind: 'agent', hostId: 'local', agentSessionId: 'another-agent', run: { runId: 'owner-run' } })
    f.inputOccupation({ kind: 'agent', hostId: 'local', agentSessionId: 'owner', run: { runId: 'another-run' } })
    expect(f.admissionSignal()!.aborted).toBe(false)
    f.state.mode = 'draft'; f.state.draftText = 'Original human draft, retained verbatim.\n'
    f.inputOccupation()
    expect(f.admissionSignal()!.aborted).toBe(true)
    f.release(); await f.idle()
    expect(f.actualInputs).toEqual([])
    expect(f.state.draftText).toBe('Original human draft, retained verbatim.\n')
    expect((await f.demands.inspectDelegation('goal', task.operationId))!.attention).toEqual(original)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('preclaim-gui-draft-keeps-user-text', { ...await f.proof(), draftText: f.state.draftText, originalSignalAborted: f.admissionSignal()!.aborted })
  })

  it('keeps the original reminder eligible when another delegation in the same Goal changes before its Native claim', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle(); f.holdNative()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.admissionSignal()).toBeDefined())
    const original = (await f.demands.inspectDelegation('goal', task.operationId))!.attention!
    const other = { ...task, operationId: 'other-delegation', sourceMessageId: 'other-source', threadId: 'other-thread', text: 'Another task' }
    await f.demands.prepareDelegation('goal', other, 'owner')
    expect(f.admissionSignal()!.aborted).toBe(false)
    f.release(); await f.idle()
    expect(f.actualInputs).toHaveLength(1)
    expect(f.actualInputs[0]).toMatchObject({ operationId: original.operationId, supervisorSessionId: 'owner', supervisorRunId: 'owner-run' })
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('same-goal-other-delegation-keeps-input', await f.proof())
  })

  it('performs no new related observation or input for one hundred unrelated Session/Run events', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle()
    const goalReads = vi.mocked(f.demands.get); goalReads.mockClear()
    const baseline = { goalRead: f.readOwner.observeDelegation.mock.calls.length, agent: f.runtime.agentCreation.mock.calls.length, input: f.actualInputs.length, progress: f.runtime.observeContinuousProgress.mock.calls.length }
    for (let index = 0; index < 100; index++) {
      f.emit(processEvent('unrelated-run-' + index, 'exited'))
      f.emit({ type: 'agent-session', session: { agentSessionId: 'unrelated-session-' + index } } as AgentMuxClientEvent)
    }
    await f.idle()
    expect(goalReads).not.toHaveBeenCalled()
    expect({ goalRead: f.readOwner.observeDelegation.mock.calls.length, agent: f.runtime.agentCreation.mock.calls.length, input: f.actualInputs.length, progress: f.runtime.observeContinuousProgress.mock.calls.length }).toEqual(baseline)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('unrelated-session-events-no-work', await f.proof())
  })

  it('exposes an exact reminder preparation failure before a reference exists and keeps the original event handling recoverable', async () => {
    const f = await fixture(); await f.owner.start(); await f.idle()
    f.runtime.agentCreation.mockRejectedValueOnce(new Error('Original Supervisor metadata observation is unconfirmed.'))
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited')); await f.idle()
    const original = (await f.demands.inspectDelegation('goal', task.operationId))!
    expect(original.attention).toBeUndefined()
    expect(f.actualInputs).toEqual([])
    await expect(f.owner.observe('goal', original)).rejects.toThrow('Original Supervisor metadata observation is unconfirmed.')
    expect(f.runtime.observeCoreEvents).toHaveBeenCalledOnce()
    expect(f.runtime.stop).not.toHaveBeenCalled()
    f.nativeCompletion(); await f.idle()
    expect(f.actualInputs).toHaveLength(1)
    expect((await f.demands.inspectDelegation('goal', task.operationId))!).toMatchObject({ ...task,
      attention: { hostId: 'local', supervisorAgentSessionId: 'owner', supervisorRunId: 'owner-run' } })
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('preparation-observation-failed-before-reference', await f.proof())
  })

  it('registers healthy event handling despite an initial Goal read failure and recovers on actual business facts', async () => {
    const f = await fixture(), fault = vi.spyOn(f.demands, 'snapshot').mockRejectedValueOnce(new Error('Original Goal observation failed'))
    await expect(f.owner.start()).resolves.toBeUndefined()
    expect(f.runtime.observeCoreEvents).toHaveBeenCalledOnce()
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    const saved = (await f.demands.inspectDelegation('goal', task.operationId))!
    await expect(f.owner.observe('goal', saved)).rejects.toThrow(/Goal responsibilities failed/u)
    fault.mockRestore(); await f.demands.update('goal', { title: 'Original Goal, edited' }); await f.idle()
    f.state.workerRun = undefined; f.emit(processEvent(task.workerRunId, 'running')); await f.idle()
    expect((await f.demands.inspectDelegation('goal', task.operationId))!.attention).toBeUndefined()
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    f.state.workerRun = 'exited'; f.emit(processEvent(task.workerRunId, 'exited'))
    await vi.waitFor(() => expect(f.actualInputs).toHaveLength(1))
    expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
    expect(f.runtime.stop).not.toHaveBeenCalled()
    await record('initial-goal-read-failed-healthy-registration', await f.proof())
  })
})
