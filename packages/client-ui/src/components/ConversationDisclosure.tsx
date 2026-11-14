import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

export function ConversationDisclosure({ open, id, className, triggerRef, children }: {
  open: boolean
  id: string
  className: string
  triggerRef: RefObject<HTMLButtonElement | null>
  children: ReactNode
}) {
  const [presented, setPresented] = useState(open)
  const panelRef = useRef<HTMLDivElement>(null)
  if (open && !presented) setPresented(true)
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!open && panel?.contains(panel.ownerDocument.activeElement)) triggerRef.current?.focus()
  }, [open, triggerRef])
  return <div ref={panelRef} id={id} className="conversation-disclosure" data-open={open}
    inert={!open} aria-hidden={!open}>
    <div className="conversation-disclosure__clip">
      {open || presented ? <div className={className}>{children}</div> : null}
    </div>
  </div>
}
