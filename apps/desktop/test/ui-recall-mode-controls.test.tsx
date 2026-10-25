// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { applyNotebookChange, emptyNotebookState, type NotebookState } from '@agentmux/core/notebook-catalog'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NOTE_SCHEMA } from '../src/shared/note-document'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Retain the installed browser PanelGroup and the real App/Region/Note portal.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Only unrelated native terminal/file paint is isolated. Note preview is the real Tiptap editor.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <textarea defaultValue="Original terminal input" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: (props: { surface: { path: string }; preview?: import('react').ReactNode }) =>
  props.surface.path.endsWith('.note.md') && props.preview ? props.preview : <textarea data-original-file defaultValue="Original file input" /> }))

import { App } from '../src/renderer/src/App'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'

const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!, session = composerSession()
const notes = { ...workspace, id: NOTES_WORKSPACE_ID, path: fixturePath('ui-recall-mode-notes'), name: 'Notes' }
const bookId = 'mode-research', noteId = 'mode-original-note', path = 'original.note.md'
const originalDocument = { path, revision: 'mode-original-revision', content: serializeNoteDocument({ schema: NOTE_SCHEMA, noteId,
  content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'original-finding' }, content: [{ type: 'text', text: 'Original saved finding' }] }] } }) }
const originalKey = documentKey(workspace.id, 'draft.md'), noteKey = documentKey(notes.id, path)
const agent = { regionId: 'original-agent', kind: 'agent' as const, phase: 'attached' as const, workspaceId: workspace.id, sessionId: session.id }
const noteTab = createWorkbenchTab('original-note-tab', { kind: 'file', regionId: 'original-note-region', workspaceId: notes.id, path })
const originalTab = addWorkbenchRegion(createWorkbenchTab('original-work-tab', agent), agent.regionId, 'right',
  { kind: 'file', regionId: 'original-file-region', workspaceId: workspace.id, path: 'draft.md' })
let catalog: NotebookState
let observationReads: { workspaceId: string; path: string }[]
const stage = (name: string) => console.info(`[bounded Recall] ${name}`)

beforeEach(() => {
  installNoteCanvasGeometry()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 48, 900, 600))
  useNotebookLibrary.setState({ state: null, issue: null })
  useLauncherState.setState({ drafts: {}, sections: {}, executors: {}, persistenceIssue: null })
  useAppStore.setState({ loading: false, initialize: vi.fn(async () => () => {}), mainSurface: 'workbench',
    config: { ...composerConfig, workspaces: [workspace, notes] }, activeWorkspaceId: workspace.id,
    sessions: [session], viewModes: { [session.id]: 'terminal' },
    tabs: { [originalTab.id]: originalTab, [noteTab.id]: noteTab }, layouts: {
      [workspace.id]: createWorkspaceLayout('original-work-group', [originalTab.id]),
      [notes.id]: createWorkspaceLayout('original-note-group', [noteTab.id]) },
    originalSpatialGraph: null, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {},
    recallNotebookId: bookId, recallNoteId: null, recallZoneSelection: null,
    recallSidebarWidth: 220, recallSidebarCollapsed: false, notebookRecoveries: [], surveyZoneSelection: null,
    projectRailOpen: true, toolsOpen: true, workspaceTool: 'agents', demands: {},
    documents: { [originalKey]: { path: 'draft.md', content: 'Original unsaved file', revision: 'original-file-revision' } },
    dirtyDocuments: { [originalKey]: true }, agentFocus: { execution: { sessionId: session.id, history: [] }, pmo: { sessionId: null } },
    error: null, lastError: null, errorDismissed: true, displacedAgentSessionIds: [], retainedSpatialFocus: null, regionCaretFocus: null })

  // Prepare legal input facts; this task does not exercise creating or persisting a Note.
  const locations = spatialCatalog(useAppStore.getState(), []).locations.filter(location => location.tabId === noteTab.id && location.regionId === noteTab.titleRegionId)
  expect(locations).toHaveLength(1)
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [noteTab.id]: { ...noteTab,
    space: { spaceId: locations[0]!.spaceId, zoneId: locations[0]!.zoneId } } } }))
  const workface = { zoneId: locations[0]!.zoneId, workspaceId: notes.id }
  catalog = emptyNotebookState()
  catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: 'mode-create-book',
    change: { kind: 'create', notebookId: bookId, name: 'Research notebook', workface } }, { kind: 'user', id: 'mode-reader' }, 1)
  catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: 'mode-register-page',
    change: { kind: 'register', noteId, notebookId: bookId, parentNoteId: null, title: 'Original finding',
      resource: { hostId: notes.hostId, workspaceId: notes.id, workspacePath: notes.path, path }, workface } }, { kind: 'user', id: 'mode-reader' }, 2)
  vi.spyOn(api.notebooks, 'read').mockImplementation(async () => structuredClone(catalog))
  vi.spyOn(api.notebooks, 'apply').mockRejectedValue(new Error('Mode selection must not mutate the original catalog'))
  vi.spyOn(api.notebooks, 'onChange').mockReturnValue(() => {})
  vi.spyOn(api.files, 'read').mockImplementation(async (workspaceId, requestedPath) => {
    expect([workspaceId, requestedPath]).toEqual([notes.id, path])
    return { status: 'read', document: structuredClone(originalDocument) }
  })
  vi.spyOn(api.files, 'write').mockRejectedValue(new Error('Mode selection must not write the original file'))
  observationReads = []
  const observation = new NotebookObservationOwner({ workspace: id => id === notes.id ? notes : undefined, files: {
    async read(owner, requestedPath, options) {
      options?.signal?.throwIfAborted()
      expect([owner.id, owner.hostId, owner.path, requestedPath]).toEqual([notes.id, notes.hostId, notes.path, path])
      observationReads.push({ workspaceId: owner.id, path: requestedPath })
      return { status: 'read' as const, document: structuredClone(originalDocument) }
    }
  } })
  vi.spyOn(api.notebooks, 'graph').mockImplementation(async (params, options) => ({ catalog: structuredClone(catalog), graph: await observation.graph(catalog, params, options) }))
  vi.spyOn(api.notebooks, 'content').mockImplementation((id, options) => observation.content(catalog, id, options))
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  stage('prepared typed catalog, exact workface and read-only original file ports')
})

function editor() {
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>('.recall-preserved-workbench:not([hidden]) .note-block-content')
  expect(element, JSON.stringify({ selection: useAppStore.getState().recallZoneSelection,
    document: useAppStore.getState().documents[noteKey], issue: useAppStore.getState().error,
    ui: dom.container.querySelector('.global-recall-surface')?.textContent?.slice(-1800) })).not.toBeNull()
  return element!.editor
}
async function settled(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 5000 })
}
async function click(selector: string) { await dom.click(selector) }

it('switches real Recall modes and reopens the same dirty editor, caret and spatial reference without unrelated IO', async () => {
  stage('mounting real App')
  await dom.render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
  await act(async () => { await vi.dynamicImportSettled() })
  await click('[aria-label="Recall: keep and revisit knowledge"]')
  await settled(() => expect(useNotebookLibrary.getState().state?.revision).toBe(catalog.revision))
  await click(`.survey-notebook-page[data-note-id="${noteId}"]`)
  await act(async () => { await vi.dynamicImportSettled() })
  await settled(() => { expect(useAppStore.getState().recallNoteId).toBe(noteId); expect(editor()).toBeDefined() })
  stage('original Note opened through App and original canonical file path')

  const originalEditor = editor(), originalNode = originalEditor.view.dom
  await act(async () => { originalEditor.commands.insertContent('Keep this unsaved finding'); originalEditor.commands.setTextSelection(5) })
  const state = useAppStore.getState(), selection = state.recallZoneSelection!, reference = selection.active!
  const draft = state.documents[noteKey]!, caret = originalEditor.state.selection.toJSON()
  const apiReads = vi.mocked(api.files.read).mock.calls.length, source = structuredClone(catalog)
  expect(draft.content).toContain('Keep this unsaved finding')
  expect(state.dirtyDocuments[noteKey]).toBe(true)
  expect(reference).toEqual({ tabId: noteTab.id, regionId: noteTab.titleRegionId })
  const locations = spatialCatalog(state, []).locations.filter(location => location.zoneId === selection.zoneId &&
    location.tabId === reference.tabId && location.regionId === reference.regionId)
  expect(locations).toHaveLength(1)
  expect(locations[0]).toMatchObject({ displayWorkspaceId: notes.id, groupId: 'original-note-group', ...reference })
  await click('[aria-label="Notebook directory: Research notebook"]')
  const picker = dom.container.querySelector<HTMLElement>('[aria-label="Notebook presentation"]')!
  expect(picker.getAttribute('role')).toBe('tablist')
  const tree = picker.querySelector<HTMLButtonElement>('[aria-label="Tree view"]')!
  expect(tree.getAttribute('aria-selected')).toBe('true')
  await act(async () => { tree.focus(); tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Cards view')
  expect(picker.querySelector('[aria-label="Cards view"]')?.getAttribute('aria-selected')).toBe('true')
  expect(picker.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(tree)
  expect(tree.getAttribute('aria-selected')).toBe('true')

  for (const view of ['Cards', 'Graph', 'Tree']) {
    await click(`[aria-label="${view} view"]`)
    if (view === 'Graph') await settled(() => expect(dom.container.querySelector(`.note-canvas-title[data-note-id="${noteId}"]`)).not.toBeNull())
    expect(useAppStore.getState().recallZoneSelection).toBe(selection)
    expect(useAppStore.getState().recallNoteId).toBe(noteId)
    expect(dom.container.querySelector('.recall-preserved-workbench')?.hasAttribute('hidden')).toBe(true)
    expect(dom.container.querySelector('.recall-preserved-workbench .note-block-content')).toBe(originalNode)
    expect(useAppStore.getState().documents[noteKey]).toBe(draft)
  }
  expect(api.files.read).toHaveBeenCalledTimes(apiReads)
  expect(api.files.write).not.toHaveBeenCalled()
  expect(api.notebooks.apply).not.toHaveBeenCalled()
  expect(api.notebooks.graph).toHaveBeenCalled()
  expect(observationReads.length).toBeGreaterThan(0)
  expect(observationReads).toEqual(observationReads.map(() => ({ workspaceId: notes.id, path })))
  stage('real tabs and Graph consumed; same dirty editor retained without extra editor file IO')

  await click('[aria-label="Cards view"]')
  await click(`.recall-note-card[data-note-id="${noteId}"]`)
  await settled(() => expect(dom.container.querySelector('.recall-preserved-workbench')?.hasAttribute('hidden')).toBe(false))
  expect(editor()).toBe(originalEditor)
  expect(originalEditor.view.dom).toBe(originalNode)
  expect(editor().state.selection.toJSON()).toEqual(caret)
  expect(useAppStore.getState().recallZoneSelection?.active).toEqual(reference)
  expect(spatialCatalog(useAppStore.getState(), []).locations.filter(location => location.zoneId === selection.zoneId &&
    location.tabId === reference.tabId && location.regionId === reference.regionId)).toEqual(locations)
  expect(useAppStore.getState().tabs[reference.tabId]!.regions[reference.regionId]).toMatchObject({ workspaceId: notes.id, path })
  expect(useAppStore.getState().documents[noteKey]).toBe(draft)
  expect(useAppStore.getState().dirtyDocuments[noteKey]).toBe(true)
  // Reopening explicitly confirms the canonical original, then reuses the dirty editor.
  expect(api.files.read).toHaveBeenCalledTimes(apiReads + 1)
  expect(api.files.write).not.toHaveBeenCalled()
  expect(api.notebooks.apply).not.toHaveBeenCalled()
  expect(catalog).toEqual(source)
  expect(originalDocument.revision).toBe('mode-original-revision')
  expect(originalDocument.content).not.toContain('Keep this unsaved finding')
  expect(useAppStore.getState().sessions).toEqual([session])
  expect(useAppStore.getState().tabs[originalTab.id]?.regions[agent.regionId]).toEqual(agent)
  expect(useAppStore.getState().documents[originalKey]?.content).toBe('Original unsaved file')
  expect(useAppStore.getState().dirtyDocuments[originalKey]).toBe(true)
  expect(api.sessions.stop).not.toHaveBeenCalled()
  stage('reopened same editor/caret/resource; original Session and unsaved work kept')
})
