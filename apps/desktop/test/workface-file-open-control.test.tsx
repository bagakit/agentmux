// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
// Keep the real FileSurfaceView/EditorPane and their owner. Only browser canvas painting is adapted.
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Private source canvas" value={value} readOnly /> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Original private Terminal painter</div> }))
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { documentKey, fileTabId, initialWorkbenchRegionId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { noteCreationTarget } from '../src/renderer/src/lib/note-creation'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { agent, neighborSid, privateEnvironment, regionIdC, tabId, targetSid } from './helpers/workface-control-fixture'
import { fileConfig, fileTopics, fileCatalog, startWorkfaceFileFixture, zoneFor } from './helpers/workface-file-fixture'

const initial = useAppStore.getState(), ownFile = 'apps/desktop/test/workface-file-open-control.test.tsx'
const restoring = process.env.AGENTMUX_WORKFACE_RESTORE_PHASE === 'file-open-child'
const restoreName = 'ordinary independent process restores the original File graph and reads its document through the actual Pane'
let root: Root, container: HTMLDivElement, fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>> | undefined
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  if (!restoring) fixture = await startWorkfaceFileFixture()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await fixture?.stop(); fixture = undefined
  vi.restoreAllMocks(); useAppStore.setState(initial, true); vi.unstubAllGlobals() })
function args(path: string, workspaceId = 'resource', extra: string[] = []) {
  return ['open', 'file', '--zone', zoneFor(workspaceId, workspaceId === SCRATCH_WORKSPACE_ID).zoneId, '--path', path, ...extra]
}
async function open(path: string, workspaceId = 'resource', extra: string[] = [], code = 0) {
  const receipt = await fixture!.run(args(path, workspaceId, extra), code)
  expect(receipt.operation).toBe('open.file')
  if (receipt.operation !== 'open.file') throw new Error('Wrong File open receipt.')
  return receipt.result
}
function protectedFacts() { const state = useAppStore.getState(); return { activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
  agentFocus: state.agentFocus, drafts: state.agentComposerDrafts, sessions: state.sessions, retained: state.retainedSpatialFocus, policy: state.workbenchNavigationInputPolicy } }
function surface(path: string, workspaceId = 'resource') {
  const id = fileTabId(workspaceId, path), file = useAppStore.getState().tabs[id]?.regions[initialWorkbenchRegionId(id)]
  expect(file?.kind).toBe('file'); return { id, file: file as FileWorkbenchSurface }
}
async function mount(path: string, workspaceId = 'resource', composer = false) {
  const target = surface(path, workspaceId)
  await act(async () => root.render(<><div data-file><FileSurfaceView tabId={target.id} surface={target.file} /></div>
    {composer ? <div data-original-input><SessionPane sessionId={neighborSid} surfaceKind="agent" visible interactiveResize={false}
      linkOrigin={{ workspaceId: 'display', tabGroupId: 'display-group', tabId, regionId: regionIdC }} /></div> : null}</>))
  await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) })
  return target
}

describe.skipIf(restoring)('File open through compiled CLI and the actual File owner', () => {
  it('opens the first Topic File at the Zone directory, keeps background selection and shares the original Note mapping', async () => {
    const before = protectedFacts(), topic = fileTopics[0]!, path = `${topic.directoryPath}/notes 中文.md`
    const result = await open('notes 中文.md', SCRATCH_WORKSPACE_ID)
    expect(result).toMatchObject({ resource: { hostId: 'local', workspaceId: SCRATCH_WORKSPACE_ID,
      workspacePath: '/private/workface-scratch', zonePath: '/private/workface-scratch/' + topic.directoryPath, path },
      placement: { status: 'created' }, data: { kind: 'text' }, navigation: 'background', changed: true, outcome: 'opened',
      save: { localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed' }, issues: [] })
    expect(result.placement.locations.map(location => [location.displayWorkspaceId, location.groupId])).toEqual([[SCRATCH_WORKSPACE_ID, 'topic-group']])
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path)
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBeNull()
    expect(protectedFacts()).toEqual(before); fixture!.noLifecycle()
    const target = surface(path, SCRATCH_WORKSPACE_ID)
    const note = noteCreationTarget(useAppStore.getState(), fileTopics, { workspaceId: SCRATCH_WORKSPACE_ID, groupId: 'topic-group',
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, launcher: { tabId: target.id, regionId: target.file.regionId } })
    expect(note.relativeDirectory).toBe(topic.directoryPath)
    await mount(path, SCRATCH_WORKSPACE_ID); expect(container.querySelector('textarea')?.value).toContain('Current readable source')
  })
  it('reuses the canonical File, preserves the dirty TextDoc and opens another display without choosing the caller Workspace', async () => {
    const first = await open('draft.md'), target = surface('draft.md'), key = documentKey('resource', 'draft.md')
    useAppStore.getState().updateDocument(target.id, '# Original unsaved draft', target.file.regionId)
    const doc = useAppStore.getState().documents[key], before = protectedFacts(), layout = useAppStore.getState().layouts.resource
    const again = await open('./draft.md')
    expect(again).toMatchObject({ placement: { status: 'reused', tabId: first.placement.tabId, regionId: first.placement.regionId }, changed: false, outcome: 'unchanged' })
    expect(useAppStore.getState().documents[key]).toBe(doc); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().layouts.resource).toEqual(layout); expect(protectedFacts()).toEqual(before)
    const elsewhere = await open('draft.md', 'resource', ['--display-workspace', 'display', '--group', 'display-group'])
    expect(elsewhere.placement.locations.map(location => location.displayWorkspaceId)).toEqual(['resource', 'display'])
    expect(Object.keys(useAppStore.getState().tabs).filter(id => id === target.id)).toEqual([target.id])
    expect(api.files.read).toHaveBeenCalledTimes(1); fixture!.noLifecycle()
  })
  it('explicit focus chooses the exact display while preserving an eligible original Composer and does not authorize caret transfer', async () => {
    await open('focused.md'); useAppStore.setState({ viewModes: { [neighborSid]: 'activity' } })
    await mount('focused.md', 'resource', true)
    const input = container.querySelector<HTMLElement>('[data-original-input] [aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    await act(async () => input.focus()); const text = input.textContent
    const before = protectedFacts()
    let result!: Awaited<ReturnType<typeof open>>
    await act(async () => { result = await open('focused.md', 'resource', ['--display-workspace', 'display', '--group', 'display-group', '--focus']) })
    expect(result).toMatchObject({ navigation: 'applied', placement: { status: 'reused' }, outcome: 'opened' })
    expect(useAppStore.getState().activeWorkspaceId).toBe('display'); expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: 'display', groupId: 'display-group', tabId: result.placement.tabId, regionId: result.placement.regionId })
    expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true); expect(input.textContent).toBe(text)
    expect(useAppStore.getState().regionCaretFocus).toBeNull(); expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('preserve')
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.drafts); fixture!.noLifecycle()
  })
  it('keeps the applied File navigation separate from a formerly eligible input removed by its actual display', async () => {
    await open('input-before.md'); useAppStore.setState({ viewModes: { [neighborSid]: 'activity' } })
    await mount('input-before.md', 'resource', true)
    const input = container.querySelector<HTMLElement>('[data-original-input] [aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    await act(async () => input.focus()); const before = protectedFacts(), focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.workbenchSpaceSelection?.tabId !== fileTabId('resource', 'input-after.md')) return
      const target = surface('input-after.md')
      root.render(<FileSurfaceView tabId={target.id} surface={target.file} />)
    })
    let result!: Awaited<ReturnType<typeof open>>
    try { await act(async () => { result = await open('input-after.md', 'resource', ['--focus'], 1) }) }
    finally { unsubscribe() }
    expect(result).toMatchObject({ navigation: 'applied', placement: { status: 'created' }, data: { kind: 'text' }, outcome: 'partial' })
    expect(result.issues.map(issue => issue.code)).toEqual(['INPUT_PRESERVATION_UNCONFIRMED'])
    expect(input.isConnected).toBe(false); expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.drafts)
    expect(useAppStore.getState().regionCaretFocus).toBeNull(); fixture!.noLifecycle()
  })
  it('preserves a later human navigation after a deferred read while returning the actually created File', async () => {
    let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = open('late.md', 'resource', ['--focus'], 1)
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledTimes(1))
    useAppStore.setState({ mainSurface: 'survey', activeWorkspaceId: 'display' })
    release({ status: 'read', document: { path: 'late.md', content: 'Late original bytes', revision: 'late' } })
    expect(await pending).toMatchObject({ placement: { status: 'created' }, data: { kind: 'text' }, navigation: 'cancelled', outcome: 'partial' })
    expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().activeWorkspaceId).toBe('display')
    expect(useAppStore.getState().layouts.resource?.groups[0]?.activeTabId).toBe(tabId)
    expect(useAppStore.getState().documents[documentKey('resource', 'late.md')]?.content).toBe('Late original bytes'); fixture!.noLifecycle()
  })
  it('does not recreate or sign a replaced same-Region target after the deferred original read', async () => {
    await open('original.md'); const target = surface('original.md'), key = documentKey('resource', 'original.md')
    useAppStore.setState({ documents: {}, documentIssues: {} })
    let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = open('original.md', 'resource', [], 1)
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledTimes(2))
    const replacement = { ...target.file, path: 'different.md' }
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [target.id]: { ...state.tabs[target.id]!, regions: { [target.file.regionId]: replacement } } } }))
    release({ status: 'read', document: { path: 'original.md', content: 'Late data', revision: 'late' } })
    expect(await pending).toMatchObject({ placement: { status: 'unconfirmed', tabId: null, regionId: null }, outcome: 'unknown' })
    expect(useAppStore.getState().tabs[target.id]?.regions[target.file.regionId]).toBe(replacement)
    expect(useAppStore.getState().documents[key]).toBeUndefined(); fixture!.noLifecycle()
  })
  it('uses the original media/binary panes and refuses directories without an Explorer or Browser detour', async () => {
    vi.mocked(api.files.read).mockImplementation(async (_ws, path) => path.endsWith('.directory') || path === 'folder.png' ? { status: 'directory' }
      : { status: 'binary', path, revision: 'private-bytes', byteLength: 3 })
    expect(await open('photo.png')).toMatchObject({ data: { kind: 'media-preview' }, placement: { status: 'created' } })
    await mount('photo.png'); expect(container.querySelector('.file-preview-pane')).not.toBeNull(); expect(container.querySelector('textarea')).toBeNull()
    expect(await open('blob.unknown')).toMatchObject({ data: { kind: 'binary-preview' }, placement: { status: 'created' } })
    await mount('blob.unknown'); expect(container.querySelector('.file-preview-pane')).not.toBeNull()
    const before = protectedFacts(), explorer = useAppStore.getState().fileExplorerStates
    for (const path of ['sub.directory', 'folder.png']) expect(await open(path, 'resource', ['--focus'], 1)).toMatchObject({ data: { kind: 'not-file' }, placement: { status: 'none' }, outcome: 'refused' })
    expect(useAppStore.getState().tabs[fileTabId('resource', 'folder.png')]).toBeUndefined()
    expect(protectedFacts()).toEqual(before); expect(useAppStore.getState().fileExplorerStates).toBe(explorer)
    const bookmark = vi.spyOn(api.files, 'readBookmark'), browser = vi.spyOn(api.browser, 'create')
    vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path: 'source.webloc', content: '<plist>original source</plist>', revision: 'source' } })
    expect(await open('source.webloc')).toMatchObject({ data: { kind: 'text' } })
    expect(bookmark).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled(); fixture!.noLifecycle()
  })
  it('reports read and save failures honestly and retains healthy original content and the persistent save notice', async () => {
    vi.mocked(api.files.read).mockResolvedValue({ status: 'error', code: 'PRIVATE_READ_ERROR', message: 'Private file read failed' })
    expect(await open('failed.md', 'resource', [], 1)).toMatchObject({ data: { kind: 'failed', reason: 'Private file read failed' }, placement: { status: 'none' }, outcome: 'unknown' })
    vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path: 'retained.md', content: 'Still usable', revision: 'retained' } })
    fixture!.flush.mockRejectedValue(new Error('Private storage flush unavailable'))
    expect(await open('retained.md', 'resource', [], 1)).toMatchObject({ placement: { status: 'created' }, outcome: 'partial',
      save: { localStorageWritten: true, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'Private storage flush unavailable' } })
    expect(useAppStore.getState().documents[documentKey('resource', 'retained.md')]?.content).toBe('Still usable')
    expect(useAppStore.getState().workbenchSaveWarning).toContain('Private storage flush unavailable'); fixture!.noLifecycle()
  })
  it('refuses escaping paths, unmatched display parents, multiple Space references and foreign canonical Zone before reading', async () => {
    const before = protectedFacts()
    for (const path of ['/absolute.md', '../escape.md', 'sub/../../escape.md']) expect(await open(path, 'resource', [], 1)).toMatchObject({ outcome: 'unknown', placement: { status: 'unconfirmed' } })
    expect(await open('file.md', 'resource', ['--display-workspace', 'display', '--group', 'missing-group'], 1)).toMatchObject({ outcome: 'unknown' })
    expect(api.files.read).not.toHaveBeenCalled(); expect(protectedFacts()).toEqual(before)
    await open('foreign.md'); const original = surface('foreign.md'), beforeForeign = useAppStore.getState().tabs[original.id]!
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [original.id]: { ...beforeForeign, space: { spaceId: 'another-space', zoneId: 'another-zone' } } } }))
    const count = vi.mocked(api.files.read).mock.calls.length, foreign = useAppStore.getState().tabs[original.id]
    expect(await open('foreign.md', 'resource', [], 1)).toMatchObject({ outcome: 'refused', issues: [{ code: 'SPACE_PARENT_MISMATCH' }] })
    expect(useAppStore.getState().tabs[original.id]).toBe(foreign); expect(api.files.read).toHaveBeenCalledTimes(count)
    const zone = zoneFor('resource'), space = fileCatalog().spaces.find(space => space.directoryPath === '/private/workface-display')!
    useAppStore.setState({ spaceZoneBindings: { [zone.zoneId]: { workspaceId: 'resource', spaceId: fileCatalog().bindings.find(binding => binding.zoneId === zone.zoneId)!.spaceId,
      relations: { [space.spaceId]: true } } } })
    const ambiguous = await open('file.md', 'resource', [], 1)
    expect(ambiguous.issues[0]?.candidates).toHaveLength(2)
    expect(ambiguous.issues[0]?.candidates?.map(candidate => candidate.zoneId)).toEqual([zone.zoneId, zone.zoneId])
    expect(api.files.read).toHaveBeenCalledTimes(count)
  })
})

it(restoreName, async () => {
  if (restoring) {
    const payload = JSON.parse(await readFile(process.env.AGENTMUX_WORKFACE_RESTORE_RECORD!, 'utf8'))
    expect(process.pid).not.toBe(payload.parentPid)
    localStorage.setItem('agentmux-workbench-v1', payload.record)
    vi.spyOn(api.config, 'get').mockResolvedValue(fileConfig); vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(fileTopics)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent(targetSid), agent(neighborSid)], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'private-native-' + control.agentSessionId }, items: [], nextCursor: null }))
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'restore.md', content: 'Fresh restored original source', revision: 'restored' } })
    const dispose = await useAppStore.getState().initialize()
    try {
      expect(useAppStore.getState().tabs).toEqual(payload.tabs); expect(useAppStore.getState().layouts).toEqual(payload.layouts)
      expect(useAppStore.getState().agentComposerDrafts).toEqual(payload.drafts)
      await mount('restore.md'); await vi.waitFor(() => expect(container.querySelector('textarea')?.value).toBe('Fresh restored original source'))
      expect(api.files.read).toHaveBeenCalledExactlyOnceWith('resource', 'restore.md')
      await writeFile(payload.childProof, JSON.stringify({ parentPid: payload.parentPid, pid: process.pid, recordSha256: createHash('sha256').update(payload.record).digest('hex'),
        tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts, drafts: useAppStore.getState().agentComposerDrafts, paneText: container.querySelector('textarea')?.value }))
    } finally { dispose() }
    return
  }
  await open('restore.md', 'resource', ['--focus']); await prepareRendererUpdate()
  const state = useAppStore.getState(), record = localStorage.getItem('agentmux-workbench-v1')!; expect(record.length).toBeGreaterThan(0)
  const directory = await mkdtemp('/tmp/amx-wfo-'), recordPath = join(directory, 'record.json'), childProof = join(directory, 'child-proof.json'), reportPath = join(directory, 'vitest.json')
  await writeFile(recordPath, JSON.stringify({ parentPid: process.pid, record, childProof, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts }))
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson'),
    AGENTMUX_WORKFACE_RESTORE_PHASE: 'file-open-child', AGENTMUX_WORKFACE_RESTORE_RECORD: recordPath })
  try {
    const result = await promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', process.env.AGENTMUX_WORKFACE_MUTATION_CONFIG ?? 'vitest.config.ts',
      ownFile, '--testNamePattern', restoreName, '--maxWorkers=1', '--reporter=json', '--outputFile=' + reportPath], { env, timeout: 30000 })
    await writeFile(join(directory, 'child.log'), result.stdout + result.stderr)
  } catch (error) { const failure = error as { stdout?: string; stderr?: string }; await writeFile(join(directory, 'child.log'), (failure.stdout ?? '') + (failure.stderr ?? '')); throw error }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  expect(report.testResults.map((item: { name: string }) => resolve(item.name))).toEqual([join(process.cwd(), ownFile)])
  expect(report.testResults[0].assertionResults.filter((item: { status: string }) => item.status === 'passed').map((item: { title: string }) => item.title)).toEqual([restoreName])
  const proof = JSON.parse(await readFile(childProof, 'utf8')); expect(proof.pid).not.toBe(process.pid)
  expect(proof.recordSha256).toBe(createHash('sha256').update(record).digest('hex')); expect(proof.tabs).toEqual(state.tabs); expect(proof.layouts).toEqual(state.layouts)
  expect(proof.drafts).toEqual(state.agentComposerDrafts); expect(proof.paneText).toBe('Fresh restored original source')
}, 40000)
