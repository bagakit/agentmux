import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { NotebookPageDetails } from '../src/renderer/src/components/NotebookPageDetails'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { observeNotebookLibrary, useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { useAppStore } from '../src/renderer/src/store'
import { newNoteDocument, readNoteDocument } from '../src/shared/note-document'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), actor = { kind: 'user', id: 'original-person' } as const
let owner: AgentMuxNotebookStore, directory: string, stop: () => void
function Page({ active = true }: { active?: boolean }) {
  const page = useNotebookLibrary(state => state.state?.pages.original)
  return <WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>{page ? <NotebookPageDetails page={page} /> : null}</WorkbenchPresentationContext.Provider>
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amx-note-header-')); owner = new AgentMuxNotebookStore(join(directory, 'catalog.json'))
  await owner.apply({ operationId: 'register', expectedRevision: 0, change: { kind: 'register', noteId: 'original', title: 'Original finding', resource: { hostId: 'local', workspaceId: 'workspace', workspacePath: directory, path: 'original.note.md' }, source: { sourceId: 'original-web', title: 'Original web source', url: 'https://example.org/research', recordedAt: _newTailFixtureEpoch(0, 0, 1) } } }, actor)
  await owner.apply({ operationId: 'destination', expectedRevision: 1, change: { kind: 'create', notebookId: 'research', name: 'Research' } }, actor)
  vi.spyOn(api.notebooks, 'actor').mockResolvedValue(actor)
  vi.spyOn(api.notebooks, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.notebooks, 'apply').mockImplementation(input => owner.apply(input, actor))
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  useNotebookLibrary.setState({ state: await owner.read(), issue: null }); stop = observeNotebookLibrary()
})
afterEach(async () => { stop(); await rm(directory, { recursive: true, force: true }); useNotebookLibrary.setState({ state: null, issue: null }) })
async function menu() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Page options"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  return trigger
}
async function choose(label: string) {
  await menu()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(item, label).toBeDefined(); await act(async () => item!.click())
}
async function input(field: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}

it('opens grouped page information in the original Radix menu and closes details to their exact trigger', async () => {
  await dom.render(<Page />)
  expect(dom.container.querySelector('[aria-label="Page sources"]')).toBeNull()
  const trigger = await menu()
  expect(document.querySelector('[role="group"][aria-label="Page organization"]')).not.toBeNull()
  expect(document.querySelector('[role="group"][aria-label="Page information"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Page sources"]')!.click())
  const panel = dom.container.querySelector('[aria-label="Saved web sources"]')!
  expect(panel?.querySelector('h3')?.textContent).toBe('Page sources')
  expect(panel?.textContent).toContain('https://example.org/research')
  const closeSources = dom.container.querySelector<HTMLButtonElement>('[aria-label="Close page sources"]')!
  await act(async () => { closeSources.focus(); closeSources.click() })
  expect(dom.container.querySelector('[aria-label="Saved web sources"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
  await dom.click('[aria-label="Page followers"]'); await dom.click('[aria-label="Close followers"]')
  expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Page followers"]'))
  await menu(); await dom.render(<Page active={false} />)
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  expect(document.activeElement).not.toBe(trigger)
})

it('preserves title commit/cancel and moves the exact original through the same Notebook owner', async () => {
  await dom.render(<Page />)
  const title = dom.container.querySelector<HTMLInputElement>('[aria-label="Page title"]')!
  await act(async () => title.focus()); await input(title, 'Cancelled name')
  await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(title.value).toBe('Original finding'); expect((await owner.read()).pages.original!.title).toBe('Original finding')
  await act(async () => title.focus()); await input(title, 'A durable finding')
  await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.title).toBe('A durable finding'))
  await choose('Move page')
  expect(dom.container.querySelector('[aria-label="Move Note page"] h3')?.textContent).toBe('Move page')
  const destination = dom.container.querySelector<HTMLSelectElement>('[aria-label="Destination notebook"]')!
  await act(async () => { destination.value = 'research'; destination.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => dom.container.querySelector<HTMLFormElement>('[aria-label="Move Note page"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.notebookId).toBe('research'))
  await choose('Page history')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('Moved')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('A durable finding')
  await dom.click('[aria-label="Close page history"]')
  await choose('Archive page')
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.archivedAt).toBeDefined())
  await choose('Restore page')
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.archivedAt).toBeUndefined())
  expect((await owner.read()).pages.original!.resource.path).toBe('original.note.md')
})

it('opens page options from a real pointer press and returns keyboard dismissal to the same trigger', async () => {
  await dom.render(<Page />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Page options"]')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerType: 'mouse', bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  const content = document.querySelector<HTMLElement>('[role="menu"]')!
  await act(async () => { content.focus(); content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('retains the exact saved source and its recovery message through the new menu entry', async () => {
  const open = vi.spyOn(useAppStore.getState(), 'createSurveyBrowser').mockRejectedValue(new Error('Original source opening unavailable'))
  await dom.render(<Page />); await choose('Page sources')
  await dom.click('[aria-label="Open source Original web source"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original source opening unavailable'))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace', url: 'https://example.org/research' }))
  expect((await owner.read()).pages.original!.sources[0]!.sourceId).toBe('original-web')
  expect(dom.container.querySelector('[aria-label="Open source Original web source"]')).not.toBeNull()
})

it('keeps the grouped reference command wired to real original blocks and the canonical note change', async () => {
  const note = newNoteDocument('Current draft', 'current', 'current-block'), target = newNoteDocument('Exact finding', 'target', 'target-block')
  const knowledge = noteKnowledge([{ location: { workspaceId: 'workspace', path: 'target.note.md' }, document: { path: 'target.note.md', content: serializeNoteDocument(target), revision: 'target-r1' } }])
  const change = vi.fn()
  await dom.render(<NoteBlockEditor note={note} knowledge={knowledge} onChange={change} onSave={() => {}} onOpen={() => {}} onIssue={() => {}} />)
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!.editor
  await act(async () => { editor.view.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  await dom.click('[aria-label="Reference block"]')
  expect(dom.container.querySelector('[aria-label="Choose an original block"]')).not.toBeNull()
  expect(dom.container.querySelector('[role="group"][aria-label="Block references"] [aria-label="Reference block"]')).not.toBeNull()
  await dom.click('[aria-label="Reference workspace · target.note.md · target-block"]')
  await vi.waitFor(() => expect(change).toHaveBeenCalled())
  const read = readNoteDocument(change.mock.lastCall![0])
  expect(read.status).toBe('valid')
  if (read.status === 'valid') expect(read.note.content.content).toContainEqual(expect.objectContaining({ type: 'blockReference', attrs: expect.objectContaining({ target: { noteId: 'target', blockId: 'target-block' }, mode: 'reference' }) }))
})
