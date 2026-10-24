// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { hydrateNoteProvenance } from '@agentmux/client-ui/note/note-metadata'
import { NoteBlockEditor, type NoteEditorHandle } from '../src/renderer/src/components/NoteBlockEditor'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { NOTE_SCHEMA, readNoteDocument, serializeNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { composerDOM } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'

const dom = composerDOM()
beforeEach(() => vi.stubGlobal('Worker', NoteSnapshotTestWorker))
const paragraph = (blockId: string, text = ''): JSONContent => ({ type: 'paragraph', attrs: { blockId, provenance: {
  created: { actor: { kind: 'agent', id: `creator:${blockId}` }, at: 1 },
  lastEdited: { actor: { kind: 'user', id: `editor:${blockId}` }, at: 2 }
} }, ...(text ? { content: [{ type: 'text', text }] } : {}) })
const documentOf = (...content: JSONContent[]): NoteDocument => ({ schema: NOTE_SCHEMA, noteId: 'empty-paragraph-note', content: { type: 'doc', content } })
async function mount(note: NoteDocument, onSave = () => {}) {
  const changed = vi.fn(), issue = vi.fn(), handle: { current: NoteEditorHandle | null } = { current: null }
  await dom.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={changed} onOpen={() => {}} onSave={onSave} onIssue={issue} handleRef={handle} />)
  await vi.waitFor(() => expect(handle.current).not.toBeNull())
  return { editor: handle.current!.editor, changed, issue }
}
async function key(editor: Editor, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true, ...options })
  await act(async () => { editor.view.dom.dispatchEvent(event) })
  return event
}
async function select(editor: Editor, selection: number | { from: number; to: number }) {
  await act(async () => { editor.commands.setTextSelection(selection) })
}
function blockStart(editor: Editor, index: number) {
  let position = 1
  for (let i = 0; i < index; i++) position += editor.state.doc.child(i).nodeSize
  return position
}

it('deletes the leading empty paragraph through the mounted editor and keeps all following identities, provenance and undo', async () => {
  const { editor, changed, issue } = await mount(documentOf(paragraph('empty'), paragraph('original', 'Original text'), paragraph('tail', 'Tail')))
  const before = editor.getJSON()
  expect(dom.container.querySelector('[data-author-block="empty"]')).not.toBeNull()
  await select(editor, 1)
  const event = await key(editor)
  expect(event.defaultPrevented).toBe(true)
  expect(editor.getJSON()).toEqual({ ...before, content: before.content!.slice(1) })
  expect(editor.state.selection.$from.parent.attrs.blockId).toBe('original')
  expect(editor.state.selection.$from.parentOffset).toBe(0)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(issue).toHaveBeenLastCalledWith(null)
  const emitted = readNoteDocument(changed.mock.lastCall![0])
  expect(emitted.status).toBe('valid')
  if (emitted.status === 'valid') expect(emitted.note.content.content!.map(node => node.attrs?.blockId)).toEqual(['original', 'tail'])
  await act(async () => { expect(editor.commands.undo()).toBe(true) })
  expect(editor.getJSON()).toEqual(before)
  await act(async () => { expect(editor.commands.redo()).toBe(true) })
  expect(editor.getJSON()).toEqual({ ...before, content: before.content!.slice(1) })
})

it.each(['heading', 'horizontalRule'] as const)('keeps the following %s intact without creating a replacement paragraph', async type => {
  const next: JSONContent = type === 'heading' ? { ...paragraph('next', 'Heading'), type, attrs: { ...paragraph('next').attrs, level: 2 } } : { type, attrs: paragraph('next').attrs }
  const { editor } = await mount(documentOf(paragraph('empty'), next))
  const before = editor.getJSON()
  await select(editor, 1); await key(editor)
  expect(editor.getJSON()).toEqual({ ...before, content: before.content!.slice(1) })
  expect(editor.state.selection.from).toBe(type === 'heading' ? 1 : 0)
})

it.each(['middle', 'last'] as const)('retains the existing backward join for a %s empty paragraph', async position => {
  const content = position === 'middle' ? [paragraph('first', 'Before'), paragraph('empty'), paragraph('last', 'After')] : [paragraph('first', 'Before'), paragraph('empty')]
  const { editor } = await mount(documentOf(...content)), before = editor.getJSON()
  await select(editor, blockStart(editor, 1)); await key(editor)
  expect(editor.getJSON()).toEqual({ ...before, content: before.content!.filter(node => node.attrs?.blockId !== 'empty') })
  expect(editor.state.selection.$from.parent.attrs.blockId).toBe('first')
  expect(editor.state.selection.$from.parentOffset).toBe('Before'.length)
})

it('retains the sole empty paragraph and its editable position', async () => {
  const { editor, changed } = await mount(documentOf(paragraph('only'))), before = editor.getJSON()
  await select(editor, 1); await key(editor)
  expect(editor.getJSON()).toEqual(before)
  expect(editor.state.selection.from).toBe(1)
  expect(changed).not.toHaveBeenCalled()
})

it('keeps nonempty head text and ordinary selected-text deletion behavior', async () => {
  const { editor } = await mount(documentOf(paragraph('first', 'Keep text'), paragraph('tail', 'After'))), before = editor.getJSON()
  await select(editor, 1); await key(editor)
  expect(editor.getJSON()).toEqual(before)
  await select(editor, { from: 1, to: 5 }); await key(editor)
  expect(editor.state.doc.firstChild!.textContent).toBe(' text')
  expect(editor.state.doc.firstChild!.attrs).toEqual(before.content![0]!.attrs)
  expect(editor.getJSON().content![1]).toEqual(before.content![1])
})

it.each(['blockquote', 'bulletList'] as const)('preserves normal lifting of an empty nested %s paragraph', async type => {
  const empty = paragraph('nested'), nested = type === 'blockquote' ? { type, attrs: { blockId: 'quote' }, content: [empty] } : { type, content: [{ type: 'listItem', attrs: { blockId: 'item' }, content: [empty] }] }
  const { editor } = await mount(documentOf(nested, paragraph('tail', 'After'))), before = editor.getJSON()
  await select(editor, type === 'blockquote' ? 2 : 3); await key(editor)
  expect(editor.state.doc.firstChild!.type.name).toBe('paragraph')
  expect(editor.state.doc.firstChild!.attrs.blockId).toBe('nested')
  expect(editor.state.doc.firstChild!.textContent).toBe('')
  expect(editor.getJSON().content![1]).toEqual(before.content![1])
})

// The primary handler must leave these gestures to the installed editor keymaps.
// Calling it directly distinguishes non-interception from any later default action.
it.each([
  { name: 'Shift', options: { shiftKey: true } }, { name: 'Alt', options: { altKey: true } },
  { name: 'Control', options: { ctrlKey: true } }, { name: 'Meta', options: { metaKey: true } },
  { name: 'IME event', options: { isComposing: true } }, { name: 'Delete', options: { key: 'Delete' } }
])('does not consume $name as leading-empty Backspace', async ({ options }) => {
  const { editor, changed } = await mount(documentOf(paragraph('empty'), paragraph('next', 'Kept'))), before = editor.getJSON()
  await select(editor, 1)
  const handler = editor.options.editorProps.handleKeyDown!
  const event = new KeyboardEvent('keydown', { key: 'Backspace', ...options })
  expect(handler.call(editor.view, editor.view, event)).toBe(false)
  expect(editor.getJSON()).toEqual(before); expect(changed).not.toHaveBeenCalled()
})

it('does not consume a live composition or a selected range starting in the empty paragraph', async () => {
  const { editor, changed } = await mount(documentOf(paragraph('empty'), paragraph('next', 'Kept'))), before = editor.getJSON()
  await select(editor, 1)
  const handler = editor.options.editorProps.handleKeyDown!, event = new KeyboardEvent('keydown', { key: 'Backspace' })
  const composing = vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true)
  expect(handler.call(editor.view, editor.view, event)).toBe(false)
  composing.mockRestore()
  await select(editor, { from: 1, to: 4 })
  expect(handler.call(editor.view, editor.view, event)).toBe(false)
  expect(editor.getJSON()).toEqual(before); expect(changed).not.toHaveBeenCalled()
})

it('leaves an empty heading and a node selection to the original keymaps', async () => {
  const heading = { ...paragraph('heading'), type: 'heading', attrs: { ...paragraph('heading').attrs, level: 2 } }
  const { editor, changed } = await mount(documentOf(heading, paragraph('next', 'Kept'))), before = editor.getJSON()
  const handler = editor.options.editorProps.handleKeyDown!, event = new KeyboardEvent('keydown', { key: 'Backspace' })
  await select(editor, 1)
  expect(handler.call(editor.view, editor.view, event)).toBe(false)
  await act(async () => { editor.commands.setNodeSelection(0) })
  expect(handler.call(editor.view, editor.view, event)).toBe(false)
  expect(editor.getJSON()).toEqual(before); expect(changed).not.toHaveBeenCalled()
})

it('persists deletion only on explicit save through the original revision-aware writer and preserves the next author', async () => {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-empty-')))
  const workspace = { id: 'workspace', hostId: 'local', path: rootPath, name: 'Notes', kind: 'folder' as const }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' } as ExecutionHost))
  const metadata = new AgentMuxNotebookStore(join(rootPath, 'catalog.json')), writer = new NoteFileWriter(files, undefined, metadata)
  const path = 'empty.note.md'
  try {
    const created = await writer.write(workspace, { path, expectedRevision: null, content: serializeNoteDocument(documentOf(paragraph('empty'), paragraph('original', 'Original text'))) }, { actor: { kind: 'agent', id: 'original-author' } })
    expect(created.status).toBe('written')
    const original = await writer.read(workspace, path)
    if (original.status !== 'read') throw new Error('The original Note must be readable')
    const parsed = readNoteDocument(original.document.content)
    if (parsed.status !== 'valid') throw new Error('The original Note must be valid')
    const note = hydrateNoteProvenance(parsed.note, original.document.noteProvenance, original.document.revision)
    const write = vi.spyOn(writer, 'write')
    let saving: ReturnType<NoteFileWriter['write']> | undefined
    const { editor, changed } = await mount(note, () => { saving = writer.write(workspace, { path, content: changed.mock.lastCall![0], expectedRevision: original.document.revision }, { actor: { kind: 'user', id: 'deleting-author' } }) })
    await select(editor, 1); await key(editor)
    expect(write).not.toHaveBeenCalled()
    expect(await writer.read(workspace, path)).toEqual(original)
    await key(editor, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(saving).toBeDefined()
    const receipt = await saving!
    expect(receipt.status).toBe('written')
    expect(write).toHaveBeenCalledTimes(1)
    const saved = await writer.read(workspace, path)
    if (saved.status !== 'read') throw new Error('The saved original Note must be readable')
    expect(saved.document.revision).not.toBe(original.document.revision)
    const persisted = readNoteDocument(saved.document.content)
    expect(persisted.status).toBe('valid')
    if (persisted.status === 'valid') expect(persisted.note.content.content).toEqual(parsed.note.content.content!.slice(1))
    expect(saved.document.noteProvenance?.status).toBe('recorded')
    expect(saved.document.noteProvenance?.blocks.original).toEqual(original.document.noteProvenance?.blocks.original)
    expect(saved.document.noteProvenance?.blocks.empty).toBeUndefined()
  } finally { await files.dispose(); await rm(rootPath, { recursive: true, force: true }) }
})
