// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NOTE_SCHEMA, type NoteDocument } from '../src/shared/note-document'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'

const note: NoteDocument = { schema: NOTE_SCHEMA, noteId: 'original-note', content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: 'original-block' }, content: [{ type: 'text', text: 'Preserve this selection' }] }
] } }
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function key(target: HTMLElement, key: string) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await new Promise(done => setTimeout(done, 0)) })
}
it('moves focus across the actual Note tools without formatting or moving the editor selection', async () => {
  const changed = vi.fn()
  await act(async () => root.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={changed} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />))
  const toolbar = host.querySelector<HTMLElement>('[role="toolbar"]')!
  const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons.filter(button => button.tabIndex === 0)).toHaveLength(0)
  expect(toolbar.tabIndex).toBe(0)
  const editor = (host.querySelector('.note-block-content') as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
  await act(async () => { editor.commands.setTextSelection({ from: 2, to: 6 }) })
  const before = editor.state.selection.toJSON()
  await act(async () => toolbar.focus())
  expect(document.activeElement).toBe(buttons[0])
  await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', isComposing: true, bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(buttons[0])
  await key(buttons[0]!, 'End')
  expect(document.activeElement).toBe(buttons.at(-1))
  await key(buttons.at(-1)!, 'ArrowLeft')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Quote')
  await key(document.activeElement as HTMLElement, 'Home')
  expect(document.activeElement).toBe(buttons[0])
  expect(editor.state.selection.toJSON()).toEqual(before)
  expect(editor.getJSON().content![0]!.type).toBe('paragraph')
  expect(changed).not.toHaveBeenCalled()
  expect(buttons.filter(button => button.tabIndex === 0)).toEqual([buttons[0]])
  await act(async () => buttons[0]!.click())
  expect(editor.getJSON().content![0]!.type).toBe('heading')
  expect(editor.getJSON().content![0]!.attrs?.blockId).toBe('original-block')
  await act(async () => { editor.commands.undo() })
  expect(editor.getJSON().content![0]!.type).toBe('paragraph')
  expect(editor.getJSON().content![0]!.attrs?.blockId).toBe('original-block')
})
