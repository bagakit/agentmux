// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { MoteDetailsPanel } from '../src/renderer/src/components/MoteDetailsPanel'
import { MoteProfilePopover } from '../src/renderer/src/components/MoteProfilePopover'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { DEFAULT_MOTE_BEHAVIOR } from '../src/renderer/src/lib/mote-behavior'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import type { WorkspaceFileInvalidated } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { customMoteId, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const original = useAppStore.getState(), rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const memoryPath = rootPath + '/MEMORY.md', memoryKey = documentKey(scratchWorkspace.id, memoryPath)
const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
const version = (letter: string) => 'sha256:' + letter.repeat(64)
const initialMemory = '## Preferences\n- Give me the conclusion first.\n\n[Project notes](project-notes.md)\n'
const scope = (id = PMO_TEAMS_TOPIC_ID) => ({ workspace: scratchWorkspace,
  topic: moteTopics.find(topic => topic.id === id)!, rootPath: scratchTopicDirectoryName(id) })
let container: HTMLDivElement, root: Root, saved: Map<string, { content: string; revision: string }>
let listeners: Set<(event: WorkspaceFileInvalidated) => void>
const openPath = vi.fn(async (path: string) => useAppStore.getState().openFile(path, 'mote-group', undefined, scratchWorkspace.id))
function material(params: FileReadParams, content?: string, revision?: string): FileReadResult {
  const topic = moteTopics.find(item => directoryIdentity(scratchWorkspace.hostId, item.directoryPath) === params.spaceId)!
  const directory = scratchTopicDirectoryName(topic.id), path = directory + '/' + params.path
  const file = saved.get(path)
  return { resource: { ...params.expectedResource!, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + directory, path },
    result: { status: 'read', document: { path, content: content ?? file?.content ?? (params.path === 'BEHAVIOR.md' ? DEFAULT_MOTE_BEHAVIOR : '# Original SOUL'),
      revision: revision ?? file?.revision ?? version('f') } } }
}
const memoryReads = () => vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => params.path === 'MEMORY.md')
const memory = () => container.querySelector<HTMLDetailsElement>('.mote-memory')!
async function click(name: string, within: ParentNode = container) {
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') || item.textContent) === name)
  expect(button, name).toBeTruthy(); await act(async () => button!.click())
}
async function expand(open = true) {
  expect(memory()).toBeTruthy()
  await act(async () => { memory().open = open; memory().dispatchEvent(new Event('toggle')) })
}
async function render(active = true, id = PMO_TEAMS_TOPIC_ID) {
  await act(async () => root.render(<MoteDetailsPanel scope={scope(id)} reference={reference} active={active} onOpenPath={openPath} />))
}
async function invalidate(path = memoryPath, workspaceId = scratchWorkspace.id) {
  await act(async () => { for (const listener of [...listeners]) listener({ workspaceId, path }) })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface()
  useAppStore.setState({ activeWorkspaceId: scratchWorkspace.id, mainSurface: 'workbench', documents: {}, dirtyDocuments: {},
    documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {},
    launchAgent: vi.fn(), send: vi.fn(), stopSession: vi.fn(), reportError: vi.fn() })
  saved = new Map([[memoryPath, { content: initialMemory, revision: version('a') }],
    [scratchTopicDirectoryName(customMoteId) + '/MEMORY.md', { content: '## Preferences\nUse visual examples.', revision: version('c') }]])
  listeners = new Set()
  openPath.mockClear()
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => material(params))
  vi.spyOn(api.files, 'onInvalidated').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: saved.get(path)?.content ?? '', revision: saved.get(path)?.revision ?? version('f') } }))
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => {
    const before = saved.get(input.path)
    if (before?.revision !== input.expectedRevision) return { status: 'conflict', observedRevision: before?.revision ?? null }
    const revision = before.revision === version('a') ? version('b') : version('d')
    saved.set(input.path, { content: input.content, revision }); return { status: 'written', revision }
  })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); useAppStore.setState(original, true) })

describe('original Memory in the shared Mote Profile', () => {
  it('reads only after explicit expansion, with exact original resource, full saved content and original file links', async () => {
    await render(); const before = useAppStore.getState()
    expect(memory().open).toBe(false); expect(memoryReads()).toHaveLength(0)
    expect(container.querySelectorAll('.mote-memory')).toHaveLength(1)
    await expand()
    const spaceId = directoryIdentity(scratchWorkspace.hostId, scope().topic.directoryPath)
    expect(memoryReads()).toEqual([[{ zoneId: homeZoneId(spaceId), spaceId, path: 'MEMORY.md',
      expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } }]])
    expect(memory().textContent).toContain('Give me the conclusion first.')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('a'))
    expect(memory().querySelector('.mote-memory__source')?.textContent).toContain(scope().topic.directoryPath)
    expect(memory().textContent).toContain('Agent use is not confirmed.')
    expect(memory().querySelector('.mote-memory__source')?.hasAttribute('open')).toBe(false)
    const link = memory().querySelector<HTMLButtonElement>('.md-link')!
    expect(link.textContent).toBe('Project notes'); await act(async () => link.click())
    expect(openPath).toHaveBeenCalledWith(rootPath + '/project-notes.md')
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id])
    expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().send).not.toHaveBeenCalled(); expect(useAppStore.getState().stopSession).not.toHaveBeenCalled()
    expect(api.files.write).not.toHaveBeenCalled()
  })

  it('reuses the real shared Profile opening and original Editor for correction and withdrawal', async () => {
    await act(async () => root.render(<MoteProfilePopover workspaceId={scratchWorkspace.id} topicId={PMO_TEAMS_TOPIC_ID}
      reference={reference} active onReferenceSelect={() => {}}>{trigger => trigger}</MoteProfilePopover>))
    expect(memoryReads()).toHaveLength(0)
    await click('Show Mote profile')
    const panel = document.querySelector<HTMLElement>('.mote-profile-popover')!
    const disclosure = panel.querySelector<HTMLDetailsElement>('.mote-memory')!
    expect(disclosure).toBeTruthy(); expect(memoryReads()).toHaveLength(0)
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
    const before = useAppStore.getState()
    await click('Correct or remove a memory detail in editor', panel)
    const state = useAppStore.getState(), file = Object.values(state.tabs).flatMap(tab => Object.values(tab.regions)
      .filter(region => region.kind === 'file' && region.path === memoryPath).map(region => ({ tabId: tab.id, regionId: region.regionId, region })))
    expect(file).toHaveLength(1)
    expect(file[0]!.region).toMatchObject({ kind: 'file', workspaceId: scratchWorkspace.id, path: memoryPath })
    expect(api.files.read).toHaveBeenCalledWith(scratchWorkspace.id, memoryPath)
    expect(state.documents[memoryKey]).toMatchObject({ content: initialMemory, revision: version('a') })
    expect(api.files.write).not.toHaveBeenCalled()
    const corrected = initialMemory.replace('Give me the conclusion first.', 'Use short examples before the conclusion.')
    await act(async () => useAppStore.getState().updateDocument(file[0]!.tabId, corrected, file[0]!.regionId))
    expect(disclosure.textContent).toContain('The editor has unsaved changes.')
    expect(disclosure.textContent).toContain('Give me the conclusion first.')
    expect(disclosure.textContent).not.toContain('Use short examples before the conclusion.')
    await act(async () => { await useAppStore.getState().saveDocument(file[0]!.tabId, file[0]!.regionId) })
    expect(api.files.write).toHaveBeenCalledWith(scratchWorkspace.id, { path: memoryPath, content: corrected, expectedRevision: version('a') })
    expect(disclosure.textContent).toContain('Use short examples before the conclusion.')
    expect(disclosure.querySelector('[data-memory-revision]')?.textContent).toBe(version('b'))
    const withdrawn = corrected.replace('- Use short examples before the conclusion.\n', '')
    await act(async () => { useAppStore.getState().updateDocument(file[0]!.tabId, withdrawn, file[0]!.regionId); await useAppStore.getState().saveDocument(file[0]!.tabId, file[0]!.regionId) })
    expect(saved.get(memoryPath)?.content).toBe(withdrawn)
    expect(disclosure.textContent).not.toContain('Use short examples before the conclusion.')
    expect(disclosure.textContent).toContain('Project notes')
    expect(disclosure.textContent).toContain('earlier conversations and model history remain')
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id])
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().send).not.toHaveBeenCalled(); expect(useAppStore.getState().stopSession).not.toHaveBeenCalled()
  })

  it('keeps full last confirmed saved text and its version through unknown, missing, binary and actual read failure, then retries', async () => {
    const full = '# Saved memory\n' + Array.from({ length: 90 }, (_, index) => `\nParagraph ${index}: keep my original detailed notes.\n`).join('') + '\nFINAL ORIGINAL DETAIL'
    saved.set(memoryPath, { content: full, revision: version('a') })
    await render(); await expand()
    const params = memoryReads()[0]![0]
    const failures: FileReadResult[] = [
      { resource: null, result: { status: 'unknown', code: 'ORIGINAL_UNAVAILABLE', message: 'Original Host unavailable.' } },
      { ...material(params), result: { status: 'deleted' } },
      { ...material(params), result: { status: 'binary', path: memoryPath, byteLength: 4, revision: version('b') } }
    ]
    for (const result of failures) {
      vi.mocked(api.files.readPublic).mockResolvedValueOnce(result); await invalidate()
      expect(memory().textContent).toContain('Last confirmed saved content')
      expect(memory().textContent).toContain('Paragraph 0:'); expect(memory().textContent).toContain('Paragraph 89:'); expect(memory().textContent).toContain('FINAL ORIGINAL DETAIL')
      expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('a'))
      expect(memory().querySelector('.mote-memory__source')?.textContent).toContain(memoryPath)
      expect(memory().querySelector('[role="status"]')?.textContent).toContain(result.result.status === 'unknown' ? 'Original Host unavailable.' : result.result.status === 'deleted' ? 'no longer present' : 'binary data')
    }
    vi.mocked(api.files.readPublic).mockRejectedValueOnce(new Error('Original transport failed'))
    await invalidate(); expect(memory().textContent).toContain('Original transport failed'); expect(memory().textContent).toContain('FINAL ORIGINAL DETAIL')
    saved.set(memoryPath, { content: '# Current memory\nA corrected detail.', revision: version('b') })
    await click('Retry memory')
    expect(memory().textContent).toContain('A corrected detail.'); expect(memory().textContent).not.toContain('Original transport failed')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('b'))
  })

  it('stops new reads and Markdown while hidden, then reads the current original saved version on reveal', async () => {
    await render(); await expand(); await render(false)
    expect(memory().querySelector('.mote-memory__prose')).toBeNull()
    const reads = memoryReads().length
    saved.set(memoryPath, { content: '# Revealed latest\nThe saved file changed while hidden.', revision: version('b') })
    await invalidate(); await invalidate(rootPath + '/unrelated.md')
    await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [memoryKey]: { path: memoryPath, content: 'UNSAVED EDITOR TEXT', revision: version('b') } }, dirtyDocuments: { [memoryKey]: true } })))
    expect(memoryReads()).toHaveLength(reads)
    await render()
    expect(memoryReads()).toHaveLength(reads + 1)
    expect(memory().textContent).toContain('The saved file changed while hidden.')
    expect(memory().textContent).not.toContain('UNSAVED EDITOR TEXT')
    expect(memory().textContent).toContain('The editor has unsaved changes.')
  })

  it('retains the same original preview across Profile → Ideas → Profile and keeps it when the fresh read is unknown', async () => {
    await render(); await expand()
    const disclosure = memory(), panel = container.querySelector<HTMLElement>('[role="tabpanel"]')!
    await click('Edit behavior settings')
    expect(document.querySelector('.mote-behavior-dialog')).not.toBeNull()
    panel.scrollTop = 100
    await click('Ideas'); expect(panel.scrollTop).toBe(0)
    expect(memory()).toBe(disclosure); expect(memory().parentElement?.hidden).toBe(true)
    expect(memory().querySelector('.mote-memory__prose')).toBeNull()
    const reads = memoryReads().length
    await invalidate(); expect(memoryReads()).toHaveLength(reads)
    vi.mocked(api.files.readPublic).mockImplementation(async params => params.path === 'MEMORY.md'
      ? { resource: null, result: { status: 'unknown', code: 'ORIGINAL_UNKNOWN', message: 'Memory source is temporarily unconfirmed.' } } : material(params))
    panel.scrollTop = 100; await click('Profile')
    expect(panel.scrollTop).toBe(0); expect(memory()).toBe(disclosure)
    expect(memoryReads()).toHaveLength(reads + 1)
    expect(memory().textContent).toContain('Memory source is temporarily unconfirmed.')
    expect(memory().textContent).toContain('Give me the conclusion first.')
    expect(memory().textContent).toContain('Last confirmed saved content')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('a'))
    expect(document.querySelector('.mote-behavior-dialog')).toBeNull()
  })

  it('admits no Memory reads from inactive Ideas or a collapsed entry, and closing then opening reads current content', async () => {
    await render(); await click('Ideas'); await invalidate(); expect(memoryReads()).toHaveLength(0)
    await click('Profile'); await invalidate(); expect(memoryReads()).toHaveLength(0)
    await expand(); await expand(false)
    const reads = memoryReads().length
    saved.set(memoryPath, { content: '# Saved later\nA more recent original detail.', revision: version('b') })
    await invalidate(); expect(memoryReads()).toHaveLength(reads)
    await expand(); expect(memoryReads()).toHaveLength(reads + 1)
    expect(memory().textContent).toContain('A more recent original detail.')
  })

  it('rejects an old Mote’s late read without adopting its content, source or version into another Mote', async () => {
    const pending = deferred<FileReadResult>(); let requested!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementation(params => { if (params.path === 'MEMORY.md') { requested = params; return pending.promise } return Promise.resolve(material(params)) })
    await render(); await expand(); const old = requested
    await render(true, customMoteId)
    vi.mocked(api.files.readPublic).mockImplementation(async params => material(params))
    await expand()
    await act(async () => pending.resolve(material(old, '# OLD MOTE PRIVATE DETAIL', version('e'))))
    expect(memory().dataset.moteMemory).toBe(customMoteId)
    expect(memory().textContent).toContain('Use visual examples.')
    expect(memory().textContent).not.toContain('OLD MOTE PRIVATE DETAIL')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('c'))
    expect(memory().querySelector('.mote-memory__source')?.textContent).toContain(scratchTopicDirectoryName(customMoteId) + '/MEMORY.md')
    expect(memory().querySelector('.mote-memory__source')?.textContent).not.toContain(memoryPath)
  })

  it('does not adopt a pending result after the exact Workspace resource moves away and back in one React batch', async () => {
    await render(); await expand()
    const pending = deferred<FileReadResult>(), params = memoryReads()[0]![0]
    vi.mocked(api.files.readPublic).mockReturnValueOnce(pending.promise); await invalidate()
    const config = useAppStore.getState().config!
    await act(async () => {
      useAppStore.setState({ config: { ...config, workspaces: config.workspaces.map(workspace => workspace.id === scratchWorkspace.id ? { ...workspace, hostId: 'foreign-host' } : workspace) } })
      useAppStore.setState({ config })
      pending.resolve(material(params, 'LATE FOREIGN RESOURCE RESULT', version('e')))
    })
    expect(memory().textContent).toContain('The original Mote folder changed.')
    expect(memory().textContent).toContain('Give me the conclusion first.')
    expect(memory().textContent).not.toContain('LATE FOREIGN RESOURCE RESULT')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('a'))
    await click('Retry memory'); expect(memory().textContent).not.toContain('The original Mote folder changed.')
  })

  it('keeps the newer confirmed original version when an earlier read finishes late', async () => {
    await render(); await expand()
    const params = memoryReads()[0]![0], pending = deferred<FileReadResult>()
    vi.mocked(api.files.readPublic).mockReturnValueOnce(pending.promise)
    await invalidate()
    saved.set(memoryPath, { content: '# Latest original memory\nUse the newly corrected preference.', revision: version('b') })
    await invalidate()
    expect(memory().textContent).toContain('Use the newly corrected preference.')
    await act(async () => pending.resolve(material(params, '# Stale original memory\nOutdated preference.', version('a'))))
    expect(memory().textContent).toContain('Use the newly corrected preference.')
    expect(memory().textContent).not.toContain('Outdated preference.')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('b'))
  })

  it('rejects a wrong public Files target and keeps the original confirmation and recovery actions', async () => {
    await render(); await expand(); const params = memoryReads()[0]![0], result = material(params)
    vi.mocked(api.files.readPublic).mockResolvedValueOnce({ ...result, resource: { ...result.resource!, hostId: 'foreign-host' } })
    await invalidate()
    expect(memory().textContent).toContain('Another File resource')
    expect(memory().textContent).toContain('Give me the conclusion first.')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('a'))
    expect(memory().querySelector('[aria-label="Correct or remove a memory detail in editor"]')).not.toBeNull()
    await click('Retry memory'); expect(memory().textContent).not.toContain('Another File resource')
  })

  it('refreshes only the relevant saved file and never treats Editor typing as a saved memory version', async () => {
    await render(); await expand(); const reads = memoryReads().length
    for (let revision = 1; revision <= 8; revision++) {
      await invalidate(rootPath + '/other.md'); await invalidate(memoryPath, 'another-workspace')
      await act(async () => useAppStore.setState(state => ({
        sessions: state.sessions.map(session => ({ ...session, updatedAt: revision })),
        workspaceFileRevisions: { ...state.workspaceFileRevisions, [scratchWorkspace.id]: revision },
        documents: { ...state.documents, [documentKey(scratchWorkspace.id, rootPath + '/other.md')]: { path: rootPath + '/other.md', content: 'Unrelated', revision: version('c') } }
      })))
    }
    expect(memoryReads()).toHaveLength(reads)
    await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [memoryKey]: { path: memoryPath, content: 'FIRST UNSAVED DRAFT', revision: version('a') } }, dirtyDocuments: { [memoryKey]: true } })))
    const afterAttach = memoryReads().length
    await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [memoryKey]: { ...state.documents[memoryKey]!, content: 'LATER UNSAVED DRAFT' } } })))
    expect(memoryReads()).toHaveLength(afterAttach)
    expect(memory().textContent).toContain('Give me the conclusion first.')
    expect(memory().textContent).not.toContain('LATER UNSAVED DRAFT')
    saved.set(memoryPath, { content: '# Actually saved now\nThis is the disk version.', revision: version('b') })
    await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [memoryKey]: { path: memoryPath, ...saved.get(memoryPath)! } }, dirtyDocuments: {} })))
    expect(memoryReads()).toHaveLength(afterAttach + 1)
    expect(memory().textContent).toContain('This is the disk version.')
    expect(memory().textContent).not.toContain('The editor has unsaved changes.')
  })

  it('shows an empty original file as empty saved notes without claiming memory was maintained', async () => {
    saved.set(memoryPath, { content: '', revision: version('a') })
    await render(); await expand()
    expect(memory().textContent).toContain('No saved notes yet. Add a detail in the editor.')
    expect(memory().textContent).toContain('Agent use is not confirmed.')
    expect(memory().querySelector('[data-memory-revision]')?.textContent).toBe(version('a'))
    expect(api.files.write).not.toHaveBeenCalled()
  })

  it('keeps one pending saved read in the StrictMode-rendered shared Profile', async () => {
    const pending = deferred<FileReadResult>(); let params!: FileReadParams
    vi.mocked(api.files.readPublic).mockImplementation(request => {
      if (request.path === 'MEMORY.md') { params = request; return pending.promise }
      return Promise.resolve(material(request))
    })
    await act(async () => root.render(<StrictMode><MoteDetailsPanel scope={scope()} reference={reference} active onOpenPath={openPath} /></StrictMode>))
    await expand(); expect(memoryReads()).toHaveLength(1)
    await act(async () => pending.resolve(material(params)))
    expect(memory().textContent).toContain('Give me the conclusion first.')
    expect(memory().textContent).not.toContain('Reading saved memory…')
    expect(memoryReads()).toHaveLength(1)
  })
})
