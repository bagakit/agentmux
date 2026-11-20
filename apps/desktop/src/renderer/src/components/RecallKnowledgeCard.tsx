import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import '../styles/recall-knowledge-card.css'

const Bookmark = semanticIconComponent('object.bookmark')

/** Shared presentation for a saved knowledge card. Consumers supply exact navigation. */
export function RecallKnowledgeCard({ title, kind, actions, children, showTitle = true }: { title: string; kind: string; showTitle?: boolean; actions?: ReactNode; children?: ReactNode }) {
  return <article className="recall-knowledge-card" aria-label={showTitle ? undefined : title}>
    <Bookmark size={15} aria-hidden="true" />
    <div className="recall-knowledge-card__body">
      <span className="recall-knowledge-card__kind">{kind}</span>
      {showTitle ? <strong>{title}</strong> : null}
      {actions ? <div className="recall-knowledge-card__actions">{actions}</div> : null}
      {children}
    </div>
  </article>
}

export function RecallCardLink({ children, onOpen }: { children: ReactNode; onOpen: (document: Document) => void }) {
  return <Button type="button" onClick={event => onOpen(event.currentTarget.ownerDocument)}>{children}</Button>
}
