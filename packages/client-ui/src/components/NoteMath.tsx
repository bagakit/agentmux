import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { NoteMathInlineNode, NoteMathBlockNode } from '../note/note-content-schema.js'
import { MarkdownMath } from './MarkdownMath.js'

/** The formula source stays in the original node; preview never writes rendered HTML. */
function Formula({ node, editor, updateAttributes, selected }: NodeViewProps) {
  const display = node.type.name === 'noteMathBlock', latex = String(node.attrs.latex ?? '')
  const [editing, setEditing] = useState(false)
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  useEffect(() => { if (selected && !latex && editor.isEditable && editor.view.hasFocus()) setEditing(true) }, [selected, latex, editor])
  useEffect(() => { if (editing && editor.isEditable) field.current?.focus() }, [editing, editor])
  const source = display ? `$$\n${latex}\n$$` : `$${latex}$`
  const input = {
    'aria-label': display ? 'Block formula source' : 'Inline formula source',
    value: latex,
    ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => { field.current = element },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => updateAttributes({ latex: event.currentTarget.value }),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        editor.options.editorProps.handleKeyDown?.call(editor.view, editor.view, event.nativeEvent)
        return
      }
      if (event.key === 'Escape' || event.key === 'Enter' && !display) { event.preventDefault(); setEditing(false); editor.commands.focus() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) editor.commands.redo(); else editor.commands.undo()
      }
    }
  }
  return <NodeViewWrapper as={display ? 'div' : 'span'} className={`note-formula${display ? ' note-formula--block' : ''}`} contentEditable={false} data-block-id={node.attrs.blockId}>
    {editor.isEditable ? <>
      {!editing && <button type="button" className="note-formula__preview" aria-label={display ? 'Edit block formula' : 'Edit inline formula'} onClick={() => setEditing(true)}>
        <MarkdownMath expression={latex} source={source} display={display} />
      </button>}
      {editing && <span className="note-formula__edit">
        {display ? <textarea {...input} rows={Math.max(2, Math.min(6, latex.split('\n').length))} spellCheck={false} /> : <input {...input} spellCheck={false} />}
        <button type="button" className="note-formula__done" onClick={() => { setEditing(false); editor.commands.focus() }}>Done</button>
      </span>}
    </> : <MarkdownMath expression={latex} source={source} display={display} />}
  </NodeViewWrapper>
}
// KaTeX renders nested spans inside the button. Those events belong to the
// formula control, including mousedown before ProseMirror selects the atom.
const formulaView = () => ReactNodeViewRenderer(Formula, { stopEvent: ({ event }) => {
  const target = event.target as Element | null
  return Boolean(target?.nodeType === 1 && target.closest('button, input, textarea'))
} })
export const NoteMathInline = NoteMathInlineNode.extend({ addNodeView: formulaView })
export const NoteMathBlock = NoteMathBlockNode.extend({ addNodeView: formulaView })
