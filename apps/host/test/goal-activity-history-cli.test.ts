import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { startAgentMuxHost } from '../src/host.js'
import { desktopGoalControl } from '../../desktop/src/main/desktop-goals.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { pageGoalActivity, parseGoalActivityHistoryParams, parseGoalActivityHistoryResult } from '../../../packages/core/src/goal-activity-history.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const original = await rpcOwnerFixture(['original-agent'], core); cleanup.push(original.close)
  const native = original.inner.kernel; await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const configurationPath = join(original.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [] }))
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, configurationPath, socketPath: join(original.root, 'control.sock'),
      desktopSocketPath: join(original.root, 'desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const demands = openDemandStore({ root: join(original.root, 'demands') })
  await demands.create({ id: 'goal-original', title: 'Original Goal' })
  await demands.create({ id: 'goal-other', title: 'Other Goal' })
  await demands.create({ id: 'goal-empty', title: 'Empty Goal' })
  for (let index = 0; index < 17; index++) await demands.addActivity('goal-original', {
    id: 'activity-' + index, kind: 'evidence', message: 'Original ' + index, actorId: null,
    createdAt: index % 2 === 0 ? 7 : 3, operationId: 'original-evidence-' + index })
  await demands.addActivity('goal-other', { id: 'other-activity', kind: 'evidence', message: 'Other', actorId: null, createdAt: 5 })
  const env = objectCliEnvironment(original.root)
  const cli = (args: string[]) => runCompiledObjectCli(['goal', 'activity', ...args], env)
  const cursorPath = join(original.root, 'cursor.json')
  return { original, host, demands, cli, cursorPath }
}

it('compiled CLI pages the actual Host original Demand history by fixed append anchors despite new appends and unordered clocks', async () => {
  const f = await fixture(), beforeSessions = await readFile(f.original.store.path)
  const first = await f.cli(['history', '--goal', 'goal-original', '--limit', '4'])
  expect(first.code, first.stderr).toBe(0)
  let page = JSON.parse(first.stdout).result
  expect(page).toMatchObject({ totalCount: 17, throughActivityId: 'activity-16', order: 'newest-first', diskDurability: 'confirmed' })
  expect(page.activities.map((a: { id: string }) => a.id)).toEqual(['activity-16', 'activity-15', 'activity-14', 'activity-13'])
  const ids = page.activities.map((a: { id: string }) => a.id)
  await f.demands.addActivity('goal-original', { id: 'late-activity', kind: 'evidence', message: 'Outside original cut', actorId: null })
  let pages = 1
  while (page.nextCursor) {
    await writeFile(f.cursorPath, JSON.stringify(page.nextCursor))
    const result = await f.cli(['history', '--goal', 'goal-original', '--limit', '4', '--cursor', f.cursorPath])
    expect(result.code, result.stderr).toBe(0)
    page = JSON.parse(result.stdout).result; pages++
    expect(page.totalCount).toBe(17); expect(page.throughActivityId).toBe('activity-16')
    ids.push(...page.activities.map((a: { id: string }) => a.id))
    expect(pages).toBeLessThan(7)
  }
  expect(pages).toBe(5)
  expect(ids).toEqual(Array.from({ length: 17 }, (_, i) => 'activity-' + (16 - i)))
  expect(new Set(ids).size).toBe(17)
  expect((await f.demands.readActivities('goal-original')).activities).toHaveLength(18)
  expect(await readFile(f.original.store.path)).toEqual(beforeSessions)
  const empty = await f.cli(['history', '--goal', 'goal-empty'])
  expect(empty.code, empty.stderr).toBe(0)
  expect(JSON.parse(empty.stdout).result).toMatchObject({ activities: [], totalCount: 0, throughActivityId: null, nextCursor: null })
})

it('actual Host aggregate reports complete matching scope and truncation; cursor misuse never mutates the original Goal', async () => {
  const f = await fixture()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.original.root, 'control.sock') } }); cleanup.push(() => rpc.dispose())
  for (const input of [{ since: 'invalid' }, { since: -1 }, { since: 1.5 }, { limit: 0 }]) {
    await expect(rpc.call('goal.activity', input as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  const perGoalRead = vi.spyOn(Object.getPrototypeOf(f.demands), 'readActivities').mockRejectedValue(new Error('Aggregate must consume the single original snapshot, not reread the Store per Goal.'))
  const tail = await f.cli(['--limit', '2'])
  expect(tail.code, tail.stderr).toBe(0)
  const result = JSON.parse(tail.stdout).result
  expect(result.activity).toHaveLength(2)
  expect(result.coverage).toEqual({ scope: 'matching-goals', observation: 'selected-goals-then-confirmed-activity', order: 'goal-order-then-append', matchedGoalCount: 3,
    totalActivityCount: 18, returnedActivityCount: 2, limit: 2, truncated: true })
  const single = await f.cli(['--goal', 'goal-other', '--limit', '2'])
  expect(single.code, single.stderr).toBe(0)
  expect(JSON.parse(single.stdout).result.coverage).toMatchObject({ matchedGoalCount: 1, totalActivityCount: 1, truncated: false })
  expect(perGoalRead).not.toHaveBeenCalled(); perGoalRead.mockRestore()
  for (const cursor of [
    { goalId: 'goal-other', throughActivityId: 'activity-16', beforeActivityId: 'activity-13' },
    { goalId: 'goal-original', throughActivityId: 'missing-through', beforeActivityId: 'activity-13' },
    { goalId: 'goal-original', throughActivityId: 'activity-16', beforeActivityId: 'missing-before' }
  ]) {
    await writeFile(f.cursorPath, JSON.stringify(cursor))
    const read = await f.cli(['history', '--goal', 'goal-original', '--cursor', f.cursorPath])
    expect(read.code, read.stdout).not.toBe(0)
    expect(JSON.parse(read.stderr).error.code).toBe(cursor.goalId === 'goal-other' ? 'INVALID_CONTROL_REQUEST' : 'GOAL_ACTIVITY_CURSOR_EXPIRED')
  }
  expect((await f.demands.readActivities('goal-original')).activities).toHaveLength(17)
})

it('strict public history codec rejects foreign scope, oversized pages and invalid counts', () => {
  const input = parseGoalActivityHistoryParams({ goalId: 'original', limit: 1 })
  const activity = { id: 'a', kind: 'evidence', message: 'Original', createdAt: 7, actorId: null }
  const page = pageGoalActivity([activity], input)
  expect(parseGoalActivityHistoryResult(page, input)).toEqual(page)
  for (const value of [{ ...page, goalId: 'other' }, { ...page, totalCount: 0 }, { ...page, activities: [activity, activity] },
    { ...page, nextCursor: { goalId: 'other', throughActivityId: 'a', beforeActivityId: 'a' } }])
    expect(() => parseGoalActivityHistoryResult(value, input)).toThrow()
})

it('actual Host preserves original activity durability failure and confirms one exact batch without replaying input', async () => {
  const f = await fixture(), sessions = await readFile(f.original.store.path)
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.original.root, 'control.sock') } }); cleanup.push(() => rpc.dispose())
  const confirm = vi.spyOn(Object.getPrototypeOf(f.demands), 'confirmSnapshot')
  const batch = await rpc.call('goal.activity.collection', { goalIds: ['goal-other', 'goal-original'] })
  expect(batch.groups.map(group => group.goalId)).toEqual(['goal-other', 'goal-original'])
  expect(batch.groups.map(group => group.activities.length)).toEqual([1, 17])
  expect(batch.diskDurability).toBe('confirmed'); expect(confirm).toHaveBeenCalledTimes(1)
  for (const goalIds of [[], ['goal-original', 'goal-original'], ['missing-goal']])
    await expect(rpc.call('goal.activity.collection', { goalIds })).rejects.toThrow()
  const calls: string[] = []
  const desktopOwner = desktopGoalControl({ callOriginalCore: async (_host, method, params) => {
    calls.push(method); return await rpc.call(method, params as never)
  } })
  const desktop = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'collection-desktop.sock'), coreClients: () => [], execute: async (request, _name, context) => await desktopOwner(request, context) })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const desktopRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.original.root, 'collection-desktop.sock') } }); cleanup.push(() => desktopRpc.dispose())
  const forwarded = await desktopRpc.call('goal.activity.collection', { goalIds: ['goal-original'] })
  expect(forwarded.groups[0]!.goalId).toBe('goal-original'); expect(forwarded.groups[0]!.activities).toHaveLength(17)
  expect(calls).toEqual(['goal.activity.collection'])
  const badCollection = vi.spyOn(Object.getPrototypeOf(f.demands), 'readActivityCollection').mockResolvedValue({ groups: [{ demandId: 'foreign-goal', activities: [] }], diskDurability: 'confirmed' })
  await expect(rpc.call('goal.activity.collection', { goalIds: ['goal-original'] })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  badCollection.mockRestore()
  confirm.mockClear()
  const aggregate = await f.cli(['--limit', '3'])
  expect(aggregate.code, aggregate.stderr).toBe(0); expect(confirm).toHaveBeenCalledTimes(1)
  confirm.mockRejectedValue(new Error('Original activity disk confirmation is unavailable'))
  const failed = await f.cli(['--goal', 'goal-original'])
  expect(failed.code, failed.stdout).not.toBe(0); expect(JSON.parse(failed.stderr).error.message).toContain('disk confirmation is unavailable')
  await expect(f.demands.readActivities('goal-original')).rejects.toThrow('disk confirmation is unavailable')
  expect((await rpc.call('goal.inspect', { goalId: 'goal-original' })).goal!.activities).toHaveLength(17)
  expect((await rpc.call('goal.ls', { all: true })).goals).toHaveLength(3)
  expect(await readFile(f.original.store.path)).toEqual(sessions)
  confirm.mockRestore()
  expect((await f.demands.readActivities('goal-original')).activities).toHaveLength(17)
})
