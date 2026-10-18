import { useState } from 'react'
import CodeBlock from '@tiptap/extension-code-block'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react'
import { useMarkdownDiagramRenderer } from '../platform.js'
import { useVisibleWork } from '../lib/use-visible-work.js'
import { markdownDiagramLanguage } from './MarkdownCodeBlock.js'

/** Presentation only: the inherited code node remains the original language, text and identity. */
export const NoteCodeBlock = CodeBlock.extend({
  // A real pre keeps multiline browser input inside the one content DOM.
  // An inner span/div can be replaced or split into unobserved siblings.
  addNodeView() { return ReactNodeViewRenderer(NoteCodeBlockView, { contentDOMElementTag: 'pre' }) },
})

function NoteCodeBlockView({ node, editor }: NodeViewProps) {
  const renderDiagram = useMarkdownDiagramRenderer()
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : null
  const diagram = markdownDiagramLanguage(language)
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable })
  const [showSource, setShowSource] = useState(false)
  const { ref, visible } = useVisibleWork<HTMLDivElement>(Boolean(diagram && renderDiagram))
  // Editing never hides or replaces ProseMirror's content DOM, even while a preview is pending.
  const sourceVisible = editable || !diagram || !renderDiagram || showSource
  return <NodeViewWrapper className="note-code-block" data-block-id={node.attrs.blockId ?? undefined} data-diagram-language={diagram ?? undefined}>
    <div ref={ref}>
      {diagram && <div className="note-code-block__header" contentEditable={false}>
        <span>{language?.trim() || diagram}</span>
        {!editable && renderDiagram && <button type="button" aria-expanded={showSource} onClick={() => setShowSource(value => !value)}>{showSource ? 'Hide source' : 'Show source'}</button>}
      </div>}
      {diagram && renderDiagram && <div className="note-code-block__preview" contentEditable={false}>
        {visible ? renderDiagram({ code: node.textContent, language: diagram, visible }) : <span className="note-code-block__notice">Diagram preview</span>}
      </div>}
      {diagram && !renderDiagram && <p className="note-code-block__notice" contentEditable={false} role="status">Diagram preview is unavailable here. The original source remains readable.</p>}
      <NodeViewContent className={`note-code-block__source${language ? ` language-${language}` : ''}`} hidden={!sourceVisible} />
    </div>
  </NodeViewWrapper>
}
