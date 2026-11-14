import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { HostMoteQuickPreferences } from '../../../host/src/mote-quick-preferences'
import { createHostMoteMainReader } from '../../../host/src/mote-dialogue'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { OrdinaryWorkspaceFiles } from '@agentmux/host/ordinary-files'
import { parseMoteQuickMode, serializeMoteQuickMode, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import type { AgentMuxControlRequest } from '@agentmux/core/control'
import { registerMotePreferencesIpc } from '../../src/main/mote-preferences-ipc'
import { WorkbenchUserStateStore } from '../../src/main/workbench-user-state'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { spatialCatalog as desktopCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { moteConnectionTarget } from '../../src/renderer/src/lib/mote-connection-default'
import { scratchTopicsScope } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { moteTopics, scratchWorkspace, quietMoteId } from '../fixtures/mote-workface'
import { initializeLauncherState, useLauncherState } from '../../src/renderer/src/lib/launcher-state'
import { desktopUserDocument } from '../../src/renderer/src/lib/desktop-user-state'

/** Real original Files/Host/IPC owners; only the Electron transport is in-process. */
export async function moteQuickOwner(options: { root?: string; restore?: boolean } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), 'amx-quick-owner-')))
  const closes: Array<() => Promise<unknown>> = options.root ? [] : [() => rm(root, { recursive: true, force: true })]
  try {
    const workspace = { ...scratchWorkspace, path: join(root, 'scratch') }
    const topics = moteTopics.map(topic => ({ ...topic, directoryPath: join(workspace.path, scratchTopicDirectoryName(topic.id)),
      topicPath: join(workspace.path, scratchTopicDirectoryName(topic.id), 'topic.md') }))
    const path = join(topics.find(topic => topic.id === quietMoteId)!.directoryPath, 'MOTE.md')
    const original = serializeMoteQuickMode('', { executorId: 'fixture' }) + '\n# Keep my cooperation notes.\n'
    if (!options.restore) for (const topic of topics) { await mkdir(topic.directoryPath, { recursive: true }); await writeFile(join(topic.directoryPath, 'MOTE.md'), original) }
    const state = useAppStore.getState()
    const config = { ...state.config!, workspaces: state.config!.workspaces.map(value => value.id === workspace.id ? workspace : value) }
    useAppStore.setState({ config, spaceZoneBindings: {},
      scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics, error: null, reading: false } },
      sessions: state.sessions.map(session => {
        const topic = 'workspacePath' in session ? moteTopics.find(item => session.workspacePath === item.directoryPath) : undefined
        return topic ? { ...session, workspacePath: topics.find(item => item.id === topic.id)!.directoryPath } : session
      }) })
    const refreshTopics = async () => Promise.all(topics.map(async topic => {
      const parsed = parseMoteQuickMode(await readFile(join(topic.directoryPath, 'MOTE.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }))
      return parsed.status === 'valid' ? { ...topic, quickMode: { status: 'saved' as const, defaults: parsed.defaults, version: 'fixture-topic-read' } } : topic
    }))
    vi.mocked(api.scratch.listTopics).mockImplementation(refreshTopics)
    vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => (await refreshTopics()).find(topic => topic.id === id) ?? null)
    const catalog = desktopCatalog(useAppStore.getState(), topics)
    const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
    if (!options.restore) await spatial.commit({ expectedRevision: 0, graph: { spaces: catalog.spaces, zones: catalog.zones, bindings: catalog.bindings,
      tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
    const sourceCatalog = async () => spatialCatalog((await spatial.read())!.graph)
    const ordinary = new OrdinaryWorkspaceFiles()
    const files = new FileReadOwner({ catalog: sourceCatalog, workspace: id => config.workspaces.find(value => value.id === id),
      files: { read: ordinary.read.bind(ordinary), listFiles: ordinary.listFiles.bind(ordinary), write: ordinary.write.bind(ordinary) } })
    const configurationPath = join(root, 'configuration.json'); if (!options.restore) await writeFile(configurationPath, JSON.stringify(config))
    const nativePath = join(root, 'workbench-user-state.json'), user = new WorkbenchUserStateStore(nativePath)
    const nativeReads = vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
    vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(raw => user.importIfAbsent(raw))
    const nativeWrites = vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => user.write(raw))
    vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
    await initializeLauncherState()
    if (!options.restore) useLauncherState.setState({ drafts: {} })
    closes.push(async () => { await desktopUserDocument.persistent.flush() })
    const main = createHostMoteMainReader({ configurationPath, spatial, files })
    const discovery = {
      catalog: vi.fn(async (): Promise<ReturnType<typeof desktopCatalog>> => desktopCatalog(useAppStore.getState(), topics)),
      executors: vi.fn(async () => [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }])
    }
    const owner = new HostMoteQuickPreferences({ files, main, catalog: () => discovery.catalog(), executors: () => discovery.executors() })
    const host = new AgentMuxControlServer({ socketPath: join(root, 'host.sock'), spatialState: spatial, coreClients: () => [], moteQuickPreferences: owner })
    await host.start(); closes.push(() => host.stop())
    const hostClient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path } })
    closes.push(() => hostClient.dispose())
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    registerMotePreferencesIpc({ socketPath: host.path, handleWithEvent: (channel, handler) => { handlers.set(channel, handler) },
      runtime: {
        callOriginalCore: (_hostId, method, params) => hostClient.call(method, params),
        connectionHostingTarget: async () => { throw new Error('Connector hosting discovery is outside this original Quick fixture') },
        callConnectionHost: async () => { throw new Error('Connection preferences are outside this original Quick fixture') },
        watchConnectionMetadata: async () => { throw new Error('Connection metadata is outside this original Quick fixture') }
      } })
    const reads = vi.spyOn(api.motePreferences, 'read').mockImplementation(input => handlers.get('motePreferences:read')!({ sender: {} }, input) as ReturnType<typeof api.motePreferences.read>)
    const saves = vi.spyOn(api.motePreferences, 'save').mockImplementation(input => handlers.get('motePreferences:save')!({ sender: {} }, input) as ReturnType<typeof api.motePreferences.save>)
    const requests: AgentMuxControlRequest[] = []
    const desktop = new AgentMuxControlServer({ socketPath: join(root, 'desktop.sock'), spatialState: spatial, coreClients: () => [],
      execute: async request => { requests.push(request); return useAppStore.getState().executeControl(request) } })
    await desktop.start(); closes.push(() => desktop.stop())
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
    closes.push(() => client.dispose())
    const topic = topics.find(value => value.id === quietMoteId)!
    const scope = { workspace, topic, rootPath: scratchTopicDirectoryName(quietMoteId) }
    const target = moteConnectionTarget(scope, {})!
    return { root, path, original, workspace, topics, scope, target, owner, files, main, discovery, reads, saves, client, requests,
      user, nativePath, nativeReads, nativeWrites,
      disconnect: () => hostClient.dispose(),
      bytes: () => readFile(path, 'utf8'), async close() { for (const close of closes.splice(0).reverse()) await close() } }
  } catch (error) { for (const close of closes.splice(0).reverse()) await close(); throw error }
}
export type MoteQuickOwnerFixture = Awaited<ReturnType<typeof moteQuickOwner>>
