import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, observeAgent, type AgentMuxClientEvent, type AgentMuxAgentRuntimeStatus, type AgentPromptSubmissionRecord } from '@agentmux/core'
import { demandExecutionReferences, demandResponsibilityScope, openDemandStore } from '@agentmux/demand'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import type { GoalDelegationAuthority, GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { GoalPatrolOwner } from '@agentmux/host/goal-patrol-owner'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks() })
const person: GoalDelegationAuthority = { actor: { kind: 'user', id: 'person' } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-patrol-owner-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root })
  await demands.create({ id: 'goal', title: 'Original work', status: 'in_progress', supervisorSessionId: 'manager', assigneeSessionIds: ['manager', 'worker'] })
  await demands.proposeAlignment('goal', { summary: 'Original target', criteria: [{ id: 'AC', text: 'Original evidence' }], openQuestions: [] })
  await demands.prepareDispatch('goal', { operationId: 'start', agentSessionId: 'worker', hostId: 'worker-host', runId: 'worker-run', prompt: 'Original task', execution: 'finite' })
  await demands.recordDispatchPhase('goal', 'start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:start', createdAt: Date.now() } })
  const state = { mode: 'idle', runId: 'manager-run', lost: false, unavailable: false }
  const notes = new Map<string, { operationId: string; intentId: string; agentMuxNote: string }>(), receipts = new Map<string, AgentPromptSubmissionRecord>(), submitted: string[] = []
  const semantic = (id = 'manager') => ({ state: state.mode === 'busy' ? 'working' as const : 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() - 90_000, currentActivityRevision: 3 })
  const session = (id = 'manager') => ({ kind: 'agent' as const, agentSessionId: id, providerId: 'codex', executorId: 'fixture', hostId: id === 'manager' ? 'manager-host' : 'worker-host', workspacePath: root,
    run: { runId: id === 'manager' ? state.runId : 'worker-run' }, retiredRuns: [], createdAt: Date.now() - 100_000, updatedAt: Date.now(), semanticStatus: semantic(id) })
  const status = (id = 'manager') => { const original = session(id); return { session: original, run: { ...original.run, state: 'running' }, capabilities: { timeline: 'complete-events' },
    observation: observeAgent({ process: 'running', status: original.semanticStatus, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, Date.now()) } as unknown as AgentMuxAgentRuntimeStatus }
  let listener: ((host: string, event: AgentMuxClientEvent) => void) | undefined
  const runtime = {
    resolveGoalAgent: vi.fn(async () => { if (state.unavailable) throw new AgentMuxError('Original route unavailable.', 'CONTROL_UNAVAILABLE'); return { hostId: 'manager-host', status: status() } }),
    observeGoalAgent: vi.fn(async (_host, id) => status(id)),
    observeCoreEvents: vi.fn((_types, consume) => { listener = consume; return () => { listener = undefined } }), observeInputOccupation: vi.fn(() => () => {}),
    saveGoalAttention: vi.fn(async note => { if (note.supervisorRunId !== state.runId) throw new AgentMuxError('Original Run changed.', 'STALE_AGENT_SESSION'); notes.set(note.intentId, note) }),
    disableGoalAttention: vi.fn(async note => { notes.delete(note.intentId) }), inspectGoalAttention: vi.fn(async note => receipts.get(note.operationId) ?? null),
    observeContinuousProgress: vi.fn(async (target, tickId, now) => { const original = session(), note = notes.get(target.futureIntentId!)
      return { session: { ...original, futurePromptIntents: note ? { [note.intentId]: { operationId: note.operationId, prompt: '', active: true, message: { systemContext: note.agentMuxNote } } } : {} },
        observation: status().observation, now, tickId, inputByte: 0, inputOccupied: state.mode === 'draft' } }),
    submitPrompt: vi.fn(async (control, prompt, operationId, _condition, automation, _choice, authorHuman, note) => {
      const original = (await demands.get('goal'))!.patrols![0]!.attempts.at(-1)!
      expect(original.attemptedAt).toBeGreaterThan(0); expect(original.operationId).toBe(operationId); expect(automation!.isCurrent()).toBe(true)
      expect(control.hostId).toBe('manager-host'); expect(prompt).toBe(''); expect(authorHuman).toBeUndefined(); expect(note).toBe(original.agentMuxNote)
      submitted.push(operationId); if (state.lost) throw new AgentMuxError('Original Native input receipt lost.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      receipts.set(operationId, { agentSessionId: 'manager', run: { runId: state.runId }, admission: { operationId, submissionId: operationId, acknowledged: true, startByte: 0, endByte: Buffer.byteLength(original.agentMuxNote),
        inputKey: { kind: 'prompt', agentSessionId: 'manager', expectedRun: { runId: state.runId }, submissionId: operationId },
        intent: { run: { runId: state.runId }, ownerInstanceId: 'fixture', prompt: '', plan: { kind: 'single-phase', data: original.agentMuxNote }, message: { systemContext: original.agentMuxNote } } } })
    })
  } satisfies ConstructorParameters<typeof GoalPatrolOwner>[1]
  const read = vi.fn(async (): Promise<GoalDelegationResult> => { const goal = (await demands.get('goal'))!
    return { goalId: goal.id, goalUpdatedAt: goal.updatedAt, delegations: goal.delegations ?? [], dispatches: goal.dispatches ?? [], diskDurability: 'confirmed' } })
  const changed = vi.fn()
  const create = () => { const owner = new GoalPatrolOwner(demands, runtime, read, changed)
    cleanup.push(async () => { owner.dispose(); await Promise.allSettled([...(owner as unknown as { flights: Map<string, Promise<void>> }).flights.values()]) }); return owner }
  const owner = create(); await owner.start()
  const settle = async () => { await Promise.allSettled([...(owner as unknown as { flights: Map<string, Promise<void>> }).flights.values()]); await new Promise(resolve => setImmediate(resolve)) }
  return { root, demands, state, runtime, submitted, receipts, notes, read, changed, owner, create, settle, emit: (event: AgentMuxClientEvent) => listener!('manager-host', event) }
}
it('one click admits real original PMO input once; delivery alone does not change business responsibility', async () => {
  const f = await fixture(); await Promise.all([f.owner.request('goal', 'patrol', {}, person), f.owner.request('goal', 'other-click', {}, person)]); await f.settle()
  const goal = (await f.demands.get('goal'))!
  expect(goal.patrols).toHaveLength(1); expect(f.submitted).toHaveLength(1)
  expect(await f.owner.observe(goal)).toMatchObject([{ state: 'delivered' }]); expect(goal.progressUpdates).toBeUndefined(); expect(goal.status).toBe('in_progress')
  expect(goal.patrols![0]!.attempts[0]!.target).toMatchObject({ hostId: 'manager-host', agentSessionId: 'manager', runId: 'manager-run' })
  const patrol = goal.patrols![0]!, attempt = patrol.attempts[0]!, metadata = JSON.parse(attempt.agentMuxNote.split('\n')[0]!)
  expect(metadata).toMatchObject({ schema: 'agentmux.goal-patrol.v1', goalId: 'goal', patrolOperationId: patrol.operationId,
    inputOperationId: attempt.operationId, target: attempt.target, context: { alignmentRevision: 1, executions: [
      { kind: 'start', operationId: 'start', hostId: 'worker-host', agentSessionId: 'worker', runId: 'worker-run' }
    ] }, read: { method: 'goal.delegations', params: { goalId: 'goal' }, patrolOperationId: patrol.operationId } })
  expect(metadata).not.toHaveProperty('roleGuidance')
  expect(metadata.next).toBe('Read amux goal --skill and the retained original Goal/patrol/execution/input/evidence before inspection. Actually inspect progress, evidence, gaps and unknowns; use goal patrol report --input FILE to write back this patrol, current business status and next responsible party/action. Explicit review of an original stored worker report collects its exact authenticated reply atomically; do not collect separately before frozen-scope reporting. Delivery, acknowledgement and reminders are not inspection or acceptance. Retain original Goal/Session/Run and unknown inputs; never blindly resend. Human confirmation and acceptance remain human actions.')
  expect(attempt.agentMuxNote).toBe(JSON.stringify(metadata) + '\n\n' + goalRoleGuidance({ role: 'manager', goalId: 'goal',
    agentSessionId: 'manager', runId: 'manager-run', source: { kind: 'goal-patrol', operationId: patrol.operationId } }))
})
it('busy and occupied PMO input remain prepared, then the actual agent-input protocol event admits the same input', async () => {
  const f = await fixture(); f.state.mode = 'draft'; await f.owner.request('goal', 'patrol', {}, person); await f.settle()
  expect(f.submitted).toEqual([]); const before = (await f.demands.get('goal'))!.patrols![0]!
  expect(before.attempts[0]!.attemptedAt).toBeUndefined()
  f.state.mode = 'idle'; f.emit({ type: 'agent-input', receipt: { ref: { key: { kind: 'prompt', agentSessionId: 'manager', expectedRun: { runId: 'manager-run' }, submissionId: 'prior-human-input' } } } } as AgentMuxClientEvent)
  await vi.waitFor(() => expect(f.submitted).toEqual([before.attempts[0]!.operationId]))
})
it('lost input receipts, repeated clicks and a restarted observer never replay an attempted input', async () => {
  const f = await fixture(); f.state.lost = true; await f.owner.request('goal', 'patrol', {}, person); await f.settle()
  expect(f.submitted).toHaveLength(1); f.owner.dispose(); const restarted = f.create(); await restarted.start()
  await restarted.request('goal', 'patrol', {}, person)
  expect(f.submitted).toHaveLength(1); expect(await restarted.observe((await f.demands.get('goal'))!)).toMatchObject([{ state: 'unknown' }])
  f.state.runId = 'recovered-manager-run'
  await expect(restarted.continue('goal', 'patrol', 'continue', f.state.runId, {}, person)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(f.runtime.disableGoalAttention).not.toHaveBeenCalled()
})
it('submits a saved original patrol packet verbatim and keeps its unknown receipt across owner restart', async () => {
  const f = await fixture(); f.state.mode = 'draft'; f.state.lost = true
  const goal = (await f.demands.get('goal'))!, target = { hostId: 'manager-host', agentSessionId: 'manager',
    runId: 'manager-run', providerId: 'codex', workspacePath: f.root }
  const agentMuxNote = JSON.stringify({ schema: 'agentmux.goal-patrol.v1', goalId: 'goal', patrolOperationId: 'patrol',
    roleGuidance: 'Saved original manager guidance\nwith an original line break', target }) + '\r\n  '
  await f.demands.preparePatrol('goal', { operationId: 'patrol', expectedScope: demandResponsibilityScope(goal),
    executions: demandExecutionReferences(goal), supervisorAgentSessionId: 'manager', context: 'Original retained inspection context',
    requestedBy: person.actor, attempt: { operationId: 'original-patrol-input', actionOperationId: 'patrol', intentId: 'original-patrol-input', target, agentMuxNote } })
  await f.settle(); expect(f.submitted).toEqual([])
  f.state.mode = 'idle'; await f.owner.request('goal', 'patrol', {}, person); await f.settle()
  expect(f.submitted).toEqual(['original-patrol-input'])
  expect(f.runtime.submitPrompt).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'manager', run: { runId: 'manager-run' } }),
    '', 'original-patrol-input', expect.anything(), expect.anything(), undefined, undefined, agentMuxNote, 'api')
  const original = (await f.demands.get('goal'))!.patrols![0]!
  expect(original.attempts[0]!.agentMuxNote).toBe(agentMuxNote)
  f.owner.dispose(); const restarted = f.create(); await restarted.start(); await restarted.request('goal', 'patrol', {}, person); await f.settle()
  expect(f.submitted).toEqual(['original-patrol-input'])
  expect((await f.demands.get('goal'))!.patrols![0]).toEqual(original)
  expect(await restarted.observe((await f.demands.get('goal'))!)).toMatchObject([{ state: 'unknown' }])
})
it('an unavailable original manager route can bind its first attempt; wrong authors cannot cancel pending work', async () => {
  const f = await fixture(); f.state.unavailable = true; await f.owner.request('goal', 'patrol', {}, person)
  expect((await f.demands.get('goal'))!.patrols![0]!.attempts).toEqual([])
  await expect(f.owner.continue('goal', 'patrol', 'wrong', 'manager-run', {}, { actor: { kind: 'agent', id: 'stranger' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.runtime.disableGoalAttention).not.toHaveBeenCalled()
  f.state.unavailable = false; await f.owner.continue('goal', 'patrol', 'bind-first', 'manager-run', {}, person)
  expect(f.submitted).toHaveLength(1)
  await f.owner.continue('goal', 'patrol', 'bind-first', 'manager-run', {}, person); expect(f.submitted).toHaveLength(1)
  await expect(f.owner.continue('goal', 'patrol', 'bind-first', 'different-run', {}, person)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
})
it('explicit recovered-Session continuation disables the old intent and preserves both immutable original inputs', async () => {
  const f = await fixture(); f.state.mode = 'busy'; await f.owner.request('goal', 'patrol', {}, person); await f.settle()
  f.state.runId = 'recovered-manager-run'; f.state.mode = 'idle'
  await f.owner.continue('goal', 'patrol', 'continue', f.state.runId, {}, person)
  const attempts = (await f.demands.get('goal'))!.patrols![0]!.attempts
  expect(attempts).toHaveLength(2); expect(attempts[0]!.supersededAt).toBeGreaterThan(0); expect(attempts[0]!.attemptedAt).toBeUndefined()
  expect(f.runtime.disableGoalAttention).toHaveBeenCalledOnce(); expect(f.submitted).toEqual([attempts[1]!.operationId])
  await f.owner.continue('goal', 'patrol', 'continue', f.state.runId, {}, person); expect(f.submitted).toHaveLength(1)
})
it('valid large original tasks use source references instead of copying task bodies into the bounded PMO input', async () => {
  const f = await fixture()
  for (const id of ['a', 'b']) { const task = { operationId: id, sourceMessageId: 'source-' + id, hostId: 'worker-host', ownerAgentSessionId: 'manager', ownerRunId: 'manager-run', workerAgentSessionId: 'worker', workerRunId: 'worker-run', threadId: 'thread-' + id,
    text: 'x'.repeat(40_000), alignmentRevision: 1, criterionIds: ['AC'] }
    await f.demands.prepareDelegation('goal', task, 'manager'); await f.demands.linkDelegation('goal', id, task.sourceMessageId, 'manager') }
  await f.owner.request('goal', 'patrol', {}, person)
  const note = (await f.demands.get('goal'))!.patrols![0]!.attempts[0]!.agentMuxNote
  expect(Buffer.byteLength(note)).toBeLessThan(64 * 1024); expect(note).not.toContain('x'.repeat(100)); expect(JSON.parse(note.split('\n')[0]!).read).toMatchObject({ method: 'goal.delegations', params: { goalId: 'goal' } })
})

it('retains typed original file evidence once in the frozen inspection and actual PMO input', async () => {
  const f = await fixture()
  const evidence = { kind: 'file' as const, resource: { hostId: 'worker-host', workspaceId: 'original-worktree', workspacePath: f.root, zoneId: 'original-zone', zonePath: f.root, path: 'result.log' }, revision: 'sha256:' + 'a'.repeat(64) }
  await f.demands.proposeGrounding('goal', { alignmentRevision: 1, summary: 'Original result', checks: [{ criterionId: 'AC', outcome: 'met', evidence: [evidence, structuredClone(evidence), 'Original citation'], note: '' }] })
  await f.owner.request('goal', 'patrol', {}, person); await f.settle()
  const patrol = (await f.demands.get('goal'))!.patrols![0]!
  expect(JSON.parse(patrol.context).evidence).toEqual([evidence, 'Original citation'])
  expect(JSON.parse(patrol.attempts[0]!.agentMuxNote.split('\n')[0]!).context.evidence).toEqual([evidence, 'Original citation'])
  expect(f.submitted).toHaveLength(1)
})
