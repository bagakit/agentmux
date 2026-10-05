import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { vi } from 'vitest'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { beginRendererStartup } from '../../src/renderer/src/lib/startup-progress'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../src/renderer/src/lib/desktop-spatial-state'
import { composerConfig } from './composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './startup-observation-api-fixture'
import type { AppConfig, RuntimeSnapshot } from '../../src/shared/contracts'

const actions = useAppStore.getState()
export const disposalTarget = { tabId: 'opening', regionId: 'opening-region' }
export const disposalConfig = (path: string): AppConfig => ({ ...structuredClone(composerConfig), executors: {},
  hosts: [{ id: 'local', kind: 'local' as const, label: 'Private callback proof' }],
  workspaces: [{ id: 'private', kind: 'folder' as const, hostId: 'local', name: 'Private callback proof', path }] })

/** Calls actual initialize; adapters only supply its public filesystem/config/native ports. */
export async function initializeDisposal(path: string, snapshot?: () => Promise<RuntimeSnapshot>) {
  const config = disposalConfig(path)
  const tab = createWorkbenchTab(disposalTarget.tabId, { regionId: disposalTarget.regionId, kind: 'launcher', workspaceId: 'private' })
  const recovery = createWorkbenchTab('recovery', { regionId: 'recovery-region', kind: 'launcher', workspaceId: 'private' })
  useAppStore.setState({ config, loading: true, restoredWorkbench: null, activeWorkspaceId: 'private',
    tabs: { opening: tab, recovery }, layouts: { private: createWorkspaceLayout('private-group', ['opening', 'recovery']) },
    sessions: [], warmTerminal: null, unclaimedTerminalSessionIds: [], closingWorkbenchViews: {},
    agentNames: {}, agentComposerDrafts: { 'opening-region': 'Retain private draft' }, agentSteerQueues: {},
    spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [],
    workbenchSpaceSelection: null, prewarmTerminal: actions.prewarmTerminal, retryWarmTerminal: actions.retryWarmTerminal,
    promoteWarmTerminal: actions.promoteWarmTerminal, launchTerminal: actions.launchTerminal,
    detectExecutors: vi.fn(async () => {}) })
  const spatial = new AgentMuxSpatialStateStore(path + '/callback-spatial-' + crypto.randomUUID() + '.json')
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockImplementation(snapshot ?? (async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })))
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.notesStorage, 'inspect').mockResolvedValue({ directory: path + '/notes', catalogPath: path + '/notes/notebooks.json', resourceChanges: [], directoryChanges: [], operation: null })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(async () => (await spatial.read())!)
  const dispose = await beginRendererStartup(useAppStore.getState().initialize)
  return { dispose, spatial, config }
}

export function removeOpeningPresentation() {
  const { opening: _closed, ...remaining } = useAppStore.getState().tabs
  useAppStore.setState({ tabs: remaining, layouts: { private: createWorkspaceLayout('private-group', ['recovery']) } })
}
