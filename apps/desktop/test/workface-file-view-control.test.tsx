// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { addTabOccurrence } from '@agentmux/layout'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Private source canvas" value={value} readOnly />,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => <div data-private-diff><pre data-old>{original}</pre><pre data-new>{modified}</pre></div> }))
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion, documentKey, fileTabId, initialWorkbenchRegionId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { agent, neighborSid, privateEnvironment, targetSid } from './helpers/workface-control-fixture'
import { fileConfig, fileTopics, startWorkfaceFileFixture, zoneFor } from './helpers/workface-file-fixture'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

const initial = useAppStore.getState(), ownFile = 'apps/desktop/test/workface-file-view-control.test.tsx'
const restoring = process.env.AGENTMUX_WORKFACE_RESTORE_PHASE === 'file-view-child'
const restoreName = 'ordinary independent process retains File identities and TextDoc while transient modes return to format defaults'
let fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>> | undefined, root: Root, container: HTMLDivElement
let currentId: string, currentRegion: string, otherRegion: string
const diff = vi.fn(async (_workspace: string, path: string) => ({ path, old: { present: true as const, binary: false as const, text: 'Original HEAD bytes' },
  new: { present: true as const, binary: false as const, text: 'Original worktree bytes' }, binary: false, change: 'modified' as const }))
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true); diff.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('agentmux', undefined)
  window.agentmux = { git: { diff } } as unknown as AgentMuxPreloadApi
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  if (!restoring) fixture = await startWorkfaceFileFixture()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await fixture?.stop(); fixture = undefined
  delete (window as Partial<Window>).agentmux; vi.restoreAllMocks(); useAppStore.setState(initial, true); vi.unstubAllGlobals() })
async function arrange(path = 'shared.md', opaqueId?: string) {
  const receipt = await fixture!.run(['open', 'file', '--zone', zoneFor('resource').zoneId, '--path', path])
  expect(receipt.operation).toBe('open.file')
  currentId = fileTabId('resource', path); currentRegion = opaqueId ?? initialWorkbenchRegionId(currentId); otherRegion = 'file-neighbor-region'
  let tab = opaqueId ? createWorkbenchTab(currentId, { kind: 'file', regionId: opaqueId, workspaceId: 'resource', path }) : useAppStore.getState().tabs[currentId]!
  const space = useAppStore.getState().tabs[currentId]!.space
  tab = { ...tab, ...(space ? { space } : {}) }
  tab = addWorkbenchRegion(tab, currentRegion, 'right', { kind: 'file', regionId: otherRegion, workspaceId: 'resource', path })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [currentId]: tab }, layouts: { ...state.layouts,
    display: addTabOccurrence(state.layouts.display!, 'display-group', currentId)! } }))
  await prepareRendererUpdate(); fixture!.flush.mockClear(); fixture!.snapshot.mockClear(); diff.mockClear()
  return tab
}
async function view(mode?: string, region = currentRegion, code = 0) {
  const receipt = await fixture!.run(['space', 'view', '--region', region, ...(mode ? ['--mode', mode] : [])], code)
  expect(receipt.operation).toBe('space.view'); if (receipt.operation !== 'space.view') throw new Error('Wrong File view report.'); return receipt.result
}
function file(region: string) { const surface = useAppStore.getState().tabs[currentId]?.regions[region]; expect(surface?.kind).toBe('file'); return surface as FileWorkbenchSurface }
async function mount() {
  await act(async () => root.render(<><div data-file-view="first" data-workbench-tab-id={currentId} data-workbench-region-id={currentRegion}><FileSurfaceView tabId={currentId} surface={file(currentRegion)} /></div>
    <div data-file-view="second" data-workbench-tab-id={currentId} data-workbench-region-id={currentRegion}><FileSurfaceView tabId={currentId} surface={file(currentRegion)} /></div>
    <div data-file-view="neighbor" data-workbench-tab-id={currentId} data-workbench-region-id={otherRegion}><FileSurfaceView tabId={currentId} surface={file(otherRegion)} /></div></>))
  await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
function canvases() { const nodes = [...container.querySelectorAll('[data-file-view]')]; expect(nodes).toHaveLength(3)
  return nodes.map(node => node.querySelector('[data-private-diff]') ? 'diff' : node.querySelector('textarea') ? 'source' : node.querySelector('.file-preview-pane') ? 'bytes-preview' : 'preview') }
function protectedFacts() { const state = useAppStore.getState(); return { tabs: state.tabs, layouts: state.layouts, documents: state.documents, dirty: state.dirtyDocuments,
  sessions: state.sessions, drafts: state.agentComposerDrafts, mainSurface: state.mainSurface, activeWorkspaceId: state.activeWorkspaceId,
  agentFocus: state.agentFocus, selection: state.workbenchSpaceSelection, retained: state.retainedSpatialFocus, caret: state.regionCaretFocus } }

describe.skipIf(restoring)('File Region modes through the compiled CLI and actual File consumers', () => {
  it('queries exact Region facts and all occurrences without file/diff reads, writes, save, DOM input or Runtime refresh', async () => {
    await arrange(); await mount(); const before = protectedFacts(), read = vi.mocked(api.files.read), setter = vi.spyOn(useAppStore.getState(), 'setEditorRegionMode')
    read.mockClear(); const active = vi.spyOn(document, 'activeElement', 'get')
    const result = await view()
    expect(result).toMatchObject({ storedOverride: null, effectiveMode: 'source', supportedModes: ['source', 'diff', 'preview'], data: 'text',
      content: { status: 'available', reason: null }, changed: false, outcome: 'read', save: null, issues: [] })
    expect(result.locations.map(location => [location.displayWorkspaceId, location.regionId])).toEqual([['resource', currentRegion], ['display', currentRegion]])
    expect(read).not.toHaveBeenCalled(); expect(diff).not.toHaveBeenCalled(); expect(setter).not.toHaveBeenCalled(); expect(active).not.toHaveBeenCalled()
    expect(fixture!.flush).not.toHaveBeenCalled(); expect(protectedFacts()).toEqual(before); fixture!.noLifecycle()
  })
  it('changes both occurrences of one Region while another Region of the same dirty TextDoc remains source', async () => {
    await arrange(); useAppStore.getState().updateDocument(currentId, '# Unsaved original text\n\nStill one TextDoc', currentRegion); await mount()
    expect(canvases()).toEqual(['source', 'source', 'source']); const before = protectedFacts()
    await act(async () => { expect(await view('preview')).toMatchObject({ storedOverride: 'preview', effectiveMode: 'preview', changed: true, outcome: 'changed' }) })
    expect(canvases()).toEqual(['preview', 'preview', 'source']); expect(container.querySelector('[data-file-view="first"]')?.textContent).toContain('Unsaved original text')
    expect(protectedFacts()).toEqual(before)
    await act(async () => { expect(await view('diff')).toMatchObject({ effectiveMode: 'diff', data: 'text', content: { status: 'available' }, outcome: 'changed' }) })
    expect(canvases()).toEqual(['diff', 'diff', 'source']); expect(diff).toHaveBeenCalledExactlyOnceWith('resource', 'shared.md')
    expect([...container.querySelectorAll('[data-old]')].map(node => node.textContent)).toEqual(['Original HEAD bytes', 'Original HEAD bytes'])
    expect([...container.querySelectorAll('[data-new]')].map(node => node.textContent)).toEqual(['Original worktree bytes', 'Original worktree bytes'])
    await act(async () => { await view('source') }); expect(canvases()).toEqual(['source', 'source', 'source'])
    expect(protectedFacts()).toEqual(before); fixture!.noLifecycle()
  })
  it('uses the same original Preview and Diff controls so SVG/Note-style default preview cannot mask a selected Diff', async () => {
    await arrange('toggle.md'); await mount()
    const first = container.querySelector('[data-file-view="first"]')!
    const click = async (label: string) => { const button = [...first.querySelectorAll('button')].find(node => node.textContent?.trim() === label); expect(button).toBeDefined(); await act(async () => button!.click()) }
    await click('Preview'); expect(canvases()).toEqual(['preview', 'preview', 'source'])
    await click('Diff'); expect(canvases()).toEqual(['diff', 'diff', 'source']); expect((await view()).effectiveMode).toBe('diff')
    await click('Diff'); expect(canvases()).toEqual(['source', 'source', 'source'])
    await act(async () => { await view('preview') }); await click('Source'); expect(canvases()).toEqual(['source', 'source', 'source'])
  })
  it('applies Diff and Source over the actual SVG format default preview instead of leaving the old preview dominant', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Original source</title></svg>'
    vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path: 'default.svg', content: svg, revision: 'svg' } })
    const originalUrl = URL.createObjectURL, originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:private-svg'); URL.revokeObjectURL = vi.fn()
    try {
      await arrange('default.svg'); await mount(); expect(canvases()).toEqual(['preview', 'preview', 'preview'])
      expect(container.querySelectorAll('.image-preview')).toHaveLength(3)
      expect(await view()).toMatchObject({ storedOverride: null, effectiveMode: 'preview', supportedModes: ['source', 'diff', 'preview'] })
      await act(async () => { await view('diff') }); expect(canvases()).toEqual(['diff', 'diff', 'preview'])
      expect(container.querySelectorAll('.image-preview')).toHaveLength(1)
      await act(async () => { await view('source') }); expect(canvases()).toEqual(['source', 'source', 'preview'])
      expect([...container.querySelectorAll('textarea')].map(node => node.value)).toEqual([svg, svg])
    } finally { URL.createObjectURL = originalUrl; URL.revokeObjectURL = originalRevoke }
  })
  it.each(['constructor', 'toString', '__proto__'])('uses own legal mode and Diff entries for the opaque Region %s in real consumers', async id => {
    await arrange('opaque.md', id); await mount()
    expect(await view()).toMatchObject({ storedOverride: null, effectiveMode: 'source', outcome: 'read' }); expect(canvases()).toEqual(['source', 'source', 'source'])
    useAppStore.setState({ editorRegionModes: { [id]: 'invalid' as never } })
    expect(await view()).toMatchObject({ storedOverride: null, effectiveMode: 'source' })
    await act(async () => { await view('diff') }); expect(diff).toHaveBeenCalledExactlyOnceWith('resource', 'opaque.md'); expect(canvases()).toEqual(['diff', 'diff', 'source'])
    expect(Object.hasOwn(useAppStore.getState().editorRegionModes, id)).toBe(true)
  })
  it('reports applied mode but unconfirmed input when the formerly eligible source input is actually removed', async () => {
    await arrange(); await mount(); const input = container.querySelector<HTMLTextAreaElement>('[data-file-view="first"] textarea')!
    expect(input).not.toBeNull(); vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    await act(async () => input.focus()); const before = protectedFacts(), focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
    let result!: Awaited<ReturnType<typeof view>>
    await act(async () => { result = await view('preview', currentRegion, 1) })
    expect(result).toMatchObject({ storedOverride: 'preview', effectiveMode: 'preview', content: { status: 'available' }, outcome: 'partial' })
    expect(result.issues.map(issue => issue.code)).toEqual(['INPUT_PRESERVATION_UNCONFIRMED'])
    expect(input.isConnected).toBe(false); expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled(); expect(protectedFacts()).toEqual(before)
  })
  it('retains the eligible neighbor input and its draft without implicit input transfer on target mode changes', async () => {
    await arrange(); await mount(); const input = container.querySelector<HTMLTextAreaElement>('[data-file-view="neighbor"] textarea')!
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect); await act(async () => input.focus())
    const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
    await act(async () => { expect(await view('preview')).toMatchObject({ outcome: 'changed', issues: [] }) })
    expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true); expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
    expect(input.value).toContain('Current readable source'); expect(canvases()).toEqual(['preview', 'preview', 'source'])
  })
  it('rejects unsupported previews and keeps declared media, known binary and unknown content facts honest without another read', async () => {
    await arrange('plain.html'); const before = protectedFacts(), count = vi.mocked(api.files.read).mock.calls.length
    expect(await view('preview', currentRegion, 1)).toMatchObject({ supportedModes: ['source', 'diff'], effectiveMode: 'source', outcome: 'refused' })
    expect(protectedFacts()).toEqual(before); expect(api.files.read).toHaveBeenCalledTimes(count)
    await arrange('photo.png'); await mount(); expect(canvases()).toEqual(['bytes-preview', 'bytes-preview', 'bytes-preview'])
    expect(await view()).toMatchObject({ effectiveMode: 'preview', supportedModes: ['preview'], data: 'media-preview', content: { status: 'unconfirmed' } })
    expect(await view('source', currentRegion, 1)).toMatchObject({ outcome: 'refused', effectiveMode: 'preview' })
    useAppStore.setState({ documents: {}, documentIssues: {} }); currentId = fileTabId('resource', 'unread.txt'); currentRegion = 'unread-region'
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [currentId]: createWorkbenchTab(currentId, { kind: 'file', workspaceId: 'resource', path: 'unread.txt', regionId: currentRegion }) } }))
    const reads = vi.mocked(api.files.read).mock.calls.length
    expect(await view()).toMatchObject({ supportedModes: null, data: 'unconfirmed', content: { status: 'unconfirmed' }, outcome: 'read', save: null })
    expect(await view('diff', currentRegion, 1)).toMatchObject({ outcome: 'unknown', save: null })
    expect(api.files.read).toHaveBeenCalledTimes(reads)
  })
  it('keeps the applied Diff and TextDoc when its bridge or save is unavailable', async () => {
    await arrange(); delete (window as Partial<Window>).agentmux
    const before = protectedFacts()
    expect(await view('diff', currentRegion, 1)).toMatchObject({ storedOverride: 'diff', effectiveMode: 'diff', data: 'text', outcome: 'partial',
      content: { status: 'failed', reason: 'Git is unavailable in this build.' } })
    expect(protectedFacts()).toEqual(before); await mount(); expect(container.textContent).toContain('Could not load diff')
    fixture!.flush.mockRejectedValue(new Error('Private save unavailable'))
    expect(await view('source', currentRegion, 1)).toMatchObject({ storedOverride: 'source', effectiveMode: 'source', outcome: 'partial', save: { reason: 'Private save unavailable' } })
    expect(useAppStore.getState().workbenchSaveWarning).toContain('Private save unavailable'); expect(protectedFacts()).toEqual(before); fixture!.noLifecycle()
  })
})

it(restoreName, async () => {
  if (restoring) {
    const payload = JSON.parse(await readFile(process.env.AGENTMUX_WORKFACE_RESTORE_RECORD!, 'utf8')); expect(process.pid).not.toBe(payload.parentPid)
    localStorage.setItem('agentmux-workbench-v1', payload.record)
    vi.spyOn(api.config, 'get').mockResolvedValue(fileConfig); vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(fileTopics)
    vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'private-native-' + control.agentSessionId }, items: [], nextCursor: null }))
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent(targetSid), agent(neighborSid)], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined); vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockImplementation(async (_ws, path) => ({ status: 'read', document: { path, content: 'Restored canonical source', revision: 'restored' } }))
    const dispose = await useAppStore.getState().initialize()
    try {
      expect(useAppStore.getState().tabs).toEqual(payload.tabs); expect(useAppStore.getState().layouts).toEqual(payload.layouts); expect(useAppStore.getState().agentComposerDrafts).toEqual(payload.drafts)
      expect(useAppStore.getState().editorRegionModes).toEqual({}); expect(useAppStore.getState().editorRegionDiffs).toEqual({})
      currentId = payload.currentId; currentRegion = payload.currentRegion; otherRegion = payload.otherRegion
      await mount(); await vi.waitFor(() => expect(canvases()).toEqual(['source', 'source', 'source']))
      expect([...container.querySelectorAll('textarea')].map(node => node.value)).toEqual(['Restored canonical source', 'Restored canonical source', 'Restored canonical source'])
      await writeFile(payload.childProof, JSON.stringify({ parentPid: payload.parentPid, pid: process.pid, recordSha256: createHash('sha256').update(payload.record).digest('hex'),
        tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts, drafts: useAppStore.getState().agentComposerDrafts, canvases: canvases() }))
    } finally { dispose() }
    return
  }
  await arrange(); await view('preview'); await prepareRendererUpdate()
  const state = useAppStore.getState(), record = localStorage.getItem('agentmux-workbench-v1')!; expect(record.length).toBeGreaterThan(0)
  expect(JSON.parse(record).state.editorRegionModes).toBeUndefined()
  const directory = await mkdtemp('/tmp/amx-wfv-'), recordPath = join(directory, 'record.json'), childProof = join(directory, 'child-proof.json'), reportPath = join(directory, 'vitest.json')
  await writeFile(recordPath, JSON.stringify({ parentPid: process.pid, record, childProof, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, currentId, currentRegion, otherRegion }))
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson'), AGENTMUX_WORKFACE_RESTORE_PHASE: 'file-view-child', AGENTMUX_WORKFACE_RESTORE_RECORD: recordPath })
  try { const result = await promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', process.env.AGENTMUX_WORKFACE_MUTATION_CONFIG ?? 'vitest.config.ts',
    ownFile, '--testNamePattern', restoreName, '--maxWorkers=1', '--reporter=json', '--outputFile=' + reportPath], { env, timeout: 30000 }); await writeFile(join(directory, 'child.log'), result.stdout + result.stderr) }
  catch (error) { const failure = error as { stdout?: string; stderr?: string }; await writeFile(join(directory, 'child.log'), (failure.stdout ?? '') + (failure.stderr ?? '')); throw error }
  const report = JSON.parse(await readFile(reportPath, 'utf8')); expect(report.testResults.map((item: { name: string }) => resolve(item.name))).toEqual([join(process.cwd(), ownFile)])
  expect(report.testResults[0].assertionResults.filter((item: { status: string }) => item.status === 'passed').map((item: { title: string }) => item.title)).toEqual([restoreName])
  const proof = JSON.parse(await readFile(childProof, 'utf8')); expect(proof.pid).not.toBe(process.pid); expect(proof.recordSha256).toBe(createHash('sha256').update(record).digest('hex'))
  expect(proof.tabs).toEqual(state.tabs); expect(proof.layouts).toEqual(state.layouts); expect(proof.drafts).toEqual(state.agentComposerDrafts); expect(proof.canvases).toEqual(['source', 'source', 'source'])
}, 40000)
