import type { MouseEvent } from 'react'
import type { NoteLinkTarget } from '@agentmux/core/note-links'

/** Raw saved text has no stored occurrence identity. Opening it never allocates one. */
export type NoteLinkOpenRequest = { text: string; target: NoteLinkTarget | null; referenceId?: string; rawRange?: { from: number; to: number } }

export function NoteInlineLink({ link, onOpen, editable = false }: {
  link: NoteLinkOpenRequest; onOpen?: ((link: NoteLinkOpenRequest) => void) | undefined; editable?: boolean
}) {
  function open(event: MouseEvent<HTMLButtonElement>) {
    if (editable && !event.metaKey && !event.ctrlKey && event.detail !== 0) return
    event.preventDefault(); event.stopPropagation(); onOpen?.(link)
  }
  return <button type="button" className={`note-inline-link${link.target ? '' : ' note-inline-link--unbound'}`}
    style={{ display: 'inline', padding: 0, border: 0, background: 'transparent', font: 'inherit', lineHeight: 'inherit', color: 'var(--green, currentColor)', textAlign: 'inherit', cursor: 'pointer', textDecorationLine: 'underline', textDecorationStyle: link.target ? 'solid' : 'dotted', textUnderlineOffset: 3 }}
    data-note-inline-link="" aria-label={`Open Note link ${link.text}`}
    title={`${editable ? 'Ctrl / ⌘-click to open · ' : ''}${link.target ? `Original Note ${link.target.noteId}${link.target.blockId ? ` · block ${link.target.blockId}` : ''}` : 'Unconfirmed page query · choose or retry without changing the source'}`}
    onMouseDown={event => { if (editable) event.preventDefault() }} onClick={open}>{`[[${link.text}]]`}</button>
}
