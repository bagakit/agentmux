// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchInput, AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
let directory: string, dispose: (() => void) | undefined
afterEach(async () => {
  dispose?.(); dispose = undefined
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
  localStorage.clear()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function startingAgent() {
  directory = await mkdtemp(join(tmpdir(), 'amx-launch-spatial-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'project', name: 'Project', hostId: 'local', path: directory, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  const snapshot = await api.sessions.snapshot()
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: [], recoveryCandidates: [], timelines: {} })
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'launcher', workspaceId: 'project' })
  const work = { config, sessions: [], tabs: { [tab.id]: tab },
    layouts: { project: createWorkspaceLayout('group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(work, []) })
  useAppStore.setState({ ...work, restoredWorkbench: { tabs: work.tabs, layouts: work.layouts },
    pendingAgentLaunches: {}, agentComposerDrafts: { 'original-region': 'Original request' } })
  dispose = await useAppStore.getState().initialize()
  await useAppStore.getState().retryWorkbenchSave()
  let release!: (value: AgentLaunchResult) => void, reject!: (error: Error) => void, input!: AgentLaunchInput
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(request => {
    input = request
    return new Promise((resolve, fail) => { release = resolve; reject = fail })
  })
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  const completion = useAppStore.getState().launchAgent('codex', 'Original request', 'group',
    { tabId: tab.id, regionId: 'original-region' }).then(() => null, error => error as Error & { code?: string })
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
  const id = input.agentSessionId!
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id, kind: 'agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: directory, label: 'Original Agent', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run' } } }
  return { spatial, id, input, launch, stop, completion, reject, finish() {
    release({ created: { kind: 'agent', agentSessionId: id, providerId: session.providerId, executorId: session.executorId,
      hostId: session.hostId, workspacePath: directory, run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 1 },
      session, timeline: { agentSessionId: id, revision: 0, items: [] }, projectionFailures: [] })
  } }
}

it.each(['save-ack', 'remote-update'] as const)('keeps the original pending Region across %s and opens that Agent in Focus', async trigger => {
  const work = await startingAgent()
  const before = useAppStore.getState().tabs['original-tab']!.regions['original-region']!
  expect(before).toMatchObject({ kind: 'agent', phase: 'launching', sessionId: work.id })
  await useAppStore.getState().retryWorkbenchSave()
  if (trigger === 'remote-update') {
    await work.spatial.mutateDisplayLabel({ target: { kind: 'tab', id: 'original-tab' }, operationId: 'independent-name',
      expectedNameRevision: 0, value: 'Independent name', source: 'manual' },
      { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
        entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } })
    expect(useAppStore.getState().tabs['original-tab']!.name).toBe('Independent name')
  }
  expect(useAppStore.getState().tabs['original-tab']!.regions['original-region']).toBe(before)
  expect(useAppStore.getState().agentComposerDrafts['original-region']).toBe('Original request')
  expect(useAppStore.getState().pendingAgentLaunches[work.id]?.request?.createOperationId).toBe(work.input.createOperationId)
  work.finish()
  expect(await work.completion).toBeNull()
  await useAppStore.getState().retryWorkbenchSave()
  expect(useAppStore.getState().tabs['original-tab']!.regions['original-region']).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: work.id })
  expect(useAppStore.getState().focusExecutionSession(work.id)).toBe(true)
  expect(work.launch).toHaveBeenCalledTimes(1)
  expect(work.stop).not.toHaveBeenCalled()
})

it.each(['launcher-target', 'file', 'agent', 'moved', 'removed'] as const)('applies an explicit %s replacement without reviving the old pending surface', async replacement => {
  const work = await startingAgent()
  await useAppStore.getState().retryWorkbenchSave()
  const saved = (await work.spatial.readForLayout())!
  const graph = structuredClone(saved.graph)
  if (replacement === 'launcher-target') graph.resources['region:original-region'] = { workspaceId: 'project', executorId: 'another-executor' }
  else if (replacement === 'file') {
    graph.regions[0]!.kind = 'file'
    graph.resources['region:original-region'] = { workspaceId: 'project', path: 'original.md' }
  } else if (replacement === 'agent') {
    Object.assign(graph.regions[0]!, { kind: 'agent', agentSessionId: 'another-session', runId: 'another-run',
      execution: { hostId: 'local', cwd: directory } })
    graph.resources['region:original-region'] = { workspaceId: 'project', phase: 'attached',
      agentPresentation: { sessionId: 'another-session', agentSessionId: 'another-session', hostId: 'local' } }
  } else if (replacement === 'moved') {
    graph.tabs[0]!.tabId = 'destination-tab'
    graph.regions[0]!.tabId = 'destination-tab'
    graph.tabLayouts['destination-tab'] = graph.tabLayouts['original-tab']!
    graph.resources['tab:destination-tab'] = graph.resources['tab:original-tab']!
    delete graph.tabLayouts['original-tab']; delete graph.resources['tab:original-tab']
    graph.layouts.project = createWorkspaceLayout('group', ['destination-tab'])
  } else {
    graph.tabs = []; graph.regions = []; graph.tabLayouts = {}
    graph.layouts.project = createWorkspaceLayout('group', [])
    delete graph.resources['tab:original-tab']; delete graph.resources['region:original-region']
  }
  await work.spatial.commit({ expectedRevision: saved.revision, graph, allowEntityRemoval: replacement === 'removed' || replacement === 'moved' })
  const surface = useAppStore.getState().tabs['original-tab']?.regions['original-region']
  if (replacement === 'launcher-target') expect(surface).toMatchObject({ kind: 'launcher', executorId: 'another-executor' })
  else if (replacement === 'file') expect(surface).toMatchObject({ kind: 'file', path: 'original.md' })
  else if (replacement === 'agent') expect(surface).toMatchObject({ kind: 'agent', sessionId: 'another-session' })
  else expect(surface).toBeUndefined()
  if (replacement === 'moved') expect(useAppStore.getState().tabs['destination-tab']!.regions['original-region']).toMatchObject({ kind: 'launcher' })
  work.finish()
  expect(await work.completion).toMatchObject({ code: 'CONTROL_OWNER_LOST' })
  expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toEqual(surface)
  expect(useAppStore.getState().sessions).toContainEqual(expect.objectContaining({ id: work.id, processState: 'running' }))
  expect(work.stop).not.toHaveBeenCalled()
  expect(work.launch).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'not_applied'] as const)('retains the original %s outcome after a spatial ACK', async disposition => {
  const work = await startingAgent()
  await useAppStore.getState().retryWorkbenchSave()
  work.reject(Object.assign(new Error('Original creation outcome'), { controlFailure: { disposition, confirmedInputBytes: null } }))
  expect(await work.completion).toBeInstanceOf(Error)
  const surface = useAppStore.getState().tabs['original-tab']!.regions['original-region']!
  expect(surface.kind).toBe(disposition === 'unknown' ? 'agent' : 'launcher')
  expect(useAppStore.getState().agentComposerDrafts['original-region']).toBe('Original request')
  expect(work.launch).toHaveBeenCalledTimes(1)
  expect(work.stop).not.toHaveBeenCalled()
})
