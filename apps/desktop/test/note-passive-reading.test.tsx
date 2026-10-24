// @vitest-environment happy-dom
import { act, Fragment, useMemo } from 'react'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ExecutionHost } from '@agentmux/core'
import type { Editor } from '@tiptap/core'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { defaultAgent, defaultTab, installNativePopover, moteTopics, savedMoteKey, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import { pinPmoTeamsTopicFloating, pmoTeamsTopicFloatingViewTargets, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import * as noteKnowledge from '../src/renderer/src/lib/note-knowledge'
import * as noteDocument from '@agentmux/client-ui/note/note-document'
import { desktopElementVisible } from '../src/renderer/src/lib/desktop-presentation'

// Native terminal painting and source-code editing are outside this reading proof.
// The original Workbench, File read/store, rich Note and Mote hover owners are real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div data-original-activity /> }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: () => <div data-original-source-editor /> }))
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// happy-dom has no layout engine. The actual floating owner still commits its
// visible state; only native positioning coordinates are supplied by this boundary.
vi.mock('@floating-ui/dom', async importOriginal => ({ ...(await importOriginal<typeof import('@floating-ui/dom')>()),
  computePosition: vi.fn(async () => ({ x: 20, y: 20, placement: 'top-start', strategy: 'fixed', middlewareData: {} }))
}))

const baseline = useAppStore.getState()
const file: FileWorkbenchSurface = { kind: 'file', regionId: 'original-note-region', workspaceId: SCRATCH_WORKSPACE_ID, path: 'original.note.md' }
const split = addWorkbenchRegion(defaultTab, defaultTab.layout.activeRegionId, 'right', file)
const mixed = { ...split, layout: { ...split.layout, activeRegionId: defaultTab.layout.activeRegionId } }
const key = documentKey(file.workspaceId, file.path)
const source = serializeNoteDocument(newNoteDocument('Original nonempty Note body', 'original-note', 'original-block'))
const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: mixed.id, regionId: defaultTab.layout.activeRegionId }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, restorePopover: () => void
let rootPath: string, files: WorkspaceFiles, workspace: typeof scratchWorkspace, topics: typeof moteTopics

function Workface() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts)
  const pmo = useAppStore(state => state.agentFocus.pmo.sessionId)
  const projectionState = useMemo(() => moteWorkbenchProjection(spatialCatalog(useAppStore.getState(), topics), tabs, floating,
    selected => setFloating({ targetTabId: selected.tabId, reference: selected }), layouts), [floating, tabs, layouts, setFloating])
  const targets = useMemo(() => pmoTeamsTopicFloatingViewTargets(floating, tabs, layouts[SCRATCH_WORKSPACE_ID], pmo, projectionState.projection),
    [floating, tabs, layouts, pmo, projectionState])
  return <Fragment>
    <input aria-label="Original input" defaultValue="Unsent original input" />
    <PmoTeamsTopicEntry />
    <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} visible={false} viewTargets={targets} />
    <PmoTeamsTopicFloatingPanel floating={floating} setFloating={setFloating} projectionState={projectionState} />
  </Fragment>
}
function panel() { return container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')! }
function entry() { return container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')! }
function editor() { return panel().querySelector<HTMLElement & { editor: Editor }>('.note-block-content')?.editor }
async function hover() {
  await act(async () => {
    entry().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    entry().dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))
  })
  await vi.waitFor(() => expect(panel().dataset.motePresentation).toBe('preview'))
}
async function readyEditor() {
  await vi.waitFor(async () => { await act(async () => {}); expect(editor()).toBeDefined() }, { timeout: 15_000 })
  return editor()!
}
async function previewMode(label: string) {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
  expect(button).toBeDefined(); await act(async () => button!.click())
  await act(async () => { await vi.dynamicImportSettled() })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.closest('[hidden], [inert]') ? new DOMRect() : new DOMRect(0, 0, 800, 600)
  })
  // HappyDOM retains a child's inherited `hidden` after the actual floating owner
  // changes its inline visibility to `visible`. Supply only that CSS inheritance
  // boundary from the current DOM; native focus and the production visibility
  // predicate remain real, including the owner's not-yet-positioned hidden state.
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo)
    if (!element.closest('[data-pmo-teams-topic-floating]')) return style
    return new Proxy(style, { get(target, property, receiver) {
      if (property === 'visibility') {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const visibility = (node as HTMLElement).style?.visibility
          if (visibility === 'visible' || visibility === 'hidden' || visibility === 'collapse') return visibility
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  window.localStorage.clear(); restorePopover = installNativePopover()
  rootPath = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-passive-')))
  workspace = { ...scratchWorkspace, path: rootPath }
  topics = moteTopics.map(topic => ({ ...topic, directoryPath: join(rootPath, scratchTopicDirectoryName(topic.id)) }))
  files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' } as ExecutionHost))
  await writeFile(join(rootPath, file.path), source)
  seedMoteWorkface()
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [workspace] }, sessions: [defaultAgent],
    tabs: { [mixed.id]: mixed }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout(reference.groupId, [mixed.id]) },
    documents: {}, dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {},
    noteBlockSelections: {}, noteDirectorySources: {}, editorRegionModes: {}, regionCaretFocus: null, retainedSpatialFocus: null,
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(workspace), revision: 0, topics, error: null, reading: false } },
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}), launchAgent: vi.fn(), send: vi.fn(() => true) }))
  window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: mixed.id, reference }))
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id)!)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (workspaceId, path) => {
    expect(workspaceId).toBe(workspace.id); expect(path).toBe(file.path)
    return files.read(workspace, path)
  })
  vi.spyOn(api.files, 'readDirectory').mockRejectedValue(new Error('Reading a Note must not discover other files'))
  vi.spyOn(api.files, 'write').mockRejectedValue(new Error('Passive reading must not save'))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover()
  await files.dispose(); await rm(rootPath, { recursive: true, force: true })
  window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(baseline, true)
})

it.each([false, true])('reads the original Main file in a cold passive Mote preview with pending focus=%s without claiming input or saving', async pendingFocus => {
  const request = pendingFocus ? { regionId: file.regionId, nonce: 812 } : null
  useAppStore.setState({ regionCaretFocus: request })
  // A cold disk read may finish after the hover is already positioned. Keep this
  // real Main read behind that UI boundary so a zero/hidden DOM cannot mask focus.
  const read = vi.mocked(api.files.read).getMockImplementation()!
  let releaseRead!: () => void
  const shown = new Promise<void>(resolve => { releaseRead = resolve })
  vi.mocked(api.files.read).mockImplementation(async (...args) => { await shown; return read(...args) })
  await act(async () => root.render(<Workface />))
  expect(api.files.read).not.toHaveBeenCalled()
  const input = container.querySelector<HTMLInputElement>('[aria-label="Original input"]')!
  input.focus(); input.setSelectionRange(2, 8)
  const before = useAppStore.getState(), saved = window.localStorage.getItem(savedMoteKey)
  await hover()
  await vi.waitFor(async () => { await act(async () => {}); expect(panel().style.visibility).toBe('visible') }, { timeout: 15_000 })
  await act(async () => releaseRead())
  await vi.waitFor(async () => { await act(async () => {}); expect(useAppStore.getState().documents[key]?.content).toBe(source) }, { timeout: 15_000 })
  expect(await readFile(join(rootPath, file.path), 'utf8')).toBe(source)
  expect(api.files.write).not.toHaveBeenCalled()
  expect(useAppStore.getState().dirtyDocuments[key]).toBeUndefined()
  expect(useAppStore.getState().tabs[mixed.id]).toBe(mixed)
  expect(useAppStore.getState().tabs[mixed.id]!.layout.activeRegionId).toBe(defaultTab.layout.activeRegionId)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(window.localStorage.getItem(savedMoteKey)).toBe(saved)
  await vi.waitFor(async () => { await act(async () => {}); expect(editor()?.state.doc.textContent).toBe('Original nonempty Note body') }, { timeout: 15_000 })
  expect(panel().style.visibility).toBe('visible')
  expect(desktopElementVisible(editor()!.view.dom)).toBe(true)
  expect(document.activeElement).toBe(input); expect(useAppStore.getState().regionCaretFocus).toBe(request)
  if (pendingFocus) {
    // Pending focus can also be refreshed after cold placement. This is still the
    // original Region intent and must wait for activation, not mere readability.
    await act(async () => useAppStore.setState({ regionCaretFocus: { ...request!, nonce: request!.nonce + 1 } }))
  }
  expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
  expect(useAppStore.getState().regionCaretFocus).toEqual(pendingFocus ? { ...request!, nonce: request!.nonce + 1 } : request)
  if (pendingFocus) {
    await act(async () => pinPmoTeamsTopicFloating())
    await vi.waitFor(() => expect(useAppStore.getState().regionCaretFocus).toBeNull())
    expect(document.activeElement).toBe(editor()!.view.dom)
  }
}, 40_000)

it('keeps passive updates, editing and hidden retention when Source receives a newer original file', async () => {
  const index = vi.spyOn(noteKnowledge, 'noteKnowledge')
  await act(async () => root.render(<Workface />)); await hover()
  const originalEditor = await readyEditor()
  await act(async () => pinPmoTeamsTopicFloating())
  await act(async () => originalEditor.commands.setTextSelection({ from: 2, to: 7 }))
  const selection = originalEditor.state.selection.toJSON()
  await previewMode('Source')
  const indexed = index.mock.calls.length, encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
  const incoming = serializeNoteDocument(newNoteDocument('Original nonempty Note body updated externally', 'original-note', 'original-block'))
  await writeFile(join(rootPath, file.path), incoming)
  await act(async () => useAppStore.getState().refreshDocument(file.workspaceId, file.path))
  expect(useAppStore.getState().documents[key]?.content).toBe(incoming)
  expect(index).toHaveBeenCalledTimes(indexed); expect(encode).not.toHaveBeenCalled()
  expect(originalEditor.state.doc.textContent).toBe('Original nonempty Note body')
  expect(originalEditor.state.selection.toJSON()).toEqual(selection)
  await previewMode('Preview'); expect(await readyEditor()).toBe(originalEditor)
  await vi.waitFor(async () => { await act(async () => {}); expect(originalEditor.state.doc.textContent).toBe('Original nonempty Note body updated externally') })
  expect(originalEditor.state.selection.toJSON()).toEqual(selection)
  expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
  expect(api.files.write).not.toHaveBeenCalled()
  expect(await readFile(join(rootPath, file.path), 'utf8')).toBe(incoming)
}, 40_000)

it('keeps passive updates, editing and hidden retention on the same original editor without unrelated derivation', async () => {
  const index = vi.spyOn(noteKnowledge, 'noteKnowledge'), parse = vi.spyOn(noteDocument, 'readNoteDocument')
  await act(async () => root.render(<Workface />)); await hover()
  const originalEditor = await readyEditor()
  const input = container.querySelector<HTMLInputElement>('[aria-label="Original input"]')!
  input.focus(); input.setSelectionRange(1, 4)
  const updated = serializeNoteDocument(newNoteDocument('Updated original Note body', 'original-note', 'original-block'))
  await writeFile(join(rootPath, file.path), updated)
  await act(async () => useAppStore.getState().reloadDocument(mixed.id, file.regionId))
  await vi.waitFor(async () => { await act(async () => {}); expect(originalEditor.state.doc.textContent).toBe('Updated original Note body') })
  expect(editor()).toBe(originalEditor); expect(panel().dataset.motePresentation).toBe('preview')
  expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4])
  const visibleCosts = { indexed: index.mock.calls.length, parsed: parse.mock.calls.length }
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: 512 })) })))
  expect({ indexed: index.mock.calls.length, parsed: parse.mock.calls.length }).toEqual(visibleCosts)
  await act(async () => pinPmoTeamsTopicFloating())
  expect(editor()).toBe(originalEditor)
  await act(async () => {
    originalEditor.view.focus()
    originalEditor.commands.insertContentAt(1, 'Edited ')
    originalEditor.commands.setTextSelection({ from: 3, to: 8 })
  })
  const draft = useAppStore.getState().documents[key]!, selection = originalEditor.state.selection.toJSON(), doc = originalEditor.state.doc
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(noteDocument.readNoteDocument(draft.content)).toMatchObject({ status: 'valid', note: { noteId: 'original-note', content: { content: [expect.objectContaining({ attrs: expect.objectContaining({ blockId: 'original-block' }) })] } } })
  expect(originalEditor.state.doc.textContent).toBe('Edited Updated original Note body')
  input.focus(); input.setSelectionRange(2, 6)
  await previewMode('Source')
  expect(originalEditor.view.dom.closest('[hidden]')).not.toBeNull()
  const hiddenCosts = { indexed: index.mock.calls.length, parsed: parse.mock.calls.length }
  const reads = vi.mocked(api.files.read).mock.calls.length
  await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents,
    [documentKey(SCRATCH_WORKSPACE_ID, 'another.note.md')]: { path: 'another.note.md', revision: 'unrelated', content: serializeNoteDocument(newNoteDocument('Unrelated loaded Note', 'other-note', 'other-block')) }
  } })))
  expect({ indexed: index.mock.calls.length, parsed: parse.mock.calls.length }).toEqual(hiddenCosts)
  expect(originalEditor.isDestroyed).toBe(false); expect(originalEditor.state.doc).toBe(doc)
  expect(originalEditor.state.selection.toJSON()).toEqual(selection)
  expect(vi.mocked(api.files.read).mock.calls).toHaveLength(reads)
  await previewMode('Preview'); expect(await readyEditor()).toBe(originalEditor)
  expect(originalEditor.state.doc).toBe(doc); expect(originalEditor.state.selection.toJSON()).toEqual(selection)
  expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
  expect(useAppStore.getState().documents[key]).toBe(draft)
  expect(useAppStore.getState().tabs[mixed.id]!.layout.activeRegionId).toBe(defaultTab.layout.activeRegionId)
  expect(await readFile(join(rootPath, file.path), 'utf8')).toBe(updated)
  expect(api.files.write).not.toHaveBeenCalled(); expect(api.files.readDirectory).not.toHaveBeenCalled()
}, 40_000)
