import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ScratchTopicSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'

const original = useAppStore.getState()
let dispose: (() => void) | undefined
function agent(id: string, path: string): SessionSnapshot {
  return { id, kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: path,
    label: id, processState: 'running', createdAt: 1, updatedAt: 2, latestOutputBytes: 0,
    status: { state: 'working', source: 'run-process', observedAt: 2 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'run-' + id } } }
}
afterEach(() => {
  dispose?.(); dispose = undefined
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(original, true)
})

type Scenario = { ordinary?: boolean; observedKind?: 'mote' | 'topic'; absent?: boolean; retained?: boolean; core?: boolean; retired?: boolean }
async function restore(scenario: Scenario = {}) {
  const scratch = { id: '__scratch__', hostId: 'local', path: _hygiene_fixturePath("private-fixture/agentmux/scratch"), name: 'Topics', kind: 'folder' as const }
  const project = { id: 'project', hostId: 'local', path: _hygiene_fixturePath("private-fixture/project"), name: 'Project', kind: 'folder' as const }
  const config = { ...(await api.config.get()), workspaces: [scratch, project] }
  const pmo = agent('pmo', scenario.ordinary ? project.path : _hygiene_fixturePath("private-fixture/agentmux/motes/0123456789abcdef"))
  const exec = agent('execution', project.path)
  const topic: ScratchTopicSnapshot = { id: 'launcher:custom-mote', kind: scenario.observedKind ?? 'mote', title: 'Original directory', summary: '',
    directoryPath: '0123456789abcdef', physicalDirectoryPath: pmo.workspacePath, confirmedDirectoryPaths: [pmo.workspacePath], topicPath: '0123456789abcdef/topic.md', collaborators: [] }
  const pmoTab = { ...createWorkbenchTab('mote-tab', { kind: 'agent', phase: 'attached', workspaceId: scratch.id, sessionId: pmo.id, regionId: 'mote-region' }), topicId: topic.id }
  const execTab = { ...createWorkbenchTab('execution-tab', { kind: 'agent', phase: 'attached', workspaceId: project.id, sessionId: exec.id, regionId: 'execution-region' }),
    space: { spaceId: JSON.stringify(['local', project.path]), zoneId: JSON.stringify([JSON.stringify(['local', project.path]), 'workspace', project.id]) } }
  const tabs = scenario.retained === false ? { [execTab.id]: execTab } : { [pmoTab.id]: pmoTab, [execTab.id]: execTab }
  const layouts = { [scratch.id]: createWorkspaceLayout('mote-group', scenario.retained === false ? [] : [pmoTab.id]), [project.id]: createWorkspaceLayout('execution-group', [execTab.id]) }
  const agentFocus = { execution: { sessionId: exec.id, history: [{ sessionId: exec.id, focusedAt: 123 }] }, pmo: { sessionId: pmo.id } }
  useAppStore.setState({ ...original, scratchTopicSnapshots: scenario.observedKind ? { [scratch.id]: {
    scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], reading: false, error: null } } : {} }, true)
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: { agentFocus, activeWorkspaceId: project.id,
    restoredWorkbench: projectPersistedWorkbench({ tabs, layouts }), mainSurface: 'agents', agentComposerDrafts: { [exec.id]: 'original unsent input' } } }))
  await useAppStore.persist.rehydrate()
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockResolvedValue(scenario.core ? { schemaVersion: 1, revision: 1,
    graph: desktopSpatialGraph({ ...original, config, tabs, layouts, sessions: [pmo, exec] }, [topic]) } : null)
  const sessions = scenario.absent || scenario.retired ? [exec] : [pmo, exec]
  const candidates = scenario.retired ? [{ ...pmo, agentSessionId: pmo.id, run: pmo.control.run,
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() - 1000 } }] : []
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions, timelines: {}, recoveryCandidates: candidates })
  // Directory discovery is deliberately pending; starting a healthy Agent is never its remedy.
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(() => new Promise(() => {}))
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  const operations = ['launchAgent', 'launchTerminal', 'recover', 'resume', 'stop', 'submitPrompt', 'write', 'interrupt', 'attach'] as const
  const lifecycle = Object.fromEntries(operations.map(name => [name, vi.spyOn(api.sessions, name)]))
  if (scenario.retired) lifecycle.recover.mockResolvedValue({ kind: 'retired' })
  dispose = await useAppStore.getState().initialize()
  const state = useAppStore.getState()
  expect(state.loading).toBe(false)
  if (!scenario.retired) {
    expect(Object.keys(state.tabs).sort()).toEqual(Object.keys(tabs).sort())
    for (const tab of Object.values(tabs)) expect(state.tabs[tab.id]).toMatchObject({ id: tab.id, regions: tab.regions, layout: tab.layout })
    expect(state.layouts).toEqual(layouts)
    // Exact baseline scene: no derived identity can conceal a lost original projection.
    if (!scenario.core && !scenario.observedKind && !scenario.absent && !scenario.ordinary) expect(state.tabs).toEqual(tabs)
  } else {
    expect(state.tabs[pmoTab.id]).toBeUndefined()
    expect(state.error).toMatch(/retired/)
  }
  expect(state.sessions.map(s => [s.id, s.control.run.runId])).toEqual(sessions.map(s => [s.id, s.control.run.runId]))
  expect(state.agentComposerDrafts[exec.id]).toBe('original unsent input')
  expect(state.agentFocus.execution).toEqual(agentFocus.execution)
  for (const name of operations) {
    if (scenario.retired && name === 'recover') expect(lifecycle[name]).toHaveBeenCalledTimes(1)
    else expect(lifecycle[name]).not.toHaveBeenCalled()
  }
  return state.agentFocus.pmo.sessionId
}

it('retains durable healthy PMO focus while its hashed Mote directory identity is unobserved', async () => {
  expect(await restore()).toBe('pmo')
})
it('retains the same PMO when original positions restore from Core spatial state', async () => {
  expect(await restore({ core: true })).toBe('pmo')
})
it('clears a wrongly stored PMO reference for a confirmed ordinary project execution Agent', async () => {
  expect(await restore({ ordinary: true })).toBeNull()
})
it('keeps a confirmed hashed Mote as coordination focus', async () => {
  expect(await restore({ observedKind: 'mote' })).toBe('pmo')
})
it('clears a wrongly stored PMO reference for a confirmed Topic execution Agent', async () => {
  expect(await restore({ observedKind: 'topic' })).toBeNull()
})
it('keeps an unobserved Session reference only when its original workface is retained', async () => {
  expect(await restore({ absent: true })).toBe('pmo')
})
it('does not resurrect an absent Session with no retained projection', async () => {
  expect(await restore({ absent: true, retained: false })).toBeNull()
})
it('honors explicit Core retirement of the original saved Agent', async () => {
  expect(await restore({ retired: true })).toBeNull()
})
