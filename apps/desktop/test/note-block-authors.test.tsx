// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from '@tiptap/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { LocalExecutionHost } from '@agentmux/core'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { noteKnowledge, parseNoteFile } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
const authorshipStyles = readFileSync(join(import.meta.dirname, '../../../packages/client-ui/src/styles/note-authorship.css'), 'utf8')

const originalWorker = globalThis.Worker
const dom = composerDOM(), creator = { kind: 'agent', id: 'exact-original-creator' } as const, editorActor = { kind: 'agent', id: 'exact-latest-editor' } as const
const names = { [creator.id]: 'Research', [editorActor.id]: 'Review' }
const button = (id: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('.note-block-author')].find(node => JSON.parse(node.dataset.authorBlocks!).includes(id))!
const panel = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Block authors"]')
const directories: string[] = [], owners: WorkspaceFiles[] = []
afterEach(async () => { await dom.render(null); await Promise.all(owners.splice(0).map(owner => owner.dispose())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.stubGlobal('Worker', originalWorker) })

async function original() {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const path = await realpath(await mkdtemp(join(tmpdir(), 'note-authors-'))); directories.push(path)
  const workspace = { id: 'notes', name: 'Notes', hostId: 'local', kind: 'folder', path } as const
  const files = new WorkspaceFiles(() => new LocalExecutionHost()); owners.push(files)
  const writer = new NoteFileWriter(files, undefined, new AgentMuxNotebookStore(join(path, 'notes.sqlite')))
  const note = newNoteDocument('Original paragraph', 'original', 'authored')
  const created = await writer.write(workspace, { path: 'original.note.md', content: serializeNoteDocument(note), expectedRevision: null }, { actor: creator })
  expect(created.status).toBe('written'); if (created.status !== 'written') throw Error('Original write failed')
  note.content.content![0]!.content![0]!.text = 'Reviewed paragraph'
  const edited = await writer.write(workspace, { path: 'original.note.md', content: serializeNoteDocument(note), expectedRevision: created.revision }, { actor: editorActor })
  expect(edited.status).toBe('written')
  const read = await writer.read(workspace, 'original.note.md'); expect(read.status).toBe('read')
  if (read.status !== 'read') throw Error('Original read failed')
  const parsed = parseNoteFile(read.document); if (parsed.status !== 'valid') throw Error('Original must parse')
  return { document: read.document, note: parsed.note, writer, workspace }
}
async function openAuthors(id: string) { await act(async () => button(id).click()); await vi.waitFor(() => expect(panel()).not.toBeNull()) }
async function escape() { await act(async () => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); expect(panel()).toBeNull() }

it.each(['rich editor', 'reader'] as const)('shows exact saved creator and latest editor in the real %s while preserving original content and selection', async mode => {
  const source = await original(), onChange = vi.fn()
  useAppStore.setState({ agentNames: names })
  if (mode === 'rich editor') await dom.render(<NoteBlockEditor note={source.note} knowledge={noteKnowledge([])} onChange={onChange} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
  else await dom.render(<NoteReader {...source.document} workspaceId="notes" agentNames={names} />)
  const body = dom.container.querySelector<HTMLElement & { editor: Editor }>('.ProseMirror')!, editor = body.editor
  const content = editor.getJSON(), selected = editor.state.selection.toJSON()
  expect(button('authored').textContent).toBe('')
  expect(button('authored').querySelector('[data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe('object.agent')
  expect(button('authored').getAttribute('aria-label')).toBe('Block authors: Agent · Review')
  await openAuthors('authored')
  expect(panel()?.textContent).toContain('Created byAgent · Research')
  expect(panel()?.textContent).toContain('Last edited byAgent · Review')
  const identities = panel()!.querySelectorAll('details')
  expect(identities).toHaveLength(2)
  expect(identities[0]!.textContent).toContain(creator.id); expect(identities[1]!.textContent).toContain(editorActor.id)
  expect(panel()!.querySelectorAll('time')).toHaveLength(2)
  expect(document.activeElement).toBe(panel())
  expect(button('authored').getAttribute('aria-expanded')).toBe('true')
  await escape()
  expect(document.activeElement).toBe(button('authored')); expect(button('authored').getAttribute('aria-expanded')).toBe('false')
  expect(editor.getJSON()).toEqual(content); expect(editor.state.selection.toJSON()).toEqual(selected)
  expect(onChange).not.toHaveBeenCalled()
  expect(serializeNoteDocument({ ...source.note, content: editor.getJSON() })).toBe(source.document.content)
})

it('keeps missing attribution distinct from confirmed people and retains an Agent creator after a human edit', async () => {
  const source = await original(), note = structuredClone(source.note), saved = note.content.content![0]!.attrs!.provenance
  const human = { actor: { kind: 'user', id: 'confirmed-person' }, at: saved.lastEdited.at }
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'unknown', provenance: null }, content: [{ type: 'text', text: 'Unattributed original' }] },
    { type: 'paragraph', attrs: { blockId: 'human', provenance: { created: human, lastEdited: human } }, content: [{ type: 'text', text: 'Human original' }] })
  saved.lastEdited = human
  useAppStore.setState({ agentNames: names })
  await dom.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={() => {}} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
  expect(button('authored').textContent).toBe('')
  expect(button('authored').title).toBe('Block authors: Agent · Research')
  expect(button('unknown').textContent).toBe(''); expect(button('unknown').title).toBe('Block authors: Author unconfirmed'); expect(button('unknown').querySelector('[data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe('status.unknown'); expect(button('unknown').hasAttribute('data-human-only')).toBe(false)
  expect(button('human').hasAttribute('data-human-only')).toBe(true)
  await openAuthors('unknown'); expect(panel()!.textContent).not.toContain('Person'); expect(panel()!.querySelectorAll('time')).toHaveLength(0); await escape()
  await openAuthors('authored'); expect(panel()!.textContent).toContain('Last edited byPerson'); expect(panel()!.textContent).toContain('confirmed-person'); await escape()
  await openAuthors('human'); expect(panel()!.textContent).toContain('Created byPerson'); await escape()
})

it('rebuilds only this editor decorations after real content changes and never serializes its author controls', async () => {
  const source = await original(), changed = vi.fn()
  await dom.render(<NoteBlockEditor note={source.note} knowledge={noteKnowledge([])} onChange={changed} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
  const editor = (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
  await openAuthors('authored')
  await act(async () => { editor.commands.insertContentAt(1, 'Draft ') })
  expect(panel()).toBeNull(); expect(changed).toHaveBeenCalledTimes(1)
  expect(changed.mock.calls[0]![0]).toContain('Draft Reviewed paragraph')
  expect(changed.mock.calls[0]![0]).not.toContain('Block authors'); expect(changed.mock.calls[0]![0]).not.toContain(creator.id)
  expect(dom.container.querySelectorAll('[data-author-block="authored"]')).toHaveLength(1)
})

it('keeps partial saved attribution unknown and resolves the exact author after its display name changes', async () => {
  const source = await original(), note = structuredClone(source.note)
  note.content.content![0]!.attrs!.provenance.created = null
  useAppStore.setState({ agentNames: names })
  await dom.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={() => {}} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
  expect(button('authored').textContent).toBe('')
  expect(button('authored').querySelector('[data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe('object.agent')
  expect(button('authored').getAttribute('aria-label')).toContain('some attribution is unconfirmed')
  expect(button('authored').hasAttribute('data-human-only')).toBe(false)
  await openAuthors('authored')
  expect(panel()!.textContent).toContain('Created byAuthor unconfirmed')
  expect(panel()!.querySelectorAll('time')).toHaveLength(1)
  await act(async () => useAppStore.setState({ agentNames: { ...names, [editorActor.id]: 'Reviewer renamed' } }))
  // A replaced decoration cannot remain the focus-return target of an open dialog.
  expect(panel()).toBeNull()
  expect(button('authored').textContent).toBe('')
  expect(button('authored').title).toContain('Agent · Reviewer renamed')
  await openAuthors('authored')
  expect(panel()!.textContent).toContain('Last edited byAgent · Reviewer renamed')
  expect(panel()!.querySelector('code')!.textContent).toBe(`agent · ${editorActor.id}`)
  await escape()
})

it('identifies saved reference occurrence authors separately from the referenced original content', async () => {
  const source = await original(), note = structuredClone(source.note)
  note.content.content!.push({ type: 'blockReference', attrs: { blockId: 'occurrence', referenceId: 'original-reference', mode: 'embed',
    target: { noteId: 'unread-original', blockId: 'original-block' }, provenance: note.content.content![0]!.attrs!.provenance } })
  await dom.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={() => {}} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
  expect(button('occurrence').getAttribute('aria-label')).toContain('Reference authors:')
  await openAuthors('occurrence')
  expect(panel()!.textContent).toContain('Recorded for this saved reference occurrence.')
  expect(panel()!.textContent).toContain(creator.id)
  await escape()
})

it.each(['rich editor', 'reader'] as const)('keeps checked-item and paragraph authors exact on one line without hidden human line boxes in the real %s', async mode => {
  const f = await original(), human = { kind: 'user', id: 'original-list-writer' } as const
  const p = (id: string, text: string) => ({ type: 'paragraph', attrs: { blockId: id }, content: [{ type: 'text', text }] })
  const note = newNoteDocument('', 'list-authors', 'unused')
  note.content.content = [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'checked-item', checked: false }, content: [p('checked-body', 'Original task text'),
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'nested-item', checked: false }, content: [p('nested-body', 'Nested text')] }] }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: 'plain-item' }, content: [p('plain-body', 'Plain item text')] }] },
    { type: 'codeBlock', attrs: { blockId: 'human-code' }, content: [{ type: 'text', text: 'Original code' }] },
    { type: 'blockquote', attrs: { blockId: 'quote' }, content: [p('quote-body', 'Original quote')] }]
  const created = await f.writer.write(f.workspace, { path: 'items.note.md', content: serializeNoteDocument(note), expectedRevision: null }, { actor: human })
  if (created.status !== 'written') throw Error('Original list write must succeed')
  note.content.content![0]!.content![0]!.attrs!.checked = true
  const checked = await f.writer.write(f.workspace, { path: 'items.note.md', content: serializeNoteDocument(note), expectedRevision: created.revision }, { actor: editorActor })
  if (checked.status !== 'written') throw Error('Checked-only write must succeed')
  const read = await f.writer.read(f.workspace, 'items.note.md')
  if (read.status !== 'read') throw Error('Original list must read')
  const parsed = parseNoteFile(read.document)
  if (parsed.status !== 'valid') throw Error('Original list must parse')
  useAppStore.setState({ agentNames: names })
  const changed = vi.fn(), style = document.createElement('style'); style.textContent = authorshipStyles; document.head.append(style)
  try {
    if (mode === 'rich editor') await dom.render(<NoteBlockEditor note={parsed.note} knowledge={noteKnowledge([])} onChange={changed} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
    else await dom.render(<NoteReader {...read.document} workspaceId={f.workspace.id} agentNames={names} />)
    const editor = (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
    const content = editor.getJSON(), selection = editor.state.selection.toJSON(), couldUndo = editor.can().undo()
    expect(button('checked-item').closest('p')?.dataset.blockId).toBe('checked-body')
    expect(button('nested-item').closest('p')?.dataset.blockId).toBe('nested-body')
    expect(button('plain-item').closest('p')?.dataset.blockId).toBe('plain-body')
    expect(button('checked-item').textContent).toBe('')
    expect(button('checked-item').querySelector('[data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe('object.agent')
    expect(button('checked-item').getAttribute('aria-label')).toBe('Item authors: Agent · Review; Block authors: Person')
    expect(button('checked-item').hasAttribute('data-human-only')).toBe(false)
    expect(button('checked-body')).toBe(button('checked-item'))
    expect(button('checked-body').closest('p')!.querySelectorAll('.note-block-author')).toHaveLength(1)
    expect(button('nested-item')).toBe(button('nested-body'))
    expect(getComputedStyle(button('nested-item')).position).toBe('absolute')
    expect(button('quote')).toBe(button('quote-body'))
    expect(button('quote').closest('p')?.dataset.blockId).toBe('quote-body')
    expect(button('quote').closest('blockquote')!.querySelectorAll('.note-block-author')).toHaveLength(1)
    expect(button('human-code').closest('pre')).toBeNull()
    expect(button('human-code').dataset.authorPlacement).toBe('block-end')
    expect(getComputedStyle(button('human-code').parentElement!).height).toBe('0px')
    expect(getComputedStyle(button('human-code')).position).toBe('absolute')
    expect(getComputedStyle(button('human-code')).pointerEvents).not.toBe('none')
    await openAuthors('checked-item')
    expect(panel()!.textContent).toContain('Item authors')
    expect(panel()!.textContent).toContain('structure and checked state')
    expect(panel()!.textContent).toContain('Created byPerson')
    expect(panel()!.textContent).toContain('Last edited byAgent · Review')
    expect(panel()!.textContent).toContain(human.id); expect(panel()!.textContent).toContain(editorActor.id)
    await escape(); expect(document.activeElement).toBe(button('checked-item'))
    await openAuthors('checked-body')
    expect(panel()!.querySelectorAll('[data-author-record]')).toHaveLength(2)
    const itemRecord = panel()!.querySelector('[data-author-record="checked-item"]')!
    const paragraphRecord = panel()!.querySelector('[data-author-record="checked-body"]')!
    expect(itemRecord.textContent).toContain(editorActor.id)
    expect(paragraphRecord.textContent).toContain('Last edited byPerson')
    expect(paragraphRecord.textContent).not.toContain(editorActor.id)
    await escape()
    expect(editor.getJSON()).toEqual(content); expect(editor.state.selection.toJSON()).toEqual(selection)
    expect(editor.can().undo()).toBe(couldUndo); expect(changed).not.toHaveBeenCalled()
    expect(serializeNoteDocument({ ...parsed.note, content: editor.getJSON() })).toBe(read.document.content)
  } finally { style.remove() }
})
