import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { LocalExecutionHost } from '@agentmux/core'
import { NotebookPageDetails } from '../src/renderer/src/components/NotebookPageDetails'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { observeNotebookLibrary, useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { useAppStore } from '../src/renderer/src/store'
import { newNoteDocument, readNoteDocument } from '../src/shared/note-document'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { composerDOM } from './helpers/composer-dom-fixture'
import { NoteTitleFileWriter } from '@agentmux/host/note-title-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'

const dom = composerDOM(), actor = { kind: 'user', id: 'original-person' } as const
let owner: AgentMuxNotebookStore, directory: string, stop: () => void, files: WorkspaceFiles
function Page({ active = true, sourceTitle, sourceDirty, onCheckOriginal }: { active?: boolean; sourceTitle?: string; sourceDirty?: boolean; onCheckOriginal?: () => void }) {
  const page = useNotebookLibrary(state => state.state?.pages.original)
  return <WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>{page ? <NotebookPageDetails page={page} sourceTitle={sourceTitle} sourceDirty={sourceDirty} onCheckOriginal={onCheckOriginal} /> : null}</WorkbenchPresentationContext.Provider>
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amx-note-header-'))
  const workspace: WorkspaceRecord = { id: 'workspace', hostId: 'local', path: directory, name: 'Original', kind: 'folder' }
  const host = new LocalExecutionHost()
  files = new WorkspaceFiles(() => host)
  let titleWriter: NoteTitleFileWriter
  owner = new AgentMuxNotebookStore(join(directory, 'catalog.json'), undefined, { title: {
    inspect: id => titleWriter.inspect(id), write: intent => titleWriter.write(workspace, intent), current: (id, resource) => titleWriter.current(workspace, id, resource)
  } })
  titleWriter = new NoteTitleFileWriter(files, owner)
  await writeFile(join(directory, 'original.note.md'), serializeNoteDocument(newNoteDocument('Original body', 'original', 'original-block', 'Original finding')))
  await owner.apply({ operationId: 'register', expectedRevision: 0, change: { kind: 'register', noteId: 'original', title: 'Original finding', resource: { hostId: 'local', workspaceId: 'workspace', workspacePath: directory, path: 'original.note.md' }, source: { sourceId: 'original-web', title: 'Original web source', url: 'https://example.org/research', recordedAt: _newTailFixtureEpoch(0, 0, 1) } } }, actor)
  await owner.apply({ operationId: 'destination', expectedRevision: 1, change: { kind: 'create', notebookId: 'research', name: 'Research' } }, actor)
  vi.spyOn(api.notebooks, 'actor').mockResolvedValue(actor)
  vi.spyOn(api.notebooks, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.notebooks, 'apply').mockImplementation(input => owner.apply(input, actor))
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  useNotebookLibrary.setState({ state: await owner.read(), issue: null }); stop = observeNotebookLibrary()
})
afterEach(async () => { stop(); files.dispose(); await rm(directory, { recursive: true, force: true }); useNotebookLibrary.setState({ state: null, issue: null }) })
async function menu() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Page options"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][data-state="open"]')).not.toBeNull())
  return trigger
}
async function choose(label: string) {
  await menu()
  let item: HTMLElement | undefined
  await vi.waitFor(() => {
    item = [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
    expect(item, label).toBeDefined()
    expect(item!.getAttribute('aria-disabled')).not.toBe('true')
  })
  await act(async () => item!.click())
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
  // Owner publication can precede the original operation's UI completion.
  await vi.waitFor(() => expect(title.disabled).toBe(false))
  expect(readNoteDocument(await readFile(join(directory, 'original.note.md'), 'utf8'))).toMatchObject({ status: 'valid', note: { title: 'A durable finding' } })
  await choose('Move page')
  expect(dom.container.querySelector('[aria-label="Move Note page"] h3')?.textContent).toBe('Move page')
  const destination = dom.container.querySelector<HTMLSelectElement>('[aria-label="Destination notebook"]')!
  await act(async () => { destination.value = 'research'; destination.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => dom.container.querySelector<HTMLFormElement>('[aria-label="Move Note page"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.notebookId).toBe('research'))
  await vi.waitFor(() => expect(title.disabled).toBe(false))
  await choose('Page activity')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Page activity"]')?.textContent).toContain('Moved'))
  expect(title.value).toBe('A durable finding')
  await dom.click('[aria-label="Close page activity"]')
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
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][data-state="open"]')).not.toBeNull())
  const content = document.querySelector<HTMLElement>('[role="menu"]')!
  await act(async () => { content.focus(); content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('shows the saved source title before a stale directory projection without making a rename on blur', async () => {
  const content = serializeNoteDocument(newNoteDocument('Original body', 'original', 'original-block', 'File title C'))
  await writeFile(join(directory, 'original.note.md'), content)
  const check = vi.fn(), apply = vi.mocked(api.notebooks.apply)
  await dom.render(<Page sourceTitle="File title C" onCheckOriginal={check} />)
  const title = dom.container.querySelector<HTMLInputElement>('[aria-label="Page title"]')!
  expect(title.value).toBe('File title C'); expect(title.disabled).toBe(false)
  expect(dom.container.textContent).toContain('Saved file title differs from the page list. Page list title: Original finding.')
  await act(async () => { title.focus(); title.blur() })
  expect(apply).not.toHaveBeenCalled()
  await dom.click('.notebook-change-issue button')
  expect(check).toHaveBeenCalledTimes(1)
  expect((await owner.read()).pages.original!.title).toBe('Original finding')
  expect(await readFile(join(directory, 'original.note.md'), 'utf8')).toBe(content)
})

it('labels a dirty source title as a draft and keeps the exact title editable', async () => {
  await dom.render(<Page sourceTitle="Unsaved title D" sourceDirty />)
  const title = dom.container.querySelector<HTMLInputElement>('[aria-label="Page title"]')!
  expect(title.value).toBe('Unsaved title D'); expect(title.disabled).toBe(false)
  expect(dom.container.textContent).toContain('Draft title differs from the page list.')
  expect(dom.container.textContent).toContain('This draft is not saved yet.')
  expect(dom.container.textContent).not.toContain('Saved file title')
  expect(api.notebooks.apply).not.toHaveBeenCalled()
})

it('retains typed titles through source changes while editing or a rename is in flight', async () => {
  await dom.render(<Page sourceTitle="File title C" />)
  const title = dom.container.querySelector<HTMLInputElement>('[aria-label="Page title"]')!
  await act(async () => title.focus()); await input(title, 'Keep my input')
  await dom.render(<Page sourceTitle="Later title E" />)
  expect(title.value).toBe('Keep my input')
  await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(title.value).toBe('Later title E'); expect(api.notebooks.apply).not.toHaveBeenCalled()
  const originalApply = vi.mocked(api.notebooks.apply).getMockImplementation()!
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async request => { await pending; return originalApply(request) })
  await act(async () => title.focus()); await input(title, 'A committed file title')
  await act(async () => title.blur())
  await vi.waitFor(() => expect(title.disabled).toBe(true))
  await dom.render(<Page sourceTitle="Later source F" sourceDirty />)
  expect(title.value).toBe('A committed file title')
  await act(async () => { release(); await pending })
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.title).toBe('A committed file title'))
  expect(readNoteDocument(await readFile(join(directory, 'original.note.md'), 'utf8'))).toMatchObject({ status: 'valid', note: { title: 'A committed file title' } })
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
  const note = newNoteDocument('Current draft', 'current', 'current-block'), target = newNoteDocument('Exact finding', 'target', 'target-block', 'Original file title')
  const knowledge = noteKnowledge([{ location: { workspaceId: 'workspace', path: 'target.note.md' }, document: { path: 'target.note.md', content: serializeNoteDocument(target), revision: 'target-r1' } }])
  const change = vi.fn()
  await dom.render(<NoteBlockEditor note={note} knowledge={knowledge} onChange={change} onSave={() => {}} onOpen={() => {}} onIssue={() => {}} />)
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!.editor
  await act(async () => { editor.view.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  await dom.click('[aria-label="Reference block"]')
  expect(dom.container.querySelector('[aria-label="Choose an original block"]')).not.toBeNull()
  expect(dom.container.querySelector('.note-reference-picker__row small')?.textContent).toBe('Original file title')
  expect(dom.container.querySelector('[role="group"][aria-label="Block references"] [aria-label="Reference block"]')).not.toBeNull()
  await dom.click('[aria-label="Reference workspace · target.note.md · target-block"]')
  await vi.waitFor(() => expect(change).toHaveBeenCalled())
  const read = readNoteDocument(change.mock.lastCall![0])
  expect(read.status).toBe('valid')
  if (read.status === 'valid') expect(read.note.content.content).toContainEqual(expect.objectContaining({ type: 'blockReference', attrs: expect.objectContaining({ target: { noteId: 'target', blockId: 'target-block' }, mode: 'reference' }) }))
})
