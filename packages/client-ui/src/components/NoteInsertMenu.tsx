import { useEffect, useRef, useState } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import type { SelectionBookmark } from '@tiptap/pm/state'

const diagramSources: Record<string, string> = {
  mermaid: 'flowchart LR\n  A[Start] --> B[Result]',
  dot: 'digraph {\n  Start -> Result;\n}',
  plantuml: '@startuml\nAlice -> Bob: Message\n@enduml',
  drawio: '<mxfile><diagram name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Start" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>',
  html: '<section style="padding:16px;background:#f2f5f2;color:#17251a;border-radius:8px">\n  <h3>Summary</h3>\n  <p>Write your static content here.</p>\n</section>',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100" viewBox="0 0 320 100">\n  <rect x="10" y="10" width="300" height="80" rx="12" fill="#e5f1e8"/>\n  <text x="160" y="57" text-anchor="middle" fill="#173a23">Your illustration</text>\n</svg>',
}

/** Inserts draft content only; the existing file writer owns persistence. */
export function NoteInsertMenu({ editor, onImportFiles, importing = false }: {
  editor: Editor | null
  importing?: boolean
  onImportFiles?: (files: readonly File[], editor: Editor) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<{ src: string; alt: string; title: string; editor: Editor; bookmark: SelectionBookmark } | null>(null)
  useEffect(() => {
    if (!image) return
    const original = image.editor
    const map = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => setImage(current => current?.editor === original ? { ...current, bookmark: current.bookmark.map(transaction.mapping) } : current)
    original.on('transaction', map)
    return () => { original.off('transaction', map) }
  }, [image?.editor])
  useEffect(() => { setImage(current => current && current.editor !== editor ? null : current) }, [editor])
  return <>
    <select className="note-rich-insert" aria-label="Insert Note content" value="" onChange={event => {
      const kind = event.currentTarget.value
      if (!editor || editor.isDestroyed || !editor.isEditable || !kind) return
      if (kind === 'image') { setImage({ src: '', alt: '', title: '', editor, bookmark: editor.state.selection.getBookmark() }); return }
      if (kind === 'file') { fileInput.current?.click(); return }
      if (kind === 'table') { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); return }
      if (kind === 'task') { editor.chain().focus().toggleTaskList().run(); return }
      const node: JSONContent = kind === 'inline-formula' || kind === 'block-formula'
        ? { type: kind === 'inline-formula' ? 'noteMathInline' : 'noteMathBlock', attrs: { latex: 'x^2' } }
        : { type: 'codeBlock', attrs: { language: kind === 'code' ? null : kind }, ...(diagramSources[kind] ? { content: [{ type: 'text', text: diagramSources[kind] }] } : {}) }
      editor.chain().focus().insertContent(node).run()
    }}>
      <option value="" disabled>Insert…</option>
      <optgroup label="Content"><option value="image">Image address…</option>{onImportFiles && <option value="file" disabled={importing}>Image or attachment file…</option>}<option value="table">Table</option><option value="task">Task list</option></optgroup>
      <optgroup label="Static content"><option value="html">HTML source</option><option value="svg">SVG source</option></optgroup>
      <optgroup label="Diagram"><option value="mermaid">Mermaid</option><option value="drawio">Draw.io</option><option value="dot">DOT</option><option value="plantuml">PlantUML</option></optgroup>
      <optgroup label="Formula"><option value="inline-formula">Inline formula</option><option value="block-formula">Block formula</option></optgroup>
      <option value="code">Code block</option>
    </select>
    {onImportFiles && <input ref={fileInput} type="file" multiple hidden aria-label="Choose Note images or attachments" onChange={event => {
      const files = Array.from(event.currentTarget.files ?? [])
      if (files.length && editor && !editor.isDestroyed) onImportFiles(files, editor)
      event.currentTarget.value = ''
    }} />}
    {image && <form className="note-image-insert" aria-label="Insert image address" onSubmit={event => {
      event.preventDefault()
      if (image.editor.isDestroyed) return
      const selection = image.bookmark.resolve(image.editor.state.doc)
      image.editor.view.dispatch(image.editor.state.tr.setSelection(selection))
      image.editor.chain().focus().setImage({ src: image.src.trim(), alt: image.alt, ...(image.title ? { title: image.title } : {}) }).run()
      setImage(null)
    }}>
      <label>Image address<input required autoFocus aria-label="Image address" value={image.src} onChange={event => setImage({ ...image, src: event.currentTarget.value })} placeholder="assets/image.png or https://…" /></label>
      <label>Alternative text<input aria-label="Image alternative text" value={image.alt} onChange={event => setImage({ ...image, alt: event.currentTarget.value })} /></label>
      <label>Title<input aria-label="Image title" value={image.title} onChange={event => setImage({ ...image, title: event.currentTarget.value })} /></label>
      <div><button type="submit">Insert image</button><button type="button" onClick={() => { setImage(null); image.editor.commands.focus() }}>Cancel</button></div>
    </form>}
  </>
}
