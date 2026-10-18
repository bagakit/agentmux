// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor, JSONContent } from '@tiptap/core'
import { NoteReader, type NoteReaderDraftInclude } from '@agentmux/client-ui/components/NoteReader'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { noteCanvasDraftIncludeSelector, useNoteCanvasDraftIncludes } from '../src/renderer/src/lib/use-note-canvas-draft-includes'
import { copyNoteBlock, stageNoteShare } from '../src/renderer/src/lib/note-share-staging'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const resource = (noteId: string) => ({ noteId, hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: noteId + '.note.md' })
const source = resource('source-draft'), host = resource('host-draft'), key = (target: typeof source) => documentKey(target.workspaceId, target.path)
const paragraph = (blockId: string, text: string): JSONContent => ({ type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] })
const heading = (blockId: string, level: number, text: string): JSONContent => ({ type: 'heading', attrs: { blockId, level }, content: [{ type: 'text', text }] })
afterEach(async () => { await dom.render(null); vi.unstubAllGlobals() })
function put(target: typeof source, note: NoteDocument) {
  useAppStore.setState(state => ({ documents: { ...state.documents, [key(target)]: { path: target.path, content: serializeNoteDocument(note), revision: 'source-revision' } } }))
}
function current(target: typeof source) { return useAppStore.getState().documents[key(target)]! }
async function setup(content: JSONContent[]) {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const note = { ...newNoteDocument('', source.noteId, 'empty'), content: { type: 'doc', content } }
  put(source, note); put(host, newNoteDocument('Host prose.', host.noteId, 'host-body'))
  await dom.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={() => {}} onSave={() => {}} onIssue={() => {}} onOpen={() => {}} />)
  const editor = (dom.container.querySelector('.note-block-content') as HTMLElement & { editor: Editor }).editor
  const observe = vi.spyOn(useAppStore.getState(), 'observeNoteFile').mockImplementation(() => () => {})
  const load = vi.spyOn(useAppStore.getState(), 'loadNoteFile').mockResolvedValue()
  const save = vi.spyOn(useAppStore.getState(), 'saveNoteFile').mockResolvedValue()
  return { editor, observe, load, save }
}
function stage(editor: Editor, blockId: string) {
  let position = -1
  editor.state.doc.descendants((node, pos) => { if (node.attrs.blockId === blockId) position = pos })
  expect(position).toBeGreaterThanOrEqual(0)
  const copy = copyNoteBlock(editor, position, source, { zoneId: 'original-zone', path: source.path })
  return stageNoteShare(key(host), copy)
}
function setIncludes(includes: ReturnType<typeof stage>[]) {
  const content = serializeNoteDocument({ ...newNoteDocument('', host.noteId, 'unused'), content: { type: 'doc', content: includes.map(include => ({ type: 'noteInclude', attrs: include })) } })
  useAppStore.setState(state => ({ documents: { ...state.documents, [key(host)]: { ...current(host), content } } }))
  return content
}
function Preview({ active = true }: { active?: boolean }) {
  const content = useAppStore(state => state.documents[key(host)]!.content)
  const draftIncludes = useNoteCanvasDraftIncludes(active, host, content)
  return <NoteReader resource={host} content={content} path={host.path} workspaceId={host.workspaceId} revision={null} draftIncludes={draftIncludes} />
}

it('reads the real staged heading range, tasks and table through Store → adapter → read-only Reader without saving', async () => {
  const task: JSONContent = { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'task', checked: true }, content: [paragraph('task-body', 'Checked original task')] }] }
  const table: JSONContent = { type: 'table', attrs: { blockId: 'table' }, content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('cell', 'Original table heading')] }] }] }
  const f = await setup([heading('section', 2, 'Shared section'), paragraph('inside', 'Source section body'), heading('child', 3, 'Child heading'), task, table, heading('stop', 2, 'Outside section'), paragraph('outside', 'Do not include this text')])
  setIncludes([stage(f.editor, 'section')])
  const before = JSON.stringify(useAppStore.getState().documents)
  await dom.render(<Preview />)
  expect(dom.container.textContent).toContain('Pending shared content'); expect(dom.container.textContent).toContain('Source section body')
  expect(dom.container.textContent).toContain('Child heading'); expect(dom.container.textContent).toContain('Original table heading')
  expect(dom.container.textContent).not.toContain('Outside section'); expect(dom.container.textContent).not.toContain('Do not include this text')
  expect(dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  expect(dom.container.querySelector('table')).not.toBeNull()
  expect(dom.container.querySelector('[data-pending-reference-id] [contenteditable="true"]')).toBeNull()
  expect(JSON.stringify(useAppStore.getState().documents)).toBe(before); expect(f.save).not.toHaveBeenCalled()
  expect(f.load).toHaveBeenCalledWith(source)
})

it('binds same-target tickets to each exact occurrence and removes previews immediately when the occurrence or ticket is undone', async () => {
  const f = await setup([paragraph('body', 'Exact staged original')]), first = stage(f.editor, 'body'), second = stage(f.editor, 'body')
  setIncludes([first, second]); await dom.render(<Preview />)
  expect(dom.container.querySelectorAll('[data-pending-reference-id]')).toHaveLength(2)
  await act(async () => { setIncludes([second]) })
  expect(dom.container.querySelectorAll('[data-pending-reference-id]')).toHaveLength(1)
  expect(dom.container.querySelector('[data-pending-reference-id]')!.getAttribute('data-pending-reference-id')).toBe(second.referenceId)
  await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [key(host)]: { ...current(host), noteEditing: { ...current(host).noteEditing, shares: {} } } } })))
  expect(dom.container.querySelector('[data-pending-reference-id]')).toBeNull(); expect(dom.container.textContent).not.toContain('Exact staged original')
  expect(f.save).not.toHaveBeenCalled()
})

it('rejects remapped source resources and changed occurrence targets without borrowing another original draft', async () => {
  const f = await setup([paragraph('body', 'Never leak another original')]), include = stage(f.editor, 'body')
  const content = setIncludes([include]), select = noteCanvasDraftIncludeSelector(host, content)
  expect(select(useAppStore.getState()).includes[0]?.status).toBe('read')
  const state = useAppStore.getState(), wrongConfig = { ...state.config!, workspaces: state.config!.workspaces.map(value => value.id === source.workspaceId ? { ...value, hostId: 'another-host' } : value) }
  expect(select({ ...state, config: wrongConfig }).includes).toEqual([])
  const changed = { ...current(host), content: current(host).content.replace(include.path, 'another.note.md') }
  const altered = { ...state, documents: { ...state.documents, [key(host)]: changed } }
  expect(noteCanvasDraftIncludeSelector(host, changed.content)(altered).includes).toEqual([])
  expect(noteCanvasDraftIncludeSelector({ ...host, noteId: 'another-note' }, content)(state).includes).toEqual([])
})

it('preserves a task item container and checked state, rejects duplicate source IDs, and performs no hidden reads', async () => {
  const task: JSONContent = { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'task', checked: true }, content: [paragraph('body', 'Unique task body')] }] }
  const f = await setup([task]), include = stage(f.editor, 'task')
  setIncludes([include]); await dom.render(<Preview active={false} />)
  expect(f.load).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled()
  const selected = noteCanvasDraftIncludeSelector(host, current(host).content)(useAppStore.getState()).includes[0]!
  expect(selected.status).toBe('read')
  if (selected.status === 'read') expect(selected.content.content?.[0]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true, blockId: 'task' } }] })
  await dom.render(<Preview />)
  expect(dom.container.querySelector('input[type="checkbox"]'), dom.container.innerHTML).not.toBeNull()
  expect(dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  const document = current(source), duplicated = document.content + document.content.slice(document.content.indexOf('\n\n') + 2)
  await act(async () => useAppStore.setState(state => ({ documents: { ...state.documents, [key(source)]: { ...document, content: duplicated } } })))
  expect(dom.container.textContent).toContain('source range has not been confirmed')
  expect(dom.container.textContent).not.toContain('Unique task body'); expect(f.save).not.toHaveBeenCalled()
})

it('the pure Reader isolates exact host/occurrence frames and terminates pending source cycles', async () => {
  const f = await setup([paragraph('body', 'Exact source body')]), include = stage(f.editor, 'body'), content = setIncludes([include])
  const projection = noteCanvasDraftIncludeSelector(host, content)(useAppStore.getState()), dto = projection.includes[0]!
  const open = vi.fn()
  const render = (entries: readonly NoteReaderDraftInclude[]) => dom.render(<NoteReader resource={host} content={content} path={host.path} workspaceId={host.workspaceId} revision={null} draftIncludes={entries} onOpenDraftSource={open} />)
  await render([{ ...dto, hostResource: { ...host, hostId: 'another-host' } }])
  expect(dom.container.textContent).not.toContain('Exact source body')
  await render([{ ...dto, include: { ...dto.include, referenceId: 'another-occurrence' } }])
  expect(dom.container.textContent).not.toContain('Exact source body')
  const recursive = { type: 'doc', content: [{ type: 'noteInclude', attrs: include }] }
  await render([{ ...dto, status: 'read', content: recursive }, { ...dto, hostResource: source, hostNoteId: source.noteId, status: 'read', content: recursive }])
  expect(dom.container.textContent).toContain('Circular pending source')
  const buttons = [...dom.container.querySelectorAll('button')].filter(button => button.textContent === 'Open original source')
  expect(buttons.length).toBeGreaterThan(0)
  await act(async () => buttons[0]!.click())
  expect(open).toHaveBeenCalledWith(dto.source)
  expect(f.save).not.toHaveBeenCalled()
})
