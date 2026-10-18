import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NoteRawBlock } from '../src/components/NoteRawBlock.js'
import { noteContentExtensions } from '../src/note/note-content-schema.js'

let root: Root, container: HTMLDivElement, editor: Editor
const provenance = { created: { actor: { kind: 'agent', id: 'original' }, at: 1 }, lastEdited: null }
async function flush() { await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 5)) }) }
async function mount(source: string, format = 'html', editable = true) {
  editor = new Editor({ extensions: noteContentExtensions().map(extension => extension.name === 'noteRawBlock' ? NoteRawBlock : extension), editable, content: { type: 'doc', content: [
    { type: 'noteRawBlock', attrs: { source, format, blockId: 'original-raw', provenance } },
    { type: 'paragraph', attrs: { blockId: 'original-adjacent' }, content: [{ type: 'text', text: 'Editable neighbor' }] },
  ] } })
  await act(async () => root.render(<EditorContent editor={editor} />)); await flush()
}
async function input(source: string) {
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, source)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }); await flush()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly callback: IntersectionObserverCallback) {} observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) } disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount(); editor?.destroy() }); container.remove(); vi.unstubAllGlobals() })

it('edits exact multiline raw source as one original region, with adjacent rich editing and undo', async () => {
  const original = '<section data-original="yes">\n  Original source\n</section>'
  await mount(original)
  const attrs = editor.getJSON().content![0]!.attrs
  const changed = '# New Markdown-looking text\n\n<div data-custom="a & b">Preserve me</div>\n^literal-anchor\n```custom metadata\nraw\n```'
  await input(changed)
  expect(editor.state.doc.firstChild!.attrs).toEqual({ ...attrs, source: changed })
  expect(editor.state.doc.childCount).toBe(2)
  await act(async () => editor.commands.insertContentAt(editor.state.doc.firstChild!.nodeSize + 1, 'Still '))
  expect(editor.state.doc.lastChild!.textContent).toBe('Still Editable neighbor')
  expect(editor.state.doc.firstChild!.attrs.source).toBe(changed)
  await act(async () => editor.commands.undo())
  expect(editor.state.doc.firstChild!.attrs).toMatchObject({ blockId: 'original-raw', provenance })
  // Raw textarea shortcuts use the same original PM history and public Save handler.
  await input('Another exact source')
  const saved = vi.fn(() => true)
  editor.setOptions({ editorProps: { handleKeyDown: saved } })
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
  expect(saved).toHaveBeenCalledTimes(1)
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })))
  expect(editor.state.doc.firstChild!.attrs.source).not.toBe('Another exact source')
  expect(editor.state.doc.firstChild!.attrs).toMatchObject({ blockId: 'original-raw', provenance })
})

it('keeps raw HTML inert until explicit preview and readonly source unchanged by presentation', async () => {
  const original = '<div data-extra="retain">Original <b>HTML</b></div>'
  await mount(original)
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.querySelector('textarea')!.value).toBe(original)
  expect(container.querySelector('[data-extra]')).toBeNull()
  await act(async () => editor.setEditable(false)); await flush()
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('.note-raw-block__source')!.textContent).toBe(original)
  const snapshot = editor.getJSON()
  await act(async () => container.querySelector<HTMLButtonElement>('.note-static-markup button')!.click()); await flush()
  expect(container.querySelector('iframe')?.srcdoc).toContain('Original')
  expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  expect(editor.getJSON()).toEqual(snapshot)
  expect(container.querySelector('.note-raw-block__source')!.textContent).toBe(original)
})

it('retains unsupported Markdown as local editable source without interpreting HTML or whole-document recovery', async () => {
  const original = ':::unknown option\n**Original**\n<script>source only</script>\n:::'
  await mount(original, 'markdown')
  expect(container.querySelector('textarea')!.value).toBe(original)
  expect(container.textContent).toContain('Original Markdown')
  expect(container.textContent).toContain('Editable neighbor')
  expect(container.querySelector('.note-static-markup')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
  await input(original + '\n\nStill the same original region')
  expect(editor.state.doc.firstChild!.attrs.source).toBe(original + '\n\nStill the same original region')
  expect(editor.state.doc.childCount).toBe(2)
})
