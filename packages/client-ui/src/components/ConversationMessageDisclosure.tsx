import { useEffect, useState, type ReactNode } from 'react'
import { SemanticIcon } from '../theme/icons.js'

/** Local reading only. The caller keys this owner to the original record and content. */
export function ConversationMessageDisclosure({ preview, reveal, children }: {
  preview: string
  reveal: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(reveal)
  useEffect(() => { if (reveal) setOpen(true) }, [reveal])
  return <details className="message-disclosure" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      {!open ? <span className="message-disclosure__preview">{preview}…</span> : null}
      <span className="message-disclosure__action"><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />{open ? 'Collapse message' : 'Show full message'}</span>
    </summary>
    {open ? children : null}
  </details>
}
