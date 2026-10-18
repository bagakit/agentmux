// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '../src/shared/note-content-schema'
import { fileUploadRevision } from '@agentmux/core/files'
import { noteKnowledge, parseNoteFile } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'

const dom = composerDOM(), originalWorker = globalThis.Worker
afterEach(async () => { await dom.render(null); vi.stubGlobal('Worker', originalWorker) })

it('keeps the empty Note author inspectable through first typing, clearing and undo', async () => {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const initial = newNoteDocument('', 'empty-note', 'empty-block'), changed = vi.fn(), issue = vi.fn()
  function Draft() {
    const [note, setNote] = useState(initial)
    return <NoteBlockEditor note={note} knowledge={noteKnowledge([])} onOpen={() => {}} onSave={() => {}} onIssue={issue} onChange={content => {
      changed(content)
      const parsed = parseNoteFile({ path: 'empty.note.md', content, revision: fileUploadRevision(new TextEncoder().encode(content)) })
      if (parsed.status !== 'valid') throw new Error('Edited Note must remain readable')
      setNote(parsed.note)
    }} />
  }
  await dom.render(<Draft />)
  const editor = (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
  const empty = () => dom.container.querySelector<HTMLElement>('.note-editor')!.dataset.noteEmpty
  const author = () => dom.container.querySelector<HTMLButtonElement>('[data-author-block="empty-block"]')!
  const dialog = () => document.querySelector<HTMLElement>('[aria-label="Block authors"][role="dialog"]')
  const selection = editor.state.selection.toJSON(), content = editor.getJSON()
  expect(empty()).toBe('true'); expect(author().textContent).toBe('Author unconfirmed')
  await act(async () => author().click())
  expect(dialog()!.textContent).toContain('Created byAuthor unconfirmed')
  expect(dialog()!.textContent).toContain('Last edited byAuthor unconfirmed')
  expect(dialog()!.textContent).not.toContain('Person')
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(author())
  expect(editor.getJSON()).toEqual(content); expect(editor.state.selection.toJSON()).toEqual(selection)
  expect(changed).not.toHaveBeenCalled()
  await act(async () => { editor.commands.insertContentAt(1, 'A first line') })
  expect(empty()).toBe('false'); expect(editor.state.doc.textContent).toBe('A first line')
  editor.view.dispatch(closeHistory(editor.state.tr))
  await act(async () => { editor.commands.deleteRange({ from: 1, to: 13 }) })
  expect(empty()).toBe('true'); expect(author().textContent).toBe('Author unconfirmed')
  expect(editor.state.doc.firstChild!.attrs.blockId).toBe('empty-block')
  expect(changed.mock.calls.at(-1)![0]).toBe(serializeNoteDocument(initial))
  await act(async () => { editor.commands.undo() })
  expect(empty()).toBe('false'); expect(editor.state.doc.textContent).toBe('A first line')
  expect(editor.state.doc.firstChild!.attrs.blockId).toBe('empty-block')
  expect(issue.mock.calls.every(([value]) => value === null)).toBe(true)
  expect(changed.mock.calls.every(([value]) => !value.includes('Author unconfirmed'))).toBe(true)
})
