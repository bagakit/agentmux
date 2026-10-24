import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxMemoryAgentSessionStore,
  hashAgentCapability, issueAgentCapability, type AgentMuxRpcResult } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { GoalDelegationOwner, type GoalDelegationCorePort } from '@agentmux/host/goal-delegation-owner'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'

const execute = promisify(execFile), cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllEnvs() })

it('runs the actual CLI/RPC/Main prepare owner, retains frozen intent and rejects a forged participant without touching the Goal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-goal-prepare-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.sqlite'))
  const store = new AgentMuxMemoryAgentSessionStore(), credentials = new Map<string, string>()
  for (const id of ['owner', 'worker']) {
    const capability = issueAgentCapability(); credentials.set(id, capability)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: root, run: { runId: id + '-run' }, retiredRuns: [],
      hookBindingId: 'binding-' + id, hookToken: 'fixture-token-' + id,
      capabilityHash: hashAgentCapability(capability), createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100) })
  }
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean }; registry: { load(hostId: string): Promise<void> } }
  internals.connected = true; internals.kernel.isConnected = () => true; await internals.registry.load('local')
  cleanup.push(() => client.dispose())
  const demands = openDemandStore({ root: join(root, 'goals') })
  await demands.create({ id: 'goal', title: 'Original Goal', description: 'Original intent', status: 'in_progress',
    assigneeSessionIds: ['owner', 'worker'], supervisorSessionId: 'owner' })
  await demands.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Recover the result' }], openQuestions: [] })
  const owner = new GoalDelegationOwner(demands, { agentCreation: async (_hostId, id) => (await store.readMetadata(id))! })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'),
    coreClients: () => [{ hostId: 'local', client }], goalDelegations: owner })
  await server.start(); cleanup.push(() => server.stop())
  const intent = { operationId: 'original-operation', sourceMessageId: 'original-message', hostId: 'local',
    ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker', ownerRunId: 'owner-run', workerRunId: 'worker-run',
    threadId: 'original-thread', text: ' Original frozen input\nwith whitespace ', alignmentRevision: 1, criterionIds: ['AC'] }
  const inputPath = join(root, 'intent.json'); await writeFile(inputPath, JSON.stringify({ goalId: 'goal', intent }))
  const cli = async (who: string, args: string[]) => {
    const result = await execute(process.execPath, [resolve('packages/core/dist/agentmux.js'), '--endpoint', 'unix:' + server.path, ...args], {
      env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: who, AGENTMUX_AGENT_CAPABILITY: credentials.get(who)! }
    })
    return JSON.parse(result.stdout)
  }
  const first = await cli('owner', ['goal', 'delegation', 'prepare', '--input', inputPath])
  expect(first.ok).toBe(true)
  expect(first.result.delegations).toHaveLength(1)
  const frozen = first.result.delegations[0]
  expect(frozen).toMatchObject({ ...intent, text: expect.stringContaining(intent.text), requestText: intent.text })
  expect(frozen.text.startsWith(intent.text + '\n\n[AgentMux delegation]\n')).toBe(true)
  const coordination = frozen.text.split('\n[AgentMux delegation]\n')[1]!, metadata = JSON.parse(coordination.split('\n')[0]!)
  expect(metadata).toMatchObject({ schema: 'agentmux.goal-delegation.v1',
    goalId: 'goal', operationId: intent.operationId, sourceMessageId: intent.sourceMessageId, threadId: intent.threadId,
    ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker', hostId: 'local', alignmentRevision: 1, criterionIds: ['AC'] })
  expect(metadata).not.toHaveProperty('roleGuidance')
  expect(metadata.next).toBe('Use goal report --input FILE to return every delegated criterion with evidence, gap or unknown under this original dispatch. For a question/block, reply to the original source and record message dispatch report --kind question|escalation. A report is pending collection and human acceptance; exiting or worker_done does not complete the Goal.')
  expect(coordination).toBe(JSON.stringify(metadata) + '\n\n' + goalRoleGuidance({ role: 'executor', goalId: 'goal',
    agentSessionId: 'worker', runId: 'worker-run', source: { kind: 'goal-delegation', operationId: intent.operationId,
      sourceMessageId: intent.sourceMessageId, threadId: intent.threadId } }))
  const original = await demands.snapshot()
  const repeated = await cli('owner', ['goal', 'delegation', 'prepare', '--input', inputPath])
  expect(repeated.result).toEqual(first.result)
  expect(await demands.snapshot()).toEqual(original)
  await expect(cli('worker', ['goal', 'delegation', 'prepare', '--input', inputPath])).rejects.toMatchObject({ code: 1 })
  expect(await demands.snapshot()).toEqual(original)
  const read = await cli('owner', ['goal', 'delegations', '--goal', 'goal'])
  expect(read.result.delegations).toEqual(first.result.delegations)
  expect((await demands.get('goal'))!).toMatchObject({ description: 'Original intent', supervisorSessionId: 'owner', status: 'in_progress', alignment: { confirmedAt: null } })
})

async function retirementFixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-goal-retired-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  const store = new AgentMuxMemoryAgentSessionStore()
  for (const id of ['owner', 'worker']) await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: id + '-run' }, retiredRuns: [], hookBindingId: 'binding-' + id, hookToken: 'fixture-token-' + id,
    capabilityHash: hashAgentCapability(issueAgentCapability()), createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100),
    creation: { createOperationId: 'create-' + id, intentDigest: 'd'.repeat(64), initialPrompt: 'confirmed', agentMuxContext: 'confirmed' }
  })
  const client = new AgentMuxClient({ store }); cleanup.push(() => client.dispose())
  const demands = openDemandStore({ root: join(root, 'goals') })
  await demands.create({ id: 'goal', title: 'Original Goal', description: 'Original intent', status: 'in_progress',
    assigneeSessionIds: ['owner', 'worker'], supervisorSessionId: 'owner' })
  await demands.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Recover the result' }], openQuestions: [] })
  const calls: string[] = []
  const core: GoalDelegationCorePort = {
    call: async (hostId, method) => {
      calls.push(method)
      if (method === 'message.read') return { hostId, message: null } as AgentMuxRpcResult<typeof method>
      throw new Error('A retired participant must not cause ' + method)
    },
    observeRun: async () => { throw new Error('Retirement is read without connecting to a Run') }
  }
  const owner = new GoalDelegationOwner(demands, { agentCreation: async (_hostId, id) => client.inspectAgentCreation(id) }, undefined, core)
  const intent = { operationId: 'original-operation', sourceMessageId: 'original-message', hostId: 'local',
    ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker', ownerRunId: 'owner-run', workerRunId: 'worker-run',
    threadId: 'original-thread', text: 'Original frozen input', alignmentRevision: 1, criterionIds: ['AC'] }
  const authority = { actor: { kind: 'agent' as const, id: 'owner' }, hostId: 'local', runId: 'owner-run' }
  const retire = async (id: string) => {
    const session = (await store.readMetadata(id))!
    const reservation = { kind: 'stop' as const, reservationId: 'retire-' + id, ownerId: 'fixture-owner', ownerPid: process.pid,
      agentSessionId: id, expectedRun: session.run, operationId: 'stop-' + id, expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'stop-' + id, runId: session.run.runId } }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)
    expect(await client.inspectAgentCreation(id)).toMatchObject({ kind: 'retired-agent', agentSessionId: id })
    return await store.readRetiredAgentSession(id)
  }
  return { owner, demands, store, calls, intent, authority, retire }
}

it('reuses an original delegation packet and request verbatim without recomposing current role guidance', async () => {
  const f = await retirementFixture(), text = f.intent.text + '\n\n[AgentMux delegation]\n' + JSON.stringify({
    schema: 'agentmux.goal-delegation.v1', goalId: 'goal', roleGuidance: 'Saved original executor guidance\nwith an original line break'
  }) + '\r\n  '
  await f.demands.prepareDelegation('goal', { ...f.intent, requestText: f.intent.text, text }, 'owner')
  const original = await f.demands.snapshot(), pending = f.owner.call('goal.delegation.prepare', { goalId: 'goal', intent: f.intent }, {}, f.authority)
  await expect(pending).resolves.toMatchObject({ delegations: [{ requestText: f.intent.text, text }] })
  expect(await f.demands.snapshot()).toEqual(original)
  expect(f.calls).toEqual([])
})

it.each(['owner', 'worker'])('rejects a new delegation with a retired %s without sending or changing the Goal', async id => {
  const f = await retirementFixture(), retired = await f.retire(id), original = await f.demands.snapshot()
  await expect(f.owner.call('goal.delegate', { goalId: 'goal', intent: f.intent }, {}, f.authority))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_RETIRED' })
  expect(f.calls).toEqual([])
  expect(await f.demands.snapshot()).toEqual(original)
  expect(await f.store.readRetiredAgentSession(id)).toEqual(retired)
})

it('retains a frozen delegation but rejects a new report to its retired owner without sending', async () => {
  const f = await retirementFixture()
  await f.owner.call('goal.delegation.prepare', { goalId: 'goal', intent: f.intent }, {}, f.authority)
  await f.demands.linkDelegation('goal', f.intent.operationId, f.intent.sourceMessageId, 'owner')
  const retired = await f.retire('owner'), original = await f.demands.snapshot()
  const saved = await f.owner.call('goal.delegation.prepare', { goalId: 'goal', intent: f.intent }, {}, f.authority)
  expect(saved.delegations[0]).toMatchObject({ operationId: f.intent.operationId, sourceMessageId: f.intent.sourceMessageId })
  const report = { operationId: 'report-operation', replyMessageId: 'report-reply', authorAgentSessionId: 'worker',
    grounding: { alignmentRevision: 1, summary: 'Original worker result',
      checks: [{ criterionId: 'AC', outcome: 'met' as const, evidence: ['fixture-result:7'], note: '' }] } }
  await expect(f.owner.call('goal.report', { goalId: 'goal', operationId: f.intent.operationId, report }, {},
    { actor: { kind: 'agent', id: 'worker' }, hostId: 'local', runId: 'worker-run' })).rejects.toMatchObject({ code: 'AGENT_SESSION_RETIRED' })
  expect(f.calls).toEqual(['message.read'])
  expect(await f.demands.snapshot()).toEqual(original)
  expect(await f.store.readRetiredAgentSession('owner')).toEqual(retired)
})
