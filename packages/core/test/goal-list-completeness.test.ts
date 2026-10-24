import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { callPublicGoalControl } from '../src/rpc-business-codec.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxDemand } from '../src/control.js'
import { readDesktopGoals, desktopGoalControl } from '../../../apps/desktop/src/main/desktop-goals.js'
import { fixtureEpoch } from './helpers/fixture-values.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function originalGoals() {
  const root = await mkdtemp(join(tmpdir(), 'goal-list-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const goals: AgentMuxDemand[] = Array.from({ length: 103 }, (_, index) => ({
    id: `original-goal-${index}`, title: `Goal ${index}`, description: 'Original durable content',
    status: index === 102 ? 'done' : 'backlog', priority: 'normal', projectId: null, projectName: null,
    executorId: null, assigneeSessionIds: [], supervisorSessionId: null, participations: [], tags: [],
    plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null,
    activities: [], activityLog: [], decisions: [], sessionIds: [], source: 'default-topic',
    createdAt: fixtureEpoch(0, 0, index + 1), updatedAt: fixtureEpoch(0, 0, index + 1)
  }))
  let domainReads = 0
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [],
    goalControl: async request => {
      if (request.operation !== 'demand.list') throw new Error('Only the original Goal list is exposed by this owner.')
      domainReads++
      return { operation: 'demand.list', demands: structuredClone(goals) }
    } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  return { goals, rpc, domainReads: () => domainReads }
}

it('the original public Goal reader preserves its default and explicit limits while complete discovery returns every matching record', async () => {
  const f = await originalGoals()
  expect((await f.rpc.call('goal.ls', {})).goals.map(goal => goal.id)).toEqual(f.goals.slice(0, 100).map(goal => goal.id))
  expect((await f.rpc.call('goal.ls', { limit: 3 })).goals.map(goal => goal.id)).toEqual(f.goals.slice(0, 3).map(goal => goal.id))
  expect((await f.rpc.call('goal.ls', { all: true })).goals.map(goal => goal.id)).toEqual(f.goals.map(goal => goal.id))
  expect((await f.rpc.call('goal.ls', { all: true, status: 'done' })).goals.map(goal => goal.id)).toEqual(['original-goal-102'])
  expect((await f.rpc.call('goal.ls', { all: true, goalId: 'absent-original-goal' })).goals).toEqual([])
  const before = f.domainReads()
  for (const params of [{ all: true, limit: 3 }, { all: false }, { all: 'true' }, { all: null }, { all: true, unknown: true }])
    await expect(f.rpc.call('goal.ls', params as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.domainReads()).toBe(before)
})

it('CLI complete discovery and the actual Desktop list adapters consume the same full public Goal set', async () => {
  const f = await originalGoals()
  const parsed = await parseAgentMuxCliInvocation(['goal', 'ls', '--all'])
  expect(parsed.params).toEqual({ all: true })
  expect(parsed.command.method).toBe('goal.ls')
  expect((await f.rpc.call('goal.ls', parsed.params)).goals.map(goal => goal.id)).toEqual(f.goals.map(goal => goal.id))
  await expect(parseAgentMuxCliInvocation(['goal', 'ls', '--all', '--limit', '3'])).rejects.toThrow('Choose --all or --limit')
  await expect(parseAgentMuxCliInvocation(['goal', 'activity', '--all'])).rejects.toThrow()
  const seen: Array<{ method: string; params: unknown }> = []
  const runtime = { callOriginalCore: async (_hostId: string, method: Parameters<typeof f.rpc.call>[0], params: never) => {
    seen.push({ method, params }); return await f.rpc.call(method, params)
  } }
  const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.list' as const, requestId: 'original-complete-board' }
  const publicResult = await callPublicGoalControl(request, (method, params) => f.rpc.call(method, params as never))
  expect(publicResult.operation === 'demand.list' && publicResult.demands.map(goal => goal.id)).toEqual(f.goals.map(goal => goal.id))
  expect((await readDesktopGoals(runtime as never)).map(goal => goal.id)).toEqual(f.goals.map(goal => goal.id))
  const desktopResult = await desktopGoalControl(runtime as never)(request)
  expect(desktopResult.operation === 'demand.list' && desktopResult.demands.map(goal => goal.id)).toEqual(f.goals.map(goal => goal.id))
  expect(seen).toEqual([{ method: 'goal.ls', params: { all: true } }, { method: 'goal.ls', params: { all: true } }])
})
