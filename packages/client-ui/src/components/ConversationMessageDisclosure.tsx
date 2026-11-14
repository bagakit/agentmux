import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SemanticIcon } from '../theme/icons.js'

/** Local reading only. The caller keys this owner to the original record and content. */
export function ConversationMessageDisclosure({ preview, reveal, children, summary, expanded = false, open: controlledOpen, onOpenChange, hidden = false }: {
  preview: string
  reveal: boolean
  children: ReactNode
  summary?: ReactNode
  expanded?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** A reading preference; an explicit choice, location, selection or focus takes precedence. */
  hidden?: boolean
}) {
  const [choice, setChoice] = useState<boolean | undefined>(reveal ? true : undefined)
  const [presented, setPresented] = useState(reveal || expanded || controlledOpen === true)
  const body = useRef<HTMLDivElement>(null)
  const [, selectionChanged] = useState(0)
  const document = body.current?.ownerDocument, selection = document?.defaultView?.getSelection()
  let selected = false, selectedRecord = false
  if (selection && !selection.isCollapsed && selection.rangeCount && body.current) {
    try {
      selected = selection.getRangeAt(0).intersectsNode(body.current)
      selectedRecord = Boolean(body.current.parentElement && selection.getRangeAt(0).intersectsNode(body.current.parentElement))
    } catch { selected = selectedRecord = true }
  }
  const focused = Boolean(body.current && document?.activeElement && body.current.contains(document.activeElement))
  const focusedRecord = Boolean(body.current?.parentElement && document?.activeElement && body.current.parentElement.contains(document.activeElement))
  const open = reveal || selected || focused || (controlledOpen ?? choice ?? expanded)
  const suppressed = hidden && !reveal && !selectedRecord && !focusedRecord && controlledOpen !== true && choice !== true
  useEffect(() => {
    if (!selectedRecord || !document) return
    const changed = () => selectionChanged(value => value + 1)
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [selectedRecord, document])
  useEffect(() => { if (open) setPresented(true) }, [open])
  useEffect(() => { if (reveal) { setChoice(true); setPresented(true); onOpenChange?.(true) } }, [reveal])
  return <details className="message-disclosure" data-submission={summary ? true : undefined} hidden={suppressed} inert={suppressed} open={open}
    onFocusCapture={() => selectionChanged(value => value + 1)} onBlurCapture={() => selectionChanged(value => value + 1)} onToggle={event => {
    const next = event.currentTarget.open
    // Synchronizing the open attribute also emits toggle; only a changed DOM choice is user intent.
    if (next === open) return
    setChoice(next); if (next) setPresented(true)
    onOpenChange?.(next)
  }}>
    <summary>
      {summary}
      {!open && preview ? <span className="message-disclosure__preview">{preview}{summary ? '' : '…'}</span> : null}
      <span className="message-disclosure__action"><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />{summary ? open ? '收起原文' : '展开原文' : open ? 'Collapse message' : 'Show full message'}</span>
    </summary>
    <div ref={summary ? body : undefined} className="message-disclosure__body" hidden={!open} inert={!open}>{open || presented ? children : null}</div>
  </details>
}
