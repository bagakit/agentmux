// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDemandStore } from '@agentmux/demand'
import { projectHostGoal } from '../../host/src/goal-projection.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { initializeGoalResponsibilityObservation } from '../src/renderer/src/lib/goal-delegation-work.js'
import { composerConfig } from './helpers/composer-dom-fixture.js'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture.js'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'

const initial = useAppStore.getState()
let root: string, owner: ReturnType<typeof openDemandStore>, release: (() => void) | undefined
let changed: Parameters<typeof api.demands.onChanged>[0]
let online: boolean
beforeEach(async () => {
  useAppStore.setState(initial, true); useAppStore.setState({ demands: {}, selectedDemandId: null })
  root = await mkdtemp(join(tmpdir(), 'goal-observation-')); owner = openDemandStore({ root }); online = true
  vi.spyOn(api.demands, 'onChanged').mockImplementation(listener => {
    changed = listener
    return owner.subscribe((_snapshot, ids) => { if (online) listener([...ids], false) })
  })
  vi.spyOn(api.demands, 'onObservationIssue').mockReturnValue(() => {})
  vi.spyOn(api.demands, 'delegation').mockRejectedValue(new Error('An ordinary Goal needs no responsibility read.'))
  vi.spyOn(api.goals, 'execute').mockImplementation(async request => {
    if (request.operation !== 'demand.show') throw new Error('Only the exact original Goal read is expected.')
    const goal = await owner.get(request.demandId)
    return { operation: 'demand.show', demand: goal ? projectHostGoal(goal) : null, goalContinuations: [] }
  })
})
afterEach(async () => { release?.(); release = undefined; vi.restoreAllMocks(); useAppStore.setState(initial, true); await rm(root, { recursive: true, force: true }) })

it('ordinary durable Goal creation, edits and deletion reach the live Board by exact ID without unrelated reads', async () => {
  release = initializeGoalResponsibilityObservation()
  await owner.create({ id: 'ordinary-goal', title: 'Original title', description: 'Original description' })
  await vi.waitFor(() => expect(useAppStore.getState().demands['ordinary-goal']?.title).toBe('Original title'))
  await owner.update('ordinary-goal', { title: 'Changed remotely', description: 'Actual new description' })
  await vi.waitFor(() => expect(useAppStore.getState().demands['ordinary-goal']).toMatchObject({ title: 'Changed remotely', description: 'Actual new description' }))
  expect(api.goals.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'demand.show', demandId: 'ordinary-goal' }))
  expect(vi.mocked(api.goals.execute).mock.calls.every(([request]) => request.operation === 'demand.show' && request.demandId === 'ordinary-goal')).toBe(true)
  expect(api.demands.delegation).not.toHaveBeenCalled()
  await owner.remove('ordinary-goal')
  await vi.waitFor(() => expect(useAppStore.getState().demands['ordinary-goal']).toBeUndefined())
  await expect(useAppStore.getState().refreshDemand('ordinary-goal')).rejects.toMatchObject({ code: 'GOAL_OWNER_NOT_FOUND' })
})

it('a complete reconnect membership removes a Goal deleted while offline and retains a failed exact observation', async () => {
  release = initializeGoalResponsibilityObservation()
  await owner.create({ id: 'deleted-offline', title: 'Original retained Goal' })
  await owner.create({ id: 'healthy-goal', title: 'Healthy retained Goal' })
  await vi.waitFor(() => expect(Object.keys(useAppStore.getState().demands).sort()).toEqual(['deleted-offline', 'healthy-goal']))
  online = false; await owner.remove('deleted-offline')
  const healthy = useAppStore.getState().demands['healthy-goal']
  vi.mocked(api.goals.execute).mockImplementationOnce(async request => {
    if (request.operation === 'demand.show' && request.demandId === 'healthy-goal') throw new Error('Exact owner observation is unavailable.')
    const goal = request.operation === 'demand.show' ? await owner.get(request.demandId) : null
    return { operation: 'demand.show', demand: goal ? projectHostGoal(goal) : null, goalContinuations: [] }
  })
  const error = vi.spyOn(useAppStore.getState(), 'reportError')
  changed(['healthy-goal'], true)
  await vi.waitFor(() => expect(useAppStore.getState().demands['deleted-offline']).toBeUndefined())
  expect(useAppStore.getState().demands['healthy-goal']).toBe(healthy)
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Exact owner observation is unavailable.' }))
  online = true; await owner.update('healthy-goal', { title: 'Recovered original read' })
  await vi.waitFor(() => expect(useAppStore.getState().demands['healthy-goal']?.title).toBe('Recovered original read'))
})

it('a change during an exact Goal read requests a new cut and never turns a stale missing result into deletion of a later saved view', async () => {
  release = initializeGoalResponsibilityObservation()
  await owner.create({ id: 'changing-goal', title: 'Original title' })
  await vi.waitFor(() => expect(useAppStore.getState().demands['changing-goal']).toBeTruthy())
  const priorReads = vi.mocked(api.goals.execute).mock.calls.length
  let complete!: (value: any) => void
  vi.mocked(api.goals.execute).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  changed(['changing-goal'], false)
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  await owner.update('changing-goal', { title: 'Latest original title' })
  const saved = (await owner.get('changing-goal'))!
  useAppStore.setState(state => ({ demands: { ...state.demands, 'changing-goal': { ...state.demands['changing-goal']!, title: saved.title, updatedAt: saved.updatedAt } } }))
  complete({ operation: 'demand.show', demand: null, goalContinuations: [] })
  await vi.waitFor(() => expect(vi.mocked(api.goals.execute).mock.calls.length).toBeGreaterThanOrEqual(priorReads + 2))
  await vi.waitFor(() => expect(useAppStore.getState().demands['changing-goal']?.title).toBe('Latest original title'))
})

it('an exact deletion while the startup catalog is in flight cannot be resurrected by that older catalog', async () => {
  await owner.create({ id: 'deleted-during-startup', title: 'Old startup entry' })
  const stale = await owner.list()
  let finish!: (value: typeof stale) => void
  vi.spyOn(api.demands, 'list').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(structuredClone(composerConfig))
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], recoveryCandidates: [], timelines: {} })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(input => spatial.retainDisplayLabels(input))
  const initializing = useAppStore.getState().initialize()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await owner.remove('deleted-during-startup')
  await vi.waitFor(() => expect(api.goals.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'demand.show', demandId: 'deleted-during-startup' })))
  await new Promise(resolve => setTimeout(resolve, 0))
  finish(stale); release = await initializing
  await vi.waitFor(() => expect(useAppStore.getState().loading).toBe(false))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(useAppStore.getState().demands['deleted-during-startup']).toBeUndefined()
})
