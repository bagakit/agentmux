import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { readFile, writeFile, mkdir, copyFile, rm, lstat, mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
// Retain the real File owner and Pane; adapt only the browser source canvas.
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Private restored source canvas" value={value} readOnly /> }))
vi.mock('monaco-editor', async () => (await import('./helpers/workface-monaco-fixture')).workfaceMonacoAdapter())
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { api } from '../src/renderer/src/lib/api'
import { openSessionFileLink } from '../src/renderer/src/lib/session-link-opening'
import { createSessionProjectFileContextSelector } from '../src/renderer/src/lib/session-project-file-context'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { documentKey, workbenchSurfaces, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { agent, neighborSid, regionIdA, tabId, targetSid, runWorkfaceRestore } from './helpers/workface-control-fixture'
import { fileCatalog, fileConfig, fileTopics, startWorkfaceFileFixture } from './helpers/workface-file-fixture'
import { workfaceMonacoModelCount } from './helpers/workface-monaco-fixture'

const ownFile = 'apps/desktop/test/focus-file-region-restore.test.tsx'
const restoreName = 'independent process restores the Focus File Region inside its original Tab with Agent identities and unsaved content'
const restoring = process.env.AGENTMUX_WORKFACE_RESTORE_PHASE === 'focus-file-region-child'
const initial = useAppStore.getState(), path = 'focus-restore.md', key = documentKey('resource', path)
type AppState = ReturnType<typeof useAppStore.getState>
const retainedContent = '# Original unsaved File\n\nKeep these exact bytes after the independent process restores the original Region.'
const origin = { workspaceId: 'display', tabGroupId: 'display-group', tabId, regionId: regionIdA, sessionId: targetSid }
const reference = { displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId, regionId: regionIdA }
let fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>> | undefined
let spatialDirectory: string | undefined
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, modelBaseline: number
type RestorePayload = { parentPid: number; record: string; childProof: string; tabs: AppState['tabs']; layouts: AppState['layouts']; drafts: AppState['agentComposerDrafts'] }
function fileRegion(): FileWorkbenchSurface {
  const file = workbenchSurfaces(useAppStore.getState().tabs[tabId]!).find(region => region.kind === 'file' && region.path === path)
  expect(file?.kind).toBe('file')
  if (!file || file.kind !== 'file') throw new Error('The actual original Tab must contain its File Region')
  return file
}
function snapshot() {
  const s = useAppStore.getState()
  return { tabs: s.tabs, layouts: s.layouts, drafts: s.agentComposerDrafts, document: s.documents[key], dirty: s.dirtyDocuments[key],
    focus: s.agentFocus, mainSurface: s.mainSurface, sessions: s.sessions.map(session => ({ id: session.id,
      hostId: session.hostId, runId: session.control.run.runId, workspacePath: session.workspacePath })) }
}
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  modelBaseline = workfaceMonacoModelCount()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  if (!restoring) fixture = await startWorkfaceFileFixture()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); expect(workfaceMonacoModelCount()).toBe(modelBaseline)
  if (fixture) {
    const directory = fixture.directory
    await fixture.stop(); fixture = undefined
    await expect(lstat(join(directory, 'control.sock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(directory, { recursive: true, force: true })
  }
  if (spatialDirectory) { await rm(spatialDirectory, { recursive: true, force: true }); spatialDirectory = undefined }
  delete process.env.T025_FOCUS_SPATIAL_RECORD
  vi.restoreAllMocks(); useAppStore.setState(initial, true); vi.unstubAllGlobals()
})

it(restoreName, async () => {
  if (restoring) {
    const recordPath = process.env.AGENTMUX_WORKFACE_RESTORE_RECORD!
    const payload: RestorePayload = JSON.parse(await readFile(recordPath, 'utf8'))
    expect(process.pid).not.toBe(payload.parentPid)
    const durable = JSON.parse(payload.record).state as Pick<AppState, 'agentFocus' | 'mainSurface' | 'documents' | 'dirtyDocuments'>
    expect(durable.documents[key]?.content).toBe(retainedContent); expect(durable.dirtyDocuments[key]).toBe(true)
    localStorage.setItem('agentmux-workbench-v1', payload.record)
    // Core owns positions; the Renderer record owns drafts. Admit the exact original Core companion.
    const spatial = JSON.parse(await readFile(process.env.T025_FOCUS_SPATIAL_RECORD!, 'utf8')) as NonNullable<Awaited<ReturnType<typeof api.spatial.read>>>
    expect(spatial.graph.tabs).toHaveLength(2)
    await api.spatial.commit({ expectedRevision: 0, graph: spatial.graph })
    vi.spyOn(api.config, 'get').mockResolvedValue(fileConfig); vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.demands, 'list').mockResolvedValue([]); vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(fileTopics)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent(targetSid), agent(neighborSid)], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'private-native-' + control.agentSessionId }, items: [], nextCursor: null }))
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: {
      path, content: 'New observed disk content must not overwrite the retained unsaved source', revision: 'later-disk-revision' } })
    const lifecycle = ['launchAgent', 'launchTerminal', 'recover', 'resume', 'stop', 'submitPrompt', 'write', 'interrupt', 'attach']
      .map(name => vi.spyOn(api.sessions, name as keyof typeof api.sessions))
    const dispose = await useAppStore.getState().initialize()
    try {
      const restored = useAppStore.getState(), file = fileRegion()
      expect(restored.tabs).toEqual(payload.tabs); expect(restored.layouts).toEqual(payload.layouts)
      expect(restored.agentComposerDrafts).toEqual(payload.drafts)
      expect(restored.tabs[tabId]!.regions[regionIdA]).toMatchObject({ kind: 'agent', sessionId: targetSid })
      expect(restored.sessions.map(session => [session.id, session.control.run.runId])).toEqual([
        [targetSid, agent(targetSid).control.run.runId], [neighborSid, agent(neighborSid).control.run.runId] ])
      expect(restored.documents[key]).toEqual(durable.documents[key]); expect(restored.dirtyDocuments[key]).toBe(true)
      expect(restored.agentFocus).toEqual(durable.agentFocus); expect(restored.mainSurface).toBe(durable.mainSurface)
      expect(restored.agentFocus.execution.sessionId).toBe(targetSid)
      expect(restored.agentFocus.execution.reference).toEqual({ ...reference, regionId: file.regionId })
      const projection = executionFocusPresentation(restored.agentFocus.execution, restored.tabs, fileCatalog(), () => {}, 'region').projection
      expect(projection?.entity).toEqual({ kind: 'region', regionId: file.regionId })
      await act(async () => root.render(<FileSurfaceView tabId={tabId} surface={file} />))
      await act(async () => { await vi.dynamicImportSettled() })
      await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Private restored source canvas"]')?.value).toBe(retainedContent))
      expect(useAppStore.getState().documents[key]?.content).toBe(retainedContent)
      expect(read).toHaveBeenCalledWith('resource', path)
      expect(read.mock.calls.every(args => args[0] === 'resource' && args[1] === path)).toBe(true)
      for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
      await writeFile(payload.childProof, JSON.stringify({ parentPid: payload.parentPid, pid: process.pid, recordPath,
        recordSha256: createHash('sha256').update(payload.record).digest('hex'), ...snapshot(),
        paneText: container.querySelector<HTMLTextAreaElement>('[aria-label="Private restored source canvas"]')!.value,
        projectionEntity: projection?.entity, spatialGraphSha256: createHash('sha256').update(JSON.stringify(spatial.graph)).digest('hex'), originalAgentSid: restored.tabs[tabId]!.regions[regionIdA]?.kind === 'agent'
          ? restored.tabs[tabId]!.regions[regionIdA]!.sessionId : null }, null, 2))
    } finally { dispose() }
    return
  }
  useAppStore.setState({ mainSurface: 'agents', agentFocus: { execution: { sessionId: targetSid, reference,
    history: [{ sessionId: targetSid, focusedAt: 1 }] }, pmo: { sessionId: null } } })
  const original = snapshot(), context = createSessionProjectFileContextSelector(targetSid, origin)(useAppStore.getState())
  expect(context.kind).toBe('session')
  await openSessionFileLink(origin, context, path, undefined, 'right')
  const file = fileRegion(), inserted = useAppStore.getState()
  expect(Object.keys(inserted.tabs)).toEqual(Object.keys(original.tabs))
  expect(inserted.tabs[tabId]!.regions[regionIdA]).toBe(original.tabs[tabId]!.regions[regionIdA])
  expect(inserted.agentComposerDrafts).toBe(original.drafts); expect(inserted.mainSurface).toBe('agents')
  expect(inserted.agentFocus.execution.reference).toEqual({ ...reference, regionId: file.regionId })
  useAppStore.getState().updateDocument(tabId, retainedContent, file.regionId)
  // The original arranged helper predates Core addressing and disposes its subscription.
  // Use the existing production projection and API, just as the original File view restart fixture does.
  const arranged = useAppStore.getState(), saved = await api.spatial.read()
  const descriptors = desktopWorkbenchFromSpatial(desktopSpatialGraph(arranged, fileTopics, saved?.graph ?? null))
  useAppStore.setState({ tabs: Object.fromEntries(Object.entries(arranged.tabs).map(([id, tab]) =>
    [id, { ...tab, ...(descriptors.tabs[id]?.space ? { space: descriptors.tabs[id]!.space } : {}) }])) })
  await prepareRendererUpdate()
  const spatial = await api.spatial.commit({ expectedRevision: saved?.revision ?? 0,
    graph: desktopSpatialGraph(useAppStore.getState(), fileTopics, saved?.graph ?? null) })
  spatialDirectory = await mkdtemp(_hygiene_fixturePath("tmp/amx-focus-spatial-"))
  const spatialPath = join(spatialDirectory, 'spatial.json')
  await writeFile(spatialPath, JSON.stringify(spatial))
  process.env.T025_FOCUS_SPATIAL_RECORD = spatialPath
  const beforeRestore = snapshot(); fixture!.noLifecycle()
  const proof = await runWorkfaceRestore(ownFile, restoreName, 'focus-file-region-child')
  expect(proof.document).toEqual(beforeRestore.document); expect(proof.dirty).toBe(true)
  expect(proof.focus).toEqual(beforeRestore.focus); expect(proof.mainSurface).toBe('agents')
  expect(proof.sessions).toEqual(beforeRestore.sessions); expect(proof.originalAgentSid).toBe(targetSid)
  expect(proof.paneText).toBe(retainedContent); expect(proof.projectionEntity).toEqual({ kind: 'region', regionId: file.regionId })
  const proofDirectory = process.env.T025_FOCUS_RESTORE_PROOF_DIRECTORY
  if (proofDirectory) {
    await mkdir(proofDirectory, { recursive: true })
    const privateDirectory = dirname(proof.recordPath)
    for (const name of ['record.json', 'child-proof.json', 'child.log', 'vitest.json']) await copyFile(join(privateDirectory, name), join(proofDirectory, name))
    await copyFile(spatialPath, join(proofDirectory, 'core-spatial-record.json'))
    await writeFile(join(proofDirectory, 'parent-snapshot.json'), JSON.stringify({ pid: process.pid, ...beforeRestore }, null, 2))
    await writeFile(join(proofDirectory, 'process-receipt.json'), JSON.stringify({ parentPid: process.pid, restoredPid: proof.pid,
      recordSha256: proof.recordSha256, spatialGraphSha256: proof.spatialGraphSha256, originalTabId: tabId, originalAgentSid: targetSid, fileRegionId: file.regionId,
      matched: ['tabs', 'layouts', 'Agent Session/Run ids', 'composer drafts', 'unsaved File bytes', 'dirty flag', 'durable Focus reference', 'actual File Pane text'],
      scope: 'Two independent Node/Vitest processes, actual persistence/restore and File owner; canvas/API fixtures. No whole GUI, native Runtime or real user Run claim.' }, null, 2))
    await rm(privateDirectory, { recursive: true, force: true })
  }
}, 40_000)
