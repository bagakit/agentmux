// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
afterEach(async () => { await dom.render(null); vi.unstubAllGlobals() })
async function setup(body = 'Original paragraph') {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const change = vi.fn(), save = vi.fn(), issue = vi.fn()
  await dom.render(<NoteBlockEditor note={newNoteDocument(body, 'common-note', 'original')} knowledge={noteKnowledge([])} onChange={change} onSave={save} onIssue={issue} onOpen={() => {}} />)
  return { editor: (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor, change, save, issue }
}
async function choose(label: string, value: string) {
  const select = dom.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  expect(select).not.toBeNull()
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function input(label: string, value: string) {
  const field = dom.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
function roundtrip(editor: Editor) {
  const source = serializeNoteDocument({ ...newNoteDocument('', 'common-note'), content: editor.getJSON() }), parsed = readNoteDocument(source)
  expect(parsed.status, parsed.status === 'invalid' ? parsed.message : '').toBe('valid')
  if (parsed.status !== 'valid') throw Error(parsed.message)
  expect(serializeNoteDocument(parsed.note)).toBe(source)
  return { source, parsed: parsed.note }
}

it('inserts an image with its original address, alternative text and title as an undoable draft', async () => {
  const { editor, save, issue, change } = await setup()
  await act(async () => editor.commands.setTextSelection(1))
  const before = editor.getJSON()
  await choose('Insert Note content', 'image')
  await input('Image address', 'assets/diagram.png')
  await input('Image alternative text', 'Architecture overview')
  await input('Image title', 'Original resource')
  await act(async () => dom.container.querySelector('form[aria-label="Insert image address"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(roundtrip(editor).source).toContain('![Architecture overview](assets/diagram.png "Original resource")')
  expect(issue).not.toHaveBeenCalledWith(expect.any(String)); expect(change).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  await act(async () => editor.commands.undo())
  expect(editor.getJSON()).toEqual(before)
})

it('maps the image insertion bookmark through neighboring editor transactions while the form is open', async () => {
  const { editor } = await setup('Original')
  await act(async () => editor.commands.setTextSelection(5))
  await choose('Insert Note content', 'image')
  await input('Image address', 'assets/picture.png')
  await act(async () => editor.view.dispatch(editor.state.tr.insertText('New ', 1)))
  await act(async () => dom.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  const paragraph = editor.getJSON().content![0]!
  expect(paragraph.content![0]!.text).toBe('New Orig')
  expect(paragraph.content![1]).toMatchObject({ type: 'image', attrs: { src: 'assets/picture.png' } })
  expect(paragraph.attrs!.blockId).toBe('original')
})

it('edits a table through the actual tools and preserves cells, aligned columns and the original neighboring paragraph', async () => {
  const { editor, change, save, issue } = await setup()
  await act(async () => editor.commands.setTextSelection(1))
  await choose('Insert Note content', 'table')
  let cell = -1
  editor.state.doc.descendants((node, pos) => { if (cell < 0 && node.type.name === 'tableHeader') cell = pos })
  expect(cell).toBeGreaterThanOrEqual(0)
  await act(async () => editor.commands.setTextSelection(cell + 2))
  await choose('Align table column', 'right')
  await act(async () => editor.commands.insertContent('Column heading'))
  await choose('Edit table', 'row-after')
  let table: any
  editor.state.doc.descendants(node => { if (node.type.name === 'table') table = node })
  expect(table.childCount).toBe(4)
  expect(table.firstChild.firstChild.attrs.align).toBe('right')
  const { source } = roundtrip(editor)
  expect(source).toContain('Column heading'); expect(source).toContain('Original paragraph'); expect(source).toContain('^original')
  expect(change).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalledWith(expect.any(String))
  await choose('Edit table', 'column-after')
  expect(roundtrip(editor).source).toContain('Column heading')
})

it('inserts a task and toggles the real checkbox without implicitly saving', async () => {
  const { editor, change, save } = await setup('Follow up')
  await act(async () => editor.commands.setTextSelection(2))
  await choose('Insert Note content', 'task')
  expect(dom.container.querySelector('input[type="checkbox"]')).not.toBeNull()
  await act(async () => dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(roundtrip(editor).source).toContain('- [x]')
  expect(roundtrip(editor).source).toContain('Follow up'); expect(change).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
})

it.each(['html', 'svg'])('inserts %s as original code and requires explicit preview', async language => {
  const { editor, save } = await setup()
  await act(async () => editor.commands.setTextSelection(1))
  await choose('Insert Note content', language)
  expect(roundtrip(editor).source).toContain('```' + language)
  expect(dom.container.querySelector('iframe')).toBeNull()
  const button = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Preview ' + language.toUpperCase())
  expect(button).toBeDefined(); expect(save).not.toHaveBeenCalled()
})
