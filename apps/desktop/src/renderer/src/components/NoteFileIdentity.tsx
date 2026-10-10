import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import type { FileDocument } from '../../../shared/contracts'
import type { NoteWrittenReceipt } from '../../../shared/note-file-editing'
import { sameNoteResource } from '../lib/notebook-library'
import { useIconFeedback } from '../lib/use-icon-feedback'

const NoteIcon = semanticIconComponent('object.note')

/** A local visual event over the original document owner's receipt; never a save owner. */
export function NoteFileIdentity({ scope, document, resource, dirty, active }: {
  scope: string; document: FileDocument; resource?: NoteResource | undefined; dirty?: boolean | undefined; active: boolean
}) {
  const host = useRef<HTMLSpanElement>(null)
  const cue = useIconFeedback(scope, active, host)
  // A saved receipt loaded with this identity is historical, including on remount.
  const observed = useRef(document.noteEditing?.receipt)
  const pending = useRef<NoteWrittenReceipt | undefined>(undefined)
  const sequence = useRef(0)
  useLayoutEffect(() => {
    const editing = document.noteEditing, receipt = editing?.receipt
    if (receipt !== observed.current) {
      const previous = observed.current; observed.current = receipt
      const eventId = receipt?.noteHistory?.eventId
      pending.current = eventId && eventId === previous?.noteHistory?.eventId ? undefined : receipt
    }
    if (!active || !resource || resource.path !== document.path) {
      pending.current = undefined; cue.stop(); return
    }
    if (editing?.attempt || editing?.input) {
      cue.stop()
      // The original owner publishes its written receipt just before canonical settlement.
      // Only that exact original attempt may wait for its own settled body; unknown cannot.
      if (editing.attempt?.phase === 'written' && editing.attempt.written === pending.current &&
          sameNoteResource(editing.attempt.resource, resource)) return
      pending.current = undefined; return
    }
    if (dirty || !receipt || receipt.revision !== document.revision || editing?.baseline?.revision !== receipt.revision ||
        editing.baseline.content !== document.content) {
      pending.current = undefined; cue.stop(); return
    }
    if (pending.current === receipt) { pending.current = undefined; cue.play(scope, `${receipt.revision}:${++sequence.current}`) }
  }, [document, resource, dirty, active, scope, cue.play, cue.stop])
  useEffect(() => {
    if (!pending.current || !host.current) return
    const owner = host.current.ownerDocument
    const discard = () => { if (owner.hidden) pending.current = undefined }
    owner.addEventListener('visibilitychange', discard); discard()
    return () => owner.removeEventListener('visibilitychange', discard)
  }, [document])
  return <span ref={host} className="note-file-identity-icon" onAnimationEnd={cue.stop}>
    <NoteIcon key={cue.key} size={16} animation={cue.animation} />
  </span>
}
