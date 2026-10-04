// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { moteConfig, moteTopics, moteTabs, moteSessions, neighborAgent, neighborTab, customAgent, customTab, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { MoteRecoveryTiming } from '../src/shared/mote-quick-mode'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'

const baseline = useAppStore.getState()
let directory: string, dispose: (() => void) | undefined, originalLayout: ReturnType<typeof createWorkspaceLayout>, event: (event: RuntimeEvent) => void
async function fixture(timing: MoteRecoveryTiming, main: boolean) {
  const selected = main ? neighborAgent : customAgent, tab = main ? neighborTab : customTab
  const conversation = { hostId: selected.control.hostId, sessionId: selected.control.agentSessionId, displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'original-group', tabId: tab.id, regionId: tab.layout.activeRegionId }
  const topics = moteTopics.map(topic => ({ ...topic, quickMode: topic.id === tab.topicId ? { status: 'saved' as const, defaults: { conversation, recovery: timing }, version: 'startup' } : { status: 'missing' as const } }))
  const ended = { ...selected, processState: 'exited' as const, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() } }
  const sessions: SessionSnapshot[] = moteSessions.map(session => session.id === selected.id ? ended : session)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  if (!vi.isMockFunction(api.scratch.ensureMote)) vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions, recoveryCandidates: [], timelines: {} })
  const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async control => ({ kind: 'resumed', session: { ...selected, control: { ...selected.control, run: { runId: 'original-resumed-run' } } } }))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const state = useAppStore.getState()
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...state, config: moteConfig, tabs: moteTabs, layouts: { [SCRATCH_WORKSPACE_ID]: originalLayout }, sessions }, []) })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  dispose = await useAppStore.getState().initialize()
  for (let i = 0; i < 20 && !useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics; i++) await new Promise(resolve => setTimeout(resolve, 10))
  await new Promise(resolve => setTimeout(resolve, 20))
  return { selected, tab, recover, sessions }
}
beforeEach(async () => {
  useAppStore.setState(baseline, true); seedMoteWorkface({ directory: false })
  originalLayout = createWorkspaceLayout('original-group', Object.keys(moteTabs))
  useAppStore.setState({ restoredWorkbench: { tabs: moteTabs, layouts: { [SCRATCH_WORKSPACE_ID]: originalLayout } }, loading: true })
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(moteConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { event = listener; return () => {} })
  directory = await mkdtemp(join(tmpdir(), 'mote-original-startup-'))
})
afterEach(async () => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); useAppStore.setState(baseline, true); await rm(directory, { recursive: true, force: true }) })
it('actual initialize restores original workface before mandatory Main continuity', async () => {
  const f = await fixture('on-open', true)
  expect(useAppStore.getState().loading).toBe(false); expect(f.recover).toHaveBeenCalledTimes(1)
  expect(f.recover).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: f.selected.control.agentSessionId }), f.selected.workspacePath, expect.any(String))
  expect(useAppStore.getState().tabs[f.tab.id]?.regions[f.tab.layout.activeRegionId]).toMatchObject({ sessionId: f.selected.id })
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toEqual(originalLayout)
})
it('actual initialize and later canonical membership do not resume an on-open fixed conversation through the old 24-hour policy', async () => {
  const f = await fixture('on-open', false); expect(f.recover).not.toHaveBeenCalled()
  event({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: 'late-foreign-agent', state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() } } })
  await new Promise(resolve => setTimeout(resolve, 80)); expect(f.recover).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[f.tab.id]?.regions[f.tab.layout.activeRegionId]).toMatchObject({ sessionId: f.selected.id })
})
it('actual initialize uses the optional startup choice exactly once and keeps healthy neighbors', async () => {
  const f = await fixture('startup', false); expect(f.recover).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions.find(session => session.id === neighborAgent.id)?.control).toEqual(neighborAgent.control)
})

it('a failed metadata ensure still reads the original directory and reconnects its confirmed Main conversation', async () => {
  vi.spyOn(api.scratch, 'ensureMote').mockRejectedValue(new Error('Metadata ensure failed'))
  const f = await fixture('on-open', true)
  expect(f.recover).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().tabs[f.tab.id]?.regions[f.tab.layout.activeRegionId]).toMatchObject({ sessionId: f.selected.id })
})
