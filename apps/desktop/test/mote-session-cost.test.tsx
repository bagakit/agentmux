// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { customAgent, customMoteId, defaultAgent, neighborAgent, moteAgent, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { MoteCurrentWork } from '../src/renderer/src/components/MoteCurrentWork'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as moteGoals from '../src/renderer/src/lib/mote-goals'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'

const original = useAppStore.getState()
const scope = { workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!, rootPath: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) }
let root: Root, container: HTMLDivElement, renders: number
const goal: DemandRecord = { id: 'original-goal', title: 'Original linked work', description: '', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, sessionIds: [defaultAgent.id, neighborAgent.id], createdAt: 1, updatedAt: 2, source: 'session' }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedMoteWorkface()
  useAppStore.setState(state => ({ demands: { [goal.id]: goal }, sessions: [...state.sessions,
    ...Array.from({ length: 80 }, (_, index) => moteAgent('unrelated-' + index, null))] }))
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container); renders = 0
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(original, true); vi.restoreAllMocks() })
async function mount(expand = false) {
  await act(async () => root.render(<Profiler id="current-work" onRender={() => { renders += 1 }}><MoteCurrentWork scope={scope} reference={null} /></Profiler>))
  expect(container.querySelector('[data-mote-goal="original-goal"]')).not.toBeNull()
  if (expand) await act(async () => container.querySelector<HTMLButtonElement>('.mote-current-work__copy')!.click())
  if (expand) expect(container.querySelector('[aria-label="Goal continuation Agent"]')).not.toBeNull()
  renders = 0
}
async function update(id: string, patch: Partial<typeof defaultAgent>) {
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, ...patch } : session) })))
}
describe('original Mote Current work and expanded Goal consumer cost', () => {
  it('keeps the original scope composition when the directory observation is unavailable', () => {
    seedMoteWorkface({ directory: false })
    const retained = { workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === customMoteId)!, rootPath: scratchTopicDirectoryName(customMoteId) }
    expect(moteGoals.moteGoalContext(useAppStore.getState(), retained, null).sessionIds).toEqual([customAgent.id])
    expect(moteGoals.moteGoalContext(useAppStore.getState(), retained, null).selectedSessionId).toBeUndefined()
  })
  it('does not rebuild membership or repaint for repeated unrelated Session/name/timeline changes', async () => {
    await mount(true)
    const context = vi.spyOn(moteGoals, 'moteGoalContext')
    const tabs = useAppStore.getState().tabs, drafts = useAppStore.getState().agentComposerDrafts
    for (let index = 0; index < 30; index += 1) {
      await update('unrelated-' + index, { updatedAt: index + 10, label: 'Other ' + index })
      await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, ['unrelated-' + index]: 'Renamed elsewhere' },
        timelines: { ...state.timelines, ['unrelated-' + index]: { agentSessionId: 'unrelated-' + index, items: [], revision: index + 1 } } })))
    }
    expect(context).not.toHaveBeenCalled(); expect(renders).toBe(0)
    expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  })
  it('updates actual linked labels and membership without observing unrelated status bookkeeping', async () => {
    await mount(true)
    const context = vi.spyOn(moteGoals, 'moteGoalContext')
    await update(defaultAgent.id, { updatedAt: 10 })
    expect(renders).toBe(0); expect(context).not.toHaveBeenCalled()
    await update(defaultAgent.id, { label: 'Original member renamed' })
    expect(container.querySelector('[aria-label="Goal continuation Agent"]')!.textContent).toContain('Original member renamed')
    expect(renders).toBeGreaterThan(0); expect(context).not.toHaveBeenCalled()
    await update(defaultAgent.id, { control: { ...defaultAgent.control, agentSessionId: 'wrong-original-agent' } })
    expect(container.querySelector('[aria-label="Goal continuation Agent"]')!.textContent).not.toContain('Original member renamed')
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== neighborAgent.id) })))
    expect(container.textContent).toContain('1 linked discussion not loaded. Original references retained.')
    expect(container.querySelector('[data-mote-goal="original-goal"]')).not.toBeNull()
  })
})
