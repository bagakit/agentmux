import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxError, AgentMuxFileAgentSessionStore, AgentMuxRpcService,
  hashAgentCapability, issueAgentCapability, type AgentMuxRun } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import type { DemandDelegationIntent, DemandDelegationReportInput } from '@agentmux/demand/delegations'
import { GoalDelegationOwner, type GoalDelegationCorePort } from '../src/main/goal-delegation-owner'

const execute = promisify(execFile), cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) { try { await dispose() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private Goal delegation cleanup failed')
})

function task(worker = 'worker-a', criterionIds = ['AC-01']): DemandDelegationIntent {
  return { operationId: `delegate-${worker}`, sourceMessageId: `source-${worker}`, hostId: 'local', ownerAgentSessionId: 'owner', workerAgentSessionId: worker,
    ownerRunId: 'owner-run', workerRunId: `${worker}-run`, threadId: `thread-${worker}`, text: ` Original task for ${worker}\nkeep all whitespace `,
    alignmentRevision: 1, criterionIds }
}
function result(task: DemandDelegationIntent, outcome: 'met' | 'gap' | 'unknown' = 'met'): DemandDelegationReportInput {
  return { operationId: `report-${task.workerAgentSessionId}`, replyMessageId: `reply-${task.workerAgentSessionId}`, authorAgentSessionId: task.workerAgentSessionId,
    grounding: { alignmentRevision: task.alignmentRevision, summary: `Worker result ${task.workerAgentSessionId}`,
      checks: task.criterionIds.map(criterionId => ({ criterionId, outcome, evidence: [`evidence/${task.workerAgentSessionId}.log:7`], note: outcome === 'gap' ? 'Remaining original work' : '' })) } }
}
async function record(scenario: string, proof: unknown) {
  const directory = process.env.AGENTMUX_GOAL_DELEGATION_FLOW_RECEIPT_DIR
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(join(directory, `${scenario}.json`), JSON.stringify({ schema: 'agentmux.goal-delegation-main-flow.v1', scenario,
    proofBoundary: 'Actual compiled CLI, Unix RPC, Main and persisted Core/Demand owners; Native input and Run observations are explicit isolated fixtures. Does not prove live independent Agent or Renderer recovery.', proof }, null, 2) + '\n')
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'goal-delegation-flow-'))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const receiptDirectory = process.env.AGENTMUX_GOAL_DELEGATION_FLOW_RECEIPT_DIR
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'AGENTMUX_GOAL_DELEGATION_FLOW_RECEIPT_DIR') vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.sqlite'))
  if (receiptDirectory) vi.stubEnv('AGENTMUX_GOAL_DELEGATION_FLOW_RECEIPT_DIR', receiptDirectory)
  const sessions = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), credentials = new Map<string, string>()
  for (const id of ['owner', 'worker-a', 'worker-b', 'stranger', 'next-owner']) {
    const capability = issueAgentCapability(); credentials.set(id, capability)
    await sessions.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
      run: { runId: id + '-run' }, retiredRuns: [], hookBindingId: 'binding-' + id, hookToken: 'fixture-token-' + id,
      capabilityHash: hashAgentCapability(capability), createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100) })
  }
  const client = new AgentMuxClient({ store: sessions })
  const inner = client as unknown as { connected: boolean; kernel: { isConnected(): boolean; stop: unknown }; registry: { load(hostId: string): Promise<void> } }
  inner.connected = true; inner.kernel.isConnected = () => true; await inner.registry.load('local')
  cleanup.push(() => client.dispose())
  const stop = vi.fn(); inner.kernel.stop = stop
  const inputs: Array<{ operationId: string; messageId: string; recipientSessionId: string; body: string }> = []
  const loseNativeReceipt = new Set<string>()
  // The only substituted input boundary is Native transport. Core author admission,
  // frozen message identity, delivery journal and dispatch facts stay real.
  const native = vi.spyOn(client, 'submitAgentMessage').mockImplementation(async input => {
    inputs.push({ operationId: input.envelope.operationId, messageId: input.envelope.messageId,
      recipientSessionId: input.agentSessionId, body: input.envelope.body })
    if (loseNativeReceipt.delete(input.envelope.operationId)) throw new AgentMuxError('The isolated Native input receipt was lost after journal save.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  })
  const demands = openDemandStore({ root: join(root, 'goals') })
  await demands.create({ id: 'goal', title: 'Original Goal', description: 'Original human intent\nkept verbatim', status: 'in_progress',
    assigneeSessionIds: ['owner', 'worker-a', 'worker-b'], supervisorSessionId: 'owner' })
  await demands.proposeAlignment('goal', { summary: 'Original target', criteria: [{ id: 'AC-01', text: 'First result' }, { id: 'AC-02', text: 'Second result' }], openQuestions: [] })
  const core = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }] })
  const runStates = new Map<string, AgentMuxRun['state']>(['owner', 'worker-a', 'worker-b'].map(id => [id + '-run', 'running']))
  const readUnavailable = new Set<string>(), runUnavailable = new Set<string>(), beforeCall = new Map<string, () => Promise<void>>(), trace: Array<{ method: string; operationId?: string; sourceMessageId?: string }> = []
  const port: GoalDelegationCorePort = {
    call: async (hostId, method, params, context) => {
      expect(hostId).toBe('local')
      const input = params as unknown as { operationId?: string; sourceMessageId?: string }
      trace.push({ method, ...input.operationId ? { operationId: input.operationId } : {}, ...input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {} })
      if (readUnavailable.delete(method + ':' + (input.operationId ?? input.sourceMessageId))) throw new AgentMuxError('The original isolated Core observation is unavailable.', 'CONTROL_UNAVAILABLE')
      const pending = beforeCall.get(method + ':' + (input.operationId ?? input.sourceMessageId))
      if (pending) { beforeCall.delete(method + ':' + (input.operationId ?? input.sourceMessageId)); await pending() }
      return await core.call(method, params, context)
    },
    readDispatch: async (hostId, sourceMessageId) => {
      expect(hostId).toBe('local'); trace.push({ method: 'trustedSDK.readDispatch', sourceMessageId })
      return { ...await client.readDispatch({ sourceMessageId }), hostId }
    },
    observeRun: async (hostId, runId) => {
      expect(hostId).toBe('local')
      if (runUnavailable.has(runId)) throw new AgentMuxError('The original isolated Run observation is unavailable.', 'RUNTIME_UNAVAILABLE')
      const state = runStates.get(runId)
      if (!state) throw new AgentMuxError('The original fixture Run is absent.', 'RUN_NOT_FOUND')
      return { runId, state }
    }
  }
  const owner = new GoalDelegationOwner(demands, { agentCreation: async (_hostId, id) => (await sessions.readMetadata(id))! }, undefined, port)
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client }], goalDelegations: owner })
  await server.start(); cleanup.push(() => server.stop())
  let sequence = 0
  const cliReceipts: unknown[] = []
  async function cli(who: string, args: string[]) {
    try {
    const { stdout } = await execute(process.execPath, [resolve('packages/core/dist/agentmux.js'), '--endpoint', 'unix:' + server.path, ...args], {
      env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: who, AGENTMUX_AGENT_CAPABILITY: credentials.get(who)! }, maxBuffer: 4 * 1024 * 1024
    })
    const receipt = JSON.parse(stdout); cliReceipts.push({ actor: who, args, receipt }); return receipt
    } catch (error) {
      const failure = error as { code?: number; stderr?: string }
      cliReceipts.push({ actor: who, args, exitCode: failure.code, failureReceipt: failure.stderr ? JSON.parse(failure.stderr) : null }); throw error
    }
  }
  async function goal(who: string, action: 'prepare' | 'bind' | 'delegate' | 'report' | 'collect', input: unknown) {
    const path = join(root, `request-${++sequence}.json`); await fs.writeFile(path, JSON.stringify(input))
    return await cli(who, ['goal', ...action === 'prepare' || action === 'bind' ? ['delegation', action] : [action], '--input', path])
  }
  async function read() { return await cli('owner', ['goal', 'delegations', '--goal', 'goal']) }
  async function proof() { return { goal: await demands.get('goal'), inputs, trace, cliReceipts, stopCalls: stop.mock.calls.length } }
  return { root, demands, sessions, client, core, credentials, native, inputs, loseNativeReceipt, runStates, readUnavailable, runUnavailable, beforeCall, trace, stop, cli, goal, read, proof }
}

describe('actual Goal delegation CLI, Main and original Core collaboration', () => {
  it('returns two worker reports through original questions, dispatches and explicit collection without completing the Goal', async () => {
    const f = await fixture(), a = task(), b = task('worker-b', ['AC-02'])
    const prepared = (await f.goal('owner', 'prepare', { goalId: 'goal', intent: a })).result.delegations[0]
    expect(prepared.requestText).toBe(a.text)
    expect(JSON.parse(prepared.text.split('\n[AgentMux delegation]\n')[1])).toMatchObject({ schema: 'agentmux.goal-delegation.v1', goalId: 'goal',
      operationId: a.operationId, sourceMessageId: a.sourceMessageId, workerAgentSessionId: a.workerAgentSessionId, criterionIds: a.criterionIds })
    expect(f.inputs).toEqual([])
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a }); await f.goal('owner', 'delegate', { goalId: 'goal', intent: b })
    expect(f.inputs[0]!.body).toBe(prepared.text)
    expect((await f.demands.inspectDelegation('goal', a.operationId))!.preparedAt).toBe(prepared.preparedAt)
    expect(f.inputs.map(input => input.messageId)).toEqual([a.sourceMessageId, b.sourceMessageId])
    const frozen = (await f.demands.get('goal'))!.delegations!
    expect(frozen).toHaveLength(2)
    expect(f.inputs.map(input => input.body)).toEqual(frozen.map(delegation => delegation.text))
    expect(frozen.map(delegation => delegation.requestText)).toEqual([a.text, b.text])
    const question = await f.cli('worker-a', ['agent', 'send', '--to-session', 'owner', '--text', 'Which result should I retain?', '--message-id', 'question-a',
      '--operation-id', 'question-operation-a', '--thread', a.threadId, '--reply-to', a.sourceMessageId])
    expect(question.result.envelope.replyTo).toBe(a.sourceMessageId)
    await f.cli('worker-a', ['message', 'dispatch', 'report', '--source-message', a.sourceMessageId, '--reply-message', 'question-a', '--kind', 'question'])
    await f.cli('owner', ['agent', 'send', '--to-session', 'worker-a', '--text', 'Retain the original evidence for AC-01.', '--message-id', 'answer-a',
      '--operation-id', 'answer-operation-a', '--thread', a.threadId, '--reply-to', 'question-a'])
    const asked = await f.read()
    expect(asked.result.observations).toHaveLength(2)
    expect(asked.result.observations[0].communication.dispatch).toMatchObject({ sourceMessageId: a.sourceMessageId, originAwaits: true,
      events: [{ kind: 'question', replyMessageId: 'question-a' }] })
    expect((await f.demands.get('goal'))!.grounding).toBeUndefined()
    const ra = result(a), rb = result(b)
    await f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })
    await f.goal('worker-b', 'report', { goalId: 'goal', operationId: b.operationId, report: rb })
    const reported = await f.read()
    expect(reported.result.delegations).toHaveLength(2)
    expect(reported.result.delegations.map((entry: { report: DemandDelegationReportInput }) => entry.report.replyMessageId)).toEqual([ra.replyMessageId, rb.replyMessageId])
    expect(reported.result.observations.map((entry: { communication: { dispatch: { originAwaits: boolean } } }) => entry.communication.dispatch.originAwaits)).toEqual([false, false])
    expect(reported.result.grounding).toBeUndefined()
    const originalInputs = structuredClone(f.inputs)
    await f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })
    expect(f.inputs).toEqual(originalInputs)
    await f.goal('owner', 'collect', { goalId: 'goal', operationId: a.operationId, collection: { operationId: 'collect-a', replyMessageId: ra.replyMessageId } })
    const partial = await f.demands.get('goal')
    expect(partial!.grounding!.checks.map(check => check.outcome)).toEqual(['met', 'unknown'])
    await f.goal('owner', 'collect', { goalId: 'goal', operationId: b.operationId, collection: { operationId: 'collect-b', replyMessageId: rb.replyMessageId } })
    const collected = (await f.read()).result
    expect(collected.grounding.checks).toEqual([...ra.grounding.checks, ...rb.grounding.checks])
    expect(collected.grounding.acceptedAt).toBeNull()
    expect((await f.demands.get('goal'))!).toMatchObject({ status: 'in_progress', supervisorSessionId: 'owner', description: 'Original human intent\nkept verbatim', alignment: { confirmedAt: null } })
    expect(f.stop).not.toHaveBeenCalled()
    await record('two-worker-question-report-collection', await f.proof())
  }, 30_000)

  it('binds an existing original message after both participants advance Runs without rewriting or replaying input', async () => {
    const f = await fixture(), a = task()
    await f.cli('owner', ['agent', 'send', '--to-session', a.workerAgentSessionId, '--text', a.text,
      '--operation-id', a.operationId, '--message-id', a.sourceMessageId, '--thread', a.threadId, '--expect-run', a.workerRunId])
    const before = await f.client.readMessage({ operationId: a.operationId }), inputs = structuredClone(f.inputs)
    expect(before!.envelope.body).toBe(a.text)
    for (const id of ['owner', 'worker-a']) {
      const original = (await f.sessions.readMetadata(id))!
      await f.sessions.compareAndSwapMetadata(original, { ...original, run: { runId: id + '-next-run' }, retiredRuns: [...original.retiredRuns, original.run], updatedAt: _reshape_fixtureEpoch(0, 0, 200) })
    }
    const binding = f.goal('owner', 'bind', { goalId: 'goal', intent: a })
    await expect(binding).resolves.toMatchObject({ ok: true })
    const bound = (await binding).result.delegations[0]
    expect(bound).toMatchObject({ ...a, linkedAt: expect.any(Number) })
    expect(bound.requestText).toBeUndefined(); expect(f.inputs).toEqual(inputs)
    expect((await f.client.readMessage({ operationId: a.operationId }))!.envelope).toEqual(before!.envelope)
    await f.goal('owner', 'bind', { goalId: 'goal', intent: a }); expect(f.inputs).toEqual(inputs)
    expect(f.stop).not.toHaveBeenCalled()
    await record('existing-original-source-bound-with-retained-runs', await f.proof())
  }, 30_000)

  it('refuses absent, unreadable or altered original source bindings without creating input or claiming material adoption', async () => {
    const f = await fixture(), a = task()
    await expect(f.goal('owner', 'bind', { goalId: 'goal', intent: a })).rejects.toMatchObject({ code: 1 })
    expect(await f.demands.inspectDelegation('goal', a.operationId)).toBeNull(); expect(f.inputs).toEqual([])
    await f.cli('owner', ['agent', 'send', '--to-session', a.workerAgentSessionId, '--text', a.text,
      '--operation-id', a.operationId, '--message-id', a.sourceMessageId, '--thread', a.threadId])
    const inputs = structuredClone(f.inputs)
    f.readUnavailable.add('message.read:' + a.operationId)
    await expect(f.goal('owner', 'bind', { goalId: 'goal', intent: a })).rejects.toMatchObject({ code: 1 })
    await expect(f.goal('owner', 'bind', { goalId: 'goal', intent: { ...a, text: a.text + ' altered' } })).rejects.toMatchObject({ code: 1 })
    await expect(f.goal('owner', 'bind', { goalId: 'goal', intent: { ...a, context: [{ kind: 'file', source: 'refs.md', revision: 'claimed', scope: 'original', availability: 'available' }] } })).rejects.toMatchObject({ code: 1 })
    expect(await f.demands.inspectDelegation('goal', a.operationId)).toBeNull(); expect(f.inputs).toEqual(inputs)
    await f.goal('owner', 'bind', { goalId: 'goal', intent: a }); expect(f.inputs).toEqual(inputs); expect(f.stop).not.toHaveBeenCalled()
    await record('existing-source-binding-unknown-retained', await f.proof())
  }, 30_000)

  it('retains saved intent after original Core read fails, then submits once only after an exact successful absence read', async () => {
    const f = await fixture(), a = task()
    f.readUnavailable.add('message.read:' + a.operationId)
    await expect(f.goal('owner', 'delegate', { goalId: 'goal', intent: a })).rejects.toMatchObject({ code: 1 })
    expect(await f.demands.inspectDelegation('goal', a.operationId)).toMatchObject({ ...a, text: expect.stringContaining(a.text), requestText: a.text })
    expect(f.inputs).toEqual([])
    await f.read(); expect(f.inputs).toEqual([])
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    expect(f.inputs.map(input => input.messageId)).toEqual([a.sourceMessageId])
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    expect(f.inputs.map(input => input.messageId)).toEqual([a.sourceMessageId])
    expect((await f.demands.get('goal'))!.status).toBe('in_progress')
    expect(f.stop).not.toHaveBeenCalled()
    await record('intent-saved-original-read-unavailable', await f.proof())
  }, 30_000)

  it('does not turn a delivered plain completion claim or worker_done event into a Goal report or human acceptance', async () => {
    const f = await fixture(), a = task()
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    await f.cli('worker-a', ['agent', 'send', '--to-session', 'owner', '--text', 'Completed every requested task.', '--message-id', 'plain-done',
      '--operation-id', 'plain-done-operation', '--thread', a.threadId, '--reply-to', a.sourceMessageId])
    await f.cli('worker-a', ['message', 'dispatch', 'report', '--source-message', a.sourceMessageId, '--reply-message', 'plain-done', '--kind', 'worker_done'])
    const read = (await f.read()).result
    expect(read.observations[0].communication.dispatch).toMatchObject({ originAwaits: false, events: [{ kind: 'worker_done', replyMessageId: 'plain-done' }] })
    expect(read.delegations[0].report).toBeUndefined()
    expect(read.delegations[0].collection).toBeUndefined()
    expect(read.grounding).toBeUndefined()
    const before = await f.demands.snapshot(), inputs = structuredClone(f.inputs)
    await expect(f.goal('owner', 'collect', { goalId: 'goal', operationId: a.operationId, collection: { operationId: 'plain-collect', replyMessageId: 'plain-done' } })).rejects.toMatchObject({ code: 1 })
    expect(await f.demands.snapshot()).toEqual(before)
    expect(f.inputs).toEqual(inputs)
    expect(before.demands[0]!).toMatchObject({ status: 'in_progress', alignment: { confirmedAt: null } })
    expect(f.stop).not.toHaveBeenCalled()
    await record('plain-claim-worker-done-is-not-goal-report', await f.proof())
  }, 30_000)

  it('reconciles a saved source after Native receipt loss without resending or blocking the other worker', async () => {
    const f = await fixture(), a = task(), b = task('worker-b', ['AC-02'])
    f.loseNativeReceipt.add(a.operationId)
    await expect(f.goal('owner', 'delegate', { goalId: 'goal', intent: a })).rejects.toMatchObject({ code: 1 })
    expect(f.inputs.map(input => input.messageId)).toEqual([a.sourceMessageId])
    await f.read(); expect(f.inputs).toHaveLength(1)
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    expect(f.inputs.map(input => input.messageId)).toEqual([a.sourceMessageId])
    expect((await f.demands.inspectDelegation('goal', a.operationId))!.linkedAt).toBeGreaterThan(0)
    const reconciled = (await f.read()).result
    const original = (await f.demands.inspectDelegation('goal', a.operationId))!
    expect(reconciled.observations[0].communication.source.envelope).toMatchObject({ operationId: a.operationId, messageId: a.sourceMessageId, body: original.text })
    expect(reconciled.observations[0].communication.source.delivery.state).toBe('queued')
    expect(reconciled.observations[0].workerRun).toEqual({ runId: a.workerRunId, state: 'running' })
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: b })
    expect(f.inputs.map(input => input.messageId)).toEqual([a.sourceMessageId, b.sourceMessageId])
    expect(f.stop).not.toHaveBeenCalled()
    await record('source-persisted-native-receipt-unknown', await f.proof())
  }, 30_000)

  it('refuses a worker Run change before first submission without delivering the frozen task to the new Run or closing its healthy input', async () => {
    const f = await fixture(), a = task()
    f.beforeCall.set('agent.send:' + a.operationId, async () => {
      const original = (await f.sessions.readMetadata(a.workerAgentSessionId))!
      await f.sessions.compareAndSwap(original, { ...original, run: { runId: 'worker-new-run' }, retiredRuns: [original.run], updatedAt: original.updatedAt + 1 })
    })
    await expect(f.goal('owner', 'delegate', { goalId: 'goal', intent: a })).rejects.toMatchObject({ code: 1 })
    expect(f.inputs).toEqual([])
    const saved = (await f.demands.inspectDelegation('goal', a.operationId))!
    expect(saved.workerRunId).toBe(a.workerRunId)
    expect(saved.linkedAt).toBeUndefined()
    expect(saved.requestText).toBe(a.text)
    await f.cli('owner', ['agent', 'send', '--to-session', 'worker-a', '--text', 'Continue this available Agent.', '--operation-id', 'healthy-new-run', '--message-id', 'healthy-new-run-message'])
    expect(f.inputs).toHaveLength(1)
    expect(f.inputs[0]).toMatchObject({ messageId: 'healthy-new-run-message', recipientSessionId: 'worker-a' })
    expect(f.stop).not.toHaveBeenCalled()
    await record('worker-run-changed-before-first-input', await f.proof())
  }, 30_000)

  it('collects the original structured Core reply after the worker exits before its Domain report receipt, without another worker submission', async () => {
    const f = await fixture(), a = task(), ra = result(a)
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    const failure = vi.spyOn(f.demands, 'submitDelegationReport').mockRejectedValueOnce(new AgentMuxError('Isolated report save failed before Domain collection.', 'CONTROL_UNAVAILABLE'))
    await expect(f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })).rejects.toMatchObject({ code: 1 })
    expect(failure).toHaveBeenCalledOnce()
    expect((await f.demands.inspectDelegation('goal', a.operationId))!.report).toBeUndefined()
    const before = (await f.read()).result
    expect(before.observations[0].communication.dispatch).toMatchObject({ originAwaits: false, events: [{ kind: 'worker_done', replyMessageId: ra.replyMessageId }] })
    expect(before.observations[0].recoverableReport).toEqual(ra)
    expect(before.grounding).toBeUndefined()
    const frozenInputs = structuredClone(f.inputs)
    f.runStates.set(a.workerRunId, 'exited')
    await expect(f.goal('owner', 'collect', { goalId: 'goal', operationId: a.operationId, collection: { operationId: 'recovered-collect', replyMessageId: ra.replyMessageId } })).resolves.toMatchObject({ ok: true })
    expect(f.inputs).toEqual(frozenInputs)
    const recovered = (await f.demands.inspectDelegation('goal', a.operationId))!.report!
    expect(recovered).toMatchObject({ ...ra, recovery: { collector: { kind: 'agent', id: 'owner' } } })
    expect((await f.demands.get('goal'))!.grounding!.acceptedAt).toBeNull()
    await f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })
    expect((await f.demands.inspectDelegation('goal', a.operationId))!.report).toEqual(recovered)
    expect(f.inputs).toEqual(frozenInputs)
    await expect(f.goal('worker-b', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })).rejects.toMatchObject({ code: 1 })
    expect(f.inputs).toEqual(frozenInputs)
    expect(f.stop).not.toHaveBeenCalled()
    await record('core-reply-event-before-domain-report', await f.proof())
  }, 30_000)

  it('collects an authenticated structured report after its original Native receipt is lost before a worker_done event and the worker exits', async () => {
    const f = await fixture(), a = task(), ra = result(a)
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    f.loseNativeReceipt.add(ra.operationId)
    // The admitted business action can either return a confirmed saved report or
    // its real Native receipt uncertainty. In both cases it retains the same reply.
    await f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra }).catch(() => undefined)
    expect(f.loseNativeReceipt.has(ra.operationId)).toBe(false)
    const actual = await f.client.readDispatch({ sourceMessageId: a.sourceMessageId })
    expect(actual.dispatch.events.some(event => event.kind === 'worker_done')).toBe(false)
    expect(actual.dispatch.originAwaits).toBe(true)
    const reply = await f.client.readMessage({ operationId: ra.operationId })
    expect(reply).not.toBeNull()
    expect(reply!.envelope).toMatchObject({ operationId: ra.operationId, messageId: ra.replyMessageId,
      senderSessionId: a.workerAgentSessionId, recipientSessionId: a.ownerAgentSessionId, replyTo: a.sourceMessageId, threadId: a.threadId })
    expect(JSON.parse(reply!.envelope.body)).toMatchObject({ schema: 'agentmux.goal-report.v1', goalId: 'goal', delegationOperationId: a.operationId, report: ra })
    expect(reply!.delivery.state).toBe('queued')
    const nativeInputs = structuredClone(f.inputs)
    f.runStates.set(a.workerRunId, 'exited')
    const ready = (await f.read()).result
    expect(ready.observations[0].recoverableReport).toEqual(ra)
    expect(ready.observations[0].communication.dispatch).toMatchObject({ originAwaits: true, events: [] })
    await expect(f.goal('owner', 'collect', { goalId: 'goal', operationId: a.operationId,
      collection: { operationId: 'native-unknown-collect', replyMessageId: ra.replyMessageId } })).resolves.toMatchObject({ ok: true })
    expect((await f.demands.inspectDelegation('goal', a.operationId))!).toMatchObject({ report: ra,
      collection: { operationId: 'native-unknown-collect', collector: { kind: 'agent', id: 'owner' } } })
    expect((await f.demands.get('goal'))!).toMatchObject({ status: 'in_progress', grounding: { acceptedAt: null }, alignment: { confirmedAt: null } })
    expect(f.inputs).toEqual(nativeInputs)
    expect(f.stop).not.toHaveBeenCalled()
    const collected = await f.client.readDispatch({ sourceMessageId: a.sourceMessageId })
    expect(collected.dispatch.events).toEqual(actual.dispatch.events)
    expect(collected.dispatch.originAwaits).toBe(true)
    await record('report-journal-saved-native-receipt-unknown-before-event', await f.proof())
  }, 30_000)

  it('keeps an opaque original reply unknown and refuses collection after its Native receipt is lost without closing another healthy worker', async () => {
    const f = await fixture(), a = task()
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    f.loseNativeReceipt.add('opaque-operation')
    await expect(f.cli('worker-a', ['agent', 'send', '--to-session', 'owner', '--text', 'An opaque original result with no structured report.',
      '--message-id', 'opaque-reply', '--operation-id', 'opaque-operation', '--thread', a.threadId, '--reply-to', a.sourceMessageId])).rejects.toMatchObject({ code: 1 })
    const actual = await f.client.readMessage({ operationId: 'opaque-operation' })
    expect(actual!.envelope).toMatchObject({ replyTo: a.sourceMessageId, senderSessionId: 'worker-a', body: 'An opaque original result with no structured report.' })
    f.runStates.set(a.workerRunId, 'exited')
    const read = (await f.read()).result
    expect(read.delegations[0].report).toBeUndefined()
    expect(read.observations[0].recoverableReport).toBeUndefined()
    expect(read.observations[0].communication.dispatch).toMatchObject({ originAwaits: true, events: [] })
    const before = await f.demands.snapshot(), inputs = structuredClone(f.inputs)
    await expect(f.goal('owner', 'collect', { goalId: 'goal', operationId: a.operationId,
      collection: { operationId: 'opaque-collect', replyMessageId: 'opaque-reply' } })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('CONTROL_PROTOCOL_ERROR') })
    expect(await f.demands.snapshot()).toEqual(before)
    expect(f.inputs).toEqual(inputs)
    await f.cli('owner', ['agent', 'send', '--to-session', 'worker-b', '--text', 'Keep the healthy input available.', '--message-id', 'available-input', '--operation-id', 'available-operation'])
    expect(f.inputs.at(-1)).toMatchObject({ messageId: 'available-input', recipientSessionId: 'worker-b' })
    expect(f.stop).not.toHaveBeenCalled()
    await record('opaque-original-reply-unknown-not-collected', await f.proof())
  }, 30_000)

  it('lets an authenticated handed-off Supervisor collect the original Core report through the business owner while its public participant read stays denied', async () => {
    const f = await fixture(), a = task(), ra = result(a)
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    vi.spyOn(f.demands, 'submitDelegationReport').mockRejectedValueOnce(new AgentMuxError('Report receipt failed after original Core reply.', 'CONTROL_UNAVAILABLE'))
    await expect(f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })).rejects.toMatchObject({ code: 1 })
    expect((await f.demands.inspectDelegation('goal', a.operationId))!.report).toBeUndefined()
    const nativeInputs = structuredClone(f.inputs)
    await f.demands.update('goal', { assigneeSessionIds: ['owner', 'worker-a', 'worker-b', 'next-owner'], supervisorSessionId: 'next-owner' })
    const publicArgs = ['message', 'dispatch', 'read', '--source-message', a.sourceMessageId]
    await expect(f.cli('next-owner', publicArgs)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('DISPATCH_PARTICIPANT_MISMATCH') })
    await expect(f.goal('stranger', 'collect', { goalId: 'goal', operationId: a.operationId,
      collection: { operationId: 'foreign-collect', replyMessageId: ra.replyMessageId } })).rejects.toMatchObject({ code: 1 })
    expect(f.trace.filter(call => call.method === 'trustedSDK.readDispatch')).toEqual([])
    await expect(f.goal('next-owner', 'collect', { goalId: 'goal', operationId: a.operationId,
      collection: { operationId: 'handoff-collect', replyMessageId: ra.replyMessageId } })).resolves.toMatchObject({ ok: true })
    const recovered = (await f.demands.inspectDelegation('goal', a.operationId))!
    expect(recovered).toMatchObject({ ownerAgentSessionId: 'owner', sourceMessageId: a.sourceMessageId, workerRunId: a.workerRunId,
      report: { ...ra, recovery: { collector: { kind: 'agent', id: 'next-owner' } } },
      collection: { operationId: 'handoff-collect', collector: { kind: 'agent', id: 'next-owner' } } })
    expect(f.trace.filter(call => call.method === 'trustedSDK.readDispatch').every(call => call.sourceMessageId === a.sourceMessageId)).toBe(true)
    expect(f.trace.filter(call => call.method === 'trustedSDK.readDispatch').length).toBeGreaterThan(0)
    await expect(f.cli('next-owner', publicArgs)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('DISPATCH_PARTICIPANT_MISMATCH') })
    expect((await f.demands.get('goal'))!).toMatchObject({ supervisorSessionId: 'next-owner', status: 'in_progress', grounding: { acceptedAt: null }, alignment: { confirmedAt: null } })
    expect(f.inputs).toEqual(nativeInputs)
    expect(f.stop).not.toHaveBeenCalled()
    await record('new-supervisor-business-reader-keeps-public-participant-denial', await f.proof())
  }, 30_000)

  it('keeps the collected original submission after post-replacement fsync uncertainty and reads the same collection on retry', async () => {
    const f = await fixture(), a = task('worker-a', ['AC-01', 'AC-02']), ra = result(a)
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a })
    await f.goal('worker-a', 'report', { goalId: 'goal', operationId: a.operationId, report: ra })
    const originalCollect = f.demands.collectDelegationReport.bind(f.demands), originalOpen = fs.open.bind(fs)
    let injected = 0
    const collectionFault = vi.spyOn(f.demands, 'collectDelegationReport').mockImplementationOnce(async (...args) => {
      const fault = vi.spyOn(fs, 'open').mockImplementation(async (...openArgs: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...openArgs)
        if (openArgs[0] === f.demands.root && injected === 0) { injected++; vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('isolated fsync EIO'), { code: 'EIO' })) }
        return handle
      })
      try { return await originalCollect(...args) } finally { fault.mockRestore() }
    })
    const request = { goalId: 'goal', operationId: a.operationId, collection: { operationId: 'collect-a', replyMessageId: ra.replyMessageId } }
    await expect(f.goal('owner', 'collect', request)).rejects.toMatchObject({ code: 1 })
    expect(collectionFault).toHaveBeenCalledOnce(); expect(injected).toBe(1)
    const frozen = await f.demands.snapshot(), inputs = structuredClone(f.inputs)
    await f.goal('owner', 'collect', request)
    expect(await f.demands.snapshot()).toEqual(frozen)
    expect(f.inputs).toEqual(inputs)
    expect(frozen.demands[0]!.grounding!.checks).toEqual(ra.grounding.checks)
    expect(frozen.demands[0]!.grounding!.acceptedAt).toBeNull()
    expect(f.stop).not.toHaveBeenCalled()
    await record('collection-replaced-durable-receipt-unknown', await f.proof())
  }, 30_000)

  it('distinguishes exited without report, reported awaiting collection and collected awaiting human acceptance while unknown observations keep healthy work available', async () => {
    const f = await fixture(), a = task(), b = task('worker-b', ['AC-02'])
    const prepared = (await f.goal('owner', 'prepare', { goalId: 'goal', intent: a })).result.delegations[0]
    expect(prepared.requestText).toBe(a.text)
    expect(JSON.parse(prepared.text.split('\n[AgentMux delegation]\n')[1])).toMatchObject({ schema: 'agentmux.goal-delegation.v1', goalId: 'goal',
      operationId: a.operationId, sourceMessageId: a.sourceMessageId, workerAgentSessionId: a.workerAgentSessionId, criterionIds: a.criterionIds })
    expect(f.inputs).toEqual([])
    await f.goal('owner', 'delegate', { goalId: 'goal', intent: a }); await f.goal('owner', 'delegate', { goalId: 'goal', intent: b })
    expect(f.inputs[0]!.body).toBe(prepared.text)
    expect((await f.demands.inspectDelegation('goal', a.operationId))!.preparedAt).toBe(prepared.preparedAt)
    f.runStates.set(a.workerRunId, 'exited')
    const exited = (await f.read()).result
    expect(exited.observations[0].workerRun).toEqual({ runId: a.workerRunId, state: 'exited' })
    expect(exited.delegations[0].report).toBeUndefined()
    expect(exited.delegations[0].collection).toBeUndefined()
    const rb = result(b); await f.goal('worker-b', 'report', { goalId: 'goal', operationId: b.operationId, report: rb })
    const reported = (await f.read()).result
    expect(reported.delegations[1].report).toMatchObject(rb)
    expect(reported.delegations[1].collection).toBeUndefined()
    await f.goal('owner', 'collect', { goalId: 'goal', operationId: b.operationId, collection: { operationId: 'collect-b', replyMessageId: rb.replyMessageId } })
    const collected = (await f.read()).result
    expect(collected.delegations[1].collection).toMatchObject({ operationId: 'collect-b', replyMessageId: rb.replyMessageId })
    expect(collected.grounding.acceptedAt).toBeNull()
    expect(collected.grounding.checks.map((check: { outcome: string }) => check.outcome)).toEqual(['unknown', 'met'])
    f.runUnavailable.add(a.workerRunId); f.readUnavailable.add('message.dispatch.read:' + a.sourceMessageId)
    const inputs = structuredClone(f.inputs), unknown = (await f.read()).result
    expect(unknown.observations).toHaveLength(2)
    expect(unknown.observations[0].unknown).toEqual(expect.any(String))
    expect(unknown.observations[0].workerRun).toBeUndefined()
    expect(unknown.observations[1].workerRun).toEqual({ runId: b.workerRunId, state: 'running' })
    expect(unknown.delegations).toEqual(collected.delegations)
    expect(f.inputs).toEqual(inputs)
    await f.cli('owner', ['agent', 'send', '--to-session', 'worker-b', '--text', 'Continue the available original work.', '--message-id', 'healthy-next', '--operation-id', 'healthy-next-operation'])
    expect(f.inputs.at(-1)).toMatchObject({ messageId: 'healthy-next', recipientSessionId: 'worker-b' })
    expect(f.stop).not.toHaveBeenCalled()
    expect((await f.demands.get('goal'))!.status).toBe('in_progress')
    await record('exit-report-collection-and-unknown', await f.proof())
  }, 30_000)
})
