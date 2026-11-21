import { useMemo, useState, type ReactNode } from 'react'
import type { JSONContent } from '@tiptap/core'
import { ReadOnlyBlock } from './NoteBlockEditor'

/** Mount a Note reader only while this card's body is open. */
export function RecallCardBody({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <details className="recall-knowledge-card__excerpt" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Saved content</summary>
    {open ? children : null}
  </details>
}

export function RecallCardContent({ blocks }: { blocks: readonly JSONContent[] }) {
  const content = useMemo(() => ({ type: 'doc', content: [...blocks] }), [blocks])
  return <ReadOnlyBlock content={content} />
}
