import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor, type JSONContent } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StaticMarkupPreview } from '../src/components/StaticMarkupPreview.js'
import { NoteCodeBlock } from '../src/components/NoteCodeBlock.js'
import { NoteReader } from '../src/components/NoteReader.js'
import { noteContentExtensions } from '../src/note/note-content-schema.js'
import { serializeNoteDocument } from '../src/note/note-document.js'

let root: Root, container: HTMLDivElement, editor: Editor | undefined
let observers: { target?: Element; callback: (entries: any[]) => void }[]
const originalProvenance = { created: { actor: { kind: 'agent', id: 'author' }, at: 1 }, lastEdited: null }
const content = (language: string, source: string): JSONContent => ({ type: 'doc', content: [
  { type: 'codeBlock', attrs: { blockId: 'original-static', language, provenance: originalProvenance }, content: [{ type: 'text', text: source }] },
  { type: 'paragraph', attrs: { blockId: 'adjacent' }, content: [{ type: 'text', text: 'Still editable' }] },
] })
const source = () => container.querySelector<HTMLElement>('.note-code-block__source')!
async function flush() { await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 5)) }) }
async function visible(value: boolean) {
  await act(async () => { for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target, isIntersecting: value }]) })
  await flush()
}
async function mount(node: ReactNode) { await act(async () => root.render(node)); await flush() }
async function code(language: string, value: string, editable = true) {
  editor = new Editor({ extensions: [...noteContentExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ codeBlock: false }) : extension), NoteCodeBlock], content: content(language, value), editable })
  await mount(<EditorContent editor={editor} />)
  return editor
}
async function click(text: string, parent: ParentNode = container) {
  const button = [...parent.querySelectorAll('button')].find(node => node.textContent === text)!
  expect(button).toBeDefined(); await act(async () => button.click()); await flush()
}
beforeEach(() => {
  observers = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    target?: Element
    constructor(public callback: (entries: any[]) => void) { observers.push(this) }
    observe(target: Element) { this.target = target; this.callback([{ target, isIntersecting: true }]) }
    disconnect() { this.target = undefined }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount(); editor?.destroy() }); editor = undefined; container.remove(); vi.unstubAllGlobals() })

// Sanitizer behavior is verified in real Chromium; happy-dom is not a security oracle.
it('keeps an HTML example as exact original code until explicit static preview', async () => {
  const html = '<div>Original <b>markup</b></div>'
  const e = await code('html', html), baseline = e.getJSON()
  expect(container.querySelector('iframe')).toBeNull(); expect(source().textContent).toBe(html)
  expect(source().hidden).toBe(false)
  await click('Preview HTML')
  const frame = container.querySelector('iframe')!
  expect(frame).not.toBeNull(); expect(frame.sandbox.toString()).toBe('')
  expect(frame.getAttribute('sandbox')).toBe(''); expect(frame.referrerPolicy).toBe('no-referrer')
  expect(frame.srcdoc).toContain("default-src 'none'")
  expect(frame.srcdoc).toContain("frame-src 'none'")
  expect(frame.srcdoc).toContain('Original <b>markup</b>')
  expect(e.getJSON()).toEqual(baseline); expect(source().textContent).toBe(html)
  expect(source().hidden).toBe(false)
})

it('offers explicit SVG preview while preserving exact original SVG source', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 100 80"><path d="M-2,-3 L12,4"/><text>source label</text></svg>'
  const e = await code(' SVG ', svg), baseline = e.getJSON()
  await click('Preview SVG')
  const frame = container.querySelector('iframe')!
  expect(frame.title).toBe('SVG preview'); expect(frame.srcdoc).toContain('source label')
  expect(e.getJSON()).toEqual(baseline); expect(source().textContent).toBe(svg)
})

it('updates only the current source preview and releases frames when hidden or offscreen', async () => {
  const e = await code('html', '<b>Original</b>')
  await click('Preview HTML'); expect(container.querySelector('iframe')?.srcdoc).toContain('Original')
  await visible(false); expect(container.querySelector('iframe')).toBeNull()
  await act(async () => { e.commands.insertContentAt({ from: 1, to: 16 }, { type: 'text', text: '<i>Current</i>' }) })
  await visible(true)
  expect(container.querySelector('iframe')?.srcdoc).toContain('Current')
  expect(container.querySelector('iframe')?.srcdoc).not.toContain('Original')
  await click('Hide preview'); expect(container.querySelector('iframe')).toBeNull()
  expect(source().textContent).toBe('<i>Current</i>')
  await act(async () => e.commands.undo())
  expect(source().textContent).toBe('<b>Original</b>')
  expect(e.getJSON().content![0]!.attrs).toMatchObject({ blockId: 'original-static', language: 'html', provenance: originalProvenance })
})

it('changes preview height and enlarges the same sanitized source without changing the Note', async () => {
  const e = await code('html', '<h1>Large original</h1>'), baseline = e.getJSON()
  await click('Preview HTML')
  const select = container.querySelector('select')!
  await act(async () => { select.value = '600'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('iframe')?.style.height).toBe('600px')
  await click('Expand preview'); await visible(true)
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog).not.toBeNull(); expect(dialog.querySelector('iframe')?.srcdoc).toContain('Large original')
  expect(dialog.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  await click('Close', dialog); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(e.getJSON()).toEqual(baseline)
})

it('keeps oversized preview failure local while its complete source and adjacent rich paragraph stay editable', async () => {
  const html = '<b>x</b>'.repeat(4000), e = await code('html', html)
  await click('Preview HTML')
  expect(container.querySelector('iframe')).toBeNull(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('static preview budget')
  expect(source().textContent).toBe(html)
  const afterCode = e.state.doc.firstChild!.nodeSize
  await act(async () => { e.commands.insertContentAt(afterCode + 1, 'Edited ') })
  expect(e.state.doc.lastChild!.textContent).toBe('Edited Still editable')
  expect(e.state.doc.firstChild!.textContent).toBe(html)
})

it('uses the real saved NoteReader for readonly Graph HTML examples, with transient preview and preserved source', async () => {
  const raw = serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'saved-static', content: content('html', '<b>Saved original</b>') })
  await mount(<NoteReader content={raw} workspaceId="original-notes" path="original.note.md" revision="r1" blockIds={['original-static']} />)
  expect(container.querySelector('iframe')).toBeNull(); expect(source().hidden).toBe(false)
  expect(source().closest('[contenteditable]')?.getAttribute('contenteditable')).toBe('false')
  await click('Preview HTML')
  expect(container.querySelector('iframe')?.srcdoc).toContain('Saved original')
  expect(source().textContent).toBe('<b>Saved original</b>')
  expect(container.textContent).not.toContain('Still editable')
})

it('keeps non-HTML code as ordinary original code', async () => {
  await code('xml', '<example />')
  expect(container.textContent).not.toContain('Preview HTML'); expect(container.querySelector('iframe')).toBeNull()
  expect(source().textContent).toBe('<example />')
})

it('uses the same shared renderer for the original Notebook output class and active lifecycle', async () => {
  await mount(<StaticMarkupPreview content="<b>Notebook output</b>" title="Original output" />)
  expect(container.querySelector('.notebook-preview__static iframe')?.srcdoc).toContain('Notebook output')
  await mount(<StaticMarkupPreview content="<b>Hidden output</b>" title="Original output" active={false} />)
  expect(container.querySelector('iframe')).toBeNull()
})
