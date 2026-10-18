import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openDemandStore } from '../src/index.js'
it('new finite Start atomically binds the observed Goal while original operation reads survive later changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-start-version-'))
  try {
    const store = openDemandStore({ root }), goal = (await store.create({ title: 'Original', sessionIds: [] })).demand
    const intent = { operationId: 'start-version', agentSessionId: 'worker', hostId: 'local', runId: 'run', execution: 'finite' as const, prompt: 'Original task' }
    const updated = (await store.update(goal.id, { description: 'Changed' })).demand
    await expect(store.prepareDispatch(goal.id, intent, goal.updatedAt)).rejects.toMatchObject({ cause: { kind: 'goal-start-version-conflict' } })
    expect(await store.inspectDispatch(goal.id, intent.operationId)).toBeNull()
    await store.prepareDispatch(goal.id, intent, updated.updatedAt)
    await store.update(goal.id, { description: 'Changed again' })
    const reopened = openDemandStore({ root })
    expect((await reopened.prepareDispatch(goal.id, intent, updated.updatedAt)).demand.dispatches).toHaveLength(1)
    expect(await reopened.inspectDispatch(goal.id, intent.operationId)).toMatchObject(intent)
  } finally { await rm(root, { recursive: true, force: true }) }
})
