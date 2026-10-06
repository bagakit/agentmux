// @vitest-environment happy-dom
import { act, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import type { NotebookResolveResult } from '@agentmux/core/note-links'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { api } from '../src/renderer/src/lib/api'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { useAppStore } from '../src/renderer/src/store'
import { newNoteDocument, readNoteDocument } from '../src/shared/note-document'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'

const dom = composerDOM(), customPath = 'M4 4H20V20H4Z'
let release: () => void
beforeEach(() => { release = mountThemeRuntime(window) })
afterEach(() => release())
function changeDrawings(names: readonly SemanticIconId[]) {
  const theme = structuredClone(GRAPHITE_THEME)
  theme.id = 'custom.note-consumers'; theme.name = 'Note consumer drawings'
  theme.icons = Object.fromEntries(names.map(name => [name, { kind: 'paths', paths: [{ d: customPath }] }]))
  expect(previewTheme(theme).applied).toBe(true)
  for (const name of names) expect(document.getElementById(semanticIconHref(name).slice(1))?.querySelector('path')?.getAttribute('d')).toBe(customPath)
}
function expectDrawing(element: Element, name: SemanticIconId) {
  expect(element.querySelector(`use[href="${semanticIconHref(name)}"]`), `Actual mounted ${name} consumer`).not.toBeNull()
}
const page = (id: string): NotebookPage => ({ noteId: id, notebookId: 'quick-notes', parentNoteId: null, title: `Original ${id}`, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: fixturePath('semantic-notes'), path: `${id}.note.json` }, createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), sources: [], topics: [] })

it('the actual Note editor key hints follow root drawings while keys insert the exact original target and retain source identity', async () => {
  const targets = [page('first'), page('second')]
  const candidates = targets.map(({ noteId, notebookId, title, resource }) => ({ noteId, notebookId, title, resource }))
  vi.spyOn(api.notebooks, 'resolve').mockImplementation(async params => {
    if (params.mode === 'search') return { mode: 'search', query: params.query, catalogRevision: 2, candidates, total: candidates.length, truncated: false }
    const selected = candidates.find(candidate => candidate.noteId === params.select?.noteId) ?? candidates[0]!
    return { mode: 'resolve', text: params.text, catalogRevision: 2, query: { page: selected.title }, candidates: [selected], blocks: [], observation: null, result: { status: 'resolved', target: { noteId: selected.noteId } } } satisfies NotebookResolveResult
  })
  let latest = ''
  function Harness() {
    const [note, setNote] = useState(newNoteDocument('', 'original-source', 'original-source-block'))
    return <NoteBlockEditor note={note} active sourceIdentity="original-source-resource" knowledge={noteKnowledge([])} onChange={raw => { latest = raw; const read = readNoteDocument(raw); if (read.status === 'valid') setNote(read.note) }} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />
  }
  await dom.render(<Harness />)
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!.editor
  await act(async () => { editor.view.focus(); editor.commands.insertContent('Keep original [[Ori') })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(dom.container.querySelectorAll('[role="option"]')).toHaveLength(2)
  const popup = dom.container.querySelector('.note-wiki-completion')!, input = editor.view.dom
  expect(popup.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Up and down arrow keys')
  for (const name of ['control.key-up', 'control.key-down', 'control.key-enter'] as const) expectDrawing(popup, name)
  await act(async () => changeDrawings(['control.key-up', 'control.key-down', 'control.key-enter']))
  expect(editor.view.dom).toBe(input); expect(editor.getText()).toBe('Keep original [[Ori')
  const key = async (value: string) => act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
  await key('ArrowDown'); expect(popup.querySelector('[aria-selected="true"]')?.textContent).toContain('Original second')
  await key('ArrowUp'); expect(popup.querySelector('[aria-selected="true"]')?.textContent).toContain('Original first')
  await key('ArrowDown'); await key('Enter')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-wiki-completion')).toBeNull())
  const links: Record<string, unknown>[] = []
  editor.state.doc.descendants(node => { if (node.type.name === 'noteLink') links.push(node.attrs) })
  expect(links).toHaveLength(1); expect(links[0]!.target).toEqual({ noteId: 'second' })
  expect(editor.getText()).toBe('Keep original [[Original second]]')
  expect(readNoteDocument(latest)).toMatchObject({ status: 'valid', note: { noteId: 'original-source', content: { content: [{ attrs: { blockId: 'original-source-block' } }] } } })
  await act(async () => editor.commands.insertContent(' [[Again'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(dom.container.querySelectorAll('[role="option"]')).toHaveLength(2)
  await key('Escape'); expect(editor.getText()).toContain('[[Again'); expect(dom.container.querySelector('.note-wiki-completion')).toBeNull()
})

it('the actual saved-note graph themes direction drawings while retaining counts, topology, literal content and exact opening', async () => {
  installNoteCanvasGeometry()
  const original = page('original-note'), catalog = emptyNotebookState()
  catalog.pages[original.noteId] = original
  const note = newNoteDocument('Original body ↑ ↓ → stays literal', original.noteId, 'original-block'), content = JSON.stringify(note)
  const snapshot: NotebookGraphSnapshot = { catalog, graph: { catalogRevision: catalog.revision, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'complete', duplicateNoteIds: [], hierarchy: [],
    references: [{ source: { noteId: original.noteId, blockId: 'original-block' }, sourceResource: original.resource, target: { kind: 'page', noteId: original.noteId }, occurrence: { kind: 'stored', referenceId: 'original-reference' }, mode: 'link', resolution: 'resolved' }],
    observations: [{ noteId: original.noteId, resource: original.resource, status: 'read', actualNoteId: original.noteId, revision: 'saved-original', blockIds: ['original-block'] }] } }
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue(snapshot)
  vi.spyOn(api.notebooks, 'content').mockResolvedValue({ noteId: original.noteId, resource: original.resource, status: 'read', actualNoteId: original.noteId, revision: 'saved-original', blockIds: ['original-block'], content })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  useAppStore.setState({ noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, documents: {}, dirtyDocuments: {} })
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={{ kind: 'note', noteId: original.noteId }} onOpen={open} />)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-degrees')).toHaveLength(1))
  const row = dom.container.querySelector('.note-canvas-degrees')!, node = dom.container.querySelector('.react-flow__node')!
  expect(row.getAttribute('aria-label')).toBe('1 incoming, 1 outgoing occurrences in the saved graph')
  expect(row.textContent).toContain('1 incoming'); expect(row.textContent).toContain('1 outgoing')
  for (const name of ['note.reference-incoming', 'note.reference-outgoing'] as const) expectDrawing(row, name)
  const positions = structuredClone(useAppStore.getState().noteCanvasLayouts)
  await act(async () => changeDrawings(['note.reference-incoming', 'note.reference-outgoing']))
  expect(dom.container.querySelector('.note-canvas-degrees')).toBe(row); expect(dom.container.querySelector('.react-flow__node')).toBe(node)
  expect(useAppStore.getState().noteCanvasLayouts).toEqual(positions)
  expect(row.getAttribute('aria-label')).toBe('1 incoming, 1 outgoing occurrences in the saved graph')
  await dom.click('[aria-label="Full note: Original original-note"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Original body ↑ ↓ → stays literal'))
  await dom.click('.note-canvas-title[data-note-id="original-note"]')
  expect(open).toHaveBeenCalledExactlyOnceWith(original)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})
