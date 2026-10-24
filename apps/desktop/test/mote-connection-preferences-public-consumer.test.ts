import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
const rendererFiles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), observe: vi.fn(), unobserve: vi.fn(), onInvalidated: () => () => {} }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { files: rendererFiles } }))
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { moteConnectionBaseline, parseMotePreferencesReadResult, parseMotePreferencesSaveParams, parseMotePreferencesSaveResult,
  type MoteConnectionPreferencesSaveParams, type MoteConnectionValues } from '@agentmux/core/mote-preferences'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { MoteConnectionPreferences } from '@agentmux/host/mote-connection-preferences'
import { registerMotePreferencesIpc, type MotePreferencesIpcChannel } from '../src/main/mote-preferences-ipc'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'
import type { IpcMainInvokeEvent } from 'electron'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { parseMoteQuickMode, serializeMoteQuickMode, parseMoteConnectionMode, serializeMoteConnectionMode } from '../src/shared/mote-quick-mode'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'

const clean: Array<() => void | Promise<void>> = [], initialState = useAppStore.getState()
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); useAppStore.setState(initialState, true); vi.restoreAllMocks() })
const values: MoteConnectionValues = { connection: { connectionId: 'original-robot', application: { domain: 'feishu.cn', appId: 'app-original' } } }
const original = '\uFEFF---\r\nversion: 1 # format comment\r\ncustom: keep\r\ndefaults:\r\n  executorId: original-executor\r\n  other: retained\r\n---\r\n# 原正文\r\n保留全部笔记。\r\n'

async function fixture(fault?: 'receipt' | 'occupy') {
  const root = await mkdtemp(join(tmpdir(), 'amx-mote-connection-')); clean.push(() => rm(root, { recursive: true, force: true }))
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Original Motes', path: root, hostId: 'local', kind: 'folder' as const }
  const motes = ['one', 'two'].map(topicId => {
    const directoryPath = join(root, topicId), spaceId = directoryIdentity('local', directoryPath)
    return { topicId, directoryPath, spaceId, zoneId: homeZoneId(spaceId) }
  })
  for (const mote of motes) { await mkdir(mote.directoryPath); await writeFile(join(mote.directoryPath, 'MOTE.md'), original) }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: motes.map(mote => ({ spaceId: mote.spaceId, kind: 'mote', name: 'Same Mote name', hostId: 'local', directoryPath: mote.directoryPath, projectId: null, topicId: mote.topicId })),
    zones: motes.map(mote => ({ zoneId: mote.zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: mote.directoryPath, branch: null })),
    bindings: motes.map(mote => ({ spaceId: mote.spaceId, zoneId: mote.zoneId })), tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const catalog = async () => spatialCatalog((await spatial.read())!.graph)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, fault ? { localWriteFault: fault } : {})
  clean.push(() => files.dispose())
  // The production Note wrapper delegates MOTE.md unchanged to this exact Files instance.
  const noteWriter = new NoteFileWriter(files)
  const publicFiles = new FileReadOwner({ catalog, workspace: id => id === workspace.id ? workspace : undefined,
    files: { read: noteWriter.read.bind(noteWriter), listFiles: files.listFiles.bind(files), write: noteWriter.write.bind(noteWriter) } })
  const connections = await createConnectionServices({ directory: join(root, 'connections') })
  clean.push(() => connections.close())
  await connections.connections.configure({ operationId: 'configure-original', expectedRevision: null, connection: {
    connectionId: values.connection!.connectionId, adapterId: 'feishu', application: values.connection!.application,
    label: 'Saved robot', enabled: false, credentialRef: 'original-credential-reference'
  } })
  const quick = vi.fn(async () => { throw new Error('Only Quick preferences may require the original Renderer') })
  const owner = new MoteConnectionPreferences({ files: publicFiles, catalog, connections: () => connections.connections.list() })
  const coreClients = vi.fn(() => { throw new Error('Preference edits cannot start or borrow an Agent') })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'public.sock'), files: publicFiles, connections: connections.connections, motePreferences: owner,
    execute: request => {
      if ((request.operation === 'space.mote.preferences.read' || request.operation === 'space.mote.preferences.save') && request.kind === 'quick') return quick()
      throw new Error('Unrelated control operation')
    }, coreClients })
  await server.start(); clean.push(() => server.stop())
  const trusted = {}, handlers = new Map<MotePreferencesIpcChannel, (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>>()
  registerMotePreferencesIpc({ socketPath: server.path, runtime: { connectionHostingTarget: async () => ({ hostId: 'local', runtimeId: 'fixture-runtime' }),
    callConnectionHost: async (_target, method, params) => client.call(method, params),
    watchConnectionMetadata: async (_target, handlers) => client.subscribe('connection.metadata.watch', {}, handlers) }, handleWithEvent: (channel, handler) => { handlers.set(channel, handler) },
    assertTrusted: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, trusted)) })
  const ipc = (channel: MotePreferencesIpcChannel, params: unknown, sender = trusted) => handlers.get(channel)!({ sender } as IpcMainInvokeEvent, params)
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); clean.push(() => client.dispose())
  const target = (index = 0) => ({ spaceId: motes[index]!.spaceId, zoneId: motes[index]!.zoneId,
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } })
  const read = async (index = 0) => parseMotePreferencesReadResult(await client.call('space.mote.preferences.read', { kind: 'connection', target: target(index) }), { kind: 'connection', target: target(index) })
  const intent = async (operationId = 'save-original', chosen = values, index = 0): Promise<MoteConnectionPreferencesSaveParams> => ({
    kind: 'connection', target: target(index), operationId, baseline: moteConnectionBaseline(await read(index))!, values: chosen
  })
  const save = async (input: MoteConnectionPreferencesSaveParams) => parseMotePreferencesSaveResult(await client.call('space.mote.preferences.save', input), input)
  const nativeWrite = files.write.bind(files), writes = vi.spyOn(files, 'write')
  const cli = async (action: 'read' | 'save', input: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'space', 'mote', 'preferences', action, '--input', '-'], objectCliEnvironment(root), JSON.stringify(input))
    return { ...result, body: JSON.parse(result.stdout) }
  }
  return { root, workspace, motes, target, read, intent, save, writes, nativeWrite, files, publicFiles, owner, quick, coreClients, client, cli, ipc, spatial,
    path: (index = 0) => join(motes[index]!.directoryPath, 'MOTE.md') }
}

it('SDK and actual compiled CLI save the same original Main file without a Renderer, destination or Agent', async () => {
  const f = await fixture(), input = await f.intent()
  const saved = await f.save(input)
  expect(saved).toMatchObject({ kind: 'connection', operationId: input.operationId, status: 'saved', source: { values } })
  expect(f.writes).toHaveBeenCalledTimes(1)
  const cliRead = await f.cli('read', { kind: 'connection', target: f.target() })
  expect(cliRead.code, cliRead.stderr).toBe(0); expect(cliRead.body.result).toMatchObject({ kind: 'connection', status: 'ready', values })
  const cliSave = await f.cli('save', await f.intent('clear-explicit', { connection: null }))
  expect(cliSave.code, cliSave.stderr).toBe(0); expect(cliSave.body.result).toMatchObject({ operationId: 'clear-explicit', status: 'saved', source: { values: { connection: null } } })
  expect((await f.read(1)).values).toEqual({ connection: null })
  expect(await readFile(f.path(1), 'utf8')).toBe(original)
  expect(f.quick).not.toHaveBeenCalled(); expect(f.coreClients).not.toHaveBeenCalled()
})

it('the original trusted Desktop IPC reaches the same public service and refuses an unrelated sender before a write', async () => {
  const f = await fixture(), input = await f.intent()
  const saved = parseMotePreferencesSaveResult(await f.ipc('motePreferences:save', input), input)
  expect(saved.status).toBe('saved')
  const current = parseMotePreferencesReadResult(await f.ipc('motePreferences:read', { kind: 'connection', target: f.target() }), { kind: 'connection', target: f.target() })
  expect(current.values).toEqual(values)
  await expect(f.ipc('motePreferences:save', await f.intent('untrusted-attempt', { connection: null }), {})).rejects.toThrow('Untrusted')
  expect(f.writes).toHaveBeenCalledTimes(1)
  expect(parseMoteConnectionMode(await readFile(f.path(), 'utf8'))).toEqual({ status: 'valid', values })
})

it('roundtrips the original AST, Quick values, comments, unknown nodes, Markdown, BOM and CRLF', async () => {
  const f = await fixture(), saved = await f.save(await f.intent())
  expect(saved.status).toBe('saved')
  const content = await readFile(f.path(), 'utf8')
  for (const retained of ['\uFEFF---\r\n', '# format comment', 'custom: keep', 'other: retained', '# 原正文\r\n保留全部笔记。\r\n']) expect(content).toContain(retained)
  expect(content.replace(/\r\n/g, '')).not.toContain('\n')
  expect(parseMoteQuickMode(content)).toEqual({ status: 'valid', defaults: { executorId: 'original-executor' } })
  const editedQuick = serializeMoteQuickMode(content, { recovery: 'on-open' })
  expect(parseMoteConnectionMode(editedQuick)).toEqual({ status: 'valid', values })
  expect(serializeMoteConnectionMode(content, values)).toBe(content)
  expect((await f.save(await f.intent('explicit-no-change'))).status).toBe('unchanged')
  expect(f.writes).toHaveBeenCalledTimes(1)
})

it('rejects stale baselines and forged baseline values without replacing current disk bytes', async () => {
  const f = await fixture(), stale = await f.intent()
  await writeFile(f.path(), original + 'Later disk edit.\r\n')
  expect((await f.save(stale)).status).toBe('refused-before-write')
  const forged = await f.intent('forged-baseline'); forged.baseline.values = values
  expect((await f.save(forged)).status).toBe('refused-before-write')
  expect(f.writes).not.toHaveBeenCalled(); expect(await readFile(f.path(), 'utf8')).toBe(original + 'Later disk edit.\r\n')
})

it('requires the exact Mote home and current Connection application, keeping unrelated capabilities available', async () => {
  const f = await fixture(), input = await f.intent()
  const wrongApp = { ...input, values: { connection: { ...values.connection!, application: { ...values.connection!.application, appId: 'another-application' } } } }
  expect((await f.save(wrongApp)).status).toBe('refused-before-write')
  await expect(f.save({ ...input, target: { ...input.target, zoneId: f.target(1).zoneId } })).rejects.toThrow('Another File resource')
  const state = (await f.spatial.read())!; state.graph.spaces[0]!.kind = 'topic'
  await f.spatial.commit({ expectedRevision: state.revision, graph: state.graph })
  expect((await f.save(input)).status).toBe('refused-before-write')
  expect(f.writes).not.toHaveBeenCalled()
  expect((await f.save(await f.intent('other-mote-remains-available', values, 1))).status).toBe('saved')
  expect(await readFile(f.path(), 'utf8')).toBe(original)
})

it('uses original exclusive create once for an absent MOTE.md and never fabricates unchanged existence', async () => {
  const f = await fixture(); await rm(f.path())
  const input = await f.intent('create-absent', { connection: null }); expect(input.baseline.document).toBeNull()
  expect((await f.save(input)).status).toBe('saved')
  expect(f.writes).toHaveBeenCalledTimes(1); expect(f.writes.mock.calls[0]![1].expectedRevision).toBeNull()
  expect(parseMoteConnectionMode(await readFile(f.path(), 'utf8'))).toEqual({ status: 'valid', values: { connection: null } })
})

it('carries the exact original revision into native CAS when the disk changes after preparation', async () => {
  const f = await fixture(), input = await f.intent(), later = original + 'Concurrent external edit.\r\n'
  f.writes.mockImplementationOnce(async (workspace, command) => { await writeFile(f.path(), later); return f.nativeWrite(workspace, command) })
  expect((await f.save(input)).status).toBe('refused-before-write')
  expect(f.writes.mock.calls[0]![1].expectedRevision).toBe(input.baseline.document!.revision)
  expect(await readFile(f.path(), 'utf8')).toBe(later)
})

it('preserves the original dirty Editor buffer through real Main save, file observation and later conflict actions', async () => {
  const f = await fixture(), input = await f.intent(), document = input.baseline.document!, key = documentKey(f.workspace.id, document.path)
  const tabId = fileTabId(f.workspace.id, document.path), tab = createWorkbenchTab(tabId, { regionId: initialWorkbenchRegionId(tabId), kind: 'file', workspaceId: f.workspace.id, path: document.path })
  rendererFiles.read.mockImplementation((_workspace, path) => f.files.read(f.workspace, path))
  rendererFiles.write.mockImplementation((_workspace, command) => f.files.write(f.workspace, command))
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [f.workspace],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    activeWorkspaceId: f.workspace.id, tabs: { [tabId]: tab }, layouts: { [f.workspace.id]: createWorkspaceLayout('original-pane', [tabId]) },
    documents: { [key]: document }, dirtyDocuments: { [key]: false }, documentGenerations: { [key]: 0 }, documentObservationGenerations: { [key]: 0 }, documentIssues: {}, savingDocuments: {} })
  const draft = original + '未保存的原输入。\r\n'
  useAppStore.getState().updateDocument(tabId, draft)
  const dispose = await f.files.observe(f.workspace, document.path, () => { void useAppStore.getState().refreshDocument(f.workspace.id, document.path) }); clean.push(dispose)
  expect((await f.save(input)).status).toBe('saved')
  await vi.waitFor(() => expect(useAppStore.getState().documentIssues[key]?.kind).toBe('changed'))
  expect(useAppStore.getState().documents[key]).toEqual({ ...document, content: draft })
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  await useAppStore.getState().saveDocument(tabId)
  expect(f.writes).toHaveBeenCalledTimes(1)
  const observed = useAppStore.getState().documentIssues[key]!
  expect(observed.kind).toBe('changed')
  await useAppStore.getState().overwriteDocument(tabId)
  expect(f.writes.mock.calls[1]![1].expectedRevision).toBe(observed.kind === 'changed' ? observed.observed.revision : null)
  expect(await readFile(f.path(), 'utf8')).toBe(draft)
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
})

it('keeps a competing create intact through the original create-only native publisher', async () => {
  const f = await fixture('occupy'); await rm(f.path())
  expect((await f.save(await f.intent('create-competing'))).status).toBe('refused-before-write')
  expect(await readFile(f.path(), 'utf8')).toBe('competing bytes')
  expect(f.writes).toHaveBeenCalledTimes(1)
})

it('retains unknown after the native writer publishes but loses its receipt; current value is not the original ACK', async () => {
  const f = await fixture('receipt'), input = await f.intent(), saved = await f.save(input)
  expect(saved).toMatchObject({ operationId: input.operationId, status: 'unconfirmed', source: null })
  expect(parseMoteConnectionMode(await readFile(f.path(), 'utf8'))).toEqual({ status: 'valid', values })
  const current = await f.read()
  expect(current).toMatchObject({ status: 'ready', values }); expect(current).not.toHaveProperty('operationId')
  expect(saved.status).toBe('unconfirmed'); expect(f.writes).toHaveBeenCalledTimes(1)
  expect(f.quick).not.toHaveBeenCalled(); expect(f.coreClients).not.toHaveBeenCalled()
})

it('does not rewrite malformed original configuration and strictly separates both public preference arms', async () => {
  const f = await fixture(), input = await f.intent()
  for (const content of ['---\nversion: 2\n---\nOriginal body', '---\nversion: 1\ndefaults: {connection: []}\n---\nOriginal body']) {
    await writeFile(f.path(), content)
    expect((await f.read()).status).toBe('unconfirmed'); expect((await f.save(input)).status).toBe('refused-before-write')
    expect(await readFile(f.path(), 'utf8')).toBe(content)
  }
  for (const bad of [{ ...input, destination: { kind: 'empty', displayWorkspaceId: 'display', groupId: 'group' } },
    { ...input, values: { connection: { ...values.connection!, hostId: 'invented-owner' } } }, { ...input, kind: 'bot' }]) expect(() => parseMotePreferencesSaveParams(bad)).toThrow()
  const originalIdentifiers = { connection: { connectionId: 'c'.repeat(1024), application: { domain: 'feishu.cn', appId: 'a'.repeat(1024) } } }
  expect(parseMotePreferencesSaveParams({ ...input, values: originalIdentifiers }).values).toEqual(originalIdentifiers)
  expect(() => parseMotePreferencesSaveResult({ kind: 'connection', target: input.target, operationId: input.operationId, status: ['saved'], source: null, message: null })).toThrow()
  expect(f.writes).not.toHaveBeenCalled()
})

it('preserves the original Quick Renderer route instead of pretending its display contract is available in Main', async () => {
  const f = await fixture()
  await expect(f.client.call('space.mote.preferences.read', { kind: 'quick', target: f.target() })).rejects.toThrow('Only Quick preferences')
  expect(f.quick).toHaveBeenCalledTimes(1); expect(f.writes).not.toHaveBeenCalled()
})
