import { act } from 'react'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import type { MoteConnectionPreferencesReadResult, MoteConnectionPreferencesSaveParams } from '@agentmux/core/mote-preferences'
import type { ConnectionResultMap } from '@agentmux/core/connections'
import { createConnectionServices } from '../../../../packages/connectors/src/connection-services.js'
import { MoteConnectionPreferences } from '@agentmux/host/mote-connection-preferences'
import { registerMotePreferencesIpc } from '../../src/main/mote-preferences-ipc'
import { registerConnectorIpc } from '../../src/main/connector-ipc'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../../src/main/workspace-files'
import { directoryIdentity, homeZoneId } from '../../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { api } from '../../src/renderer/src/lib/api'
import { unwrapSessionInputOperationResult } from '../../src/shared/session-input-result'
import type { SessionInputOperationResult } from '../../src/shared/contracts'
import { useAppStore } from '../../src/renderer/src/store'
import { createMoteApp, moteClick, settleMoteApp } from './mote-app'
import { moteTopics, moteConfig } from './mote-workface'
import { runCompiledObjectCli, objectCliEnvironment } from '../../../../packages/core/test/helpers/object-cli-rpc.js'

/** Original App/Profile/Agent menus -> trusted IPC -> public Core -> Main/Files/Connection Host. */
export async function moteConnectionJourney() {
  const root = await mkdtemp(join(tmpdir(), 'amx-mote-choice-'))
  const workspace = { ...moteConfig.workspaces[0]!, path: root }
  // Exercise the loaded workface while the separate startup availability read finishes.
  const config = { ...moteConfig, startup: { skipAgentAvailabilityCheckWait: true },
    workspaces: [workspace, ...moteConfig.workspaces.slice(1)] }
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  await useAppStore.persist.rehydrate()
  const stop = await useAppStore.getState().initialize(); stop()
  const app = createMoteApp()
  const topics = moteTopics.map(topic => ({ ...topic, directoryPath: join(root, scratchTopicDirectoryName(topic.id)),
    topicPath: join(root, scratchTopicDirectoryName(topic.id), 'topic.md') }))
  for (const topic of topics) { await mkdir(topic.directoryPath); await writeFile(join(topic.directoryPath, 'MOTE.md'), '---\nversion: 1\ndefaults: {}\n---\n# Original notes\n') }
  useAppStore.setState({ config, toolsOpen: true, moteConnectionSaveIntents: {}, spaceZoneBindings: {},
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics, error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  const motes = topics.filter(topic => !!topic.soul).map(topic => ({ ...topic,
    spaceId: directoryIdentity(workspace.hostId, topic.directoryPath), zoneId: homeZoneId(directoryIdentity(workspace.hostId, topic.directoryPath)) }))
  const graph = { spaces: motes.map(mote => ({ spaceId: mote.spaceId, kind: 'mote' as const, name: mote.title,
    hostId: workspace.hostId, directoryPath: mote.directoryPath, projectId: null, topicId: mote.id })),
    zones: motes.map(mote => ({ zoneId: mote.zoneId, workspaceId: workspace.id, kind: 'home' as const, hostId: workspace.hostId, directoryPath: mote.directoryPath, branch: null })),
    bindings: motes.map(mote => ({ spaceId: mote.spaceId, zoneId: mote.zoneId })), tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph })
  const catalog = async () => spatialCatalog((await spatial.read())!.graph)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const writer = new NoteFileWriter(files)
  const publicFiles = new FileReadOwner({ catalog, workspace: id => id === workspace.id ? workspace : undefined,
    files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), write: writer.write.bind(writer) } })
  const services = await createConnectionServices({ directory: join(root, 'connections'), bindings: { spatial, checkpoint: async () => { throw new Error('This read-only menu does not bind or grant access') } } })
  for (const suffix of ['a', 'b']) await services.connections.configure({ operationId: 'configure-' + suffix, expectedRevision: null, connection: {
    connectionId: 'robot-' + suffix, adapterId: 'feishu', application: { domain: 'feishu.cn', appId: 'app-' + suffix },
    label: 'Robot ' + suffix.toUpperCase(), enabled: true, credentialRef: 'unused-' + suffix
  } })
  const owner = new MoteConnectionPreferences({ files: publicFiles, catalog, connections: () => services.connections.list() })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'public.sock'), files: publicFiles, connections: services.connections,
    motePreferences: owner, coreClients: () => [] })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), trusted = {}
  const handleWithEvent = (channel: string, handler: (...args: any[]) => Promise<unknown>) => { handlers.set(channel, handler) }
  const assertTrusted = (_channel: string, event: { sender: object }) => { if (event.sender !== trusted) throw new Error('Untrusted renderer') }
  const hostingTarget = { hostId: 'local', runtimeId: 'fixture-runtime' }
  const runtime: import('../../src/main/connection-host-ipc').ConnectionHostIpc = {
    connectionHostingTarget: async () => structuredClone(hostingTarget),
    callConnectionHost: async (_target, method, params) => client.call(method, params),
    watchConnectionMetadata: async (_target, handlers) => client.subscribe('connection.metadata.watch', {}, handlers)
  }
  registerMotePreferencesIpc({ socketPath: server.path, runtime, handleWithEvent, assertTrusted })
  registerConnectorIpc({ runtime, handleWithEvent, assertTrusted, metadata: { publish() {}, observation() {} } })
  vi.spyOn(api.connections, 'hostingTarget').mockImplementation(hostId => runtime.connectionHostingTarget(hostId))
  const forwardRead = async (input: Parameters<typeof api.motePreferences.read>[0], target?: import('../../src/shared/contracts').ConnectionHostingTarget) => await handlers.get('motePreferences:read')!({ sender: trusted }, input, target)
  const forwardSave = async (input: MoteConnectionPreferencesSaveParams, target?: import('../../src/shared/contracts').ConnectionHostingTarget) => await handlers.get('motePreferences:save')!({ sender: trusted }, input, target)
  const reads = vi.spyOn(api.motePreferences, 'read').mockImplementation(forwardRead)
  const saves = vi.spyOn(api.motePreferences, 'save').mockImplementation(forwardSave)
  const connections = vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => {
    const envelope = structuredClone(await handlers.get('connections:call')!({ sender: trusted }, method, input, target)) as SessionInputOperationResult<ConnectionResultMap[typeof method]>
    return unwrapSessionInputOperationResult(envelope)
  })
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const target = (index = 0) => ({ spaceId: motes[index]!.spaceId, zoneId: motes[index]!.zoneId,
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } })
  async function button(label: string) {
    let found: HTMLButtonElement | undefined
    await vi.waitFor(async () => {
      await act(async () => {})
      found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
      expect(found, label).toBeDefined(); expect(found!.disabled, label).toBe(false)
    })
    const folded: HTMLDetailsElement[] = []
    for (let parent = found!.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement && !parent.open) folded.push(parent)
    for (const details of folded.reverse()) await moteClick(details.querySelector('summary')!)
    await moteClick(found!)
  }
  async function choose(label: string, accessibleName = 'Mote chat bot') {
    const options = document.querySelector<HTMLDetailsElement>('.mote-identity-options')
    if (accessibleName === 'Mote chat bot' && options && !options.open) await moteClick(options.querySelector('summary')!)
    const disclosure = document.querySelector<HTMLDetailsElement>('.mote-bot-existing')
    if (accessibleName === 'Mote chat bot' && disclosure && !disclosure.open) await moteClick(disclosure.querySelector('summary')!)
    await moteClick(document.querySelector<HTMLButtonElement>('[aria-label="' + accessibleName + '"]')!)
    await vi.waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes(label)), document.body.textContent).toBeDefined())
    await moteClick([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes(label))!)
  }
  return { app, root, config, topics, motes, target, hostingTarget, services, client, reads, saves, connections, forwardRead, forwardSave, button, choose,
    path: (index = 0) => join(motes[index]!.directoryPath, 'MOTE.md'),
    read: async (index = 0) => await client.call('space.mote.preferences.read', { kind: 'connection', target: target(index) }) as MoteConnectionPreferencesReadResult,
    async cliRead(index = 0) {
      const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'space', 'mote', 'preferences', 'read', '--input', '-'], objectCliEnvironment(root), JSON.stringify({ kind: 'connection', target: target(index) }))
      expect(output.code, output.stderr).toBe(0); return JSON.parse(output.stdout).result as MoteConnectionPreferencesReadResult
    },
    async mount() { await app.mount(); await vi.waitFor(() => expect(document.querySelector('.mote-connection__row')).not.toBeNull()) },
    async open() { await moteClick(document.querySelector<HTMLButtonElement>('.mote-connection__row')!); await settleMoteApp() },
    async dispose() { await app.dispose(); client.dispose(); await server.stop(); services.close(); files.dispose(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() },
    bytes: async (index = 0) => await readFile(join(motes[index]!.directoryPath, 'MOTE.md'), 'utf8')
  }
}
