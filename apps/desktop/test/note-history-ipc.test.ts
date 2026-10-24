// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'

const fixture = vi.hoisted(() => ({ root: '', api: undefined as unknown as AgentMuxPreloadApi,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invokes: [] as Array<{ channel: string; values: unknown[] }>,
  sender: { id: 1, isDestroyed: () => false, send: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), session: { flushStorageData: vi.fn() } }
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => fixture.root, getAppPath: () => join(process.cwd(), 'apps/desktop') },
  contextBridge: { exposeInMainWorld: (_key: string, value: AgentMuxPreloadApi) => { fixture.api = value; Object.assign(window, { agentmux: value }) } },
  webFrame: { getZoomFactor: () => 1 },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => fixture.handlers.set(channel, handler), removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  ipcRenderer: { invoke: async (channel: string, ...values: unknown[]) => {
    fixture.invokes.push({ channel, values }); const handler = fixture.handlers.get(channel)
    if (!handler) throw Error('No registered original IPC handler: ' + channel)
    return handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, ...values)
  }, on: vi.fn(), off: vi.fn(), send: vi.fn() }, safeStorage: {}, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.root }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
// Only default locations change: the actual Notes storage and journal run on private files.
vi.mock('@agentmux/core/notebook-store', async original => {
  const actual = await original<typeof import('@agentmux/core/notebook-store')>()
  return { ...actual, AgentMuxNotesStorage: class extends actual.AgentMuxNotesStorage {
    constructor(locator?: string, directory?: string, ports?: ConstructorParameters<typeof actual.AgentMuxNotesStorage>[2]) {
      super(locator ?? join(fixture.root, 'state', 'notes-location.json'), directory ?? join(fixture.root, 'notes'), ports)
    }
  } }
})
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { setPresentationWindowOwner() {} dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown' }), dispose() {} }) }))
vi.mock('@agentmux/connectors', async actual => ({ ...await actual<typeof import('@agentmux/connectors')>(), createConnectionServices: async () => ({ connections: { list: async () => [] }, secrets: {}, close: async () => {} }) }))

import '../src/preload/index'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'

let dispose: (() => Promise<void>) | undefined
let api: typeof import('../src/renderer/src/lib/api')['api']
let files: WorkspaceFiles
const noteId = 'original-note', path = 'original.note.md', zoneId = 'original-zone', spaceId = 'original-space'
beforeEach(async () => {
  fixture.handlers.clear(); fixture.invokes.length = 0
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), 'note-history-ipc-')))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.root, 'state'))
  await mkdir(join(fixture.root, 'notes')); await mkdir(join(fixture.root, 'workspace'))
  const workspace = { id: 'workspace', hostId: 'local', path: join(fixture.root, 'workspace'), name: 'Private', kind: 'folder' as const }
  const spatial = new AgentMuxSpatialStateStore()
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId, kind: 'folder', name: 'Private', hostId: 'local', directoryPath: workspace.path, projectId: null }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: workspace.path, branch: null }], bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const host = new LocalExecutionHost(); files = new WorkspaceFiles(() => host)
  let config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [workspace] }
  const runtime = { resourceSampler: { setObservationSources: () => () => {} }, setContinuousProgressInputObserver: () => () => {}, setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {}, executionHost: () => host,
    observeCoreEvents: () => () => {}, observeInputOccupation: () => () => {}, observeContinuousProgress: () => () => {}, reserveExecutorConfigEdit: async () => () => {}, reportBindingSaveFailure: vi.fn(), rpcClients: () => [] } as unknown as RuntimeController
  dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: fixture.sender } as unknown as BrowserWindow, runtime,
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    configStore: { get: async () => config, validate: value => value, save: async value => { config = value; return value } } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: () => {} } as unknown as ScratchTopics, workspaceFiles: files,
    progressLoops: { subscribe: () => () => {} } as unknown as Parameters<typeof registerIpc>[0]['progressLoops'] })
  await fixture.api.notesStorage.inspect()
  api = (await import('../src/renderer/src/lib/api')).api
  expect(api.files.historyPublic).toBe(fixture.api.files.historyPublic)
})
afterEach(async () => {
  try { await dispose?.() } finally { dispose = undefined; await files?.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (fixture.root) await rm(fixture.root, { recursive: true, force: true }) }
})
const readParams = () => ({ zoneId, spaceId, path, expectedResource: { hostId: 'local', workspaceId: 'workspace', workspacePath: join(fixture.root, 'workspace') } })
async function seed() {
  const original = serializeNoteDocument(newNoteDocument('Original body', noteId, 'original-block', 'Original'))
  const created = await api.files.write('workspace', { path, expectedRevision: null, content: original })
  expect(created.status).toBe('written'); if (created.status !== 'written') throw Error('The original private body was not created')
  expect(created.noteHistory, JSON.stringify(created.noteHistory)).toMatchObject({ status: 'committed', eventId: expect.any(String) })
  const read = await api.files.readPublic(readParams())
  expect(read.result.status).toBe('read'); if (read.result.status !== 'read' || !read.resource) throw Error('The original public resource was not read')
  return { original: read.result.document.content, created, target: { ...readParams(), expectedResource: read.resource, noteId }, document: read.result.document }
}

it('uses renderer→preload→registered Main→original files/history for timeline, exact restore and batch undo', async () => {
  const f = await seed()
  const edited = await api.files.write('workspace', { path, expectedRevision: f.document.revision, content: f.original.replace('Original body', 'Changed body') })
  expect(edited.status).toBe('written')
  const first = await api.files.historyPublic({ ...f.target, limit: 1 })
  expect(first.result).toMatchObject({ status: 'read', hasMore: true, entries: [{ actor: { kind: 'user', id: 'local-user:' + process.getuid!() } }] })
  if (first.result.status === 'unknown') throw Error(first.result.message)
  const content = await api.files.historyPublic({ ...f.target, eventId: f.created.noteHistory!.eventId!, includeContent: true })
  expect(content.result).toMatchObject({ status: 'read', entries: [{ content: f.original }] })
  const restored = await api.files.restorePublic({ ...f.target, expectedRevision: first.result.entries[0]!.revision, operationId: 'gui-restore', eventId: f.created.noteHistory!.eventId! })
  expect(restored.result).toMatchObject({ status: 'written', content: f.original, noteHistory: { eventId: 'gui-restore', status: 'committed' } })
  if (restored.result.status !== 'written') throw Error('The original restoration was not confirmed')
  const changed = await api.files.write('workspace', { path, expectedRevision: restored.result.revision, content: f.original.replace('Original body', 'Later GUI edit') })
  expect(changed.status).toBe('written'); if (changed.status !== 'written') throw Error('The original edit was not confirmed')
  const undone = await api.files.undoPublic({ ...f.target, expectedRevision: changed.revision, operationId: 'gui-undo', batchId: changed.noteHistory!.batchId!, batchLastEventId: changed.noteHistory!.eventId! })
  expect(undone.result).toMatchObject({ status: 'written', content: f.original, noteHistory: { eventId: 'gui-undo', status: 'committed' } })
  const actions = await api.files.historyPublic(f.target)
  if (actions.result.status === 'unknown') throw Error(actions.result.message)
  expect(actions.result.entries.slice(0, 3)).toMatchObject([
    { operation: 'undo', source: { batchId: changed.noteHistory!.batchId!, lastEventId: changed.noteHistory!.eventId! } },
    { operation: 'edit' }, { operation: 'restore', source: { eventId: f.created.noteHistory!.eventId! } }
  ])
  expect(await readFile(join(fixture.root, 'workspace', path), 'utf8')).toBe(f.original)
  expect(fixture.invokes.map(value => value.channel)).toEqual(expect.arrayContaining(['files:historyPublic', 'files:restorePublic', 'files:undoPublic']))
  await dispose!(); dispose = undefined
  expect(['files:historyPublic', 'files:restorePublic', 'files:undoPublic'].some(channel => fixture.handlers.has(channel))).toBe(false)
})

it('refuses an untrusted sender, a self-reported actor and an inexact original resource without changing bytes', async () => {
  const f = await seed(), writes = vi.spyOn(files, 'write')
  const restore = { ...f.target, expectedRevision: f.document.revision, operationId: 'rejected-restore', eventId: f.created.noteHistory!.eventId! }
  await expect(fixture.handlers.get('files:historyPublic')!({ sender: {} } as IpcMainInvokeEvent, f.target)).rejects.toThrow('Untrusted original Note history read sender')
  await expect(fixture.handlers.get('files:restorePublic')!({ sender: {} } as IpcMainInvokeEvent, restore)).rejects.toThrow('Untrusted original Note history restore sender')
  await expect(api.files.restorePublic({ ...restore, actor: { kind: 'agent', id: 'forged-agent' } } as typeof restore)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(api.files.restorePublic({ ...restore, expectedResource: { ...f.target.expectedResource, workspaceId: 'another-original-workspace' } })).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  expect(writes).not.toHaveBeenCalled(); expect(await readFile(join(fixture.root, 'workspace', path), 'utf8')).toBe(f.original)
})

it('preserves unknown history when its established owner is missing and keeps ordinary file reads available', async () => {
  const f = await seed(), location = await api.notesStorage.inspect()
  await rename(location.catalogPath, location.catalogPath + '.retained')
  const history = await api.files.historyPublic(f.target)
  expect(history.result).toMatchObject({ status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED' })
  expect(await api.files.readPublic(readParams())).toMatchObject({ result: { status: 'read', document: { content: f.original } } })
})

it('retains a typed known-written capacity receipt and its original operation at both GUI bridge layers', async () => {
  const f = await seed()
  vi.spyOn(FileReadOwner.prototype, 'restore').mockResolvedValueOnce({ resource: f.target.expectedResource, result: {
    status: 'written', revision: f.document.revision, contentUnavailable: 'The original body was saved; read its canonical revision separately.',
    noteHistory: { status: 'committed', eventId: 'capacity-restore', batchId: 'capacity-restore' }
  } })
  expect(await api.files.restorePublic({ ...f.target, expectedRevision: f.document.revision, operationId: 'capacity-restore', eventId: f.created.noteHistory!.eventId! })).toMatchObject({ result: {
    status: 'written', contentUnavailable: expect.stringContaining('original body was saved'), noteHistory: { eventId: 'capacity-restore', status: 'committed' }
  } })
})
