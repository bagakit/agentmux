import type { KeyboardEvent, MouseEvent } from 'react'
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import type { NoteLinkTarget } from '@agentmux/core/note-links'

/** Raw saved text has no stored occurrence identity. Opening it never allocates one. */
export type NoteLinkOpenRequest = { text: string; target: NoteLinkTarget | null; referenceId?: string; rawRange?: { from: number; to: number } }

/** The content DOM is ProseMirror-owned text. A click places the caret; a modified
 * click opens the exact binding. There is no nested button or noneditable label. */
export function NoteInlineLinkView({ node, editor, onOpen }: Pick<NodeViewProps, 'node' | 'editor'> & { onOpen?: ((link: NoteLinkOpenRequest) => void) | undefined }) {
  const link = node.attrs as NoteLinkOpenRequest
  return <NodeViewWrapper as="span" className={`note-inline-link${link.target ? '' : ' note-inline-link--unbound'}`} data-note-inline-link=""
    style={{ color: 'var(--green, currentColor)', textDecorationLine: 'underline', textDecorationStyle: link.target ? 'solid' : 'dotted', textUnderlineOffset: 3, cursor: editor.isEditable ? 'text' : 'pointer' }}
    role={editor.isEditable ? undefined : 'link'} tabIndex={editor.isEditable ? undefined : 0}
    title={editor.isEditable ? 'Edit link text · Ctrl / ⌘-click to open' : `Open Note link ${link.text}`}
    onClick={(event: MouseEvent<HTMLElement>) => { if (editor.isEditable && !event.metaKey && !event.ctrlKey) return; event.preventDefault(); event.stopPropagation(); onOpen?.(link) }}
    onKeyDown={(event: KeyboardEvent<HTMLElement>) => { if (!editor.isEditable && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onOpen?.(link) } }}>
    <NodeViewContent<'span'> as="span" />
  </NodeViewWrapper>
}
