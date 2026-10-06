import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxMemoryAgentSessionStore,
  hashAgentCapability, issueAgentCapability } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { GoalDelegationOwner } from '../src/main/goal-delegation-owner'

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
  expect(first.result.delegations[0]).toMatchObject(intent)
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
