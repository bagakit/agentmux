import type { ChangeEvent, KeyboardEvent } from 'react'
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react'
import { NoteRawBlockNode } from '../note/note-content-schema.js'
import { NoteStaticMarkup } from './NoteStaticMarkup.js'

/** The codec owns the stable raw region; this view edits only its exact source attribute. */
function RawBlock({ node, editor, updateAttributes }: NodeViewProps) {
  const source = String(node.attrs.source ?? ''), html = node.attrs.format === 'html'
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable })
  const input = {
    'aria-label': html ? 'Original HTML source' : 'Original Markdown source',
    value: source,
    spellCheck: false,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => updateAttributes({ source: event.currentTarget.value }),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') editor.options.editorProps.handleKeyDown?.call(editor.view, editor.view, event.nativeEvent)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) editor.commands.redo(); else editor.commands.undo()
      }
    },
  }
  return <NodeViewWrapper className="note-raw-block" contentEditable={false} data-block-id={node.attrs.blockId} data-raw-format={node.attrs.format}>
    <div className="note-raw-block__label">{html ? 'Original HTML' : 'Original Markdown'}</div>
    {html && <NoteStaticMarkup content={source} kind="html" />}
    {editable ? <textarea {...input} rows={Math.max(3, Math.min(10, source.split('\n').length))} /> : <pre className="note-raw-block__source">{source}</pre>}
  </NodeViewWrapper>
}

export const NoteRawBlock = NoteRawBlockNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(RawBlock, { stopEvent: ({ event }) => {
      const target = event.target as Element | null
      return Boolean(target?.nodeType === 1 && target.closest('button, input, textarea, select, iframe'))
    } })
  },
})
