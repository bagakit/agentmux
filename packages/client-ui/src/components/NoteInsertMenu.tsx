import type { Editor, JSONContent } from '@tiptap/core'

const diagramSources: Record<string, string> = {
  mermaid: 'flowchart LR\n  A[Start] --> B[Result]',
  dot: 'digraph {\n  Start -> Result;\n}',
  plantuml: '@startuml\nAlice -> Bob: Message\n@enduml',
  drawio: '<mxfile><diagram name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Start" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
}

/** Inserts only an ordinary draft node; the existing file writer owns persistence. */
export function NoteInsertMenu({ editor }: { editor: Editor | null }) {
  return <select className="note-rich-insert" aria-label="Insert diagram or formula" value="" onChange={event => {
    const kind = event.currentTarget.value
    if (!editor || editor.isDestroyed || !editor.isEditable || !kind) return
    const node: JSONContent = kind === 'inline-formula' || kind === 'block-formula'
      ? { type: kind === 'inline-formula' ? 'noteMathInline' : 'noteMathBlock', attrs: { latex: 'x^2' } }
      : { type: 'codeBlock', attrs: { language: kind === 'code' ? null : kind }, ...(diagramSources[kind] ? { content: [{ type: 'text', text: diagramSources[kind] }] } : {}) }
    editor.chain().focus().insertContent(node).run()
  }}>
    <option value="" disabled>Insert…</option>
    <optgroup label="Diagram"><option value="mermaid">Mermaid</option><option value="drawio">Draw.io</option><option value="dot">DOT</option><option value="plantuml">PlantUML</option></optgroup>
    <optgroup label="Formula"><option value="inline-formula">Inline formula</option><option value="block-formula">Block formula</option></optgroup>
    <option value="code">Code block</option>
  </select>
}
