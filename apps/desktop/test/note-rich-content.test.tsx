// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { fileUploadRevision } from '@agentmux/core/files'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { closeHistory } from '../src/shared/note-content-schema'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), originalWorker = globalThis.Worker
// Only worker transport is replaced. Canonical editor, node views and input run unchanged.
class WorkerIO extends NoteSnapshotTestWorker {
  postMessage(request: any) {
    if (!request.input) return super.postMessage(request)
    queueMicrotask(() => this.onmessage?.({ data: { id: request.id, result: { html: '<span class="katex"><span>rendered formula</span></span>' } } } as any))
  }
}
afterEach(async () => { await dom.render(null); vi.stubGlobal('Worker', originalWorker) })
const activeEditor = () => (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
const input = (display = false) => dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${display ? 'Block' : 'Inline'} formula source"]`)
function noteWithFormula(display = false, latex = 'x^2') {
  const note = newNoteDocument('Before ', 'math-note', 'paragraph')
  if (display) note.content.content!.push({ type: 'noteMathBlock', attrs: { blockId: 'formula', latex } })
  else note.content.content![0]!.content!.push({ type: 'noteMathInline', attrs: { latex } }, { type: 'text', text: ' after' })
  return note
}
async function setup(display = false, latex = 'x^2') {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', WorkerIO)
  const change = vi.fn(), save = vi.fn(), issue = vi.fn(), note = noteWithFormula(display, latex)
  await dom.render(<><input aria-label="Other draft" /><NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={change} onSave={save} onOpen={() => {}} onIssue={issue} /></>)
  return { editor: activeEditor(), change, save, issue, note }
}
async function openNested(display = false) {
  const preview = dom.container.querySelector<HTMLElement>(`[aria-label="Edit ${display ? 'block' : 'inline'} formula"]`)!
  const target = preview.querySelector<HTMLElement>('span span') ?? preview.querySelector<HTMLElement>('code')!
  expect(target).not.toBeNull()
  for (const type of ['mousedown', 'mouseup', 'click']) await act(async () => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(input(display)).not.toBeNull())
}
async function changeSource(value: string, display = false) {
  const field = input(display)!, prototype = display ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}

it.each([false, true])('edits %s formula source as an undoable draft and preserves the original editor', async display => {
  const { editor, change, save } = await setup(display)
  const before = editor.getJSON()
  await openNested(display)
  expect(document.activeElement).toBe(input(display))
  editor.view.dispatch(closeHistory(editor.state.tr))
  await changeSource('a+b', display)
  expect(change).toHaveBeenCalledTimes(1)
  expect(change.mock.calls[0]![0]).toContain(display ? '$$\na+b\n$$' : '$a+b$')
  expect(save).not.toHaveBeenCalled()
  await act(async () => input(display)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })))
  expect(editor.getJSON()).toEqual(before)
  expect(input(display)!.value).toBe('x^2')
  expect(activeEditor()).toBe(editor)
  await act(async () => input(display)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(input(display)).toBeNull()
  expect(save).not.toHaveBeenCalled()
})

it('keeps an unfocused empty formula and a read-only formula from claiming keyboard focus', async () => {
  const { editor, note } = await setup(true, '')
  const other = dom.container.querySelector<HTMLInputElement>('[aria-label="Other draft"]')!
  other.focus()
  const pos = editor.state.doc.firstChild!.nodeSize
  await act(async () => { editor.commands.setNodeSelection(pos) })
  expect(input(true)).toBeNull(); expect(document.activeElement).toBe(other)
  await dom.render(<NoteReader content={serializeNoteDocument(note)} path="formula.note.md" workspaceId="notes" revision="original" />)
  expect(dom.container.querySelector('[aria-label="Edit block formula"]')).toBeNull()
  expect(input(true)).toBeNull()
})

it.each(['inline-formula', 'block-formula'])('inserts %s into the existing draft and leaves source editing reachable', async kind => {
  const { editor, change, save } = await setup()
  await act(async () => { editor.commands.setTextSelection(1) })
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Insert Note content"]')!
  await act(async () => { select.value = kind; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(change).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  expect(activeEditor()).toBe(editor)
  const display = kind === 'block-formula'
  await openNested(display)
  await changeSource('z_1', display)
  expect(change.mock.calls.at(-1)![0]).toContain('z_1')
  expect(save).not.toHaveBeenCalled()
})

it.each(['mermaid', 'drawio', 'dot', 'plantuml'])('inserts %s through the menu and preserves its source through canonical Markdown', async language => {
  const { editor, change, save } = await setup()
  await act(async () => { editor.commands.setTextSelection(1) })
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Insert Note content"]')!
  await act(async () => { select.value = language; select.dispatchEvent(new Event('change', { bubbles: true })) })
  let source = ''
  editor.state.doc.descendants(node => { if (node.type.name === 'codeBlock' && node.attrs.language === language) source = node.textContent })
  expect(source.length).toBeGreaterThan(0)
  const markdown = change.mock.calls.at(-1)![0]
  expect(markdown).toContain(['```' + language, source, '```'].join('\n'))
  const read = readNoteDocument(markdown)
  expect(read.status).toBe('valid')
  if (read.status !== 'valid') throw new Error(read.message)
  const restored = read.note.content.content!.find(node => node.type === 'codeBlock')!
  expect(restored.attrs!.language).toBe(language)
  expect(restored.content!.map(node => node.text ?? '').join('')).toBe(source)
  expect(serializeNoteDocument(read.note)).toBe(markdown)
  expect(activeEditor()).toBe(editor)
  expect(save).not.toHaveBeenCalled()
})

it('routes an explicit save shortcut from the formula source to the original Note save owner', async () => {
  const { save } = await setup()
  await openNested()
  await changeSource('changed')
  expect(save).not.toHaveBeenCalled()
  await act(async () => input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })))
  expect(save).toHaveBeenCalledTimes(1)
})

it.each([false, true])('keeps the %s formula source input mounted and focused across the real NoteFileView draft echo', async display => {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', WorkerIO)
  const note = noteWithFormula(display), changes = vi.fn(), save = vi.fn()
  function FileDraft() {
    const [document, setDocument] = useState(() => {
      const content = serializeNoteDocument(note), revision = fileUploadRevision(new TextEncoder().encode(content))
      const author = { actor: { kind: 'user' as const, id: 'saved-author' }, at: 1 }
      return { path: 'formula.note.md', content, revision, noteProvenance: {
        status: 'recorded' as const, noteId: note.noteId, revision,
        resource: { hostId: 'local', workspaceId: 'notes', workspacePath: new URL("notes", new URL('/', import.meta.url)).pathname, path: 'formula.note.md' },
        blocks: Object.fromEntries(note.content.content!.map(block => [block.attrs!.blockId, { created: author, lastEdited: author }]))
      } }
    })
    return <NoteFileView document={document} knowledge={noteKnowledge([])} onChange={content => { changes(content); setDocument(value => ({ ...value, content })) }} onSave={save} onOpen={() => {}} />
  }
  await dom.render(<FileDraft />)
  const editor = activeEditor()
  await openNested(display)
  const field = input(display)!
  field.setSelectionRange(0, field.value.length)
  await changeSource('a^2+b^2=c^2', display)
  await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(1))
  expect(input(display)).toBe(field)
  expect(document.activeElement).toBe(field)
  expect(field.value).toBe('a^2+b^2=c^2')
  expect(activeEditor()).toBe(editor)
  await changeSource('z', display)
  expect(input(display)).toBe(field)
  expect(document.activeElement).toBe(field)
  expect(changes.mock.calls.at(-1)![0]).toContain(display ? '$$\nz\n$$' : '$z$')
  expect(save).not.toHaveBeenCalled()
  expect(editor.state.doc.firstChild!.attrs.provenance.lastEdited).toBeNull()
  editor.view.dispatch(closeHistory(editor.state.tr))
  await changeSource('last draft', display)
  await act(async () => input(display)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })))
  expect(input(display)).toBe(field); expect(field.value).toBe('z')
  await act(async () => input(display)!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })))
  expect(save).toHaveBeenCalledTimes(1)
})

it.each(['heading', 'listItem', 'blockquote'])('retains a formula input when %s container provenance is mapped by the real snapshot consumer', async kind => {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', WorkerIO)
  const note = noteWithFormula(), paragraph = note.content.content![0]!
  if (kind === 'heading') note.content.content = [{ ...paragraph, type: 'heading', attrs: { ...paragraph.attrs, level: 2 } }]
  else {
    const wrapper = { type: kind, attrs: { blockId: 'container' }, content: [paragraph] }
    note.content.content = [kind === 'listItem' ? { type: 'bulletList', content: [wrapper] } : wrapper]
  }
  const render = (value: typeof note) => dom.render(<NoteBlockEditor note={value} knowledge={noteKnowledge([])} onChange={() => {}} onSave={() => {}} onOpen={() => {}} onIssue={() => {}} />)
  await render(note); const editor = activeEditor()
  await openNested(); const field = input()!
  const next = { ...note, content: editor.getJSON() }, block = kind === 'listItem' ? next.content.content![0]!.content![0]! : next.content.content![0]!
  const id = block.attrs!.blockId
  block.attrs!.provenance = { created: { actor: { kind: 'user', id: 'saved-author' }, at: 1 }, lastEdited: null }
  await render(next)
  await vi.waitFor(() => {
    let found = false
    editor.state.doc.descendants(node => { if (node.attrs.blockId === id) found = node.attrs.provenance?.created?.actor.id === 'saved-author' })
    expect(found).toBe(true)
  })
  expect(input()).toBe(field); expect(document.activeElement).toBe(field)
})

it('still applies real text, heading level and block identity changes through the container view', async () => {
  const { editor } = await setup()
  await act(async () => { editor.commands.insertContentAt(1, 'Updated ') })
  expect(editor.view.dom.textContent).toContain('Updated Before')
  await act(async () => { editor.chain().setTextSelection(1).setHeading({ level: 2 }).run() })
  expect(editor.view.dom.querySelector('h2[data-block-id="paragraph"]')).not.toBeNull()
  await act(async () => { editor.commands.setHeading({ level: 3 }) })
  expect(editor.view.dom.querySelector('h2')).toBeNull()
  expect(editor.view.dom.querySelector('h3[data-block-id="paragraph"]')).not.toBeNull()
  await act(async () => { editor.view.dispatch(editor.state.tr.setNodeAttribute(0, 'blockId', 'new-block-identity')) })
  expect(editor.view.dom.querySelector('[data-block-id="paragraph"]')).toBeNull()
  expect(editor.view.dom.querySelector('h3[data-block-id="new-block-identity"]')).not.toBeNull()
  expect(editor.view.dom.textContent).toContain('Updated Before')
})
