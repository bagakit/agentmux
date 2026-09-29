import { useRef, type ReactNode } from 'react'
import type { ConversationAnnotation } from '../../src/renderer/src/components/ConversationMessage'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle, type ConversationAnnotationSelection } from '../../src/renderer/src/components/ConversationAnnotationNote'

/** The same note owner as SessionPane; unknown headless geometry stays unknown. */
export function ConversationAnnotationOwner({ children, onAnnotate }: {
  children: (onSelect: (selection: ConversationAnnotationSelection) => void) => ReactNode
  onAnnotate: (annotation: ConversationAnnotation) => void
}) {
  const region = useRef<HTMLDivElement>(null)
  const note = useRef<ConversationAnnotationNoteHandle>(null)
  return <div ref={region}>
    {children(selection => note.current?.select(selection, 'annotation-fixture'))}
    <ConversationAnnotationNote ref={note} sessionId="annotation-fixture" regionRef={region} active onAnnotate={onAnnotate} />
  </div>
}
