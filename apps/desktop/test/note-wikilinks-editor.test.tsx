import { fixtureEpoch as _tailRefreshFixtureEpoch, fixturePath as _tailRefreshFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { newNoteDocument, readNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { api } from '../src/renderer/src/lib/api'
import { useNoteLinkNavigation } from '../src/renderer/src/lib/use-note-link-navigation'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { scanNoteWikiLinks, type NotebookResolveParams, type NotebookResolveResult } from '@agentmux/core/note-links'

let host: HTMLDivElement, root: Root, latest: string
const page: NotebookPage = { noteId: 'target', notebookId: 'quick-notes', parentNoteId: null, title: 'Shared knowledge', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: _tailRefreshFixturePath("notes"), path: 'target.note.json' }, createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1), sources: [], topics: [] }
const candidate = { noteId: page.noteId, notebookId: page.notebookId, title: page.title, resource: page.resource }
const search = (query: string): NotebookResolveResult => ({ mode: 'search', query, catalogRevision: 2, candidates: [candidate], total: 1, truncated: false })
const lookup = (text: string, blockId?: string): NotebookResolveResult => ({ mode: 'resolve', text, catalogRevision: 2, query: { page: page.title, ...(blockId ? { fragment: { kind: 'block', value: blockId } as const } : {}) }, candidates: [candidate], blocks: [{ blockId: 'decision', text: 'Decision', type: 'heading' }, { blockId: 'finding', text: 'An exact original finding', type: 'paragraph' }], observation: { noteId: page.noteId, actualNoteId: page.noteId, resource: page.resource, status: 'read', revision: 'target-revision', blockIds: ['decision', 'finding'] }, result: { status: 'resolved', target: { noteId: page.noteId, ...(blockId ? { blockId } : {}) } } })
beforeEach(() => {
  useNotebookLibrary.setState({ state: null, issue: null })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.spyOn(api.notebooks, 'resolve').mockImplementation(async params => params.mode === 'search' ? search(params.query) : lookup(params.text, params.select?.blockId))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
function Harness({ note = newNoteDocument('', 'source', 'source-block'), active = true, open = vi.fn(), identity = 'original-resource' }: { note?: NoteDocument; active?: boolean; open?: (link: any) => void; identity?: string }) {
  const [content, setContent] = useState(note)
  return <NoteBlockEditor note={content} active={active} sourceIdentity={identity} knowledge={noteKnowledge([])} onChange={raw => { latest = raw; const read = readNoteDocument(raw); if (read.status === 'valid') setContent(read.note) }} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} onOpenLink={open} />
}
async function mount(element: React.ReactNode = <Harness />) { await act(async () => root.render(element)) }
function editor(): Editor { return host.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!.editor }
async function type(text: string) { await act(async () => { editor().view.focus(); editor().commands.insertContent(text) }) }
async function key(key: string, extra: KeyboardEventInit = {}) { await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))) }
function links() { const list: any[] = []; editor().state.doc.descendants(node => { if (node.type.name === 'noteLink') list.push(node.attrs) }); return list }
async function waitOptions() { await vi.waitFor(async () => { await act(async () => {}); expect(host.querySelector('[role="option"]')).not.toBeNull() }) }

it('converts actual typed and plain pasted wiki syntax while preserving original blocks and canonical identity', async () => {
  await mount(); await type('Before [[Shared knowledge]] after ')
  await vi.waitFor(() => expect(links()[0]?.target).toEqual({ noteId: 'target' }))
  const transfer = new DataTransfer(); transfer.setData('text/plain', '[[Shared knowledge #^finding]]')
  await act(async () => editor().view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(links()).toHaveLength(2))
  expect(new Set(links().map(link => link.referenceId)).size).toBe(2)
  const read = readNoteDocument(latest); expect(read.status).toBe('valid')
  if (read.status === 'valid') { expect(read.note.noteId).toBe('source'); expect(read.note.content.content![0]!.attrs!.blockId).toBe('source-block') }
  expect(editor().getText()).toContain('Before [[Shared knowledge]] after [[Shared knowledge #^finding]]')
})

it('uses real keyboard completion and undo without rewriting surrounding text or the original block', async () => {
  await mount(); await type('Lead [[Sha'); await waitOptions(); await key('Enter')
  await vi.waitFor(() => expect(links()[0]?.target).toEqual({ noteId: 'target' }))
  expect(editor().getText()).toBe('Lead [[Shared knowledge]]')
  expect(host.querySelector('.note-wiki-completion')).toBeNull()
  await act(async () => editor().commands.undo())
  expect(links()).toHaveLength(0); expect(editor().getText()).toContain('[[Sha')
  expect(editor().getJSON().content![0]!.attrs!.blockId).toBe('source-block')
})

it('cancels suggestions without swallowing input, ignores code/escaped tokens, and leaves composition to IME', async () => {
  await mount(); await type('[[Sha'); await waitOptions(); await key('Escape'); expect(editor().getText()).toBe('[[Sha'); expect(host.querySelector('.note-wiki-completion')).toBeNull()
  await key('Enter', { isComposing: true }); expect(links()).toHaveLength(0)
  await act(async () => editor().commands.setContent(newNoteDocument('\\[[Shared knowledge]]', 'source', 'source-block').content))
  expect(links()).toHaveLength(0)
  await act(async () => { editor().commands.setContent(newNoteDocument('', 'source', 'source-block').content); editor().commands.toggleCodeBlock(); editor().commands.insertContent('[[Shared knowledge]]') })
  expect(links()).toHaveLength(0); expect(editor().getText()).toBe('[[Shared knowledge]]')
})

it('reads one chosen page for # suggestions and filters later fragment keystrokes locally', async () => {
  await mount(); await type('[[Shared knowledge #'); await waitOptions()
  const before = vi.mocked(api.notebooks.resolve).mock.calls.filter(([params]) => params.mode === 'resolve').length
  expect(before).toBe(1); await type('Dec'); await waitOptions()
  expect(vi.mocked(api.notebooks.resolve).mock.calls.filter(([params]) => params.mode === 'resolve')).toHaveLength(before)
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1)
  await key('Enter'); await vi.waitFor(() => expect(links()[0]?.target).toEqual({ noteId: 'target', blockId: 'decision' }))
})

it('does not let an old completion response replace later input or bind a removed occurrence', async () => {
  let finish: ((value: NotebookResolveResult) => void) | undefined
  vi.mocked(api.notebooks.resolve).mockImplementation(async params => params.mode === 'search' ? search(params.query) : new Promise(resolve => { finish = resolve }))
  await mount(); await type('[[Sha'); await waitOptions(); await key('Enter'); await type(' later')
  await act(async () => finish?.(lookup('Shared knowledge')))
  expect(links()).toHaveLength(0); expect(editor().getText()).toBe('[[Sha later')
  await type(']]'); await vi.waitFor(() => expect(links()).toHaveLength(1))
  await act(async () => editor().commands.setContent(newNoteDocument('Replacement draft', 'source', 'source-block').content))
  await act(async () => finish?.(lookup('Sha later')))
  expect(editor().getText()).toBe('Replacement draft'); expect(links()).toHaveLength(0)
})

it('aborts the original completion observation when the retained editor becomes hidden', async () => {
  let signal: AbortSignal | undefined
  vi.mocked(api.notebooks.resolve).mockImplementation(async (_params, options) => { signal = options?.signal; return new Promise(() => {}) })
  await mount(<Harness active />); await type('[[Shared'); await vi.waitFor(() => expect(signal).toBeDefined())
  await mount(<Harness active={false} />)
  expect(signal!.aborted).toBe(true); expect(host.querySelector('.note-wiki-completion')).toBeNull(); expect(editor().getText()).toBe('[[Shared')
})

it('does not apply a completed lookup after the same Note identity changes original resource', async () => {
  let finish: ((value: NotebookResolveResult) => void) | undefined, signal: AbortSignal | undefined
  vi.mocked(api.notebooks.resolve).mockImplementation(async (_params, options) => { signal = options?.signal; return new Promise(resolve => { finish = resolve }) })
  await mount(<Harness identity="first-resource" />); await type('[[Shared knowledge]]')
  await vi.waitFor(() => expect(finish).toBeDefined()); expect(links()[0].target).toBeNull()
  await mount(<Harness identity="second-resource" />)
  expect(signal!.aborted).toBe(true)
  await act(async () => finish?.(lookup('Shared knowledge')))
  expect(links()[0].target).toBeNull()
})

it('shows same-title candidates separately and only confirms an explicitly chosen identity', async () => {
  vi.mocked(api.notebooks.resolve).mockImplementation(async params => params.mode === 'search' ? { ...search(params.query), candidates: [candidate, { ...candidate, noteId: 'other', notebookId: 'other-book', resource: { ...candidate.resource, path: 'other.note.json' } }], total: 2 } as NotebookResolveResult : lookup(params.text))
  await mount(); await type('[[Shared'); await waitOptions()
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2)
  expect(vi.mocked(api.notebooks.resolve).mock.calls.filter(([params]) => params.mode === 'resolve')).toHaveLength(0)
  await key('Enter'); await vi.waitFor(() => expect(links()[0]?.target).toEqual({ noteId: 'target' }))
})

it('renders stored and raw links through the real shared reader without minting or mutating source', async () => {
  const raw = newNoteDocument('Raw [[共享页面]] and ', 'reader-note', 'reader-block')
  raw.content.content![0]!.content!.push({ type: 'noteLink', attrs: { referenceId: 'existing-occurrence', text: 'Old title', target: { noteId: 'original-id' } } })
  const source = JSON.stringify(raw), open = vi.fn()
  await mount(<NoteReader content={source} workspaceId="notes" path="reader.note.json" revision="saved-revision" onOpenLink={open} />)
  const literal = host.querySelector<HTMLElement>('[data-note-wiki-text]')!; expect(literal).not.toBeNull()
  await act(async () => literal.click()); expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ text: '共享页面', target: null, rawRange: expect.any(Object) }))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-note-inline-link]')!.click())
  expect(open).toHaveBeenLastCalledWith({ referenceId: 'existing-occurrence', text: 'Old title', target: { noteId: 'original-id' } })
  expect(JSON.stringify(raw)).toBe(source); expect(api.notebooks.resolve).not.toHaveBeenCalled(); expect(scanNoteWikiLinks('[[共享页面]]')).toHaveLength(1)
})

it('opens a bound ID from the actual Canvas snapshot despite an unavailable global catalog, never by its old label', async () => {
  const state = emptyNotebookState(); state.pages.target = { ...page, title: 'Renamed' }
  const opened = vi.fn()
  function View() { const nav = useNoteLinkNavigation(opened, state); return <><button onClick={() => { void nav.openLink({ text: 'Old label now belonging elsewhere', target: { noteId: 'target', blockId: 'decision' } }) }}>Open</button>{nav.dialog}</> }
  await mount(<View />); await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(state.pages.target, 'decision'))
  expect(api.notebooks.resolve).not.toHaveBeenCalled()
})

it('promotes only an explicitly clicked original raw range and stores the chosen same-title target through the real NoteFileView', async () => {
  const note = newNoteDocument('Existing [[Shared knowledge]]', 'raw-source', 'raw-block'), catalog = emptyNotebookState()
  catalog.pages.target = page; catalog.pages.other = { ...page, noteId: 'other', resource: { ...page.resource, path: 'other.note.json' } }
  useNotebookLibrary.setState({ state: catalog })
  vi.mocked(api.notebooks.resolve).mockImplementation(async params => {
    if (params.mode === 'search') return search(params.query)
    if (!params.select) return { ...lookup(params.text), candidates: [candidate, { ...candidate, noteId: 'other', resource: catalog.pages.other!.resource }], blocks: [], observation: null, result: { status: 'ambiguous', stage: 'page', message: 'Choose the exact same-title original.' } } as NotebookResolveResult
    return lookup(params.text)
  })
  const open = vi.fn()
  function OriginalFile() {
    const [document, setDocument] = useState({ path: 'raw-source.note.json', revision: 'raw-revision', content: JSON.stringify(note) })
    return <NoteFileView document={document} resource={{ ...page.resource, path: document.path }} knowledge={noteKnowledge([])} onChange={content => { latest = content; setDocument({ ...document, content }) }} onSave={() => {}} onOpen={() => {}} onOpenPage={open} />
  }
  await mount(<OriginalFile />)
  expect(links()).toHaveLength(0)
  await act(async () => host.querySelector('[data-note-wiki-text]')!.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(host.querySelectorAll('.note-link-lookup .note-link-option')).toHaveLength(2))
  expect(links()).toHaveLength(1); const occurrence = links()[0].referenceId
  await act(async () => (host.querySelector('.note-link-lookup .note-link-option') as HTMLButtonElement).click())
  await vi.waitFor(() => expect(links()[0]?.target).toEqual({ noteId: 'target' }))
  expect(links()[0].referenceId).toBe(occurrence); expect(open).toHaveBeenCalledWith(page, undefined)
  expect(readNoteDocument(latest).status).toBe('valid'); expect(editor().getText()).toBe('Existing [[Shared knowledge]]')
})
