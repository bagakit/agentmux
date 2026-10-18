import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor, type JSONContent } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { noteRichContentExtensions } from '../src/components/NoteRichContent.js'
import { NoteReader } from '../src/components/NoteReader.js'
import { readNoteDocument, serializeNoteDocument } from '../src/note/note-document.js'
import { ClientUiProvider, type ClientUiPlatform, type MarkdownDiagramInput } from '../src/platform.js'

let container: HTMLDivElement, root: Root, editor: Editor | undefined
let observers: { target?: Element; callback: (entries: any[]) => void }[]
const provenance = { created: { actor: { kind: 'agent', id: 'original-agent' }, at: 1000 }, lastEdited: null }
const content = (language: string | null = 'mermaid', text = 'graph LR\n A-->B'): JSONContent => ({ type: 'doc', content: [
  { type: 'codeBlock', attrs: { blockId: 'original-code', language, provenance }, content: [{ type: 'text', text }] },
  { type: 'paragraph', attrs: { blockId: 'next' }, content: [{ type: 'text', text: 'Original next paragraph' }] },
] })
function viewport(visible: boolean) {
  for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target, isIntersecting: visible }])
}
async function mount(document: JSONContent, editable: boolean, renderer?: ClientUiPlatform['renderMarkdownDiagram']) {
  editor = new Editor({ extensions: noteRichContentExtensions(), content: document, editable })
  const platform = { renderMarkdownDiagram: renderer } as unknown as ClientUiPlatform
  await act(async () => root.render(<ClientUiProvider platform={platform}><EditorContent editor={editor} /></ClientUiProvider>))
  return editor
}
const source = () => container.querySelector<HTMLElement>('.note-code-block__source')!
beforeEach(() => {
  observers = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    target?: Element
    constructor(public callback: (entries: any[]) => void) { observers.push(this) }
    observe(target: Element) { this.target = target }
    disconnect() { this.target = undefined }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => { root.unmount(); editor?.destroy() }); editor = undefined; container.remove(); vi.unstubAllGlobals() })

it.each(['mermaid', 'drawio', 'dot', 'gv', 'plantuml', 'puml', ' Mermaid '])('previews %s through the host while preserving exact source and node identity', async language => {
  const render = vi.fn(({ code, language }: MarkdownDiagramInput) => <figure data-diagram={language}>{code}</figure>)
  const document = content(language, 'exact <source>\n  spacing & $literal$')
  const editor = await mount(document, true, render)
  const baseline = editor.getJSON(), selection = editor.state.selection.toJSON()
  expect(render).not.toHaveBeenCalled()
  expect(source().textContent).toBe('exact <source>\n  spacing & $literal$')
  expect(source().hidden).toBe(false)
  await act(async () => viewport(true))
  expect(render).toHaveBeenLastCalledWith({ code: 'exact <source>\n  spacing & $literal$', language: language.trim().toLowerCase() === 'puml' ? 'plantuml' : language.trim().toLowerCase(), visible: true })
  expect(container.querySelector('.note-code-block')?.getAttribute('data-block-id')).toBe('original-code')
  expect(editor.getJSON()).toEqual(baseline)
  expect(editor.state.selection.toJSON()).toEqual(selection)
  expect(source().hidden).toBe(false)
})

it('edits the original content DOM, preserves selection and undo, and round-trips source plus language through Markdown', async () => {
  const render = vi.fn(({ code }: MarkdownDiagramInput) => <figure>{code}</figure>)
  const editor = await mount(content('drawio', '<mxGraphModel />'), true, render)
  await act(async () => viewport(true))
  const originalContentDOM = source().querySelector('[data-node-view-content-react]')
  const originalAttrs = editor.state.doc.firstChild!.attrs
  await act(async () => { editor.commands.setTextSelection(2); editor.commands.insertContent('edited-') })
  expect(source().querySelector('[data-node-view-content-react]')).toBe(originalContentDOM)
  expect(editor.state.selection.from).toBe(9)
  expect(editor.state.doc.firstChild!.textContent).toBe('<edited-mxGraphModel />')
  expect(editor.state.doc.firstChild!.attrs).toEqual(originalAttrs)
  expect(render).toHaveBeenLastCalledWith({ code: '<edited-mxGraphModel />', language: 'drawio', visible: true })
  const markdown = serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'original-note', content: editor.getJSON() })
  expect(markdown).toContain('```drawio\n<edited-mxGraphModel />\n```')
  expect(markdown).not.toContain('<figure>')
  const reread = readNoteDocument(markdown)
  expect(reread.status).toBe('valid')
  if (reread.status !== 'valid') throw Error(reread.message)
  expect(reread.note.content.content![0]).toMatchObject({ type: 'codeBlock', attrs: { blockId: 'original-code', language: 'drawio' }, content: [{ type: 'text', text: '<edited-mxGraphModel />' }] })
  await act(async () => { editor.commands.undo() })
  expect(editor.state.doc.firstChild!.textContent).toBe('<mxGraphModel />')
  expect(editor.state.doc.firstChild!.attrs).toEqual(originalAttrs)
  expect(source().querySelector('[data-node-view-content-react]')).toBe(originalContentDOM)
})

it('keeps read-only source available without authoring content, then exposes it when editing becomes available', async () => {
  const render = vi.fn(({ code }: MarkdownDiagramInput) => <figure>{code}</figure>)
  const editor = await mount(content(), false, render), baseline = editor.getJSON()
  expect(source().hidden).toBe(true)
  const contentDOM = source().querySelector('[data-node-view-content-react]')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(source().hidden).toBe(false)
  expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(source().hidden).toBe(true)
  await act(async () => editor.setEditable(true))
  expect(source().hidden).toBe(false)
  expect(source().querySelector('[data-node-view-content-react]')).toBe(contentDOM)
  expect(editor.getJSON()).toEqual(baseline)
})

it('releases host work on source changes, viewport exit and unmount while source input stays mounted', async () => {
  const started = vi.fn(), stopped = vi.fn()
  function Diagram({ code }: MarkdownDiagramInput) { useEffect(() => { started(code); return () => { stopped(code) } }, [code]); return <figure>{code}</figure> }
  const editor = await mount(content(), true, input => <Diagram {...input} />)
  expect(started).not.toHaveBeenCalled()
  await act(async () => viewport(true))
  expect(started).toHaveBeenLastCalledWith('graph LR\n A-->B')
  const contentDOM = source().querySelector('[data-node-view-content-react]')
  await act(async () => { editor.commands.insertContentAt(1, 'new ') })
  expect(stopped).toHaveBeenLastCalledWith('graph LR\n A-->B')
  expect(started).toHaveBeenLastCalledWith('new graph LR\n A-->B')
  await act(async () => viewport(false))
  expect(stopped).toHaveBeenLastCalledWith('new graph LR\n A-->B')
  expect(container.querySelector('figure')).toBeNull()
  expect(source().querySelector('[data-node-view-content-react]')).toBe(contentDOM)
  await act(async () => viewport(true))
  expect(started).toHaveBeenCalledTimes(3)
  await act(async () => root.render(null))
  expect(stopped).toHaveBeenCalledTimes(3)
})

it('keeps host failures and original source readable and lets a corrected source reach the same renderer', async () => {
  const render = vi.fn(({ code }: MarkdownDiagramInput) => code === 'invalid' ? <div role="alert">Invalid diagram<pre>{code}</pre></div> : <figure>{code}</figure>)
  const editor = await mount(content('mermaid', 'invalid'), true, render)
  await act(async () => viewport(true))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('invalid')
  expect(source().hidden).toBe(false)
  await act(async () => { editor.commands.insertContentAt({ from: 1, to: 8 }, 'graph LR; A-->B') })
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(container.querySelector('figure')?.textContent).toBe('graph LR; A-->B')
  expect(editor.state.doc.firstChild!.attrs.blockId).toBe('original-code')
})

it.each(['mermaid', 'javascript', null])('preserves %s input without a platform renderer', async language => {
  const editor = await mount(content(language, 'original source'), true)
  expect(source().hidden).toBe(false)
  await act(async () => { editor.commands.insertContentAt(1, 'edited ') })
  expect(source().textContent).toBe('edited original source')
  expect(editor.state.doc.firstChild!.attrs.language).toBe(language)
  expect(observers.filter(observer => observer.target)).toHaveLength(0)
})

it.each([false, true])('renders saved Markdown in the real NoteReader (Graph excerpt: %s) and keeps authors outside collapsed source', async excerpt => {
  const render = vi.fn(({ code }: MarkdownDiagramInput) => <figure>{code}</figure>)
  const platform = { renderMarkdownDiagram: render } as unknown as ClientUiPlatform
  const raw = serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'reader-note', content: content('drawio', '<mxGraphModel />') })
  await act(async () => root.render(<ClientUiProvider platform={platform}><NoteReader content={raw} path="original.note.md" workspaceId="notes" revision="saved" {...excerpt ? { blockIds: ['original-code'] } : {}} /></ClientUiProvider>))
  expect(source()).not.toBeNull()
  expect(source().hidden).toBe(true)
  const author = container.querySelector<HTMLButtonElement>('[data-author-block="original-code"]')!
  expect(author).not.toBeNull()
  expect(author.closest('[hidden]')).toBeNull()
  expect(author.closest('.note-code-block__source')).toBeNull()
  await act(async () => author.click())
  expect(document.querySelector('[role="dialog"][aria-label="Block authors"]')).not.toBeNull()
  expect(source().hidden).toBe(true)
  await act(async () => viewport(true))
  expect(render).toHaveBeenLastCalledWith({ code: '<mxGraphModel />', language: 'drawio', visible: true })
  expect(container.querySelector('[data-note-id="reader-note"]')).not.toBeNull()
  expect(source().textContent).toBe('<mxGraphModel />')
  expect(container.textContent?.includes('Original next paragraph')).toBe(!excerpt)
})
